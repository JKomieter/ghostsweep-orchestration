import { Router } from "express";
import supabase from "./supabase.js";
import { executeMaigretScan, cleanupReport, extractEmailPrefix } from "./scanner.js";
import { mapClaimedProfiles, upsertShadowProfiles, lookupBreachesByEmail, upsertDiscoveredServices } from "./ingestion.js";
import { linkBreaches, updateSecurityScore } from "./scoring.js";
import { verifyProfiles, buildIdentity } from "./verification.js";
import { markScanStarted, updateScanStep, markScanFailed, updateScanFoundCount } from "./scan-progress.js";

/**
 * Supabase webhook payload types.
 */
interface WebhookPayload<T = Record<string, unknown>> {
  type: "INSERT" | "UPDATE";
  table: string;
  schema: string;
  record: T;
  old_record: T | null;
}

/**
 * Shape of the user record we expect from the webhook.
 * Covers both auth.users and a custom profiles table.
 */
interface UserRecord {
  id: string;
  email?: string;
  raw_user_meta_data?: {
    full_name?: string;
    name?: string;
    first_name?: string;
    last_name?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/**
 * Extract usable selectors (email, username derived from name/email) from a new user record.
 */
function extractSelectors(
  record: UserRecord
): Array<{ selector_type: string; selector_value: string }> {
  const selectors: Array<{ selector_type: string; selector_value: string }> = [];

  // Email selector
  if (record.email) {
    selectors.push({ selector_type: "email", selector_value: record.email });
  }

  // Username selectors derived from names
  const meta = record.raw_user_meta_data;
  if (meta) {
    const names = new Set<string>();

    if (meta.full_name) names.add(meta.full_name.trim().toLowerCase().replace(/\s+/g, ""));
    if (meta.name) names.add(meta.name.trim().toLowerCase().replace(/\s+/g, ""));

    if (meta.first_name && meta.last_name) {
      const first = meta.first_name.trim().toLowerCase();
      const last = meta.last_name.trim().toLowerCase();
      names.add(`${first}${last}`);
      names.add(`${first}.${last}`);
      names.add(`${first}_${last}`);
    }

    for (const name of names) {
      if (name) {
        selectors.push({ selector_type: "username", selector_value: name });
      }
    }
  }

  // Also derive a username from the email prefix
  if (record.email) {
    const prefix = extractEmailPrefix(record.email);
    const alreadyAdded = selectors.some(
      (s) => s.selector_type === "username" && s.selector_value === prefix
    );
    if (!alreadyAdded && prefix) {
      selectors.push({ selector_type: "username", selector_value: prefix });
    }
  }

  return selectors;
}

/**
 * Create the Express router for webhook endpoints.
 */
export function createWebhookRouter(): Router {
  const router = Router();

  /**
   * POST /webhook/new-user
   *
   * Called by Supabase Database Webhook on INSERT into auth.users (or profiles).
   * Extracts email + name-based selectors, persists them, and kicks off
   * an immediate scan on the email.
   */
  router.post("/new-user", async (req, res) => {
    try {
      const payload = req.body as WebhookPayload<UserRecord>;

      if (payload.type !== "INSERT") {
        res.status(200).json({ message: "Ignored non-INSERT event." });
        return;
      }

      const record = payload.record;
      const userId = record.id;

      if (!userId) {
        res.status(400).json({ error: "Missing user id in record." });
        return;
      }

      console.log(`[webhook] New user signup: ${userId} (${record.email ?? "no email"})`);

      // 1. Extract selectors from the user record
      const selectors = extractSelectors(record);

      if (selectors.length === 0) {
        console.warn("[webhook] No selectors could be extracted.");
        res.status(200).json({ message: "No selectors extracted.", userId });
        return;
      }

      console.log(`[webhook] Extracted ${selectors.length} selector(s):`, selectors);

      // 2. Insert selectors into user_selectors (ignore duplicates)
      const selectorRows = selectors.map((s) => ({
        user_id: userId,
        selector_type: s.selector_type,
        selector_value: s.selector_value,
      }));

      const { error: selectorErr } = await supabase
        .from("user_selectors")
        .upsert(selectorRows, { onConflict: "user_id, selector_value" })
        .select();

      if (selectorErr) {
        // If upsert fails due to missing constraint, fall back to insert
        console.warn("[webhook] Upsert selectors warning:", selectorErr.message);
        const { error: insertErr } = await supabase
          .from("user_selectors")
          .insert(selectorRows);

        if (insertErr) {
          console.error("[webhook] Failed to insert selectors:", insertErr.message);
          res.status(500).json({ error: "Failed to store selectors." });
          return;
        }
      }

      // 3. Kick off an immediate email breach lookup + Maigret scan on the email prefix
      if (record.email) {
        const prefix = extractEmailPrefix(record.email);

        // Run in the background — don't block the webhook response
        setImmediate(async () => {
          // Create a shadow_scans record for this webhook-initiated scan
          let scanId: string | undefined;
          try {
            const { data: scanRow } = await supabase
              .from("shadow_scans")
              .insert({ user_id: userId, status: "starting" })
              .select("id")
              .single();
            scanId = scanRow?.id;
          } catch (e) {
            console.warn("[webhook] Could not create shadow_scans row:", e);
          }

          try {
            if (scanId) await markScanStarted(scanId);
            console.log(`[webhook] Starting background scan for "${prefix}" / "${record.email}"...`);

            // Build identity from the webhook user record
            const meta = record.raw_user_meta_data;
            const identity = buildIdentity(prefix, record.email, meta as Record<string, unknown> | undefined);

            // Maigret scan on the email prefix + verification
            if (scanId) await updateScanStep(scanId, "maigret_scan");
            const results = await executeMaigretScan(prefix);
            if (scanId) await updateScanStep(scanId, "verification");
            const verified = await verifyProfiles(results, identity);
            const profiles = mapClaimedProfiles(userId, verified, scanId);
            if (scanId) await updateScanStep(scanId, "ingestion");
            await upsertShadowProfiles(profiles);
            if (scanId) await updateScanStep(scanId, "services");
            await upsertDiscoveredServices(userId, verified);
            await cleanupReport(prefix);

            // Email breach lookup
            if (scanId) await updateScanStep(scanId, "breach_lookup");
            await lookupBreachesByEmail(userId, record.email!);

            // Link & score
            if (scanId) await updateScanStep(scanId, "scoring");
            await linkBreaches(userId);
            const score = await updateSecurityScore(userId);

            // Persist found_count and mark complete
            if (scanId) {
              const { count: totalProfiles } = await supabase
                .from("shadow_profiles")
                .select("*", { count: "exact", head: true })
                .eq("user_id", userId);

              await updateScanFoundCount(scanId, totalProfiles ?? 0);
              await updateScanStep(scanId, "completed");
            }

            console.log(`[webhook] ✅ Background scan complete for user ${userId}.`);
          } catch (err) {
            if (scanId) await markScanFailed(scanId, err instanceof Error ? err.message : String(err));
            console.error(`[webhook] Background scan error for user ${userId}:`, err);
          }
        });
      }

      res.status(200).json({
        message: "User selectors created. Scan initiated.",
        userId,
        selectors: selectors.length,
      });
    } catch (err) {
      console.error("[webhook] Unhandled error:", err);
      res.status(500).json({ error: "Internal server error." });
    }
  });

  return router;
}
