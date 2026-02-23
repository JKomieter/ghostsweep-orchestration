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
  scan_id?: string;
  selector_id?: number | string;
}

/**
 * Filter scan results for "claimed" accounts and map to shadow_profiles records.
 */
export function mapClaimedProfiles(
  userId: string,
  results: MaigretSiteResult[],
  scanId?: string,
  selectorId?: number | string
): ShadowProfileRecord[] {
  const now = new Date().toISOString();

  return results
    .filter((r) => r.status === "claimed")
    .map((r) => {
      const record: ShadowProfileRecord = {
        user_id: userId,
        site_name: r.siteName,
        profile_url: r.url,
        last_verified_at: now,
      };
      if (scanId) record.scan_id = scanId;
      if (selectorId !== undefined) record.selector_id = selectorId;
      return record;
    });
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

/**
 * Extract the domain from a profile URL.
 * e.g. "https://github.com/joelk" → "github.com"
 */
function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/**
 * Map Maigret tags to the services.category enum.
 */
function mapCategory(siteName: string, tags: string[]): string {
  const name = siteName.toLowerCase();
  const allTags = tags.map((t) => t.toLowerCase());

  if (allTags.includes("social") || name.includes("facebook") || name.includes("twitter") || name.includes("instagram") || name.includes("linkedin") || name.includes("snapchat") || name.includes("pinterest") || name.includes("mastodon") || name.includes("bluesky") || name.includes("threads"))
    return "Social Media";
  if (allTags.includes("video") || allTags.includes("streaming") || allTags.includes("music") || name.includes("youtube") || name.includes("tiktok") || name.includes("twitch") || name.includes("netflix") || name.includes("spotify") || name.includes("hulu") || name.includes("disney") || name.includes("vimeo") || name.includes("soundcloud"))
    return "Streaming & Entertainment";
  if (allTags.includes("shopping") || allTags.includes("marketplace") || allTags.includes("ecommerce") || name.includes("amazon") || name.includes("ebay") || name.includes("etsy") || name.includes("shopify") || name.includes("aliexpress") || name.includes("walmart"))
    return "Shopping & E-commerce";
  if (allTags.includes("finance") || allTags.includes("crypto") || allTags.includes("trading") || allTags.includes("banking") || name.includes("paypal") || name.includes("venmo") || name.includes("cashapp") || name.includes("coinbase") || name.includes("robinhood") || name.includes("stripe") || name.includes("revolut"))
    return "Financial & Payments";
  if (allTags.includes("productivity") || allTags.includes("work") || allTags.includes("business") || allTags.includes("coding") || allTags.includes("tech") || name.includes("github") || name.includes("gitlab") || name.includes("slack") || name.includes("notion") || name.includes("trello") || name.includes("asana") || name.includes("jira") || name.includes("zoom") || name.includes("dropbox") || name.includes("figma"))
    return "Productivity & Work";
  if (allTags.includes("travel") || allTags.includes("transportation") || name.includes("airbnb") || name.includes("booking") || name.includes("uber") || name.includes("lyft") || name.includes("expedia") || name.includes("tripadvisor") || name.includes("kayak") || name.includes("flixbus"))
    return "Travel & Transportation";
  if (allTags.includes("food") || allTags.includes("delivery") || allTags.includes("restaurant") || name.includes("doordash") || name.includes("ubereats") || name.includes("grubhub") || name.includes("instacart") || name.includes("yelp") || name.includes("opentable"))
    return "Food & Delivery";
  if (allTags.includes("gaming") || allTags.includes("game") || name.includes("steam") || name.includes("roblox") || name.includes("xbox") || name.includes("playstation") || name.includes("nintendo") || name.includes("epicgames") || name.includes("battlenet") || name.includes("riot"))
    return "Gaming";
  if (allTags.includes("health") || allTags.includes("fitness") || allTags.includes("medical") || name.includes("strava") || name.includes("fitbit") || name.includes("myfitnesspal") || name.includes("peloton") || name.includes("headspace") || name.includes("calm"))
    return "Health & Fitness";
  if (allTags.includes("news") || allTags.includes("media") || allTags.includes("blog") || name.includes("medium") || name.includes("reddit") || name.includes("digg") || name.includes("buzzfeed") || name.includes("huffpost") || name.includes("nytimes") || name.includes("bbc"))
    return "News & Media";
  if (allTags.includes("email") || allTags.includes("communication") || allTags.includes("messaging") || name.includes("gmail") || name.includes("outlook") || name.includes("yahoo") || name.includes("proton") || name.includes("discord") || name.includes("telegram") || name.includes("whatsapp") || name.includes("signal") || name.includes("skype"))
    return "Email & Communication";
  if (allTags.includes("newsletter") || name.includes("substack") || name.includes("mailchimp") || name.includes("beehiiv") || name.includes("convertkit") || name.includes("buttondown"))
    return "Newsletter";
  return "Other";
}

/**
 * After discovering profiles, upsert the corresponding sites into
 * public.services and link them to the user via public.user_services.
 *
 * - services: upsert by domain (unique constraint)
 * - user_services: upsert by (user_id, service_id) with source = 'shadow_scan'
 */
export async function upsertDiscoveredServices(
  userId: string,
  results: MaigretSiteResult[]
): Promise<void> {
  const claimed = results.filter((r) => r.status === "claimed");
  if (claimed.length === 0) return;

  // Deduplicate by domain
  const domainMap = new Map<string, { siteName: string; domain: string; tags: string[] }>();
  for (const r of claimed) {
    const domain = extractDomain(r.url);
    if (!domain) continue;
    if (!domainMap.has(domain)) {
      domainMap.set(domain, { siteName: r.siteName, domain, tags: r.tags });
    }
  }

  const sites = [...domainMap.values()];
  if (sites.length === 0) return;

  console.log(`[ingestion] Upserting ${sites.length} discovered service(s)...`);

  // 1. Upsert each service by domain
  const serviceRows = sites.map((s) => ({
    name: s.siteName,
    domain: s.domain,
    category: mapCategory(s.siteName, s.tags),
  }));

  const { data: upsertedServices, error: svcErr } = await supabase
    .from("services")
    .upsert(serviceRows, { onConflict: "domain", ignoreDuplicates: false })
    .select("id, domain");

  if (svcErr) {
    console.error("[ingestion] Service upsert error:", svcErr.message);
    // Fallback: fetch existing services by domain
  }

  // 2. Build a domain → service_id map
  // Fetch all services for our domains (handles both upserted and pre-existing)
  const domains = sites.map((s) => s.domain);
  const { data: allServices, error: fetchErr } = await supabase
    .from("services")
    .select("id, domain")
    .in("domain", domains);

  if (fetchErr || !allServices) {
    console.error("[ingestion] Failed to fetch service IDs:", fetchErr?.message);
    return;
  }

  const domainToServiceId = new Map<string, string>();
  for (const svc of allServices) {
    domainToServiceId.set(svc.domain as string, svc.id as string);
  }

  // 3. Upsert user_services links
  const now = new Date().toISOString();
  const userServiceRows: Array<{
    user_id: string;
    service_id: string;
    source: string;
    first_seen_at: string;
    last_seen_at: string;
    is_account: boolean;
    status: string;
  }> = [];

  for (const site of sites) {
    const serviceId = domainToServiceId.get(site.domain);
    if (!serviceId) continue;

    userServiceRows.push({
      user_id: userId,
      service_id: serviceId,
      source: "shadow_scan",
      first_seen_at: now,
      last_seen_at: now,
      is_account: true,
      status: "active",
    });
  }

  if (userServiceRows.length === 0) return;

  // Deduplicate by (user_id, service_id)
  const seen = new Set<string>();
  const uniqueUserServices = userServiceRows.filter((r) => {
    const key = `${r.user_id}::${r.service_id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const { error: usErr } = await supabase
    .from("user_services")
    .upsert(uniqueUserServices, { onConflict: "user_id, service_id" });

  if (usErr) {
    console.error("[ingestion] user_services upsert error:", usErr.message);
    return;
  }

  console.log(`[ingestion] Linked ${uniqueUserServices.length} service(s) to user ${userId}.`);
}
