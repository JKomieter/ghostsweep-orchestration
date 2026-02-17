import supabase from "./supabase.js";
import type { MaigretSiteResult } from "./scanner.js";

/**
 * Shape of a record to upsert into public.shadow_profiles.
 */
interface ShadowProfileRecord {
  user_id: string;
  site_name: string;
  profile_url: string;
  last_verified_at: string;
}

/**
 * Filter scan results for "claimed" accounts and map to shadow_profiles records.
 */
export function mapClaimedProfiles(
  userId: string,
  results: MaigretSiteResult[]
): ShadowProfileRecord[] {
  const now = new Date().toISOString();

  return results
    .filter((r) => r.status === "claimed")
    .map((r) => ({
      user_id: userId,
      site_name: r.siteName,
      profile_url: r.url,
      last_verified_at: now,
    }));
}

/**
 * Upsert discovered profiles into public.shadow_profiles.
 * Uses the unique_user_profile constraint (user_id, profile_url).
 * Returns the upserted data.
 */
export async function upsertShadowProfiles(
  records: ShadowProfileRecord[]
): Promise<ShadowProfileRecord[]> {
  if (records.length === 0) {
    console.log("[ingestion] No claimed profiles to upsert.");
    return [];
  }

  // Deduplicate by (user_id, profile_url) to avoid
  // "ON CONFLICT DO UPDATE command cannot affect row a second time"
  const seen = new Set<string>();
  const unique = records.filter((r) => {
    const key = `${r.user_id}::${r.profile_url}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  console.log(`[ingestion] Upserting ${unique.length} shadow profiles (${records.length - unique.length} duplicates removed)...`);

  const { data, error } = await supabase
    .from("shadow_profiles")
    .upsert(unique, { onConflict: "user_id, profile_url" })
    .select();

  if (error) {
    console.error("[ingestion] Upsert error:", error.message);
    throw error;
  }

  console.log(`[ingestion] Successfully upserted ${data?.length ?? 0} rows.`);
  return (data as ShadowProfileRecord[]) ?? [];
}

/**
 * Update the last_scanned_at timestamp on the user_selector that was just processed.
 */
export async function updateSelectorTimestamp(
  selectorId: string
): Promise<void> {
  const now = new Date().toISOString();

  const { error } = await supabase
    .from("user_selectors")
    .update({ last_scanned_at: now })
    .eq("id", selectorId);

  if (error) {
    console.error("[ingestion] Failed to update selector timestamp:", error.message);
    throw error;
  }

  console.log(`[ingestion] Updated last_scanned_at for selector ${selectorId}.`);
}

/**
 * Look up breaches in user_breaches that match a full email address.
 * Returns the count of matching breach records found.
 */
export async function lookupBreachesByEmail(
  userId: string,
  email: string
): Promise<number> {
  console.log(`[ingestion] Looking up breaches for email: ${email}...`);

  const { data, error } = await supabase
    .from("user_breaches")
    .select("id")
    .eq("user_id", userId)
    .eq("email", email);

  if (error) {
    console.error("[ingestion] Email breach lookup error:", error.message);
    throw error;
  }

  const count = data?.length ?? 0;
  console.log(`[ingestion] Found ${count} breach(es) matching email "${email}".`);
  return count;
}

/**
 * Look up breaches in user_breaches that match a phone number.
 * Returns the count of matching breach records found.
 */
export async function lookupBreachesByPhone(
  userId: string,
  phone: string
): Promise<number> {
  console.log(`[ingestion] Looking up breaches for phone: ${phone}...`);

  // user_breaches has no dedicated phone column.
  // Search for the phone string appearing in breach records via email or service linkage.
  const { data, error } = await supabase
    .from("user_breaches")
    .select("id")
    .eq("user_id", userId)
    .ilike("email", `%${phone}%`);

  if (error) {
    console.error("[ingestion] Phone breach lookup error:", error.message);
    throw error;
  }

  const count = data?.length ?? 0;
  console.log(`[ingestion] Found ${count} breach(es) matching phone "${phone}".`);
  return count;
}
