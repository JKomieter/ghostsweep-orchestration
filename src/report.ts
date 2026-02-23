/**
 * GhostSweep Identity Audit PDF Generator  (premium edition)
 *
 * Pages:
 *  0. Cover Page           - full-bleed dark cover with logo + tagline
 *  1. Executive Summary    - security grade, stat cards, score bar, overview
 *  2. Inbox Discovery      - verified accounts from Gmail / Microsoft
 *  3. Shadow Web           - Maigret OSINT hits across 3,000+ sites
 *  4. Breach Timeline      - historical leaks with event cards
 *  5. Deletion Roadmap     - high-risk accounts with deletion links
 */

import PDFDocument from "pdfkit";
import https from "node:https";
import http  from "node:http";
import supabase from "./supabase.js";

// ── Logo fetcher ──────────────────────────────────────────────────────────────

const LOGO_URL = "https://ghostsweep.t3.storage.dev/ghost-svgrepo-com.png";

async function fetchLogoBuffer(): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const mod = LOGO_URL.startsWith("https") ? https : http;
    mod.get(LOGO_URL, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end",  () => resolve(Buffer.concat(chunks)));
      res.on("error", () => resolve(null));
    }).on("error", () => resolve(null));
  });
}

// ── Palette ──────────────────────────────────────────────────────────────────

const NAVY    = "#08111C";   // near-black navy
const NAVY2   = "#0D1B2A";   // slightly lighter navy (cards)
const NAVY3   = "#122436";   // sidebar / header fill
const WHITE   = "#FFFFFF";
const OFF_WHITE = "#F4F7FA";
const RED     = "#E63946";
const RED_DIM = "#9B2226";   // darker red for badges
const AMBER   = "#E07B00";
const GREEN   = "#2D9E6B";
const LIGHT   = "#EEF2F7";
const MUTED   = "#7A8FA6";
const ACCENT  = "#4A9EDB";   // electric blue
const ACCENT2 = "#1E6FAB";   // darker blue
const GHOST   = "rgba(255,255,255,0.06)"; // subtle ghost tile

const FONT_REGULAR = "Helvetica";
const FONT_BOLD    = "Helvetica-Bold";

const PAGE_WIDTH  = 612;
const PAGE_HEIGHT = 792;
const MARGIN      = 48;
const CONTENT_W   = PAGE_WIDTH - MARGIN * 2;

// ── Data types ───────────────────────────────────────────────────────────────

interface InboxAccount {
  service_name: string;
  category: string;
  last_seen_at: string | null;
  email: string | null;
  source: string;
}

interface ShadowProfile {
  site_name: string;
  profile_url: string;
  risk_level: number;
  last_verified_at: string | null;
}

interface BreachRecord {
  event_name: string;
  date: string | null;
  description: string | null;
  service_name: string;
  email: string;
}

interface RecoverableAsset {
  service_name: string;
  amount: number;
  type: string;
  status: string;
}

interface ReportData {
  userId: string;
  userEmail: string;
  firstName: string;
  generatedAt: string;
  securityScore: number;
  inboxAccounts: InboxAccount[];
  shadowProfiles: ShadowProfile[];
  breaches: BreachRecord[];
  recoverableAssets: RecoverableAsset[];
  connectedEmails: string[];
}

// ── Data fetching ────────────────────────────────────────────────────────────

export async function fetchReportData(userId: string): Promise<ReportData> {
  console.log(`[report] Fetching data for user ${userId}...`);

  // Auth user details
  const { data: authUser } = await supabase.auth.admin.getUserById(userId);
  const userEmail = authUser?.user?.email ?? "";
  const meta      = authUser?.user?.user_metadata ?? {};
  const firstName =
    meta.first_name ??
    meta.full_name?.split(" ")[0] ??
    meta.name?.split(" ")[0] ??
    "User";

  // Security score
  const { data: scoreRow } = await supabase
    .from("user_security_scores")
    .select("score")
    .eq("user_id", userId)
    .single();
  const securityScore = scoreRow?.score ?? 0;

  // Connected email accounts
  const [{ data: gmailRows }, { data: msftRows }] = await Promise.all([
    supabase
      .from("gmail_accounts")
      .select("gmail_address")
      .eq("user_id", userId),
    supabase
      .from("microsoft_accounts")
      .select("outlook_address")
      .eq("user_id", userId),
  ]);

  const connectedEmails = [
    ...(gmailRows ?? []).map((r: { gmail_address: string }) => r.gmail_address),
    ...(msftRows  ?? []).map((r: { outlook_address: string }) => r.outlook_address),
  ];

  // Inbox-sourced services (gmail + microsoft sweep events)
  const { data: userServiceRows } = await supabase
    .from("user_services")
    .select(`
      email,
      source,
      last_seen_at,
      services ( name, category )
    `)
    .eq("user_id", userId)
    .in("source", ["gmail", "outlook"])
    .order("last_seen_at", { ascending: false });

  const inboxAccounts: InboxAccount[] = (userServiceRows ?? []).map((r: any) => ({
    service_name: r.services?.name ?? "Unknown",
    category:     r.services?.category ?? "Other",
    last_seen_at: r.last_seen_at ?? null,
    email:        r.email ?? null,
    source:       r.source ?? "gmail",
  }));

  // Shadow profiles (Maigret / selector scans)
  const { data: profileRows } = await supabase
    .from("shadow_profiles")
    .select("site_name, profile_url, risk_level, last_verified_at")
    .eq("user_id", userId)
    .eq("is_teaser", false)
    .order("risk_level", { ascending: false });

  const shadowProfiles: ShadowProfile[] = (profileRows ?? []).map((r: any) => ({
    site_name:        r.site_name,
    profile_url:      r.profile_url,
    risk_level:       r.risk_level ?? 1,
    last_verified_at: r.last_verified_at ?? null,
  }));

  // Breach timeline
  const { data: breachRows } = await supabase
    .from("user_breaches")
    .select(`
      email,
      created_at,
      services ( name ),
      breaches ( name, description, breach_date )
    `)
    .eq("user_id", userId)
    .order("created_at", { ascending: false });

  const breaches: BreachRecord[] = (breachRows ?? []).map((r: any) => ({
    event_name:   r.breaches?.name ?? "Unknown Breach",
    date:         r.breaches?.breach_date ?? r.created_at ?? null,
    description:  r.breaches?.description ?? null,
    service_name: r.services?.name ?? "Unknown",
    email:        r.email,
  }));

  // Recoverable assets (gift cards, subscriptions)
  const { data: assetRows } = await supabase
    .from("found_values")
    .select("service_name, amount, type, status")
    .eq("user_id", userId)
    .in("type", ["gift_card", "rewards", "refund"])
    .order("amount", { ascending: false });

  const recoverableAssets: RecoverableAsset[] = (assetRows ?? []).map((r: any) => ({
    service_name: r.service_name,
    amount:       parseFloat(r.amount) || 0,
    type:         r.type,
    status:       r.status ?? "detected",
  }));

  return {
    userId,
    userEmail,
    firstName,
    generatedAt: new Date().toISOString(),
    securityScore,
    inboxAccounts,
    shadowProfiles,
    breaches,
    recoverableAssets,
    connectedEmails,
  };
}

