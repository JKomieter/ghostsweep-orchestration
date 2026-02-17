/**
 * Post-scan profile verification.
 *
 * After Maigret finds "claimed" profiles, this module fetches each profile
 * page and checks whether the page content actually matches the user's
 * known identity signals (names, email prefix, etc.).
 *
 * Each profile gets a confidence level:
 *   - high   → multiple identity signals match (name + username in page)
 *   - medium → at least one signal matches
 *   - low    → no signals matched (likely a different person with the same username)
 *
 * Only profiles at or above the configured threshold are kept.
 */

import type { MaigretSiteResult } from "./scanner.js";

/** Known identity signals for the user being scanned. */
export interface UserIdentity {
  /** All known names: full name, first, last, combined variants */
  names: string[];
  /** The email prefix (local-part) used as the scan username */
  emailPrefix: string;
  /** Full email address (optional) */
  email?: string | undefined;
}

export type ConfidenceLevel = "high" | "medium" | "low";

export interface VerifiedProfile extends MaigretSiteResult {
  confidence: ConfidenceLevel;
  matchedSignals: string[];
}

/** Minimum confidence required to keep a profile. */
const MIN_CONFIDENCE: ConfidenceLevel = "medium";

const CONFIDENCE_RANK: Record<ConfidenceLevel, number> = {
  high: 3,
  medium: 2,
  low: 1,
};

/**
 * Sites that are known to include the searched username in every profile
 * page URL/title regardless of ownership. These get a free pass to
 * "medium" if the page exists at all, since Maigret already confirmed
 * the profile is "claimed".
 */
const HIGH_TRUST_SITES = new Set([
  "github",
  "gitlab",
  "linkedin",
  "twitter",
  "x",
  "instagram",
  "facebook",
  "reddit",
  "tiktok",
  "youtube",
  "pinterest",
  "medium",
  "dev.to",
  "stackoverflow",
  "hackernews",
  "keybase",
]);

/**
 * Fetch the HTML content of a profile URL with a timeout.
 * Returns null if the fetch fails or times out.
 */
async function fetchPage(url: string): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);

    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml",
      },
      redirect: "follow",
    });

    clearTimeout(timeout);

    if (!res.ok) return null;

    // Only read the first 100KB to avoid downloading huge pages
    const reader = res.body?.getReader();
    if (!reader) return null;

    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    const MAX_BYTES = 100_000;

    while (totalBytes < MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      totalBytes += value.length;
    }

    reader.cancel().catch(() => {});
    return new TextDecoder().decode(Buffer.concat(chunks));
  } catch {
    return null;
  }
}

/**
 * Strip HTML tags and collapse whitespace for text matching.
 */
