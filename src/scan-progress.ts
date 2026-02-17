/**
 * Scan progress tracking for the shadow_scans table.
 *
 * Columns available:
 *   status:       'starting' | 'scanning' | 'processing' | 'completed' | 'failed'
 *   progress:     integer 0-100
 *   found_count:  integer (total claimed profiles discovered so far)
 *   message:      text (human-readable step description for the frontend)
 *   completed_at: timestamptz
 *
 * Lifecycle:
 *   starting → scanning → processing → completed   (happy path)
 *   starting → scanning → failed                    (error)
 */
import supabase from "./supabase.js";

// ── Status type ─────────────────────────────────────────────────────

export type ScanStatus = "starting" | "scanning" | "processing" | "completed" | "failed";

// ── Step definitions ────────────────────────────────────────────────

export type ScanStep =
  | "started"
  | "maigret_scan"
  | "verification"
  | "ingestion"
  | "services"
  | "breach_lookup"
  | "scoring"
  | "completed";

interface StepInfo {
  progress: number;
  status: ScanStatus;
  message: string;
}

const STEPS: Record<ScanStep, StepInfo> = {
  started:       { progress:  5, status: "starting",    message: "Initializing scan…" },
  maigret_scan:  { progress: 25, status: "scanning",    message: "Scanning 500+ sites for your accounts…" },
  verification:  { progress: 50, status: "scanning",    message: "Verifying discovered profiles…" },
  ingestion:     { progress: 65, status: "processing",  message: "Saving discovered accounts…" },
  services:      { progress: 75, status: "processing",  message: "Cataloging services…" },
  breach_lookup: { progress: 85, status: "processing",  message: "Checking for data breaches…" },
  scoring:       { progress: 93, status: "processing",  message: "Calculating vulnerability score…" },
  completed:     { progress: 100, status: "completed",  message: "Scan complete." },
};

// ── Public API ──────────────────────────────────────────────────────

/**
 * Mark a scan as started (status → "starting", progress → 5).
 */
export async function markScanStarted(scanId: string): Promise<void> {
  const { progress, status, message } = STEPS.started;
  await updateScan(scanId, { status, progress, message });
}

/**
 * Advance the scan to a named pipeline step.
 * Updates status, progress %, and a human-readable message.
 */
export async function updateScanStep(scanId: string, step: ScanStep): Promise<void> {
  const info = STEPS[step];
  if (!info) return;

  const updates: Record<string, unknown> = {
    status: info.status,
    progress: info.progress,
    message: info.message,
  };

  if (step === "completed") {
    updates.completed_at = new Date().toISOString();
  }

  await updateScan(scanId, updates);
}

/**
 * Mark a scan as failed with a user-facing error message.
 */
export async function markScanFailed(scanId: string, errorMessage: string): Promise<void> {
  await updateScan(scanId, {
    status: "failed",
    message: `Scan failed: ${errorMessage}`,
    completed_at: new Date().toISOString(),
  });
}

/**
 * Update the running found_count on the scan row.
 * Call this after upsertShadowProfiles to keep the count current.
 */
export async function updateScanFoundCount(scanId: string, foundCount: number): Promise<void> {
  await updateScan(scanId, { found_count: foundCount });
}

// ── Internal helper ─────────────────────────────────────────────────

async function updateScan(scanId: string, updates: Record<string, unknown>): Promise<void> {
  const { error } = await supabase
    .from("shadow_scans")
    .update(updates)
    .eq("id", scanId);

  if (error) {
    // Log but don't throw — progress updates should never crash the pipeline
    console.error(`[scan-progress] Failed to update scan ${scanId}:`, error.message);
  } else {
    const label = updates.message ?? updates.status ?? "update";
    console.log(`[scan-progress] Scan ${scanId} → ${String(label)} (${updates.progress ?? "–"}%)`);
  }
}
