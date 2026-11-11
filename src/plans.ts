/**
 * Subscription plans and what each one gets from a scan.
 *
 * The plan comes from user_subscriptions.current_plan. Anything that isn't a
 * paid plan (including no row at all) is treated as free.
 */
import supabase from "./supabase.js";
import type { MaigretScanOptions } from "./scanner.js";

/** Plans that get the full all-sites Maigret scan. */
export const PAID_PLANS = new Set(["pro", "buster"]);

export async function getUserPlan(userId: string): Promise<string> {
  const { data, error } = await supabase
    .from("user_subscriptions")
    .select("current_plan")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    // Fall back to the cheaper scan rather than failing the whole scan.
    console.warn(`[plans] Could not read plan for ${userId}, using free:`, error.message);
    return "free";
  }
  return (data?.current_plan as string | null) ?? "free";
}

/**
 * Maigret options for a user: paid plans scan every site Maigret knows
 * (3,000+), free plans scan the top 500.
 */
export async function getScanOptions(userId: string): Promise<MaigretScanOptions> {
  const plan = await getUserPlan(userId);
  const allSites = PAID_PLANS.has(plan);
  console.log(`[plans] User ${userId} is on "${plan}" → ${allSites ? "all sites" : "top 500 sites"}.`);
  return allSites ? { allSites: true } : {};
}