function stripHtml(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

/**
 * Check how many identity signals appear in the page text.
 */
function matchSignals(
  pageText: string,
  identity: UserIdentity
): { matched: string[]; confidence: ConfidenceLevel } {
  const matched: string[] = [];

  // Check each known name
  for (const name of identity.names) {
    if (name.length >= 3 && pageText.includes(name.toLowerCase())) {
      matched.push(`name:"${name}"`);
    }
  }

  // Check email prefix (only if it's reasonably unique — 4+ chars)
  if (identity.emailPrefix.length >= 4 && pageText.includes(identity.emailPrefix.toLowerCase())) {
    matched.push(`prefix:"${identity.emailPrefix}"`);
  }

  // Check full email
  if (identity.email && pageText.includes(identity.email.toLowerCase())) {
    matched.push(`email:"${identity.email}"`);
  }

  let confidence: ConfidenceLevel;
  if (matched.length >= 2) {
    confidence = "high";
  } else if (matched.length === 1) {
    confidence = "medium";
  } else {
    confidence = "low";
  }

  return { matched, confidence };
}

/**
 * Verify a batch of claimed Maigret results against the user's known identity.
 *
 * Fetches each profile page (with concurrency limit) and checks for
 * identity signals in the page content.
 *
 * Returns only profiles that meet the minimum confidence threshold.
 */
export async function verifyProfiles(
  results: MaigretSiteResult[],
  identity: UserIdentity
): Promise<VerifiedProfile[]> {
  const claimed = results.filter((r) => r.status === "claimed");

  if (claimed.length === 0) return [];

  console.log(`[verify] Verifying ${claimed.length} claimed profiles against user identity...`);

  // Process in batches of 5 to avoid overwhelming targets
  const BATCH_SIZE = 5;
  const verified: VerifiedProfile[] = [];

  for (let i = 0; i < claimed.length; i += BATCH_SIZE) {
    const batch = claimed.slice(i, i + BATCH_SIZE);

    const batchResults = await Promise.all(
      batch.map(async (profile): Promise<VerifiedProfile> => {
        const siteKey = profile.siteName.toLowerCase().replace(/\s+/g, "");

        // High-trust sites: if Maigret says "claimed", give at least medium
        const isHighTrust = HIGH_TRUST_SITES.has(siteKey);

        const html = await fetchPage(profile.url);

        if (!html) {
          // Couldn't fetch — trust Maigret for high-trust sites, otherwise low
          return {
            ...profile,
            confidence: isHighTrust ? "medium" : "low",
            matchedSignals: isHighTrust ? ["high-trust-site"] : ["fetch-failed"],
          };
        }

        const pageText = stripHtml(html);
        const { matched, confidence } = matchSignals(pageText, identity);

        // Boost high-trust sites to at least medium
        const finalConfidence: ConfidenceLevel =
          isHighTrust && CONFIDENCE_RANK[confidence] < CONFIDENCE_RANK["medium"]
            ? "medium"
            : confidence;

        if (isHighTrust && matched.length === 0) {
          matched.push("high-trust-site");
        }

        return {
          ...profile,
          confidence: finalConfidence,
          matchedSignals: matched,
        };
      })
    );

    verified.push(...batchResults);
  }

  // Filter by minimum confidence
  const minRank = CONFIDENCE_RANK[MIN_CONFIDENCE];
  const kept = verified.filter((v) => CONFIDENCE_RANK[v.confidence] >= minRank);
  const dropped = verified.length - kept.length;

  console.log(
    `[verify] Results: ${kept.length} verified (${verified.filter((v) => v.confidence === "high").length} high, ` +
    `${verified.filter((v) => v.confidence === "medium").length} medium), ` +
    `${dropped} dropped as low-confidence`
  );

  return kept;
}

/**
 * Build a UserIdentity from Supabase auth user metadata.
 */
export function buildIdentity(
  emailPrefix: string,
  email?: string,
  metadata?: Record<string, unknown>
): UserIdentity {
  const names: string[] = [];

  if (metadata) {
    const fullName = metadata.full_name as string | undefined;
    const name = metadata.name as string | undefined;
    const firstName = metadata.first_name as string | undefined;
    const lastName = metadata.last_name as string | undefined;

    if (fullName) {
      names.push(fullName.trim().toLowerCase());
      // Also add without spaces for matching "joelkomieter" style
      names.push(fullName.trim().toLowerCase().replace(/\s+/g, ""));
    }
    if (name && name !== fullName) {
      names.push(name.trim().toLowerCase());
      names.push(name.trim().toLowerCase().replace(/\s+/g, ""));
    }
    if (firstName) names.push(firstName.trim().toLowerCase());
    if (lastName) names.push(lastName.trim().toLowerCase());
    if (firstName && lastName) {
      const first = firstName.trim().toLowerCase();
      const last = lastName.trim().toLowerCase();
      names.push(`${first} ${last}`);
      names.push(`${first}${last}`);
    }
  }

  // Deduplicate
  const uniqueNames = [...new Set(names.filter(Boolean))];

  return {
    names: uniqueNames,
    emailPrefix,
    email,
  };
}
