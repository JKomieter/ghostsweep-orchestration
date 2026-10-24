import { Resend } from "resend";
import type { WeeklyReportData } from "./weekly-report.js";

const resend = new Resend(process.env.RESEND_API_KEY);

// ── Light theme ─────────────────────────────────────────────────────

const C = {
  page: "#f4f5f7",
  card: "#ffffff",
  panel: "#f9fafb",
  border: "#e5e7eb",
  heading: "#111827",
  text: "#374151",
  muted: "#6b7280",
  faint: "#9ca3af",
  accent: "#0d9488", // teal readable on white
  brand: "#00f2de", // button fill (black text)
  red: "#dc2626",
  orange: "#ea580c",
  yellow: "#ca8a04",
  green: "#059669",
} as const;

const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const LOGO_URL = "https://ghostsweep.t3.storage.dev/ghost-svgrepo-com.png";

/** Escape user/scan-provided text before interpolating into HTML. */
function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Shared email shell: page background, white card, logo, signature and footer.
 * `color-scheme: light` asks clients not to auto-invert into dark mode.
 */
function emailShell(opts: { title: string; body: string; footerNote: string; to: string }): string {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="color-scheme" content="light" />
    <meta name="supported-color-schemes" content="light" />
    <title>${esc(opts.title)}</title>
    <style>:root { color-scheme: light; supported-color-schemes: light; }</style>
  </head>
  <body style="margin:0;padding:0;background-color:${C.page};color:${C.text};font-family:${FONT};">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color:${C.page};padding:40px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"
            style="max-width:560px;background:${C.card};border:1px solid ${C.border};border-radius:12px;padding:40px;color:${C.text};">

            <!-- Logo -->
            <tr>
              <td style="padding-bottom:32px;">
                <img src="${LOGO_URL}" width="28" height="28" alt="GhostSweep" style="display:block;" />
              </td>
            </tr>

            ${opts.body}

            <!-- Signature -->
            <tr>
              <td style="padding-bottom:32px;font-size:15px;line-height:1.6;">
                <p style="margin:0;">
                  Stay safe,<br />
                  <span style="color:${C.heading};">Joel</span><br />
                  <span style="color:${C.muted};">Founder, GhostSweep</span>
                </p>
              </td>
            </tr>

            <!-- Footer -->
            <tr>
              <td style="border-top:1px solid ${C.border};padding-top:16px;text-align:center;">
                <p style="margin:0;font-size:12px;color:${C.faint};">
                  ${opts.footerNote}
                  <br>
                  <a href="https://ghostsweep.com/unsubscribe?email=${encodeURIComponent(opts.to)}" style="color:${C.faint};text-decoration:underline;">Unsubscribe</a>
                </p>
              </td>
            </tr>

          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function headline(text: string): string {
  return `
            <tr>
              <td style="padding-bottom:24px;">
                <h1 style="margin:0;font-size:22px;font-weight:700;color:${C.heading};line-height:1.3;">${text}</h1>
              </td>
            </tr>`;
}

function section(content: string): string {
  return `
            <tr>
              <td style="padding-bottom:28px;">${content}</td>
            </tr>`;
}

function sectionTitle(text: string): string {
  return `<h2 style="margin:0 0 16px;font-size:18px;font-weight:600;color:${C.heading};">${text}</h2>`;
}

function panel(content: string): string {
  return `<div style="background:${C.panel};border:1px solid ${C.border};border-radius:10px;padding:24px;">${content}</div>`;
}

function callout(color: string, content: string): string {
  return `<div style="background:${C.panel};border:1px solid ${C.border};border-left:4px solid ${color};border-radius:8px;padding:16px;font-size:14px;line-height:1.6;">${content}</div>`;
}

function ctaButton(href: string, label: string): string {
  return `
            <tr>
              <td align="center" style="padding-bottom:32px;">
                <a href="${href}" style="background:${C.brand};color:#000000;padding:14px 28px;text-decoration:none;border-radius:8px;font-weight:700;font-size:15px;display:inline-block;">${label}</a>
              </td>
            </tr>`;
}

/** Three-column table with header row; `rows` are already-escaped cell triples. */
function dataTable(headers: [string, string, string], rows: Array<[string, string, string]>, statusColor: string): string {
  const th = (h: string) =>
    `<th style="padding:10px 12px;font-size:12px;font-weight:600;color:${C.muted};text-align:left;text-transform:uppercase;letter-spacing:0.5px;border-bottom:1px solid ${C.border};">${h}</th>`;
  const body = rows
    .map(
      ([a, b, c]) => `
                    <tr>
                      <td style="padding:10px 12px;font-size:14px;color:${C.heading};border-bottom:1px solid ${C.border};">${a}</td>
                      <td style="padding:10px 12px;font-size:14px;color:${C.muted};border-bottom:1px solid ${C.border};">${b}</td>
                      <td style="padding:10px 12px;font-size:14px;color:${statusColor};border-bottom:1px solid ${C.border};">${c}</td>
                    </tr>`
    )
    .join("");

  return `<div style="border:1px solid ${C.border};border-radius:10px;overflow:hidden;">
                  <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
                    <tr style="background:${C.panel};">${headers.map(th).join("")}</tr>
                    ${body}
                  </table>
                </div>`;
}

/** Label/value rows inside a summary panel. */
function summaryRows(rows: Array<{ label: string; value: string }>): string {
  return `<table width="100%" cellpadding="0" cellspacing="0">${rows
    .map(
      (r, i) => `
                    <tr>
                      <td style="padding-bottom:${i === rows.length - 1 ? 0 : 14}px;font-size:14px;color:${C.text};line-height:1.6;">
                        <strong style="color:${C.heading};">${r.label}:</strong> ${r.value}
                      </td>
                    </tr>`
    )
    .join("")}</table>`;
}

// ── Scan Report Email (after an on-demand scan) ─────────────────────

/**
 * Data needed to populate the scan report email.
 */
export interface ScanReportEmailData {
  to: string;
  firstName: string;
  score: number;
  totalProfiles: number;
  breachCount: number;
  /** Top 3 discovered sites to show as teaser rows */
  topSites: Array<{
    siteName: string;
    category: string;
  }>;
}

/**
 * Categorize a site by its tags or name into a human-readable type.
 */
export function categorizeSite(siteName: string, tags: string[] = []): string {
  const name = siteName.toLowerCase();
  const allTags = tags.map((t) => t.toLowerCase());

  if (allTags.includes("trading") || allTags.includes("crypto") || name.includes("opensea") || name.includes("trading"))
    return "Financial / Crypto";
  if (allTags.includes("shopping") || name.includes("mercado") || name.includes("shop"))
    return "E-Commerce";
  if (allTags.includes("video") || name.includes("youtube") || name.includes("tiktok"))
    return "Video / Social";
  if (allTags.includes("photo") || name.includes("instagram") || name.includes("picuki") || name.includes("picsart"))
    return "Photo / Social";
  if (allTags.includes("networking") || name.includes("facebook") || name.includes("hi5"))
    return "Social Network";
  if (allTags.includes("gaming") || name.includes("roblox"))
    return "Gaming";
  if (allTags.includes("tech") || name.includes("kaggle") || name.includes("hashnode") || name.includes("github"))
    return "Tech / Developer";
  if (allTags.includes("forum") || allTags.includes("wiki"))
    return "Forum / Community";
  if (allTags.includes("art") || name.includes("behance") || name.includes("artstation"))
    return "Creative / Portfolio";
  if (allTags.includes("business") || name.includes("academia"))
    return "Professional";
  return "Online Platform";
}

/**
 * Get the risk level label and color based on score.
 */
function getRiskLevel(score: number): { label: string; emoji: string; color: string } {
  if (score >= 70) return { label: "Critical Risk", emoji: "🔴", color: C.red };
  if (score >= 40) return { label: "High Risk", emoji: "🟠", color: C.orange };
  if (score >= 20) return { label: "Moderate Risk", emoji: "🟡", color: C.yellow };
  return { label: "Low Risk", emoji: "🟢", color: C.green };
}

/**
 * Build the scan report HTML email.
 */
function buildScanReportHtml(data: ScanReportEmailData): string {
  const risk = getRiskLevel(data.score);

  const body = [
    headline("Your Identity Discovery Report is Ready"),
    `
            <tr>
              <td style="padding-bottom:24px;font-size:15px;line-height:1.6;">
                <p style="margin:0 0 16px;">Hello <strong style="color:${C.heading};">${esc(data.firstName)}</strong>,</p>
                <p style="margin:0 0 16px;">
                  Our engines have completed a deep scan of the public web for your digital <strong style="color:${C.heading};">"shadow."</strong> We searched <strong style="color:${C.heading};">3,000+ platforms</strong> to identify where your personal data is still active and vulnerable.
                </p>
              </td>
            </tr>`,
    section(
      panel(
        sectionTitle("📊 Scan Summary") +
          summaryRows([
            {
              label: "Identity Security Score",
              value: `<span style="color:${risk.color};font-weight:700;">${data.score}/100 (${risk.emoji} ${risk.label})</span>`,
            },
            { label: "Accounts Found", value: `<span style="color:${C.accent};font-weight:700;">${data.totalProfiles}</span>` },
            {
              label: "Data Breach Links",
              value: `<span style="color:${C.red};font-weight:700;">${data.breachCount} verified exposure${data.breachCount !== 1 ? "s" : ""}</span>`,
            },
          ])
      )
    ),
    section(
      sectionTitle("⚠️ Top Exposure Risks") +
        dataTable(
          ["Platform", "Discovery Type", "Status"],
          data.topSites.map((s) => [esc(s.siteName), esc(s.category), "⚠️ Redacted"]),
          C.orange
        )
    ),
    section(
      callout(
        C.red,
        `<strong style="color:${C.red};">Why is this a risk?</strong> Abandoned accounts are the #1 entry point for credential stuffing and identity theft. We found your information linked to breaches where clear-text passwords and home addresses were leaked.`
      )
    ),
    section(
      panel(
        sectionTitle("🔓 Unlock Your Full Report") +
          `<p style="margin:0;font-size:14px;line-height:1.6;">
                    To see the full list of sites, view your unredacted data, and trigger <strong style="color:${C.accent};">automated deletion requests</strong>, upgrade to your command center.
                  </p>`
      )
    ),
    ctaButton("https://ghostsweep.com/dashboard", "🛡️ SECURE MY IDENTITY — $7.99/MO"),
  ].join("");

  return emailShell({
    title: "Your Identity Discovery Report",
    body,
    footerNote: "You're receiving this because you have a GhostSweep account.",
    to: data.to,
  });
}

/**
 * Send the scan report email via Resend.
 */
export async function sendScanReportEmail(data: ScanReportEmailData): Promise<void> {
  const html = buildScanReportHtml(data);

  console.log(`[email] Sending scan report to ${data.to}...`);

  const { error } = await resend.emails.send({
    from: "Joel from GhostSweep <support@ghostsweep.com>",
    to: data.to,
    subject: `🔍 ${data.firstName}, your Identity Discovery Report is ready`,
    html,
  });

  if (error) {
    console.error("[email] Failed to send:", error.message);
    throw new Error(error.message);
  }

  console.log(`[email] ✅ Scan report sent to ${data.to}.`);
}

/**
 * Schedule a scan report email to be sent after a delay (default: 2 minutes).
 */
export function scheduleScanReportEmail(
  data: ScanReportEmailData,
  delayMs = 2 * 60 * 1000
): void {
  console.log(`[email] Scheduling scan report email to ${data.to} in ${delayMs / 1000}s...`);

  setTimeout(async () => {
    try {
      await sendScanReportEmail(data);
    } catch (err) {
      console.error("[email] Scheduled send failed:", err);
    }
  }, delayMs);
}

// ── Weekly Public Profile Report Email (Maigret OSINT) ─────────────

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/** Large number with a small caption, used in the stat row. */
function statCell(value: string, label: string, sub: string, color: string): string {
  return `<td width="33%" valign="top" style="padding:6px;">
                      <div style="background:${C.panel};border:1px solid ${C.border};border-radius:10px;padding:16px;">
                        <div style="font-size:26px;font-weight:700;color:${color};line-height:1.1;">${value}</div>
                        <div style="font-size:13px;font-weight:600;color:${C.heading};margin-top:6px;">${label}</div>
                        <div style="font-size:12px;color:${C.muted};margin-top:2px;">${sub}</div>
                      </div>
                    </td>`;
}

/** Plain-language next steps based on what Maigret found. */
function buildActions(d: WeeklyReportData): string[] {
  const actions: string[] = [];

  if (d.newProfileCount > 0) {
    actions.push("Open each new profile. If you don't use it any more, delete it or request removal.");
    actions.push("If a profile isn't yours, someone may be using your username. Check it for impersonation.");
  }
  if (d.profiles.length > 0) {
    actions.push("Remove personal details (full name, photo, location, birthday) from profiles you keep.");
  }
  if (d.usernames.length <= 1) {
    actions.push("Add any old usernames you've used to your dashboard so we can scan those too.");
  }
  if (actions.length === 0) {
    actions.push("Nothing to do this week. We'll keep watching for new profiles under your usernames.");
  }
  return actions.slice(0, 4);
}

function buildWeeklyReportHtml(d: WeeklyReportData): string {
  const usernameList = d.usernames.map((u) => `<strong style="color:${C.heading};">${esc(u)}</strong>`).join(", ");
  const searched = d.usernames.length > 0 ? ` for ${usernameList}` : "";

  const intro =
    d.newProfileCount > 0
      ? `We searched 3,000+ websites${searched}. Since ${formatDate(d.since)} we found <strong style="color:${C.heading};">${d.newProfileCount} new public profile${d.newProfileCount !== 1 ? "s" : ""}</strong> linked to you.`
      : `We searched 3,000+ websites${searched}. Good news: no new public profiles turned up since ${formatDate(d.since)}.`;

  const statRow = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                  <tr>
                    ${statCell(String(d.profiles.length), "Public profiles", "Found across all scans", C.heading)}
                    ${statCell(String(d.newProfileCount), "New this week", d.newProfileCount > 0 ? "Review these first" : "No change", d.newProfileCount > 0 ? C.orange : C.green)}
                    ${statCell(String(d.usernames.length), "Usernames scanned", "Across 3,000+ sites", C.heading)}
                  </tr>
                </table>`;

  // Profile list — new first, each linking to the public page
  const MAX_ROWS = 15;
  const newTag = `<span style="display:inline-block;background:#ffedd5;color:${C.orange};font-size:11px;font-weight:700;padding:2px 6px;border-radius:4px;margin-left:6px;">NEW</span>`;
  const profileRows = d.profiles
    .slice(0, MAX_ROWS)
    .map(
      (p) => `
                    <tr>
                      <td style="padding:10px 12px;font-size:14px;color:${C.heading};border-bottom:1px solid ${C.border};">${esc(p.siteName)}${p.isNew ? newTag : ""}</td>
                      <td style="padding:10px 12px;font-size:14px;border-bottom:1px solid ${C.border};text-align:right;"><a href="${esc(p.url)}" style="color:${C.accent};text-decoration:none;font-weight:600;">View →</a></td>
                    </tr>`
    )
    .join("");
  const moreProfiles = d.profiles.length - MAX_ROWS;
  const th = (h: string, align = "left") =>
    `<th style="padding:10px 12px;font-size:12px;font-weight:600;color:${C.muted};text-align:${align};text-transform:uppercase;letter-spacing:0.5px;border-bottom:1px solid ${C.border};">${h}</th>`;
  const profileSection =
    d.profiles.length === 0
      ? callout(C.green, `<strong style="color:${C.green};">No public profiles found.</strong> We didn't find your usernames on any of the sites we checked.`)
      : `<div style="border:1px solid ${C.border};border-radius:10px;overflow:hidden;">
                  <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
                    <tr style="background:${C.panel};">${th("Platform")}${th("Profile", "right")}</tr>
                    ${profileRows}
                  </table>
                </div>${moreProfiles > 0 ? `<p style="margin:10px 0 0;font-size:13px;color:${C.muted};text-align:center;">+ ${moreProfiles} more in your dashboard</p>` : ""}`;

  const actions = buildActions(d)
    .map((a) => `<li style="margin:0 0 8px;">${esc(a)}</li>`)
    .join("");

  const isPaid = d.plan === "pro" || d.plan === "buster";

  const body = [
    headline("Your Weekly Public Profile Scan"),
    `
            <tr>
              <td style="padding-bottom:24px;font-size:15px;line-height:1.6;">
                <p style="margin:0 0 16px;">Hello <strong style="color:${C.heading};">${esc(d.firstName)}</strong>,</p>
                <p style="margin:0;">${intro}</p>
              </td>
            </tr>`,
    section(statRow),
    section(sectionTitle("🔍 Where You're Visible Online") + profileSection),
    section(
      callout(
        C.orange,
        `<strong style="color:${C.orange};">Why this matters:</strong> Every public profile under your username is something a scammer can use to piece together who you are, and old accounts you've forgotten about are easy targets for takeover.`
      )
    ),
    section(
      callout(
        C.accent,
        `<strong style="color:${C.accent};">Recommended next steps</strong><ul style="margin:8px 0 0;padding-left:20px;color:${C.text};">${actions}</ul>`
      )
    ),
    isPaid
      ? ctaButton("https://ghostsweep.com/dashboard", "View My Full Report")
      : ctaButton("https://ghostsweep.com/dashboard", "🛡️ CLEAN UP MY FOOTPRINT — $7.99/MO"),
  ].join("");

  return emailShell({
    title: "Your Weekly Public Profile Scan",
    body,
    footerNote: "You're receiving this weekly scan because you have a GhostSweep account.",
    to: d.to,
  });
}

function weeklySubject(d: WeeklyReportData): string {
  const name = d.firstName === "there" ? "" : `${d.firstName}, `;
  const subject =
    d.newProfileCount > 0
      ? `${name}we found ${d.newProfileCount} new public profile${d.newProfileCount !== 1 ? "s" : ""} linked to you`
      : `${name}your weekly public profile scan`;
  return subject.charAt(0).toUpperCase() + subject.slice(1);
}

/**
 * Send the weekly public profile report email via Resend.
 */
export async function sendWeeklyReportEmail(data: WeeklyReportData): Promise<void> {
  const html = buildWeeklyReportHtml(data);

  console.log(`[email] Sending weekly report to ${data.to}...`);

  const { error } = await resend.emails.send({
    from: "Joel from GhostSweep <support@ghostsweep.com>",
    to: data.to,
    subject: weeklySubject(data),
    html,
  });

  if (error) {
    console.error("[email] Failed to send weekly report:", error.message);
    throw new Error(error.message);
  }

  console.log(`[email] ✅ Weekly report sent to ${data.to}.`);
}

/** Exported for rendering local previews. */
export { buildWeeklyReportHtml };

// ── Teaser Report Email ────────────────────────────────────────────

/**
 * Data needed to populate the teaser scan report email (for unauthenticated leads).
 */
export interface TeaserReportEmailData {
  to: string;
  username: string;
  totalProfiles: number;
  topSites: Array<{
    siteName: string;
    category: string;
  }>;
}

/**
 * Build the teaser scan report HTML email.
 * Shows a limited preview of findings to drive signups.
 */
function buildTeaserReportHtml(data: TeaserReportEmailData): string {
  const hiddenCount = Math.max(0, data.totalProfiles - data.topSites.length);
  const username = esc(data.username);

  const body = [
    headline(`🔍 We Found ${data.totalProfiles} Account${data.totalProfiles !== 1 ? "s" : ""} Linked to "${username}"`),
    `
            <tr>
              <td style="padding-bottom:24px;font-size:15px;line-height:1.6;">
                <p style="margin:0 0 16px;">
                  We just scanned the <strong style="color:${C.heading};">top 500 platforms</strong> on the internet for the username <strong style="color:${C.accent};">"${username}"</strong> — and here's what we found.
                </p>
                <p style="margin:0 0 16px;">
                  Each of these accounts is a potential entry point for <strong style="color:${C.heading};">identity theft, credential stuffing, or data leaks.</strong>
                </p>
              </td>
            </tr>`,
    section(
      panel(
        sectionTitle("📊 Scan Summary") +
          summaryRows([
            { label: "Username Scanned", value: `<span style="color:${C.accent};font-weight:700;">${username}</span>` },
            { label: "Sites Checked", value: `<span style="color:${C.heading};font-weight:700;">500</span>` },
            { label: "Active Accounts Found", value: `<span style="color:${C.red};font-weight:700;">${data.totalProfiles}</span>` },
          ])
      )
    ),
    section(
      sectionTitle("⚠️ Sample Discoveries") +
        dataTable(
          ["Platform", "Category", "Status"],
          data.topSites.map((s) => [esc(s.siteName), esc(s.category), "⚠️ Active"]),
          C.orange
        ) +
        (hiddenCount > 0
          ? `<p style="margin:12px 0 0;font-size:13px;color:${C.muted};text-align:center;">
                  + <strong style="color:${C.orange};">${hiddenCount} more accounts</strong> hidden. Sign up to see the full report.
                </p>`
          : "")
    ),
    section(
      callout(
        C.red,
        `<strong style="color:${C.red};">Why should you care?</strong> Abandoned and forgotten accounts are the #1 entry point for credential stuffing and identity theft. Hackers target old accounts with reused passwords to break into your primary email, banking, and social media.`
      )
    ),
    section(
      panel(
        sectionTitle("🛡️ Take Control of Your Digital Shadow") +
          `<p style="margin:0;font-size:14px;line-height:1.6;">
                    Sign up for GhostSweep to get the <strong style="color:${C.accent};">full deep scan</strong> across 3,000+ sites, see your complete vulnerability score, uncover data breach links, and send <strong style="color:${C.accent};">automated deletion requests</strong>.
                  </p>`
      )
    ),
    ctaButton("https://ghostsweep.com/signup", "🔓 GET MY FULL REPORT — FREE TRIAL"),
  ].join("");

  return emailShell({
    title: "Your Free Identity Scan Results",
    body,
    footerNote: "You're receiving this because you requested a free identity scan on GhostSweep.",
    to: data.to,
  });
}

/**
 * Send the teaser scan report email via Resend.
 */
export async function sendTeaserReportEmail(data: TeaserReportEmailData): Promise<void> {
  const html = buildTeaserReportHtml(data);

  console.log(`[email] Sending teaser report to ${data.to}...`);

  const { error } = await resend.emails.send({
    from: "Joel from GhostSweep <support@ghostsweep.com>",
    to: data.to,
    subject: `🔍 We found ${data.totalProfiles} accounts linked to "${data.username}"`,
    html,
  });

  if (error) {
    console.error("[email] Failed to send teaser:", error.message);
    throw new Error(error.message);
  }

  console.log(`[email] ✅ Teaser report sent to ${data.to}.`);
}
