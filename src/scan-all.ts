/**
 * CLI script: Run the full scan pipeline for ALL users with selectors.
 * Intended to be called by GitHub Actions on a weekly schedule.
 *
 * Usage:
 *   npx tsx src/scan-all.ts
 */
import { config } from "dotenv";
config();

import supabase from "./supabase.js";
import { executeMaigretScan, cleanupReport, ensureReportsDir, extractEmailPrefix, executePhoneOsint } from "./scanner.js";
import { mapClaimedProfiles, upsertShadowProfiles, updateSelectorTimestamp, lookupBreachesByEmail, lookupBreachesByPhone, upsertDiscoveredServices } from "./ingestion.js";
import { linkBreaches, updateSecurityScore } from "./scoring.js";
import { scheduleScanReportEmail, categorizeSite } from "./email.js";
import { verifyProfiles, buildIdentity } from "./verification.js";
import { markScanStarted, updateScanStep, markScanFailed, updateScanFoundCount } from "./scan-progress.js";
import { ratelimit } from "./redis.js";

interface UserSelector {
  id: string;
  user_id: string;
  selector_type: string;
  selector_value: string;
}

/** Cached user identity to avoid refetching for every selector of the same user. */
let cachedIdentityUserId = "";
let cachedIdentity = buildIdentity("");

async function getIdentity(userId: string): Promise<ReturnType<typeof buildIdentity>> {
  if (cachedIdentityUserId === userId) return cachedIdentity;

  const { data: authUser } = await supabase.auth.admin.getUserById(userId);
  const email = authUser?.user?.email;
  const meta = authUser?.user?.user_metadata;
  const prefix = email ? email.split("@")[0]! : "";
  cachedIdentity = buildIdentity(prefix, email, meta);
  cachedIdentityUserId = userId;
  return cachedIdentity;
}

async function processSelector(selector: UserSelector, scanId?: string): Promise<void> {
  const { id: selectorId, user_id: userId, selector_type: selectorType, selector_value: value } = selector;

  console.log(`  [scan] Processing ${selectorType}: "${value}"`);

  const { success: allowed } = await ratelimit.limit(`scan:${userId}`);
  if (!allowed) {
    console.warn(`  [scan] Rate limited for user ${userId}. Skipping.`);
    return;
  }

  const identity = await getIdentity(userId);
  let phoneBreach = 0;

  switch (selectorType) {
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
    case "email": {
      const prefix = extractEmailPrefix(value);
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
    case "phone": {
      if (scanId) await updateScanStep(scanId, "breach_lookup");
      phoneBreach = await lookupBreachesByPhone(userId, value);
      await executePhoneOsint(value);
      break;
    }
    default: {
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

  await updateSelectorTimestamp(selectorId);
  if (scanId) await updateScanStep(scanId, "scoring");
  await linkBreaches(userId);
  const score = await updateSecurityScore(userId, phoneBreach);
  console.log(`  [scan] ✅ Done "${value}" — score: ${score}`);
}

async function sendReportEmail(userId: string, score: number): Promise<void> {
  const { data: authUser } = await supabase.auth.admin.getUserById(userId);
  const email = authUser?.user?.email;
  if (!email) return;

  const meta = authUser.user?.user_metadata;
  const firstName = meta?.first_name ?? meta?.full_name?.split(" ")[0] ?? meta?.name?.split(" ")[0] ?? "there";

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

  // Send immediately for the weekly batch (no 2-min delay)
  const { sendScanReportEmail } = await import("./email.js");
  await sendScanReportEmail({
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

async function scanAll(): Promise<void> {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`[scan-all] Weekly scan starting...`);
  console.log(`${"=".repeat(60)}\n`);

  await ensureReportsDir();

  // Get all distinct user IDs with selectors
  const { data: rows, error } = await supabase
    .from("user_selectors")
    .select("user_id")
    .order("user_id");

  if (error) {
    console.error("[scan-all] Failed to fetch users:", error.message);
    process.exit(1);
  }

  const userIds = [...new Set((rows ?? []).map((r) => r.user_id))];

  if (userIds.length === 0) {
    console.log("[scan-all] No users with selectors. Nothing to do.");
    return;
  }

  console.log(`[scan-all] Found ${userIds.length} user(s) to scan.\n`);

  let processed = 0;
  let failed = 0;

  for (const uid of userIds) {
    console.log(`\n── User ${uid} ──`);

    const { data: selectors } = await supabase
      .from("user_selectors")
      .select("id, user_id, selector_type, selector_value")
      .eq("user_id", uid)
      .order("last_scanned_at", { ascending: true, nullsFirst: true });

    if (!selectors || selectors.length === 0) {
      console.log("  No selectors, skipping.");
      continue;
    }

    let lastScore = 0;

    // Create a shadow_scans record for this weekly scan run
    let scanId: string | undefined;
    try {
      const { data: scanRow } = await supabase
        .from("shadow_scans")
        .insert({ user_id: uid, status: "starting" })
        .select("id")
        .single();
      scanId = scanRow?.id;
    } catch (e) {
      console.warn("  [scan-all] Could not create shadow_scans row:", e);
    }

    if (scanId) await markScanStarted(scanId);

    for (const selector of selectors as UserSelector[]) {
      try {
        await processSelector(selector, scanId);
        // Grab the latest score after each selector
        const { data: scoreRow } = await supabase
          .from("user_security_scores")
          .select("score")
          .eq("user_id", uid)
          .single();
        if (scoreRow) lastScore = scoreRow.score;
      } catch (err) {
        console.error(`  [scan-all] Error for "${selector.selector_value}":`, err);
        failed++;
      }
    }

    // Persist found_count and mark complete
    if (scanId) {
      const { count: totalProfiles } = await supabase
        .from("shadow_profiles")
        .select("*", { count: "exact", head: true })
        .eq("user_id", uid);

      await updateScanFoundCount(scanId, totalProfiles ?? 0);
      await updateScanStep(scanId, "completed");
    }

    // Send the weekly report email
    try {
      await sendReportEmail(uid, lastScore);
    } catch (err) {
      console.error(`  [scan-all] Email failed for ${uid}:`, err);
    }

    processed++;
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(`[scan-all] ✅ Weekly scan complete.`);
  console.log(`  Users processed: ${processed}`);
  console.log(`  Errors:          ${failed}`);
  console.log(`${"=".repeat(60)}\n`);
}

scanAll()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[scan-all] Fatal error:", err);
    process.exit(1);
  });
