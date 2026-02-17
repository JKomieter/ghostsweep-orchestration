import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY);

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
  if (score >= 70) return { label: "Critical Risk", emoji: "🔴", color: "#ff4444" };
  if (score >= 40) return { label: "High Risk", emoji: "🟠", color: "#ff8c00" };
  if (score >= 20) return { label: "Moderate Risk", emoji: "🟡", color: "#ffd700" };
  return { label: "Low Risk", emoji: "🟢", color: "#00f2de" };
}

/**
 * Build the scan report HTML email matching the GhostSweep dark theme.
 */
function buildScanReportHtml(data: ScanReportEmailData): string {
  const risk = getRiskLevel(data.score);

  const siteRows = data.topSites
    .map(
      (site) => `
        <tr>
          <td style="padding:10px 12px;font-size:14px;color:#ffffff;border-bottom:1px solid #222222;">${site.siteName}</td>
          <td style="padding:10px 12px;font-size:14px;color:#b0b0b0;border-bottom:1px solid #222222;">${site.category}</td>
          <td style="padding:10px 12px;font-size:14px;color:#ff8c00;border-bottom:1px solid #222222;">⚠️ Redacted</td>
        </tr>`
    )
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Your Identity Discovery Report</title>
  </head>
  <body style="margin:0;padding:0;background-color:#0a0a0a;color:#b0b0b0;font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color:#0a0a0a;padding:40px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"
            style="
              max-width:560px;
              background:#111111;
              border:1px solid #222222;
              border-radius:12px;
              padding:40px;
              color:#b0b0b0;
            "
          >

            <!-- Logo -->
            <tr>
              <td style="padding-bottom:32px;">
                <img
                  src="https://ghostsweep.t3.storage.dev/ghost-svgrepo-com.png"
                  width="28"
                  height="28"
                  alt="GhostSweep"
                  style="display:block;"
                />
              </td>
            </tr>

            <!-- Headline -->
            <tr>
              <td style="padding-bottom:24px;">
                <h1 style="margin:0;font-size:22px;font-weight:700;color:#ffffff;line-height:1.3;">
                  Your Identity Discovery Report is Ready
                </h1>
              </td>
            </tr>

            <!-- Body Content -->
            <tr>
              <td style="padding-bottom:24px; font-size:15px; line-height:1.6;">
                <p style="margin:0 0 16px;">Hello <strong style="color:#ffffff;">${data.firstName}</strong>,</p>
                <p style="margin:0 0 16px;">
                  Our engines have completed a deep scan of the public web for your digital <strong style="color:#ffffff;">"shadow."</strong> We searched <strong style="color:#ffffff;">3,000+ platforms</strong> to identify where your personal data is still active and vulnerable.
                </p>
              </td>
            </tr>

            <!-- Scan Summary Box -->
            <tr>
              <td style="padding-bottom:28px;">
                <div style="
                  background:#0a0a0a;
                  border:1px solid #222222;
                  border-radius:10px;
                  padding:24px;
                ">
                  <h2 style="margin:0 0 20px;font-size:18px;font-weight:600;color:#ffffff;">
                    📊 Scan Summary
                  </h2>
                  <table width="100%" cellpadding="0" cellspacing="0">
                    <tr>
                      <td style="padding-bottom:14px;font-size:14px;color:#b0b0b0;line-height:1.6;">
                        <strong style="color:#ffffff;">Identity Security Score:</strong>
                        <span style="color:${risk.color};font-weight:700;"> ${data.score}/100 (${risk.emoji} ${risk.label})</span>
                      </td>
                    </tr>
                    <tr>
                      <td style="padding-bottom:14px;font-size:14px;color:#b0b0b0;line-height:1.6;">
                        <strong style="color:#ffffff;">Accounts Found:</strong>
                        <span style="color:#00f2de;font-weight:700;"> ${data.totalProfiles}</span>
                      </td>
                    </tr>
                    <tr>
                      <td style="padding-bottom:0;font-size:14px;color:#b0b0b0;line-height:1.6;">
                        <strong style="color:#ffffff;">Data Breach Links:</strong>
                        <span style="color:#ff6b6b;font-weight:700;"> ${data.breachCount} verified exposure${data.breachCount !== 1 ? "s" : ""}</span>
                      </td>
                    </tr>
                  </table>
                </div>
              </td>
            </tr>

            <!-- Top Exposure Risks Table -->
            <tr>
              <td style="padding-bottom:28px;">
                <h2 style="margin:0 0 16px;font-size:18px;font-weight:600;color:#ffffff;">
                  ⚠️ Top Exposure Risks
                </h2>
                <div style="border:1px solid #222222;border-radius:10px;overflow:hidden;">
                  <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
                    <tr style="background:#1a1a1a;">
                      <th style="padding:10px 12px;font-size:12px;font-weight:600;color:#666666;text-align:left;text-transform:uppercase;letter-spacing:0.5px;border-bottom:1px solid #222222;">Platform</th>
                      <th style="padding:10px 12px;font-size:12px;font-weight:600;color:#666666;text-align:left;text-transform:uppercase;letter-spacing:0.5px;border-bottom:1px solid #222222;">Discovery Type</th>
                      <th style="padding:10px 12px;font-size:12px;font-weight:600;color:#666666;text-align:left;text-transform:uppercase;letter-spacing:0.5px;border-bottom:1px solid #222222;">Status</th>
                    </tr>
                    ${siteRows}
                  </table>
                </div>
              </td>
            </tr>

            <!-- Risk Warning -->
            <tr>
              <td style="padding-bottom:28px;">
                <div style="
                  background:#0a0a0a;
                  border:1px solid #333333;
                  border-left:4px solid #ff6b6b;
                  border-radius:8px;
                  padding:16px;
                ">
                  <p style="margin:0;font-size:14px;line-height:1.6;">
                    <strong style="color:#ff6b6b;">Why is this a risk?</strong> Abandoned accounts are the #1 entry point for credential stuffing and identity theft. We found your information linked to breaches where clear-text passwords and home addresses were leaked.
                  </p>
                </div>
              </td>
            </tr>

            <!-- Unlock Section -->
            <tr>
              <td style="padding-bottom:28px;">
                <div style="
                  background:#0a0a0a;
                  border:1px solid #222222;
                  border-radius:10px;
                  padding:24px;
                ">
                  <h2 style="margin:0 0 16px;font-size:18px;font-weight:600;color:#ffffff;">
                    🔓 Unlock Your Full Report
                  </h2>
                  <p style="margin:0 0 16px;font-size:14px;line-height:1.6;">
                    To see the full list of sites, view your unredacted data, and trigger <strong style="color:#00f2de;">automated deletion requests</strong>, upgrade to your command center.
                  </p>
                </div>
              </td>
            </tr>

            <!-- CTA Button -->
            <tr>
              <td align="center" style="padding-bottom:32px;">
                <a href="https://ghostsweep.com/dashboard" style="
                  background: #00f2de;
                  color: #000000;
                  padding: 14px 28px;
                  text-decoration: none;
                  border-radius: 8px;
                  font-weight: 700;
                  font-size: 15px;
                  display: inline-block;
                ">
                  🛡️ SECURE MY IDENTITY — $19.99/MO
                </a>
              </td>
            </tr>

            <!-- Signature -->
            <tr>
              <td style="padding-bottom:32px; font-size:15px; line-height:1.6;">
                <p style="margin:0;">
                  Stay safe,<br />
                  <span style="color:#ffffff;">Joel</span><br />
                  <span style="color:#666666;">Founder, GhostSweep</span>
                </p>
              </td>
            </tr>

            <!-- Footer -->
            <tr>
              <td style="border-top:1px solid #222222;padding-top:16px; text-align:center;">
                <p style="margin:0;font-size:12px;color:#555555;">
                  You're receiving this because you have a GhostSweep account.
                  <br>
                  <a href="https://ghostsweep.com/unsubscribe?email=${encodeURIComponent(data.to)}" style="color:#555555;text-decoration:underline;">Unsubscribe</a>
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
