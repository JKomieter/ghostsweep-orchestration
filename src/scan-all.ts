/**
 * CLI script: Weekly Maigret OSINT scan for ALL users with username/email selectors.
 * Intended to be called by GitHub Actions on a weekly schedule.
 * Phone selectors are skipped — Maigret only searches usernames.
 *
 * Usage:
 *   npx tsx src/scan-all.ts             # scan + send weekly report emails
 *   npx tsx src/scan-all.ts --no-email  # scan only
 */
import { config } from "dotenv";
config();

import supabase from "./supabase.js";
import { executeMaigretScan, cleanupReport, ensureReportsDir, extractEmailPrefix } from "./scanner.js";
import { mapClaimedProfiles, upsertShadowProfiles, updateSelectorTimestamp } from "./ingestion.js";
import { sendWeeklyReportEmail } from "./email.js";
import { fetchWeeklyReportData, snapshotProfileUrls, getReportWindowStart, markWeeklyReportSent } from "./weekly-report.js";
import { verifyProfiles, buildIdentity } from "./verification.js";
import { markScanStarted, updateScanStep, markScanFailed, updateScanFoundCount } from "./scan-progress.js";
import { ratelimit } from "./redis.js";

const NO_EMAIL = process.argv.includes("--no-email");

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

  // Maigret searches by username; for emails we search the local part.
  const username = selectorType === "email" ? extractEmailPrefix(value) : value;

  if (scanId) await updateScanStep(scanId, "maigret_scan");
  const results = await executeMaigretScan(username);
  if (scanId) await updateScanStep(scanId, "verification");
  const verified = await verifyProfiles(results, identity);
  const records = mapClaimedProfiles(userId, verified, scanId, selectorId);
  if (scanId) await updateScanStep(scanId, "ingestion");
  await upsertShadowProfiles(records);
  await cleanupReport(username);

  await updateSelectorTimestamp(selectorId);
  console.log(`  [scan] ✅ Done "${value}" — ${records.length} verified profile(s)`);
}

async function sendWeeklyReport(
  userId: string,
  opts: Parameters<typeof fetchWeeklyReportData>[1]
): Promise<void> {
  const data = await fetchWeeklyReportData(userId, opts);
  if (!data) return;

  await sendWeeklyReportEmail(data);
  await markWeeklyReportSent(userId);
}

async function scanAll(): Promise<void> {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`[scan-all] Weekly scan starting...`);
  console.log(`${"=".repeat(60)}\n`);

  await ensureReportsDir();

  // Get all distinct user IDs with selectors (paged — PostgREST caps responses at 1000 rows)
  const rows: Array<{ user_id: string }> = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from("user_selectors")
      .select("user_id")
      .neq("selector_type", "phone")
      .order("id")
      .range(from, from + 999);

    if (error) {
      console.error("[scan-all] Failed to fetch users:", error.message);
      process.exit(1);
    }
    rows.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }

  const userIds = [...new Set(rows.map((r) => r.user_id))];

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
      .neq("selector_type", "phone")
      .order("last_scanned_at", { ascending: true, nullsFirst: true });

    if (!selectors || selectors.length === 0) {
      console.log("  No selectors, skipping.");
      continue;
    }

    // Snapshot state before scanning so the report can show what's new
    const since = await getReportWindowStart(uid);
    const profilesBefore = await snapshotProfileUrls(uid);

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

    // Send the weekly footprint report email
    try {
      if (NO_EMAIL) console.log("  [scan-all] --no-email set, skipping report email.");
      else await sendWeeklyReport(uid, { since, profilesBefore });
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