// ── Drawing helpers ──────────────────────────────────────────────────────────

function scoreToGrade(score: number): string {
  if (score >= 90) return "A";
  if (score >= 80) return "B";
  if (score >= 70) return "C";
  if (score >= 60) return "D";
  return "F";
}

function gradeColor(grade: string): string {
  if (grade === "A") return GREEN;
  if (grade === "B") return ACCENT;
  if (grade === "C") return AMBER;
  return RED;
}

function formatDate(iso: string | null): string {
  if (!iso) return "N/A";
  try {
    return new Date(iso).toLocaleDateString("en-US", {
      year: "numeric", month: "short", day: "numeric",
    });
  } catch {
    return "N/A";
  }
}

function isOlderThan3Years(iso: string | null): boolean {
  if (!iso) return false;
  const cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - 3);
  return new Date(iso) < cutoff;
}

/**
 * Draw the repeating dot-grid watermark pattern used on the cover page.
 * Gives the dark background a subtle premium texture.
 */
function drawDotGrid(doc: PDFKit.PDFDocument): void {
  const STEP = 22;
  doc.save();
  doc.fillColor("#FFFFFF").opacity(0.04);
  for (let x = 0; x < PAGE_WIDTH; x += STEP) {
    for (let y = 0; y < PAGE_HEIGHT; y += STEP) {
      doc.circle(x, y, 1).fill();
    }
  }
  doc.restore();
}

/**
 * Draw a full-bleed dark header band on interior pages.
 * Returns the Y coordinate where content should start.
 */
function drawPageHeader(
  doc: PDFKit.PDFDocument,
  sectionNum: string,
  title: string,
  subtitle: string,
  logo: Buffer | null
): number {
  const HEADER_H = 88;

  // Dark band
  doc.rect(0, 0, PAGE_WIDTH, HEADER_H).fill(NAVY3);

  // Thin accent stripe at the bottom of the band
  doc.rect(0, HEADER_H - 3, PAGE_WIDTH, 3).fill(ACCENT);

  // Section number pill on the left
  const PILL_X = MARGIN;
  const PILL_Y = 18;
  const PILL_W = 30;
  const PILL_H = 20;
  doc.roundedRect(PILL_X, PILL_Y, PILL_W, PILL_H, 4).fill(ACCENT);
  doc
    .fillColor(WHITE)
    .font(FONT_BOLD)
    .fontSize(10)
    .text(sectionNum, PILL_X, PILL_Y + 5, { width: PILL_W, align: "center" });

  // Title
  doc
    .fillColor(WHITE)
    .font(FONT_BOLD)
    .fontSize(18)
    .text(title, MARGIN + PILL_W + 10, PILL_Y + 1);

  // Subtitle / meta line
  doc
    .fillColor(MUTED)
    .font(FONT_REGULAR)
    .fontSize(9)
    .text(subtitle, MARGIN, 54, { width: PAGE_WIDTH - MARGIN * 2 - 80 });

  // Wordmark top-right
  const wordmarkX = PAGE_WIDTH - MARGIN - 100;
  if (logo) {
    try {
      doc.image(logo, wordmarkX, 10, { width: 18, height: 18 });
    } catch { /* ignore */ }
  }
  doc
    .fillColor(WHITE)
    .font(FONT_BOLD)
    .fontSize(10)
    .text("GhostSweep", wordmarkX + (logo ? 22 : 0), 14);

  return HEADER_H + 20;
}

/** Thin rule between sections. */
function rule(doc: PDFKit.PDFDocument, y: number, color = "#D0D8E4"): void {
  doc
    .moveTo(MARGIN, y)
    .lineTo(PAGE_WIDTH - MARGIN, y)
    .strokeColor(color)
    .lineWidth(0.5)
    .stroke();
}

