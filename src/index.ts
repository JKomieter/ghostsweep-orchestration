import { config } from "dotenv";
config();

import express from "express";
import supabase from "./supabase.js";
import { ratelimit } from "./redis.js";
import { executeMaigretScan, cleanupReport, ensureReportsDir, extractEmailPrefix, executePhoneOsint } from "./scanner.js";
import { mapClaimedProfiles, upsertShadowProfiles, updateSelectorTimestamp, lookupBreachesByEmail, lookupBreachesByPhone, upsertDiscoveredServices } from "./ingestion.js";
import { linkBreaches, updateSecurityScore } from "./scoring.js";
import { createWebhookRouter } from "./webhook.js";
import { scheduleScanReportEmail, categorizeSite } from "./email.js";
import { verifyProfiles, buildIdentity } from "./verification.js";
import { markScanStarted, updateScanStep, markScanFailed, updateScanFoundCount } from "./scan-progress.js";
import type { Request, Response, NextFunction } from "express";

const PORT = parseInt(process.env.PORT ?? "3000", 10);

/**
 * Supabase Auth middleware.
 * Validates the Bearer token from the Authorization header against Supabase,
 * attaches the authenticated user to `req.user`, and ensures the caller
 * can only act on their own resources.
 */
async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing or malformed Authorization header." });
    return;
  }

  const token = authHeader.slice(7);

  const { data, error } = await supabase.auth.getUser(token);

  if (error || !data.user) {
    console.warn("[auth] Invalid token:", error?.message ?? "no user");
    res.status(401).json({ error: "Invalid or expired token." });
    return;
  }

  // Attach user to the request for downstream handlers
  (req as any).user = data.user;

  // If there's a :userId param, enforce ownership
  const { userId } = req.params;
  if (userId && userId !== data.user.id) {
    res.status(403).json({ error: "You can only scan your own account." });
    return;
  }

  next();
}

/**
 * Represents a row from the user_selectors table.
 */
interface UserSelector {
  id: string;
  user_id: string;
  selector_type: string;
  selector_value: string;
}

/**
 * Process a single user selector through the full pipeline.
 * Branches by selector_type:
 *
 *  - username → Maigret Docker scan → ingest profiles → link breaches → score
 *  - email   → strip domain, Maigret scan on prefix + email breach lookup → score
 *  - phone   → breach lookup (highest risk) + phone OSINT placeholder → score
 */
async function processSelector(selector: UserSelector, scanId?: string): Promise<void> {
  const { id: selectorId, user_id: userId, selector_type: selectorType, selector_value: value } = selector;

  console.log(`\n${"=".repeat(60)}`);
  console.log(`[worker] Processing ${selectorType} selector: "${value}" (user: ${userId})`);
  console.log(`${"=".repeat(60)}\n`);

  // Rate-limit: 1 scan per user per minute
  const { success: allowed } = await ratelimit.limit(`scan:${userId}`);
  if (!allowed) {
    console.warn(`[worker] Rate limited for user ${userId}. Skipping.`);
    return;
  }

  // Fetch user identity for profile verification
  const { data: authUser } = await supabase.auth.admin.getUserById(userId);
  const userEmail = authUser?.user?.email;
  const userMeta = authUser?.user?.user_metadata;
  const emailPrefix = userEmail ? userEmail.split("@")[0]! : value;
  const identity = buildIdentity(emailPrefix, userEmail, userMeta);

  let phoneBreach = 0;

  switch (selectorType) {
    // ──────────────────────────────────────────────
    // USERNAME: full Maigret scan + verification
    // ──────────────────────────────────────────────
    case "username": {
      if (scanId) await updateScanStep(scanId, "maigret_scan");
      const results = await executeMaigretScan(value);
      if (scanId) await updateScanStep(scanId, "verification");
      const verified = await verifyProfiles(results, identity);
      const records = mapClaimedProfiles(userId, verified, scanId);
      if (scanId) await updateScanStep(scanId, "ingestion");
      await upsertShadowProfiles(records);
      if (scanId) await updateScanStep(scanId, "services");
      await upsertDiscoveredServices(userId, verified);
      await cleanupReport(value);
      break;
    }

    // ──────────────────────────────────────────────
    // EMAIL: Maigret scan on the prefix + verification + breach lookup
    // ──────────────────────────────────────────────
    case "email": {
      const prefix = extractEmailPrefix(value);
      console.log(`[worker] Email detected. Running Maigret on prefix "${prefix}" and breach lookup on "${value}".`);

      if (scanId) await updateScanStep(scanId, "maigret_scan");
      const results = await executeMaigretScan(prefix);
      if (scanId) await updateScanStep(scanId, "verification");
      const verified = await verifyProfiles(results, identity);
      const records = mapClaimedProfiles(userId, verified, scanId);
      if (scanId) await updateScanStep(scanId, "ingestion");
      await upsertShadowProfiles(records);
      if (scanId) await updateScanStep(scanId, "services");
      await upsertDiscoveredServices(userId, verified);
      await cleanupReport(prefix);

      if (scanId) await updateScanStep(scanId, "breach_lookup");
      await lookupBreachesByEmail(userId, value);
      break;
    }

    // ──────────────────────────────────────────────
    // PHONE: breach lookup (highest risk) + OSINT placeholder
    // ──────────────────────────────────────────────
    case "phone": {
      console.log(`[worker] Phone detected. Running breach lookup for "${value}".`);

      if (scanId) await updateScanStep(scanId, "breach_lookup");
      // Check if the phone number appears in any known breaches
      phoneBreach = await lookupBreachesByPhone(userId, value);

      // Placeholder for future phone OSINT module
      await executePhoneOsint(value);
      break;
    }

    default: {
      console.warn(`[worker] Unknown selector type "${selectorType}". Running Maigret scan as fallback.`);
      if (scanId) await updateScanStep(scanId, "maigret_scan");
      const results = await executeMaigretScan(value);
      if (scanId) await updateScanStep(scanId, "verification");
      const verified = await verifyProfiles(results, identity);
      const records = mapClaimedProfiles(userId, verified, scanId);
      if (scanId) await updateScanStep(scanId, "ingestion");
      await upsertShadowProfiles(records);
      if (scanId) await updateScanStep(scanId, "services");
      await upsertDiscoveredServices(userId, verified);
      await cleanupReport(value);
      break;
    }
  }

  // Common post-processing for all types
  await updateSelectorTimestamp(selectorId);
  if (scanId) await updateScanStep(scanId, "scoring");
  await linkBreaches(userId);
  const score = await updateSecurityScore(userId, phoneBreach);

  // Persist found_count on the scan row
  if (scanId) {
    const { count: totalProfiles } = await supabase
      .from("shadow_profiles")
      .select("*", { count: "exact", head: true })
      .eq("user_id", userId);

    await updateScanFoundCount(scanId, totalProfiles ?? 0);
  }

  console.log(`\n[worker] ✅ Done processing "${value}" (${selectorType}). Score: ${score}\n`);

  // ── Schedule post-scan email 2 minutes after completion ──
  try {
    const { data: authUser } = await supabase.auth.admin.getUserById(userId);
    const email = authUser?.user?.email;
    if (email) {
      const meta = authUser.user?.user_metadata;
      const firstName = meta?.first_name ?? meta?.full_name?.split(" ")[0] ?? meta?.name?.split(" ")[0] ?? "there";

      // Fetch top 3 shadow profiles for the teaser table
      const { data: profiles } = await supabase
        .from("shadow_profiles")
        .select("site_name")
        .eq("user_id", userId)
        .order("last_verified_at", { ascending: false })
        .limit(3);

      const { count: totalProfiles } = await supabase
        .from("shadow_profiles")
        .select("*", { count: "exact", head: true })
        .eq("user_id", userId);

      const { count: breachCount } = await supabase
        .from("shadow_profile_breaches")
        .select("*", { count: "exact", head: true })
        .eq("user_id", userId);

      scheduleScanReportEmail({
        to: email,
        firstName,
        score: score ?? 0,
        totalProfiles: totalProfiles ?? 0,
        breachCount: breachCount ?? 0,
        topSites: (profiles ?? []).map((p) => ({
          siteName: p.site_name,
          category: categorizeSite(p.site_name),
        })),
      });
    }
  } catch (emailErr) {
    console.error("[worker] Failed to schedule report email:", emailErr);
  }
}

