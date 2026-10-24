/**
 * Weekly Maigret OSINT report data.
 *
 * Lists the public profiles Maigret has found for a user and highlights the
 * ones that are new since their last weekly report (diffed against a
 * pre-scan snapshot, since shadow_profiles has no created_at).
 */
import supabase from "./supabase.js";
import { extractEmailPrefix } from "./scanner.js";

export interface WeeklyProfile {
  siteName: string;
  url: string;
  isNew: boolean;
}

export interface WeeklyReportData {
  to: string;
  firstName: string;
  plan: string;
  since: string;
  /** Usernames Maigret searched (email selectors reduced to their local part). */
  usernames: string[];
  /** All public profiles, new ones first. */
  profiles: WeeklyProfile[];
  newProfileCount: number;
}

/** Fetch the set of non-teaser shadow profile URLs for a user. */
export async function snapshotProfileUrls(userId: string): Promise<Set<string>> {
  const { data } = await supabase
    .from("shadow_profiles")
    .select("profile_url")
    .eq("user_id", userId)
    .or("is_teaser.is.null,is_teaser.eq.false");

  return new Set((data ?? []).map((r) => r.profile_url as string));
}

/** Start of the reporting window: last weekly report, or 7 days ago. */
export async function getReportWindowStart(userId: string): Promise<string> {
  const { data } = await supabase
    .from("user_subscriptions")
    .select("last_weekly_report")
    .eq("user_id", userId)
    .maybeSingle();

  return data?.last_weekly_report ?? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
}

export async function markWeeklyReportSent(userId: string): Promise<void> {
  const { error } = await supabase
    .from("user_subscriptions")
    .update({ last_weekly_report: new Date().toISOString() })
    .eq("user_id", userId);

  if (error) console.warn("[weekly-report] Could not update last_weekly_report:", error.message);
}

export async function fetchWeeklyReportData(
  userId: string,
  opts: {
    since: string;
    profilesBefore: Set<string>;
  }
): Promise<WeeklyReportData | null> {
  const { since, profilesBefore } = opts;

  const { data: authUser } = await supabase.auth.admin.getUserById(userId);
  const to = authUser?.user?.email;
  if (!to) return null;

  const meta = authUser.user?.user_metadata;
  const firstName = meta?.first_name ?? meta?.full_name?.split(" ")[0] ?? meta?.name?.split(" ")[0] ?? "there";

  const [{ data: subRow }, { data: selectorRows }, { data: profileRows }] = await Promise.all([
    supabase.from("user_subscriptions").select("current_plan").eq("user_id", userId).maybeSingle(),
    supabase
      .from("user_selectors")
      .select("selector_type, selector_value")
      .eq("user_id", userId)
      .neq("selector_type", "phone"),
    supabase
      .from("shadow_profiles")
      .select("site_name, profile_url")
      .eq("user_id", userId)
      .or("is_teaser.is.null,is_teaser.eq.false")
      .order("site_name"),
  ]);

  const usernames = [
    ...new Set(
      (selectorRows ?? []).map((s) =>
        s.selector_type === "email" ? extractEmailPrefix(s.selector_value as string) : (s.selector_value as string)
      )
    ),
  ];

  const profiles: WeeklyProfile[] = (profileRows ?? [])
    .map((p) => ({
      siteName: p.site_name as string,
      url: p.profile_url as string,
      isNew: !profilesBefore.has(p.profile_url as string),
    }))
    .sort((a, b) => Number(b.isNew) - Number(a.isNew));

  return {
    to,
    firstName,
    plan: subRow?.current_plan ?? "free",
    since,
    usernames,
    profiles,
    newProfileCount: profiles.filter((p) => p.isNew).length,
  };
}