/** Bold section heading with accent left-bar and optional count badge. */
function sectionHeading(
  doc: PDFKit.PDFDocument,
  text: string,
  y: number,
  badge?: string
): number {
  doc.rect(MARGIN, y, 3, 16).fill(ACCENT);
  doc.fillColor(NAVY).font(FONT_BOLD).fontSize(12).text(text, MARGIN + 10, y + 1);
  if (badge) {
    const bw = 32;
    doc.roundedRect(PAGE_WIDTH - MARGIN - bw, y, bw, 16, 8).fill(ACCENT);
    doc.fillColor(WHITE).font(FONT_BOLD).fontSize(8)
      .text(badge, PAGE_WIDTH - MARGIN - bw, y + 4, { width: bw, align: "center" });
  }
  return y + 26;
}

/**
 * Premium stat card — dark background, large coloured value, subtle label.
 */
function statCard(
  doc: PDFKit.PDFDocument,
  x: number,
  y: number,
  w: number,
  h: number,
  label: string,
  value: string,
  valueColor: string,
  icon?: string           // single emoji or short glyph
): void {
  // Card background
  doc.roundedRect(x, y, w, h, 6).fill(NAVY2);
  // Subtle top-edge highlight
  doc.roundedRect(x, y, w, 3, 3).fill(valueColor);

  // Icon
  if (icon) {
    doc.fillColor(valueColor).font(FONT_REGULAR).fontSize(18)
      .text(icon, x + 10, y + 10, { width: 26 });
  }

  const textX = x + (icon ? 40 : 14);

  // Value
  doc.fillColor(valueColor).font(FONT_BOLD).fontSize(26)
    .text(value, textX, y + 10, { width: w - textX + x - 10, lineBreak: false });

  // Label
  doc.fillColor(MUTED).font(FONT_REGULAR).fontSize(8)
    .text(label.toUpperCase(), x + 14, y + h - 18, { width: w - 28 });
}

/** Risk badge pill — inline coloured capsule. */
function riskBadge(
  doc: PDFKit.PDFDocument,
  x: number,
  y: number,
  label: string,
  color: string
): void {
  const W = 46, H = 13;
  doc.roundedRect(x, y, W, H, 6).fill(color);
  doc.fillColor(WHITE).font(FONT_BOLD).fontSize(7)
    .text(label.toUpperCase(), x, y + 3, { width: W, align: "center" });
}

/** Table column-header band. */
function tableHeader(
  doc: PDFKit.PDFDocument,
  y: number,
  cols: Array<{ label: string; x: number; w: number }>
): number {
  doc.rect(MARGIN, y, CONTENT_W, 20).fill(NAVY3);
  // Bottom rule
  doc.rect(MARGIN, y + 20, CONTENT_W, 1).fill(ACCENT);
  for (const col of cols) {
    doc
      .fillColor("#A8BDD0")
      .font(FONT_BOLD)
      .fontSize(7)
      .text(col.label.toUpperCase(), col.x + 6, y + 7, { width: col.w - 12 });
  }
  return y + 21;
}

/** Single table row — returns next Y. */
function tableRow(
  doc: PDFKit.PDFDocument,
  y: number,
  rowIndex: number,
  cells: Array<{ text: string; x: number; w: number; color?: string; bold?: boolean }>
): number {
  const ROW_H = 18;
  if (rowIndex % 2 === 0) {
    doc.rect(MARGIN, y, CONTENT_W, ROW_H).fill(OFF_WHITE);
  } else {
    doc.rect(MARGIN, y, CONTENT_W, ROW_H).fill(WHITE);
  }
  // Left border on even rows
  if (rowIndex % 2 === 0) {
    doc.rect(MARGIN, y, 2, ROW_H).fill(ACCENT);
  }
  for (const cell of cells) {
    doc
      .fillColor(cell.color ?? NAVY2)
      .font(cell.bold ? FONT_BOLD : FONT_REGULAR)
      .fontSize(8)
      .text(cell.text, cell.x + 6, y + 5, { width: cell.w - 12, lineBreak: false });
  }
  return y + ROW_H;
}

/** Elegant footer bar. */
function drawFooter(
  doc: PDFKit.PDFDocument,
  pageNum: number,
  totalPages: number,
  generatedAt: string,
  logo: Buffer | null
): void {
  const FOOTER_Y = PAGE_HEIGHT - 36;

  doc.rect(0, FOOTER_Y, PAGE_WIDTH, 36).fill(NAVY3);

  // Logo icon left
  if (logo) {
    try { doc.image(logo, MARGIN, FOOTER_Y + 9, { width: 16, height: 16 }); } catch { /* ignore */ }
  }
  const logoOffset = logo ? 22 : 0;

  doc
    .fillColor("#607D8B")
    .font(FONT_REGULAR)
    .fontSize(7)
    .text(
      `GhostSweep Identity Audit  |  Confidential  |  Generated ${formatDate(generatedAt)}`,
      MARGIN + logoOffset,
      FOOTER_Y + 13,
      { width: CONTENT_W - 60 }
    );

  // Page counter right
  doc
    .fillColor(WHITE)
    .font(FONT_BOLD)
    .fontSize(8)
    .text(
      `${pageNum} / ${totalPages}`,
      PAGE_WIDTH - MARGIN - 40,
      FOOTER_Y + 12,
      { width: 40, align: "right" }
    );
}

