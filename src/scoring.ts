import supabase from "./supabase.js";

/**
 * Extract the domain from a URL string.
 * e.g. "https://twitter.com/johndoe" → "twitter.com"
 */
function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/**
 * Cross-reference discovered shadow profile URLs against known breaches.
 *
 * For each shadow profile, extract the domain and check if there's a matching
 * service in user_breaches (via service_id → services.domain).
 * If a match is found, insert a link into shadow_profile_breaches.
 *
 * Returns the number of breach links created.
 */
export async function linkBreaches(userId: string): Promise<number> {
  console.log(`[scoring] Linking breaches for user ${userId}...`);

  // 1. Fetch the user's shadow profiles
  const { data: profiles, error: profileErr } = await supabase
    .from("shadow_profiles")
    .select("id, profile_url")
    .eq("user_id", userId);

  if (profileErr) {
    console.error("[scoring] Error fetching shadow_profiles:", profileErr.message);
    throw profileErr;
  }

  if (!profiles || profiles.length === 0) {
    console.log("[scoring] No shadow profiles to link.");
    return 0;
  }

  // 2. Fetch the user's known breaches with their associated service domain
  const { data: breaches, error: breachErr } = await supabase
    .from("user_breaches")
    .select("id, service_id, services ( domain )")
    .eq("user_id", userId);

  if (breachErr) {
    console.error("[scoring] Error fetching user_breaches:", breachErr.message);
    throw breachErr;
  }

  if (!breaches || breaches.length === 0) {
    console.log("[scoring] No user breaches to cross-reference.");
    return 0;
  }

  // Build a map: domain → breach record(s)
  const domainToBreaches = new Map<string, Array<{ breach_id: string; service_id: string }>>();
  for (const b of breaches) {
    const service = b.services as { domain?: string } | null;
    const domain = service?.domain?.replace(/^www\./, "") ?? "";
    if (!domain) continue;

    if (!domainToBreaches.has(domain)) {
      domainToBreaches.set(domain, []);
    }
    domainToBreaches.get(domain)!.push({
      breach_id: b.id as string,
      service_id: b.service_id as string,
    });
  }

  // 3. Match shadow profiles to breaches by domain
  const links: Array<{
    shadow_profile_id: number;
    breach_id: string;
    user_id: string;
  }> = [];

  for (const profile of profiles) {
    const domain = extractDomain(profile.profile_url as string);
    const matched = domainToBreaches.get(domain);
    if (matched) {
      for (const m of matched) {
        links.push({
          shadow_profile_id: profile.id as number,
          breach_id: m.breach_id,
          user_id: userId,
        });
      }
    }
  }

  if (links.length === 0) {
    console.log("[scoring] No breach-profile matches found.");
    return 0;
  }

  // 4. Upsert breach links to avoid duplicates
  const { error: insertErr } = await supabase
    .from("shadow_profile_breaches")
    .upsert(links, { onConflict: "shadow_profile_id, breach_id" });

  if (insertErr) {
    console.error("[scoring] Error inserting breach links:", insertErr.message);
    throw insertErr;
  }

  console.log(`[scoring] Linked ${links.length} breach-profile matches.`);
  return links.length;
}

/**
 * Risk weights for the vulnerability score formula.
 *
 * Phone breaches carry the highest weight because leaked phone numbers
 * enable SIM-swapping attacks, which can bypass 2FA and compromise
 * every account linked to that number.
 */
const RISK_WEIGHTS = {
  SHADOW_PROFILE: 2,
  BREACH_LINK: 10,
  PHONE_BREACH: 25, // highest — SIM-swap risk
} as const;

/**
 * Recalculate and upsert the user's vulnerability score.
 *
 * Formula:
 *   (Shadow Profiles × 2) + (Linked Breaches × 10) + (Phone Breaches × 25)
 *
 * Phone breaches receive the highest penalty because leaked phone numbers
 * are high-risk vectors for SIM-swapping and 2FA bypass.
 *
 * @param phoneBreach - Number of phone-related breach matches found in this cycle (default 0).
 */
export async function updateSecurityScore(
  userId: string,
  phoneBreach = 0
): Promise<number> {
  console.log(`[scoring] Recalculating security score for user ${userId}...`);

  // Count shadow profiles
  const { count: profileCount, error: pcErr } = await supabase
    .from("shadow_profiles")
    .select("*", { count: "exact", head: true })
    .eq("user_id", userId);

  if (pcErr) {
    console.error("[scoring] Error counting profiles:", pcErr.message);
    throw pcErr;
  }

  // Count linked breaches
  const { count: breachCount, error: bcErr } = await supabase
    .from("shadow_profile_breaches")
    .select("*", { count: "exact", head: true })
    .eq("user_id", userId);

  if (bcErr) {
    console.error("[scoring] Error counting breach links:", bcErr.message);
    throw bcErr;
  }

  const totalProfiles = profileCount ?? 0;
  const totalBreaches = breachCount ?? 0;
  const vulnerabilityScore =
    totalProfiles * RISK_WEIGHTS.SHADOW_PROFILE +
    totalBreaches * RISK_WEIGHTS.BREACH_LINK +
    phoneBreach * RISK_WEIGHTS.PHONE_BREACH;

  console.log(
    `[scoring] Profiles: ${totalProfiles}, Breach links: ${totalBreaches}, Phone breaches: ${phoneBreach}, Score: ${vulnerabilityScore}`
  );

  const { error: upsertErr } = await supabase
    .from("user_security_scores")
    .upsert(
      {
        user_id: userId,
        vulnerability_score: vulnerabilityScore,
        score: vulnerabilityScore,
        last_calculated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" }
    );

  if (upsertErr) {
    console.error("[scoring] Error upserting security score:", upsertErr.message);
    throw upsertErr;
  }

  console.log(`[scoring] Security score updated to ${vulnerabilityScore}.`);
  return vulnerabilityScore;
}