// --- Express server + entry point ---
const app = express();
app.use(express.json());

// Ensure reports dir exists once at startup
ensureReportsDir().catch(console.error);

// Health check
app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "ghostsweep-orchestration" });
});

// Supabase webhook routes
app.use("/webhook", createWebhookRouter());

/**
 * POST /scan/:userId
 *
 * Trigger a full scan pipeline for a specific user.
 * Fetches all of the user's selectors and processes them sequentially.
 * The scan runs in the background — the endpoint returns immediately.
 */
app.post("/scan/:userId", requireAuth, async (req, res) => {
  const { userId } = req.params;
  const { scan_id: scanId } = req.body as { scan_id?: string };

  if (!userId) {
    res.status(400).json({ error: "Missing userId parameter." });
    return;
  }

  // Fetch all selectors for this user
  const { data: selectors, error } = await supabase
    .from("user_selectors")
    .select("id, user_id, selector_type, selector_value")
    .eq("user_id", userId)
    .order("last_scanned_at", { ascending: true, nullsFirst: true });

  if (error) {
    console.error(`[scan] Error fetching selectors for ${userId}:`, error.message);
    res.status(500).json({ error: "Failed to fetch selectors." });
    return;
  }

  if (!selectors || selectors.length === 0) {
    res.status(404).json({ error: "No selectors found for this user." });
    return;
  }

  console.log(`[scan] Scan triggered for user ${userId} — ${selectors.length} selector(s).`);

  // Return immediately, process in background
  res.status(202).json({
    message: "Scan started.",
    userId,
    selectors: selectors.length,
  });

  // Run all selectors in the background
  setImmediate(async () => {
    if (scanId) await markScanStarted(scanId);

    try {
      for (const selector of selectors as UserSelector[]) {
        try {
          await processSelector(selector, scanId);
        } catch (err) {
          console.error(`[scan] Pipeline error for selector "${selector.selector_value}":`, err);
        }
      }

      if (scanId) await updateScanStep(scanId, "completed");
      console.log(`[scan] ✅ All selectors processed for user ${userId}.`);
    } catch (err) {
      if (scanId) await markScanFailed(scanId, err instanceof Error ? err.message : String(err));
      console.error(`[scan] Fatal error for user ${userId}:`, err);
    }
  });
});

app.listen(PORT, () => {
  console.log(`[server] Listening on port ${PORT}`);
  console.log(`[server] Endpoints:`);
  console.log(`  POST http://localhost:${PORT}/scan/:userId`);
  console.log(`  POST http://localhost:${PORT}/webhook/new-user`);
  console.log(`  GET  http://localhost:${PORT}/health`);
});