/** Add a new interior page and return starting content Y. */
function newPage(
  doc: PDFKit.PDFDocument,
  sectionNum: string,
  title: string,
  subtitle: string,
  logo: Buffer | null
): number {
  doc.addPage();
  return drawPageHeader(doc, sectionNum, title, subtitle, logo);
}

// ── Page renderers ───────────────────────────────────────────────────────────

/**
 * Page 0 — Full-bleed dark cover page.
 */
function renderCoverPage(
  doc: PDFKit.PDFDocument,
  data: ReportData,
  logo: Buffer | null
): void {
  // Full-bleed dark background
  doc.rect(0, 0, PAGE_WIDTH, PAGE_HEIGHT).fill(NAVY);

  drawDotGrid(doc);

  // Bold accent stripe — left 6px edge
  doc.rect(0, 0, 6, PAGE_HEIGHT).fill(ACCENT);

  // Logo
  if (logo) {
    try {
      doc.image(logo, MARGIN + 6, 80, { width: 52, height: 52 });
    } catch { /* ignore */ }
  }

  // Wordmark
  doc
    .fillColor(WHITE)
    .font(FONT_BOLD)
    .fontSize(28)
    .text("GhostSweep", MARGIN + 6, logo ? 142 : 80);

  doc
    .fillColor(ACCENT)
    .font(FONT_REGULAR)
    .fontSize(11)
    .text("ghostsweep.com", MARGIN + 6, logo ? 176 : 114);

  // Main report title block
  const TITLE_Y = 270;

  // Thin accent line above title
  doc.rect(MARGIN + 6, TITLE_Y - 16, 48, 2).fill(ACCENT);

  doc
    .fillColor(WHITE)
    .font(FONT_BOLD)
    .fontSize(34)
    .text("Identity Audit", MARGIN + 6, TITLE_Y);

  doc
    .fillColor("#A8BDD0")
    .font(FONT_REGULAR)
    .fontSize(14)
    .text("Confidential Privacy Report", MARGIN + 6, TITLE_Y + 44);

  // Prepared-for block
  const CARD_Y = TITLE_Y + 90;
  doc.roundedRect(MARGIN + 6, CARD_Y, CONTENT_W - 6, 60, 6).fill(NAVY2);
  doc.rect(MARGIN + 6, CARD_Y, 3, 60).fill(ACCENT);

  doc
    .fillColor(MUTED)
    .font(FONT_REGULAR)
    .fontSize(8)
    .text("PREPARED FOR", MARGIN + 18, CARD_Y + 10);

  doc
    .fillColor(WHITE)
    .font(FONT_BOLD)
    .fontSize(15)
    .text(data.firstName, MARGIN + 18, CARD_Y + 22);

  doc
    .fillColor(MUTED)
    .font(FONT_REGULAR)
    .fontSize(9)
    .text(data.userEmail, MARGIN + 18, CARD_Y + 41);

  // Date right-aligned in card
  doc
    .fillColor(MUTED)
    .font(FONT_REGULAR)
    .fontSize(9)
    .text(formatDate(data.generatedAt), MARGIN + 6, CARD_Y + 41, {
      width: CONTENT_W - 24,
      align: "right",
    });

  // Metrics strip near the bottom
  const STRIP_Y = PAGE_HEIGHT - 180;
  doc.rect(0, STRIP_Y, PAGE_WIDTH, 1).fill("#1E3A52");

  const grade     = scoreToGrade(data.securityScore);
  const gColor    = gradeColor(grade);
  const totalAcc  = data.inboxAccounts.length + data.shadowProfiles.length;
  const totalAss  = data.recoverableAssets.reduce((s, a) => s + a.amount, 0);
  const CARD_W    = (CONTENT_W - 24) / 3;

  statCard(doc, MARGIN + 6,                   STRIP_Y + 16, CARD_W, 80, "Security Grade",      grade,                    gColor);
  statCard(doc, MARGIN + 6 + CARD_W + 12,     STRIP_Y + 16, CARD_W, 80, "Accounts Found",      String(totalAcc),          ACCENT);
  statCard(doc, MARGIN + 6 + (CARD_W + 12)*2, STRIP_Y + 16, CARD_W, 80, "Recoverable Assets",  `$${totalAss.toFixed(2)}`, GREEN);

  // Bottom tagline
  doc
    .fillColor("#1E3A52")
    .font(FONT_REGULAR)
    .fontSize(8)
    .text(
      `This document contains sensitive personal data. Handle in accordance with applicable privacy regulations.`,
      MARGIN + 6,
      PAGE_HEIGHT - 28,
      { width: CONTENT_W - 6 }
    );
}

/**
 * Page 1 — Executive Summary
 */
