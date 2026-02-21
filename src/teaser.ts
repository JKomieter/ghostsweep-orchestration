/**
 * Teaser scan module.
 *
 * Runs a lightweight Maigret scan (--top 500) for unauthenticated leads.
 * Creates a shadow_scans row with status "scanning", spawns Maigret in the
 * background, streams discovered profiles into shadow_profiles with
 * is_teaser = true, and emails the result when done.
 */
import { exec } from "node:child_process";
import { readFile, unlink } from "node:fs/promises";
import path from "node:path";
import supabase from "./supabase.js";
import { ensureReportsDir, type MaigretSiteResult } from "./scanner.js";
import { categorizeSite, sendTeaserReportEmail } from "./email.js";

const REPORTS_DIR = path.resolve(process.cwd(), "reports");

// ── Types ───────────────────────────────────────────────────────────

interface MaigretRawEntry {
  url_user: string;
  status: {
    status: string;
    site_name: string;
    url: string;
    tags?: string[];
  };
  [key: string]: unknown;
}

interface TeaserShadowProfile {
  site_name: string;
  profile_url: string;
  scan_id: string;
  is_teaser: boolean;
  last_verified_at: string;
}

// ── Core logic ──────────────────────────────────────────────────────

/**
 * Create the initial shadow_scans row for a teaser scan.
 * Returns the generated scan id.
 */
export async function createTeaserScan(
  username: string,
  email?: string
): Promise<string> {
  const { data, error } = await supabase
    .from("shadow_scans")
    .insert({
      status: "scanning",
      progress: 5,
      message: "Initializing teaser scan…",
    })
    .select("id")
    .single();

  if (error) {
    console.error("[teaser] Failed to create scan row:", error.message);
    throw error;
  }

  console.log(`[teaser] Created scan ${data.id} for "${username}"${email ? ` (${email})` : ""}`);
  return data.id as string;
}

/**
 * Run the full teaser pipeline in the background.
 *
 *  1. Execute Maigret with --top 500 --json simple
 *  2. Parse the report
 *  3. Insert results into shadow_profiles with is_teaser = true
 *  4. Increment progress by ~10 % for every 50 sites processed
 *  5. Mark scan as completed
 *  6. Email the teaser report to the lead
 */
