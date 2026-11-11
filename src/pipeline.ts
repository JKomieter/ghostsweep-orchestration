/**
 * The on-demand scan pipeline, shared by POST /scan/:userId and the
 * new-user webhook.
 *
 *   plan: pro / buster → Maigret on all sites (3,000+), otherwise top 500
 *   for each selector:
 *     username / email → Maigret → verify → shadow_profiles + services
 *     email            → also breach lookup by email
 *     phone            → breach lookup by phone
 *   then: link breaches → recalculate score → found_count → completed
 */
import supabase from "./supabase.js";
import { executeMaigretScan, extractEmailPrefix, type MaigretScanOptions } from "./scanner.js";
import { getScanOptions } from "./plans.js";
import {
  mapClaimedProfiles,
  upsertShadowProfiles,
  updateSelectorTimestamp,
  lookupBreachesByEmail,
  lookupBreachesByPhone,
  upsertDiscoveredServices,
} from "./ingestion.js";
import { linkBreaches, updateSecurityScore } from "./scoring.js";
import { verifyProfiles, buildIdentity, type UserIdentity } from "./verification.js";
import {
  markScanStarted,
  updateScanStep,
  markScanFailed,
  updateScanFoundCount,
  type ScanStep,
  type SelectorPosition,
} from "./scan-progress.js";

/** A row from user_selectors (or an equivalent built in memory). */
export interface UserSelector {
  id?: string;
  user_id: string;
  selector_type: string;
  selector_value: string;
}

export interface ScanOutcome {
  score: number;
  succeeded: number;
  failed: number;
}

/** Fetch the user's identity (name, email) used to verify profile pages. */
export async function loadIdentity(userId: string): Promise<UserIdentity> {
  const { data } = await supabase.auth.admin.getUserById(userId);
  const email = data?.user?.email;
  const prefix = email ? extractEmailPrefix(email) : "";
  return buildIdentity(prefix, email, data?.user?.user_metadata);
}

/** Create a shadow_scans row for a user-owned scan. Returns undefined on failure. */
export async function createScanRow(userId: string): Promise<string | undefined> {
  const { data, error } = await supabase
    .from("shadow_scans")
    .insert({ user_id: userId, status: "starting" })
    .select("id")
    .single();

  if (error) {
    console.warn(`[pipeline] Could not create shadow_scans row for ${userId}:`, error.message);
    return undefined;
  }
  return data.id as string;
}

/** Progress message while Maigret runs, matching how many sites are checked. */
export function maigretStepMessage(options: MaigretScanOptions): string {
  return options.allSites
    ? "Deep scan: checking 3,000+ sites for your accounts…"
    : "Scanning 500 sites for your accounts…";
}

/** Maigret → verify → store, for one username. */
async function scanUsername(
  username: string,
  selector: UserSelector,
  ctx: SelectorContext
): Promise<void> {
  const { identity, step, scanId, scanOptions } = ctx;
  await step("maigret_scan", maigretStepMessage(scanOptions));
  const results = await executeMaigretScan(username, scanOptions);
  await step("verification");
  const verified = await verifyProfiles(results, identity);
  const records = mapClaimedProfiles(selector.user_id, verified, scanId, selector.id);
  await step("ingestion");
  await upsertShadowProfiles(records);
  await step("services");
  await upsertDiscoveredServices(selector.user_id, verified);
}

/**
 * Run one selector through the pipeline.
 * Returns the number of phone breaches found (only non-zero for phone selectors),
 * which feeds into the score.
 */
interface SelectorContext {
  identity: UserIdentity;
  scanOptions: MaigretScanOptions;
  step: (s: ScanStep, message?: string) => Promise<void>;
  scanId?: string | undefined;
}

async function processSelector(
  selector: UserSelector,
  identity: UserIdentity,
  scanOptions: MaigretScanOptions,
  scanId?: string,
  position?: SelectorPosition
): Promise<number> {
  const { selector_type: type, selector_value: value, user_id: userId } = selector;
  const step = async (s: ScanStep, message?: string) => {
    if (scanId) await updateScanStep(scanId, s, position, message);
  };
  const ctx: SelectorContext = { identity, scanOptions, step, scanId };

  console.log(`[pipeline] Processing ${type} selector "${value}" (user ${userId})`);
  let phoneBreaches = 0;

  switch (type) {
    case "email":
      await scanUsername(extractEmailPrefix(value), selector, ctx);
      await step("breach_lookup");
      await lookupBreachesByEmail(userId, value);
      break;

    case "phone":
      await step("breach_lookup");
      phoneBreaches = await lookupBreachesByPhone(userId, value);
      break;

    case "username":
      await scanUsername(value, selector, ctx);
      break;

    default:
      console.warn(`[pipeline] Unknown selector type "${type}"; treating it as a username.`);
      await scanUsername(value, selector, ctx);
  }

  if (selector.id) await updateSelectorTimestamp(selector.id);
  return phoneBreaches;
}

/**
 * Scan every selector for one user, then score and finish the scan row.
 *
 * Each selector fails independently. The scan is marked "failed" only if every
 * selector failed; otherwise it is "completed" with whatever was found.
 * Never throws for selector errors; reports them through `onSelectorError`.
 */
export async function runUserScan(
  userId: string,
  selectors: UserSelector[],
  opts: {
    scanId?: string | undefined;
    onSelectorError?: ((selector: UserSelector, err: unknown) => void) | undefined;
  } = {}
): Promise<ScanOutcome> {
  const { scanId } = opts;
  if (scanId) await markScanStarted(scanId);

  const [identity, scanOptions] = await Promise.all([loadIdentity(userId), getScanOptions(userId)]);
  let phoneBreaches = 0;
  let succeeded = 0;
  let lastError: unknown;

  for (const [index, selector] of selectors.entries()) {
    try {
      phoneBreaches += await processSelector(selector, identity, scanOptions, scanId, {
        index,
        total: selectors.length,
      });
      succeeded++;
    } catch (err) {
      lastError = err;
      console.error(`[pipeline] Selector "${selector.selector_value}" failed:`, err);
      opts.onSelectorError?.(selector, err);
    }
  }

  const failed = selectors.length - succeeded;

  if (succeeded === 0 && selectors.length > 0) {
    const reason = lastError instanceof Error ? lastError.message : String(lastError);
    if (scanId) await markScanFailed(scanId, reason);
    return { score: 0, succeeded, failed };
  }

  if (scanId) await updateScanStep(scanId, "scoring");
  await linkBreaches(userId);
  const score = await updateSecurityScore(userId, phoneBreaches);

  if (scanId) {
    const { count } = await supabase
      .from("shadow_profiles")
      .select("*", { count: "exact", head: true })
      .eq("user_id", userId);
    await updateScanFoundCount(scanId, count ?? 0);
    await updateScanStep(scanId, "completed");
  }

  console.log(`[pipeline] ✅ User ${userId}: ${succeeded}/${selectors.length} selector(s) ok. Score: ${score}`);
  return { score, succeeded, failed };
}