function renderExecutiveSummary(
  doc: PDFKit.PDFDocument,
  data: ReportData,
  logo: Buffer | null,
  pageNum: number,
  totalPages: number
): void {
  drawPageHeader(doc, "01", "Executive Summary", `Prepared for ${data.firstName}  |  ${formatDate(data.generatedAt)}`, logo);

  let y = 108 + 20;

  // ── Stat cards row ──
  const grade     = scoreToGrade(data.securityScore);
  const gColor    = gradeColor(grade);
  const totalAcc  = data.inboxAccounts.length + data.shadowProfiles.length;
  const totalAss  = data.recoverableAssets.reduce((s, a) => s + a.amount, 0);
  const CARD_W    = (CONTENT_W - 24) / 4;
  const CARD_H    = 76;

  statCard(doc, MARGIN,                       y, CARD_W, CARD_H, "Security Grade",    grade,                    gColor);
  statCard(doc, MARGIN + (CARD_W + 8),        y, CARD_W, CARD_H, "Accounts Found",    String(totalAcc),          ACCENT);
  statCard(doc, MARGIN + (CARD_W + 8) * 2,   y, CARD_W, CARD_H, "Active Breaches",   String(data.breaches.length), data.breaches.length > 0 ? RED : GREEN);
  statCard(doc, MARGIN + (CARD_W + 8) * 3,   y, CARD_W, CARD_H, "Recoverable Assets", `$${totalAss.toFixed(2)}`, GREEN);

  y += CARD_H + 20;

  // ── Score bar ──
  const pct = Math.min(100, data.securityScore);
  doc.fillColor(NAVY).font(FONT_BOLD).fontSize(9)
    .text(`Security Score`, MARGIN, y);
  doc.fillColor(MUTED).font(FONT_REGULAR).fontSize(9)
    .text(`${pct} / 100`, PAGE_WIDTH - MARGIN - 50, y, { width: 50, align: "right" });
  y += 14;

  // Track
  doc.roundedRect(MARGIN, y, CONTENT_W, 10, 5).fill(LIGHT);
  // Fill
  if (pct > 0) {
    const fillW = Math.max(10, Math.round(CONTENT_W * pct / 100));
    doc.roundedRect(MARGIN, y, fillW, 10, 5).fill(gColor);
  }
  y += 24;

  rule(doc, y);
  y += 16;

  // ── Connected accounts ──
  y = sectionHeading(doc, "Connected Accounts", y, String(data.connectedEmails.length));

  if (data.connectedEmails.length === 0) {
    doc.fillColor(MUTED).font(FONT_REGULAR).fontSize(9)
      .text("No connected email accounts.", MARGIN + 10, y);
    y += 16;
  } else {
    for (const addr of data.connectedEmails) {
      doc.roundedRect(MARGIN, y, CONTENT_W, 20, 4).fill(OFF_WHITE);
      doc.circle(MARGIN + 14, y + 10, 4).fill(ACCENT);
      doc.fillColor(NAVY).font(FONT_REGULAR).fontSize(9)
        .text(addr, MARGIN + 24, y + 6);
      y += 24;
    }
  }

  y += 8;
  rule(doc, y);
  y += 16;

  // ── Narrative ──
  y = sectionHeading(doc, "Report Overview", y);
  const narrative =
    `This report covers ${data.inboxAccounts.length} verified inbox account(s) discovered across ` +
    `${data.connectedEmails.length} connected email provider(s), ` +
    `${data.shadowProfiles.length} shadow-web profile(s) discovered via open-source intelligence scans ` +
    `across 3,000+ platforms, and ${data.breaches.length} known data breach event(s) linked to your ` +
    `identity. Review each section for full details and recommended actions.`;

  doc.roundedRect(MARGIN, y, CONTENT_W, 58, 4).fill(OFF_WHITE);
  doc.rect(MARGIN, y, 3, 58).fill(ACCENT);
  doc.fillColor(NAVY2).font(FONT_REGULAR).fontSize(9)
    .text(narrative, MARGIN + 14, y + 10, { width: CONTENT_W - 24, lineGap: 4 });

  drawFooter(doc, pageNum, totalPages, data.generatedAt, logo);
}

/**
 * Page 2 — Inbox Discovery
 */
function renderInboxDiscovery(
  doc: PDFKit.PDFDocument,
  data: ReportData,
  logo: Buffer | null,
  startPage: number,
  totalPages: number
): void {
  const accounts = data.inboxAccounts;
  let pageNum = startPage;
  let y = newPage(doc, "02", "Inbox Discovery",
    `${accounts.length} verified accounts found across connected email providers`, logo);

  const C1 = { label: "Service",     x: MARGIN,       w: 190 };
  const C2 = { label: "Category",    x: MARGIN + 190, w: 120 };
  const C3 = { label: "Last Active", x: MARGIN + 310, w: 110 };
  const C4 = { label: "Source",      x: MARGIN + 420, w: 92  };
  const COLS = [C1, C2, C3, C4];

  y = tableHeader(doc, y, COLS);

  if (accounts.length === 0) {
    doc.roundedRect(MARGIN, y + 8, CONTENT_W, 36, 4).fill(OFF_WHITE);
    doc.fillColor(MUTED).font(FONT_REGULAR).fontSize(9)
      .text("No inbox accounts found yet. Connect a Gmail or Microsoft account to get started.", MARGIN + 14, y + 20, { width: CONTENT_W - 28 });
    drawFooter(doc, pageNum, totalPages, data.generatedAt, logo);
    return;
  }

  for (let i = 0; i < accounts.length; i++) {
    const acc   = accounts[i]!;
    const stale = isOlderThan3Years(acc.last_seen_at);

    if (y > PAGE_HEIGHT - 76) {
      drawFooter(doc, pageNum, totalPages, data.generatedAt, logo);
      pageNum++;
      y = newPage(doc, "02", "Inbox Discovery", "continued", logo);
      y = tableHeader(doc, y, COLS);
    }

    y = tableRow(doc, y, i, [
      { text: acc.service_name,             x: C1.x, w: C1.w, bold: true,  color: stale ? RED : NAVY },
      { text: acc.category,                 x: C2.x, w: C2.w,              color: MUTED },
      { text: formatDate(acc.last_seen_at), x: C3.x, w: C3.w,              color: stale ? RED : MUTED },
      { text: acc.source,                   x: C4.x, w: C4.w,              color: ACCENT },
    ]);
  }

  if (y < PAGE_HEIGHT - 60) {
    y += 14;
    doc.circle(MARGIN + 6, y + 5, 5).fill(RED);
    doc.fillColor(MUTED).font(FONT_REGULAR).fontSize(8)
      .text("Accounts with no activity in 3+ years are highlighted in red and should be reviewed for deletion.",
        MARGIN + 16, y, { width: CONTENT_W - 16 });
  }

  drawFooter(doc, pageNum, totalPages, data.generatedAt, logo);
}