export async function runTeaserScan(
  scanId: string,
  username: string,
  email?: string
): Promise<void> {
  try {
    // ── 1. Run Maigret ────────────────────────────────────────────
    await ensureReportsDir();

    const sanitized = username.trim().replace(/\s+/g, "_");
    const shellSafe = sanitized.replace(/'/g, "'\\''");

    // Check if maigret is available directly (Fly.io) or needs Docker (local)
    const useDirect = await new Promise<boolean>((resolve) => {
      exec("which maigret", (error) => resolve(!error));
    });

    const directCmd = `maigret '${shellSafe}' --json simple --folderoutput "${REPORTS_DIR}"`;
    const dockerCmd = `docker run --rm -v "${REPORTS_DIR}:/app/reports" soxoj/maigret:latest '${shellSafe}' --json simple`;
    const cmd = useDirect ? directCmd : dockerCmd;

    console.log(`[teaser] Running Maigret (all sites) for "${sanitized}" [${useDirect ? "direct" : "Docker"}]...`);

    await updateTeaserProgress(scanId, 10, "scanning", "Scanning 3,000+ sites…");

    await new Promise<void>((resolve, reject) => {
      exec(cmd, { timeout: 300_000 }, (error, stdout, stderr) => {
        if (error) {
          console.error(`[teaser] Maigret error: ${error.message}`);
          console.error(`[teaser] stderr: ${stderr}`);
          reject(error);
          return;
        }
        console.log(`[teaser] Maigret stdout: ${stdout.slice(0, 500)}`);
        resolve();
      });
    });

    // ── 2. Parse report ───────────────────────────────────────────
    await updateTeaserProgress(scanId, 50, "scanning", "Processing results…");

    const reportPath = path.join(REPORTS_DIR, `report_${sanitized}_simple.json`);
    const raw = await readFile(reportPath, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, MaigretRawEntry>;

    const results: MaigretSiteResult[] = Object.entries(parsed).map(
      ([siteName, entry]) => ({
        siteName,
        url: entry.status?.url ?? entry.url_user ?? "",
        status: (entry.status?.status ?? "").toLowerCase(),
        tags: entry.status?.tags ?? [],
      })
    );

    const claimed = results.filter((r) => r.status === "claimed");
    console.log(`[teaser] Found ${claimed.length} claimed profiles out of ${results.length} sites.`);

    // ── 3. Insert profiles in batches, updating progress ──────────
    const now = new Date().toISOString();
    const BATCH_SIZE = 50;
    let inserted = 0;

    for (let i = 0; i < claimed.length; i += BATCH_SIZE) {
      const batch = claimed.slice(i, i + BATCH_SIZE);

      const records: TeaserShadowProfile[] = batch.map((r) => ({
        site_name: r.siteName,
        profile_url: r.url,
        scan_id: scanId,
        is_teaser: true,
        last_verified_at: now,
      }));

      const { error: upsertErr } = await supabase
        .from("shadow_profiles")
        .upsert(records);

      if (upsertErr) {
        console.error(`[teaser] Batch upsert error:`, upsertErr.message);
        // Continue with remaining batches
      } else {
        inserted += batch.length;
      }

      // Increment progress: 50 → 90 range, scaled by batches processed
      const batchesDone = Math.floor(i / BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(claimed.length / BATCH_SIZE);
      const progress = Math.min(90, 50 + Math.round((batchesDone / totalBatches) * 40));
      await updateTeaserProgress(scanId, progress, "scanning", `Saved ${inserted} of ${claimed.length} profiles…`);
    }

    console.log(`[teaser] Inserted ${inserted} teaser profiles for scan ${scanId}.`);

    // ── 4. Update found_count & mark completed ────────────────────
    await supabase
      .from("shadow_scans")
      .update({
        status: "completed",
        progress: 100,
        found_count: inserted,
        message: "Scan complete.",
        completed_at: new Date().toISOString(),
      })
      .eq("id", scanId);

    console.log(`[teaser] ✅ Scan ${scanId} completed.`);

    // ── 5. Clean up report file ───────────────────────────────────
    try {
      await unlink(reportPath);
      console.log(`[teaser] Cleaned up report: ${reportPath}`);
    } catch {
      console.warn(`[teaser] Could not delete report: ${reportPath}`);
    }

    // ── 6. Email teaser results (only if email was provided) ──────
    if (email) {
      try {
        // Fetch top 5 discovered profiles for the email teaser
        const { data: topProfiles } = await supabase
          .from("shadow_profiles")
          .select("site_name")
          .eq("scan_id", scanId)
          .eq("is_teaser", true)
          .limit(5);

        const topSites = (topProfiles ?? []).map((p: { site_name: string }) => ({
          siteName: p.site_name,
          category: categorizeSite(p.site_name),
        }));

        await sendTeaserReportEmail({
          to: email,
          username,
          totalProfiles: inserted,
          topSites,
        });

        console.log(`[teaser] 📧 Teaser email sent to ${email}.`);
      } catch (emailErr) {
        console.error("[teaser] Failed to send teaser email:", emailErr);
      }
    } else {
      console.log(`[teaser] No email provided — skipping teaser email.`);
    }
  } catch (err) {
    // Mark scan as failed
    console.error(`[teaser] Pipeline error for scan ${scanId}:`, err);
    await supabase
      .from("shadow_scans")
      .update({
        status: "failed",
        message: `Scan failed: ${err instanceof Error ? err.message : String(err)}`,
        completed_at: new Date().toISOString(),
      })
      .eq("id", scanId);
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

async function updateTeaserProgress(
  scanId: string,
  progress: number,
  status: string,
  message: string
): Promise<void> {
  const { error } = await supabase
    .from("shadow_scans")
    .update({ progress, status, message })
    .eq("id", scanId);

  if (error) {
    console.error(`[teaser] Progress update failed for ${scanId}:`, error.message);
  } else {
    console.log(`[teaser] Scan ${scanId} → ${message} (${progress}%)`);
  }
}
