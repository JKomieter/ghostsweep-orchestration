/**
 * Test script: Simulate the full scan pipeline for an existing Supabase user.
 *
 * Usage:
 *   npx tsx src/test-scan.ts <user_id>
 */
import { config } from "dotenv";
config();

import supabase from "./supabase.js";
import { extractEmailPrefix, executeMaigretScan, cleanupReport, ensureReportsDir } from "./scanner.js";
import { mapClaimedProfiles, upsertShadowProfiles, lookupBreachesByEmail, upsertDiscoveredServices } from "./ingestion.js";
import { linkBreaches, updateSecurityScore } from "./scoring.js";
import { sendScanReportEmail, categorizeSite } from "./email.js";

async function testScan(userId: string): Promise<void> {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`[test] Starting test scan for user: ${userId}`);
  console.log(`${"=".repeat(60)}\n`);

  // 1. Fetch user from Supabase auth.users via the admin API
  const { data: authUser, error: authErr } = await supabase.auth.admin.getUserById(userId);

  if (authErr || !authUser?.user) {
    console.error("[test] Failed to fetch user:", authErr?.message ?? "User not found");
    process.exit(1);
  }

  const user = authUser.user;
  console.log("[test] Found user:");
  console.log(`  ID:    ${user.id}`);
  console.log(`  Email: ${user.email ?? "none"}`);
  console.log(`  Meta:  ${JSON.stringify(user.user_metadata)}`);

  // 2. Extract selectors from the user record
  const selectors: Array<{ type: string; value: string }> = [];

  if (user.email) {
    selectors.push({ type: "email", value: user.email });
    const prefix = extractEmailPrefix(user.email);
    selectors.push({ type: "username", value: prefix });
  }

  const meta = user.user_metadata;
  if (meta) {
    const names = new Set<string>();
    if (meta.full_name) names.add(String(meta.full_name).trim().toLowerCase().replace(/\s+/g, ""));
    if (meta.name) names.add(String(meta.name).trim().toLowerCase().replace(/\s+/g, ""));
    if (meta.first_name && meta.last_name) {
      const first = String(meta.first_name).trim().toLowerCase();
      const last = String(meta.last_name).trim().toLowerCase();
      names.add(`${first}${last}`);
    }
    for (const name of names) {
      if (name && !selectors.some((s) => s.value === name)) {
        selectors.push({ type: "username", value: name });
      }
    }
  }

  console.log(`\n[test] Extracted ${selectors.length} selector(s):`);
  for (const s of selectors) {
    console.log(`  - ${s.type}: ${s.value}`);
  }

  // 3. Store selectors in user_selectors
  const selectorRows = selectors.map((s) => ({
    user_id: userId,
    selector_type: s.type,
    selector_value: s.value,
  }));

  const { error: insertErr } = await supabase
    .from("user_selectors")
    .insert(selectorRows);

  if (insertErr) {
    console.warn("[test] Selector insert warning (may already exist):", insertErr.message);
  } else {
    console.log("[test] Selectors stored in user_selectors.");
  }

  // 4. Run Maigret scan on each username selector
  await ensureReportsDir();

  const usernames = selectors.filter((s) => s.type === "username");

  for (const { value: username } of usernames) {
    console.log(`\n[test] ── Scanning username: "${username}" ──`);
    try {
      const results = await executeMaigretScan(username);
      const profiles = mapClaimedProfiles(userId, results);
      console.log(`[test] Found ${profiles.length} claimed profiles.`);
      await upsertShadowProfiles(profiles);
      await upsertDiscoveredServices(userId, results);
      await cleanupReport(username);
    } catch (err) {
      console.error(`[test] Maigret scan failed for "${username}":`, err);
    }
  }

  // 5. Email breach lookup
  const emails = selectors.filter((s) => s.type === "email");
  for (const { value: email } of emails) {
    console.log(`\n[test] ── Looking up breaches for email: "${email}" ──`);
    await lookupBreachesByEmail(userId, email);
  }

  // 6. Link breaches & update score
  console.log("\n[test] ── Linking breaches & calculating score ──");
  const breachLinks = await linkBreaches(userId);
  const score = await updateSecurityScore(userId);

  // 7. Summary
  console.log(`\n${"=".repeat(60)}`);
  console.log(`[test] ✅ SCAN COMPLETE`);
  console.log(`  User:           ${user.email ?? user.id}`);
  console.log(`  Usernames:      ${usernames.map((s) => s.value).join(", ")}`);
  console.log(`  Breach links:   ${breachLinks}`);
  console.log(`  Security score: ${score}`);
  console.log(`${"=".repeat(60)}\n`);

  // 8. Send scan report email immediately (test mode — no 2-min delay)
  if (user.email) {
    console.log("[test] Sending scan report email...");
    try {
      const meta = user.user_metadata;
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

      const { count: totalBreaches } = await supabase
        .from("shadow_profile_breaches")
        .select("*", { count: "exact", head: true })
        .eq("user_id", userId);

      await sendScanReportEmail({
        to: user.email,
        firstName,
        score: score ?? 0,
        totalProfiles: totalProfiles ?? 0,
        breachCount: totalBreaches ?? 0,
        topSites: (profiles ?? []).map((p) => ({
          siteName: p.site_name,
          category: categorizeSite(p.site_name),
        })),
      });
    } catch (emailErr) {
      console.error("[test] Email send failed:", emailErr);
    }
  }
}

// --- Entry point ---
const userId = process.argv[2];

if (!userId) {
  console.error("Usage: npx tsx src/test-scan.ts <user_id>");
  process.exit(1);
}

testScan(userId).catch((err) => {
  console.error("[test] Fatal error:", err);
  process.exit(1);
});