/**
 * Page 3 — Shadow Web Scan
 */
function renderShadowWeb(
  doc: PDFKit.PDFDocument,
  data: ReportData,
  logo: Buffer | null,
  startPage: number,
  totalPages: number
): void {
  const profiles = data.shadowProfiles;
  let pageNum = startPage;
  let y = newPage(doc, "03", "Shadow Web Scan",
    `${profiles.length} profiles found via OSINT across 3,000+ sites`, logo);

  const C1 = { label: "Site Name",     x: MARGIN,       w: 145 };
  const C2 = { label: "Profile URL",   x: MARGIN + 145, w: 210 };
  const C3 = { label: "Risk",          x: MARGIN + 355, w: 75  };
  const C4 = { label: "Last Verified", x: MARGIN + 430, w: 82  };
  const COLS = [C1, C2, C3, C4];

  y = tableHeader(doc, y, COLS);

  if (profiles.length === 0) {
    doc.roundedRect(MARGIN, y + 8, CONTENT_W, 36, 4).fill(OFF_WHITE);
    doc.fillColor(MUTED).font(FONT_REGULAR).fontSize(9)
      .text("No shadow profiles found. Run a username scan to populate this section.",
        MARGIN + 14, y + 20, { width: CONTENT_W - 28 });
    drawFooter(doc, pageNum, totalPages, data.generatedAt, logo);
    return;
  }

  const riskMeta = (level: number): { label: string; color: string } => {
    if (level >= 4) return { label: "HIGH",   color: RED    };
    if (level === 3) return { label: "MEDIUM", color: AMBER  };
    return              { label: "LOW",    color: GREEN  };
  };

  for (let i = 0; i < profiles.length; i++) {
    const p    = profiles[i]!;
    const risk = riskMeta(p.risk_level);

    if (y > PAGE_HEIGHT - 76) {
      drawFooter(doc, pageNum, totalPages, data.generatedAt, logo);
      pageNum++;
      y = newPage(doc, "03", "Shadow Web Scan", "continued", logo);
      y = tableHeader(doc, y, COLS);
    }

    // Render row background manually so we can overlay the badge
    const ROW_H = 18;
    if (i % 2 === 0) {
      doc.rect(MARGIN, y, CONTENT_W, ROW_H).fill(OFF_WHITE);
      doc.rect(MARGIN, y, 2, ROW_H).fill(ACCENT);
    } else {
      doc.rect(MARGIN, y, CONTENT_W, ROW_H).fill(WHITE);
    }

    const truncUrl = p.profile_url.length > 42
      ? p.profile_url.slice(0, 39) + "..."
      : p.profile_url;

    doc.fillColor(NAVY).font(FONT_BOLD).fontSize(8)
      .text(p.site_name, C1.x + 6, y + 5, { width: C1.w - 12, lineBreak: false });
    doc.fillColor(ACCENT).font(FONT_REGULAR).fontSize(8)
      .text(truncUrl, C2.x + 6, y + 5, { width: C2.w - 12, lineBreak: false });

    // Risk badge
    riskBadge(doc, C3.x + 6, y + 3, risk.label, risk.color);

    doc.fillColor(MUTED).font(FONT_REGULAR).fontSize(8)
      .text(formatDate(p.last_verified_at), C4.x + 6, y + 5, { width: C4.w - 12, lineBreak: false });

    y += ROW_H;
  }

  drawFooter(doc, pageNum, totalPages, data.generatedAt, logo);
}

/**
 * Page 4 — Breach Timeline
 */
