import { execFile } from "node:child_process";
import { readFile, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import path from "node:path";

const REPORTS_DIR = path.resolve(process.cwd(), "reports");
/** Top-500 scans finish well inside this. */
const MAIGRET_TIMEOUT_MS = 5 * 60 * 1000;
/** Full (-a, 3,000+ sites) scans take much longer. */
const MAIGRET_ALL_SITES_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_USERNAME_LENGTH = 100;

/**
 * Ensure the ./reports directory exists. Each scan writes into its own
 * temporary sub-directory, which is removed when the scan finishes.
 */
export async function ensureReportsDir(): Promise<void> {
  await mkdir(REPORTS_DIR, { recursive: true });
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

export interface MaigretScanOptions {
  /** Number of top-ranked sites to check (Maigret default: 500). */
  topSites?: number;
  /** Check every site in Maigret's database (3,000+). Much slower. */
  allSites?: boolean;
}

/**
 * Normalise a username for Maigret. Spaces are not allowed (Maigret treats
 * them as separate usernames), so they become underscores.
 * Throws if the result is empty, too long, or looks like a CLI flag.
 */
export function normalizeUsername(username: string): string {
  const sanitized = username.trim().replace(/\s+/g, "_");
  if (!sanitized) throw new Error("Username is empty.");
  if (sanitized.length > MAX_USERNAME_LENGTH) {
    throw new Error(`Username is longer than ${MAX_USERNAME_LENGTH} characters.`);
  }
  if (sanitized.startsWith("-")) {
    // Would be parsed as a CLI flag by Maigret.
    throw new Error("Username cannot start with '-'.");
  }
  return sanitized;
}

let maigretAvailable: Promise<boolean> | undefined;

/** Whether `maigret` is on PATH. Checked once per process. */
function hasDirectMaigret(): Promise<boolean> {
  maigretAvailable ??= new Promise((resolve) => {
    execFile("maigret", ["--version"], (error) => resolve(!error));
  });
  return maigretAvailable;
}

function run(cmd: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 },
      (error, _stdout, stderr) => {
        if (error) {
          console.error(`[scanner] Maigret error: ${error.message}`);
          if (stderr) console.error(`[scanner] stderr: ${stderr.slice(-2000)}`);
          reject(error);
          return;
        }
        resolve();
      }
    );
  });
}

/**
 * Execute a Maigret OSINT scan for a given username.
 *
 * Runs `maigret` directly if it is on PATH (Fly.io, CI), otherwise falls back
 * to the soxoj/maigret Docker image (local dev). Arguments are passed without a
 * shell, and every run writes into its own temp directory so concurrent scans
 * of the same username never read each other's report. The directory is
 * removed before this function returns.
 */
export async function executeMaigretScan(
  username: string,
  options: MaigretScanOptions = {}
): Promise<MaigretSiteResult[]> {
  await ensureReportsDir();
  const sanitized = normalizeUsername(username);
  if (sanitized !== username) {
    console.log(`[scanner] Sanitized username: "${username}" → "${sanitized}"`);
  }

  const scopeArgs = options.allSites
    ? ["-a"]
    : options.topSites
      ? ["--top-sites", String(options.topSites)]
      : [];

  const timeoutMs = options.allSites ? MAIGRET_ALL_SITES_TIMEOUT_MS : MAIGRET_TIMEOUT_MS;
  const outDir = await mkdtemp(path.join(REPORTS_DIR, "scan-"));

  try {
    const useDirect = await hasDirectMaigret();
    const scope = options.allSites ? "all sites" : `top ${options.topSites ?? 500} sites`;
    console.log(`[scanner] Running Maigret for "${sanitized}" (${scope}, ${useDirect ? "direct" : "Docker"})...`);

    if (useDirect) {
      await run("maigret", [
        sanitized, "--json", "simple", "--no-progressbar", "--folderoutput", outDir, ...scopeArgs,
      ], timeoutMs);
    } else {
      await run("docker", [
        "run", "--rm", "-v", `${outDir}:/app/reports`, "soxoj/maigret:latest",
        sanitized, "--json", "simple", "--no-progressbar", ...scopeArgs,
      ], timeoutMs);
    }

    // Maigret names the file report_<username>_simple.json; find it rather than
    // re-deriving the name, in case Maigret changes how it escapes usernames.
    const files = await readdir(outDir);
    const reportFile = files.find((f) => f.endsWith("_simple.json"));
    if (!reportFile) throw new Error(`Maigret produced no report for "${sanitized}".`);

    const raw = await readFile(path.join(outDir, reportFile), "utf-8");
    const results = parseMaigretReport(raw);
    console.log(`[scanner] Parsed ${results.length} site results for "${sanitized}".`);
    return results;
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
}

/** Convert Maigret's object-keyed simple JSON into a flat array. */
export function parseMaigretReport(raw: string): MaigretSiteResult[] {
  const parsed = JSON.parse(raw) as Record<string, MaigretRawEntry>;
  return Object.entries(parsed).map(([siteName, entry]) => ({
    siteName,
    url: entry.status?.url ?? entry.url_user ?? "",
    status: (entry.status?.status ?? "").toLowerCase(),
    tags: entry.status?.tags ?? [],
  }));
}

/**
 * Extract the local-part (prefix) from an email address.
 * e.g. "johndoe@gmail.com" → "johndoe"
 */
export function extractEmailPrefix(email: string): string {
  const atIndex = email.indexOf("@");
  return atIndex > 0 ? email.substring(0, atIndex) : email;
}
