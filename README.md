# ghostsweep-orchestration

The scan backend for [GhostSweep](https://ghostsweep.com). It finds where a person's usernames show up across popular public websites (Maigret's top 500 by default) using [Maigret](https://github.com/soxoj/maigret), filters out false matches, stores the results in Supabase, and emails the user a report.

It runs in two places:

| Where | What runs | Entry point |
|---|---|---|
| **Fly.io** (`ghostsweep-orchestration`) | Express API: on-demand scans, free teaser scans, new-user webhook, PDF reports | `src/index.ts` |
| **GitHub Actions** (every Monday 06:00 UTC) | Weekly Maigret scan of every user + weekly email | `src/scan-all.ts` |

## How a scan works

```
selector (username / email)
   │
   ▼
Maigret  ──►  verifyProfiles  ──►  shadow_profiles  ──►  email
(top 500 sites) (drop pages that      (Supabase)
                don't match the
                user's name/email)
```

1. **Selectors** — what we search for — live in `user_selectors` (`username`, `email`, `phone`). For an email, Maigret searches the part before the `@`.
2. **Maigret** runs as a subprocess (no shell) and writes JSON into a private temp folder under `./reports/`, which is deleted as soon as the results are parsed (`src/scanner.ts`). Concurrent scans of the same username don't interfere.
3. **Verification** fetches each "claimed" profile page and keeps it only if it mentions the user's name or email prefix (`src/verification.ts`). This removes most same-username-different-person hits.
4. **Ingestion** upserts verified profiles into `shadow_profiles`, keyed on `(user_id, profile_url)` (`src/ingestion.ts`).
5. **Progress** is written to `shadow_scans` as the scan moves through its steps, so the dashboard can show a progress bar (`src/scan-progress.ts`). With several selectors, progress is spread across them so it only moves forward.

**Scan size depends on the plan** (`src/plans.ts`): users whose `user_subscriptions.current_plan` is `pro` or `buster` get Maigret's full site list (`-a`, 3,000+ sites, ~9 min per username, 30 min timeout). Everyone else, and the public teaser, gets the top 500 sites (5 min timeout). This applies to on-demand and weekly scans.

The on-demand pipeline (`POST /scan/:userId` and the webhook) lives in `src/pipeline.ts`. Each selector fails independently; the scan is marked `failed` only if every selector failed.

On-demand scans (`POST /scan/:userId` and the new-user webhook) also look up breaches and recalculate the exposure score (`src/scoring.ts`). The weekly scan is **Maigret only**: no breach lookup, no scoring, and phone selectors are skipped.

## Getting started

**Requirements:** Node 22+, Python 3.10+, and either Maigret on your `PATH` or Docker running (the scanner falls back to the `soxoj/maigret` image).

```bash
npm install

# Maigret in a local venv (same as CI)
python3 -m venv .venv
.venv/bin/pip install maigret
export PATH="$PWD/.venv/bin:$PATH"

cp .env.example .env   # then fill in the values below
npm run dev            # API on http://localhost:8080 with reload
```

### Environment variables

| Variable | Used for |
|---|---|
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Service-role key — bypasses RLS, **keep it server-side** |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | Rate limiting: 3 full scans per user per hour, 3 teaser scans per IP per hour |
| `RESEND_API_KEY` | Sending report emails |
| `PORT` | API port (default `8080`) |
| `NODE_ENV` | Reported to Sentry as the environment |

> ⚠️ Every script talks to the **production** Supabase project defined in `.env`. There is no separate dev database, so local scans write real rows and can email real users.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Run the API with auto-reload (nodemon + tsx) |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run scan:all` | Weekly scan for **all** users, then send each one the weekly email |
| `npm run scan:all -- --no-email` | Same scan, no emails, and `last_weekly_report` is left untouched |
| `npx tsx src/test-scan.ts <user_id>` | Run the full on-demand pipeline for one user (sends the scan report email) |

There is no automated test suite yet (`npm test` is a placeholder).

## API

All routes are in `src/index.ts`. Routes marked 🔒 need `Authorization: Bearer <supabase access token>`. CORS allows `ghostsweep.com`, `www.ghostsweep.com` and `localhost:3000`.

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/health` | Liveness check |
| `POST` | `/scan/:userId` 🔒 | Scan all of a user's selectors in the background. Returns `429` when over the rate limit. Body may include `scan_id` to report progress on an existing `shadow_scans` row. Emails the scan report ~2 minutes after finishing. |
| `POST` | `/api/scan/teaser` | Public lead-gen scan. Body: `{ username, email? }`. Maigret top-500 sites, no verification; results saved with `is_teaser = true`; returns `202` with `scan_id`, or `429` when the IP is over the limit. |
| `GET` | `/api/scan/teaser/:scanId/progress` | Server-sent events stream of teaser scan progress (closed after 15 minutes at most) |
| `POST` | `/api/report/:userId` 🔒 | Generate the Identity Audit PDF in the background and upload it to the `reports` storage bucket |
| `GET` | `/api/report/:userId` 🔒 | Signed URL (valid 1 hour) for the latest generated PDF |
| `POST` | `/webhook/new-user` | Supabase database webhook on user `INSERT`: saves selectors from the signup and starts a first scan of the email selector. Not authenticated. |

## Weekly scan

`.github/workflows/weekly-scan.yml` installs Maigret and runs `npx tsx src/scan-all.ts`. For each user with a username or email selector it:

1. Snapshots the user's current `shadow_profiles` so new ones can be identified afterwards (the table has no `created_at`).
2. Runs Maigret + verification on each selector, oldest `last_scanned_at` first.
3. Sends the **Weekly Public Profile Scan** email: total profiles, how many are new, and a list linking to each profile with new ones tagged.
4. Sets `user_subscriptions.last_weekly_report`, which is the start of the "new since" window next week (falls back to 7 days).

Scans run one user at a time and each Maigret run can take several minutes, so a full run takes hours. The workflow's `timeout-minutes: 120` is not enough to reach every user. Raise it, or split the run, before relying on the schedule.

The workflow needs these repository secrets: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, `RESEND_API_KEY`.

## Emails

All templates are in `src/email.ts`, built on a shared light-mode layout (`emailShell`) and sent through Resend from `support@ghostsweep.com`.

| Email | Sent by | Content |
|---|---|---|
| Identity Discovery Report | On-demand scan | Score, accounts found, breach count, 3 redacted sample sites |
| Weekly Public Profile Scan | Weekly scan | Maigret profiles, new ones flagged, next steps |
| Free scan results | Teaser scan | Count found + 3 sample sites, sign-up CTA |

Scan-derived text (site names, usernames) is HTML-escaped with `esc()` before it goes into a template.

## Deployment

The API deploys to Fly.io from the `Dockerfile`, which compiles TypeScript and installs Maigret into `/opt/maigret`:

```bash
fly deploy
fly secrets set RESEND_API_KEY=... SUPABASE_SERVICE_ROLE_KEY=...   # first time / rotation
```

Errors are reported to Sentry, which is configured in `src/instrumentation.ts` and loaded with `node --import`.

## Project layout

```
src/
  index.ts          Express app, routes, auth, rate limits
  pipeline.ts       On-demand scan pipeline (used by /scan and the webhook)
  plans.ts          Plan lookup: pro / buster → all-sites scan
  scan-all.ts       Weekly scan CLI (GitHub Actions)
  scanner.ts        Runs Maigret, parses its JSON
  verification.ts   Checks profile pages against the user's identity
  ingestion.ts      Writes shadow_profiles / services / selectors
  scoring.ts        Breach linking + 0–100 exposure score
  scan-progress.ts  shadow_scans step + progress updates
  teaser.ts         Public teaser scan (top 500 sites)
  webhook.ts        Supabase new-user webhook
  weekly-report.ts  Data for the weekly email
  email.ts          Email templates + Resend
  report.ts         Identity Audit PDF (pdfkit)
  supabase.ts       Service-role client
  redis.ts          Upstash rate limiter
  instrumentation.ts Sentry setup
reports/            Temporary Maigret output (one temp folder per scan, deleted after parsing; git-ignored)
```

## Supabase tables used

| Table | Role here |
|---|---|
| `user_selectors` | Usernames / emails / phones to scan; `last_scanned_at` |
| `shadow_profiles` | Verified public profiles found by Maigret (`is_teaser` marks free-scan rows) |
| `shadow_scans` | One row per scan run, with status, progress % and found count |
| `user_breaches`, `breaches` | Breach records (read by on-demand scans and the PDF) |
| `shadow_profile_breaches` | Links between profiles and breaches (currently always empty, because profile domains rarely match breached service domains) |
| `user_security_scores` | 0–100 exposure score |
| `user_subscriptions` | Plan, and `last_weekly_report` for the weekly email window |
