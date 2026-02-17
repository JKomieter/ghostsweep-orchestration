import { exec } from "node:child_process";
import { readFile, mkdir, unlink, access } from "node:fs/promises";
import path from "node:path";

const REPORTS_DIR = path.resolve(process.cwd(), "reports");

/**
 * Ensure the ./reports directory exists for Docker volume mounts.
 */
export async function ensureReportsDir(): Promise<void> {
  try {
    await access(REPORTS_DIR);
  } catch {
    await mkdir(REPORTS_DIR, { recursive: true });
  }
}

/**
 * Represents a single site result from a Maigret scan.
 * Maigret's simple JSON is an object keyed by site name.
 */
export interface MaigretSiteResult {
  siteName: string;
  url: string;
  status: string;
  tags: string[];
}

/**
 * Raw shape of a single entry in Maigret's simple JSON output.
 */
interface MaigretRawEntry {
  url_user: string;
  status: {
    status: string;
    site_name: string;
    url: string;
    tags?: string[];
  };
  [key: string]: unknown;
}

/**
 * Execute a Maigret OSINT scan for a given username.
 * Runs maigret directly as a subprocess (works locally if installed, and on Fly.io).
 * Falls back to Docker if the direct command isn't available.
 */
export async function executeMaigretScan(
  username: string
): Promise<MaigretSiteResult[]> {
  await ensureReportsDir();

  // Sanitize username: replace spaces with underscores for the scan
  // Maigret doesn't support usernames with spaces — they get split into
  // separate positional arguments and the scan hangs or produces no output.
  const sanitized = username.trim().replace(/\s+/g, "_");
  if (sanitized !== username) {
    console.log(`[scanner] Sanitized username: "${username}" → "${sanitized}"`);
  }

  // Shell-escape the username in case it contains special characters
  const shellSafe = sanitized.replace(/'/g, "'\\''");

  // Try direct maigret first (works on Fly.io), fall back to Docker (works locally)
  const directCmd = `maigret '${shellSafe}' --json simple --folderoutput "${REPORTS_DIR}"`;
  const dockerCmd = `docker run --rm -v "${REPORTS_DIR}:/app/reports" soxoj/maigret:latest '${shellSafe}' --json simple`;

  console.log(`[scanner] Running Maigret scan for "${sanitized}"...`);

  // Check if maigret is available directly
  const useDirect = await new Promise<boolean>((resolve) => {
    exec("which maigret", (error) => resolve(!error));
  });

  const cmd = useDirect ? directCmd : dockerCmd;
  console.log(`[scanner] Using ${useDirect ? "direct" : "Docker"} mode.`);

  await new Promise<void>((resolve, reject) => {
    exec(cmd, { timeout: 300_000 }, (error, stdout, stderr) => {
      if (error) {
        console.error(`[scanner] Maigret error: ${error.message}`);
        console.error(`[scanner] stderr: ${stderr}`);
        reject(error);
        return;
      }
      console.log(`[scanner] stdout: ${stdout}`);
      resolve();
    });
  });

  const reportPath = path.join(REPORTS_DIR, `report_${sanitized}_simple.json`);
  const raw = await readFile(reportPath, "utf-8");
  const parsed = JSON.parse(raw) as Record<string, MaigretRawEntry>;

  // Convert the object-keyed format into a flat array
  const results: MaigretSiteResult[] = Object.entries(parsed).map(
    ([siteName, entry]) => ({
      siteName,
      url: entry.status?.url ?? entry.url_user ?? "",
      status: (entry.status?.status ?? "").toLowerCase(),
      tags: entry.status?.tags ?? [],
    })
  );

  console.log(
    `[scanner] Parsed ${results.length} site results for "${username}".`
  );
  return results;
}

/**
 * Remove the local JSON report file after ingestion.
 */
export async function cleanupReport(username: string): Promise<void> {
  const sanitized = username.trim().replace(/\s+/g, "_");
  const reportPath = path.join(REPORTS_DIR, `report_${sanitized}_simple.json`);
  try {
    await unlink(reportPath);
    console.log(`[scanner] Cleaned up report: ${reportPath}`);
  } catch {
    console.warn(`[scanner] Could not delete report: ${reportPath}`);
  }
}

/**
 * Extract the local-part (prefix) from an email address.
 * e.g. "johndoe@gmail.com" → "johndoe"
 */
export function extractEmailPrefix(email: string): string {
  const atIndex = email.indexOf("@");
  return atIndex > 0 ? email.substring(0, atIndex) : email;
}

/**
 * Placeholder for a future Phone OSINT module.
 * Currently logs a notice — will be replaced with actual lookup logic
 * (e.g. Truecaller API, OSINT phone databases, HLR lookups).
 */
export async function executePhoneOsint(phone: string): Promise<void> {
  console.log(`[scanner] 📞 Phone OSINT placeholder for "${phone}".`);
  console.log("[scanner] TODO: Integrate phone OSINT provider (Truecaller, HLR lookup, etc.).");
  // Future implementation:
  // - Query phone OSINT APIs for associated names, carriers, and social profiles
  // - Return structured results for ingestion into shadow_profiles
}