function renderBreachTimeline(
  doc: PDFKit.PDFDocument,
  data: ReportData,
  logo: Buffer | null,
  startPage: number,
  totalPages: number
): void {
  const breaches = data.breaches;
  let pageNum = startPage;
  let y = newPage(doc, "04", "Breach Timeline",
    `${breaches.length} known data breach event(s) linked to your identity`, logo);

  if (breaches.length === 0) {
    doc.roundedRect(MARGIN, y + 8, CONTENT_W, 56, 4).fill(OFF_WHITE);
    doc.fillColor(GREEN).font(FONT_BOLD).fontSize(14)
      .text("No breaches detected.", MARGIN + 14, y + 16, { width: CONTENT_W - 28 });
    doc.fillColor(MUTED).font(FONT_REGULAR).fontSize(9)
      .text("Your connected accounts do not appear in any known data breach databases.",
        MARGIN + 14, y + 34, { width: CONTENT_W - 28 });
    drawFooter(doc, pageNum, totalPages, data.generatedAt, logo);
    return;
  }

  for (let i = 0; i < breaches.length; i++) {
    const b       = breaches[i]!;
    const CARD_H  = 72;

    if (y > PAGE_HEIGHT - CARD_H - 50) {
      drawFooter(doc, pageNum, totalPages, data.generatedAt, logo);
      pageNum++;
      y = newPage(doc, "04", "Breach Timeline", "continued", logo);
    }

    // Card background
    doc.roundedRect(MARGIN, y, CONTENT_W, CARD_H, 6).fill(OFF_WHITE);
    // Red left edge
    doc.roundedRect(MARGIN, y, 4, CARD_H, 2).fill(RED);

    // Event name
    doc.fillColor(NAVY).font(FONT_BOLD).fontSize(12)
      .text(b.event_name, MARGIN + 16, y + 10, { width: 240 });

    // Meta pills row
    const META_Y = y + 30;
    // Service pill
    doc.roundedRect(MARGIN + 16, META_Y, 90, 14, 7).fill(NAVY3);
    doc.fillColor(WHITE).font(FONT_REGULAR).fontSize(7)
      .text(b.service_name, MARGIN + 16, META_Y + 4, { width: 90, align: "center" });
    // Email pill
    doc.roundedRect(MARGIN + 114, META_Y, 140, 14, 7).fill(NAVY3);
    doc.fillColor(ACCENT).font(FONT_REGULAR).fontSize(7)
      .text(b.email, MARGIN + 114, META_Y + 4, { width: 140, align: "center" });
    // Date pill
    doc.roundedRect(MARGIN + 262, META_Y, 90, 14, 7).fill(RED_DIM);
    doc.fillColor(WHITE).font(FONT_REGULAR).fontSize(7)
      .text(formatDate(b.date), MARGIN + 262, META_Y + 4, { width: 90, align: "center" });

    // Description
    if (b.description) {
      const desc = b.description.length > 140 ? b.description.slice(0, 137) + "..." : b.description;
      doc.fillColor(MUTED).font(FONT_REGULAR).fontSize(8)
        .text(desc, MARGIN + 16, y + 50, { width: CONTENT_W - 32, lineBreak: false });
    }

    y += CARD_H + 10;
  }

  drawFooter(doc, pageNum, totalPages, data.generatedAt, logo);
}

/**
 * Page 5 — Deletion Roadmap
 */
function renderDeletionRoadmap(
  doc: PDFKit.PDFDocument,
  data: ReportData,
  logo: Buffer | null,
  startPage: number,
  totalPages: number
): void {
  const highRisk = data.shadowProfiles.filter((p) => p.risk_level >= 3);
  let pageNum = startPage;
  let y = newPage(doc, "05", "Deletion Roadmap",
    `${highRisk.length} high-priority ghost accounts recommended for removal`, logo);

  const C1 = { label: "Site Name",     x: MARGIN,       w: 148 };
  const C2 = { label: "Risk",          x: MARGIN + 148, w: 70  };
  const C3 = { label: "Last Verified", x: MARGIN + 218, w: 100 };
  const C4 = { label: "Deletion Link", x: MARGIN + 318, w: 194 };
  const COLS = [C1, C2, C3, C4];

  y = tableHeader(doc, y, COLS);

  if (highRisk.length === 0) {
    doc.roundedRect(MARGIN, y + 8, CONTENT_W, 56, 4).fill(OFF_WHITE);
    doc.fillColor(GREEN).font(FONT_BOLD).fontSize(14)
      .text("All clear.", MARGIN + 14, y + 16, { width: CONTENT_W - 28 });
    doc.fillColor(MUTED).font(FONT_REGULAR).fontSize(9)
      .text("No high-priority ghost accounts flagged. Your digital footprint looks clean.",
        MARGIN + 14, y + 34, { width: CONTENT_W - 28 });
    drawFooter(doc, pageNum, totalPages, data.generatedAt, logo);
    return;
  }

  const riskMeta = (level: number): { label: string; color: string } => {
    if (level >= 4) return { label: "HIGH",   color: RED   };
    return              { label: "MEDIUM", color: AMBER };
  };

  for (let i = 0; i < highRisk.length; i++) {
    const p    = highRisk[i]!;
    const risk = riskMeta(p.risk_level);

    if (y > PAGE_HEIGHT - 76) {
      drawFooter(doc, pageNum, totalPages, data.generatedAt, logo);
      pageNum++;
      y = newPage(doc, "05", "Deletion Roadmap", "continued", logo);
      y = tableHeader(doc, y, COLS);
    }

    let deletionUrl = "";
    try {
      deletionUrl = `${new URL(p.profile_url).origin}/settings/delete`;
    } catch {
      deletionUrl = p.profile_url;
    }
    const truncDel = deletionUrl.length > 40
      ? deletionUrl.slice(0, 37) + "..."
      : deletionUrl;

    const ROW_H = 18;
    if (i % 2 === 0) {
      doc.rect(MARGIN, y, CONTENT_W, ROW_H).fill(OFF_WHITE);
      doc.rect(MARGIN, y, 2, ROW_H).fill(risk.color);
    } else {
      doc.rect(MARGIN, y, CONTENT_W, ROW_H).fill(WHITE);
    }

    doc.fillColor(NAVY).font(FONT_BOLD).fontSize(8)
      .text(p.site_name, C1.x + 6, y + 5, { width: C1.w - 12, lineBreak: false });

    riskBadge(doc, C2.x + 6, y + 3, risk.label, risk.color);

    doc.fillColor(MUTED).font(FONT_REGULAR).fontSize(8)
      .text(formatDate(p.last_verified_at), C3.x + 6, y + 5, { width: C3.w - 12, lineBreak: false });
    doc.fillColor(ACCENT).font(FONT_REGULAR).fontSize(8)
      .text(truncDel, C4.x + 6, y + 5, { width: C4.w - 12, lineBreak: false });

    y += ROW_H;
  }

  y += 16;
  rule(doc, y);
  y += 12;
  doc.fillColor(MUTED).font(FONT_REGULAR).fontSize(7.5)
    .text(
      "Deletion links are best-effort estimates based on common account settings paths. Always verify the correct URL via the service's official help documentation.",
      MARGIN, y, { width: CONTENT_W, lineGap: 2 }
    );

  drawFooter(doc, pageNum, totalPages, data.generatedAt, logo);
}

// ── PDF assembly ─────────────────────────────────────────────────────────────

export async function buildReportPdf(data: ReportData): Promise<Buffer> {
  const logo = await fetchLogoBuffer();

  // Rough total-page estimate for the footer counter
  const totalPages = 6;

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "LETTER",
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
      autoFirstPage: true,
      info: {
        Title:    "GhostSweep Identity Audit",
        Author:   "GhostSweep",
        Subject:  `Identity Audit for ${data.userEmail}`,
        Keywords: "privacy, identity, audit, ghostsweep",
      },
    });

    const chunks: Buffer[] = [];
    doc.on("data",  (chunk: Buffer) => chunks.push(chunk));
    doc.on("end",   () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    // Page 0 — cover (auto-created first page)
    renderCoverPage(doc, data, logo);

    // Page 1 — executive summary
    doc.addPage();
    renderExecutiveSummary(doc, data, logo, 2, totalPages);

    // Pages 2-5
    renderInboxDiscovery(doc, data,  logo, 3, totalPages);
    renderShadowWeb(doc, data,       logo, 4, totalPages);
    renderBreachTimeline(doc, data,  logo, 5, totalPages);
    renderDeletionRoadmap(doc, data, logo, 6, totalPages);

    doc.end();
  });
}

// ── Supabase Storage upload ──────────────────────────────────────────────────

const STORAGE_BUCKET = "reports";

/**
 * Upload the PDF buffer to Supabase Storage.
 * Returns the public URL for the uploaded file.
 *
 * Path: reports/{userId}/identity-audit.pdf
 */
export async function uploadReportToStorage(
  userId: string,
  pdf: Buffer
): Promise<string> {
  const storagePath = `${userId}/identity-audit.pdf`;

  console.log(`[report] Uploading PDF to storage: ${storagePath}`);

  const { error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(storagePath, pdf, {
      contentType: "application/pdf",
      upsert: true,
    });

  if (error) {
    console.error("[report] Storage upload error:", error.message);
    throw error;
  }

  // Bucket is private — generate a long-lived signed URL (1 year).
  const { data: signedData, error: signedError } = await supabase.storage
    .from(STORAGE_BUCKET)
    .createSignedUrl(storagePath, 60 * 60 * 24 * 365);

  if (signedError || !signedData?.signedUrl) {
    console.error("[report] Failed to create signed URL:", signedError?.message);
    throw signedError ?? new Error("No signed URL returned.");
  }

  const publicUrl = signedData.signedUrl;
  console.log(`[report] PDF available at: ${publicUrl}`);
  return publicUrl;
}

// ── Realtime broadcast ────────────────────────────────────────────────────────

/**
 * Broadcast a `report_ready` event on the user's personal channel
 * (`report:<userId>`) so the frontend can react in real time.
 * Non-fatal: any failure is logged and swallowed.
 */
async function broadcastReportReady(userId: string, publicUrl: string): Promise<void> {
  return new Promise((resolve) => {
    const channel = supabase.channel(`report:${userId}`);
    let settled = false;

    const finish = () => {
      if (!settled) {
        settled = true;
        supabase.removeChannel(channel).finally(() => resolve());
      }
    };

    // Safety timeout — never block the caller more than 6 s.
    const timer = setTimeout(() => {
      console.warn("[report] Realtime broadcast timed out.");
      finish();
    }, 6_000);

    channel.subscribe((status) => {
      if (status === "SUBSCRIBED") {
        channel
          .send({
            type: "broadcast",
            event: "report_ready",
            payload: {
              user_id: userId,
              url: publicUrl,
              generated_at: new Date().toISOString(),
            },
          })
          .then(() => {
            clearTimeout(timer);
            console.log(`[report] 📡 Realtime broadcast sent for user ${userId}.`);
            finish();
          })
          .catch((err) => {
            clearTimeout(timer);
            console.warn("[report] Realtime broadcast error:", err);
            finish();
          });
      }
    });
  });
}

// ── Main orchestrator ─────────────────────────────────────────────────────────

/**
 * Full pipeline: fetch data -> build PDF -> upload -> broadcast -> return public URL.
 */
export async function generateAndUploadReport(userId: string): Promise<string> {
  const data = await fetchReportData(userId);
  console.log(
    `[report] Building PDF — ${data.inboxAccounts.length} inbox accounts, ` +
    `${data.shadowProfiles.length} shadow profiles, ${data.breaches.length} breaches.`
  );

  const pdf = await buildReportPdf(data);
  console.log(`[report] PDF built — ${pdf.byteLength} bytes.`);

  const publicUrl = await uploadReportToStorage(userId, pdf);
  await broadcastReportReady(userId, publicUrl);
  return publicUrl;
}
