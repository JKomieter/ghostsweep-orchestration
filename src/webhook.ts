import { Router } from "express";
import * as Sentry from "@sentry/node";
import supabase from "./supabase.js";
import { extractEmailPrefix } from "./scanner.js";
import { createScanRow, runUserScan, type UserSelector } from "./pipeline.js";

/**
 * Supabase webhook payload types.
 */
interface WebhookPayload<T = Record<string, unknown>> {
  type: "INSERT" | "UPDATE";
  table: string;
  schema: string;
  record: T;
  old_record: T | null;
}

/**
 * Shape of the user record we expect from the webhook.
 * Covers both auth.users and a custom profiles table.
 */
interface UserRecord {
  id: string;
  email?: string;
  raw_user_meta_data?: {
    full_name?: string;
    name?: string;
    first_name?: string;
    last_name?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/**
 * Extract usable selectors (email, username derived from name/email) from a new user record.
 */
function extractSelectors(
  record: UserRecord
): Array<{ selector_type: string; selector_value: string }> {
  const selectors: Array<{ selector_type: string; selector_value: string }> = [];

  // Email selector
  if (record.email) {
    selectors.push({ selector_type: "email", selector_value: record.email });
  }

  // Username selectors derived from names
  const meta = record.raw_user_meta_data;
  if (meta) {
    const names = new Set<string>();

    if (meta.full_name) names.add(meta.full_name.trim().toLowerCase().replace(/\s+/g, ""));
    if (meta.name) names.add(meta.name.trim().toLowerCase().replace(/\s+/g, ""));

    if (meta.first_name && meta.last_name) {
      const first = meta.first_name.trim().toLowerCase();
      const last = meta.last_name.trim().toLowerCase();
      names.add(`${first}${last}`);
      names.add(`${first}.${last}`);
      names.add(`${first}_${last}`);
    }

    for (const name of names) {
      if (name) {
        selectors.push({ selector_type: "username", selector_value: name });
      }
    }
  }

  // Also derive a username from the email prefix
  if (record.email) {
    const prefix = extractEmailPrefix(record.email);
    const alreadyAdded = selectors.some(
      (s) => s.selector_type === "username" && s.selector_value === prefix
    );
    if (!alreadyAdded && prefix) {
      selectors.push({ selector_type: "username", selector_value: prefix });
    }
  }

  return selectors;
}

/**
 * Create the Express router for webhook endpoints.
 */
export function createWebhookRouter(): Router {
  const router = Router();

  /**
   * POST /webhook/new-user
   *
   * Called by Supabase Database Webhook on INSERT into auth.users (or profiles).
   * Extracts email + name-based selectors, persists them, and kicks off
   * an immediate scan on the email.
   */
  router.post("/new-user", async (req, res) => {
    try {
      const payload = req.body as WebhookPayload<UserRecord>;

      if (payload.type !== "INSERT") {
        res.status(200).json({ message: "Ignored non-INSERT event." });
        return;
      }

      const record = payload.record;
      const userId = record.id;

      if (!userId) {
        res.status(400).json({ error: "Missing user id in record." });
        return;
      }

      console.log(`[webhook] New user signup: ${userId} (${record.email ?? "no email"})`);

      // 1. Extract selectors from the user record
      const selectors = extractSelectors(record);

      if (selectors.length === 0) {
        console.warn("[webhook] No selectors could be extracted.");
        res.status(200).json({ message: "No selectors extracted.", userId });
        return;
      }

      console.log(`[webhook] Extracted ${selectors.length} selector(s):`, selectors);

      // 2. Insert selectors into user_selectors (ignore duplicates)
      const selectorRows = selectors.map((s) => ({
        user_id: userId,
        selector_type: s.selector_type,
        selector_value: s.selector_value,
      }));

      const columns = "id, user_id, selector_type, selector_value";
      let { data: stored, error: selectorErr } = await supabase
        .from("user_selectors")
        .upsert(selectorRows, { onConflict: "user_id, selector_value" })
        .select(columns);

      if (selectorErr) {
        // If upsert fails due to a missing unique constraint, fall back to insert
        console.warn("[webhook] Upsert selectors warning:", selectorErr.message);
        ({ data: stored, error: selectorErr } = await supabase
          .from("user_selectors")
          .insert(selectorRows)
          .select(columns));

        if (selectorErr) {
          console.error("[webhook] Failed to insert selectors:", selectorErr.message);
          res.status(500).json({ error: "Failed to store selectors." });
          return;
        }
      }

      // 3. First scan: only the email selector (Maigret on the prefix + breach
      //    lookup), so the user gets results quickly. Name-based usernames are
      //    picked up by the weekly scan or the next on-demand scan.
      const emailSelector = (stored as UserSelector[] | null)?.find(
        (s) => s.selector_type === "email"
      );

      if (emailSelector) {
        setImmediate(async () => {
          const scanId = await createScanRow(userId);
          try {
            await runUserScan(userId, [emailSelector], {
              scanId,
              onSelectorError: (sel, err) => {
                Sentry.captureException(err, {
                  tags: { endpoint: "webhook", selector_type: sel.selector_type },
                  extra: { userId, scanId },
                });
              },
            });
          } catch (err) {
            Sentry.captureException(err, { tags: { endpoint: "webhook" }, extra: { userId, scanId } });
            console.error(`[webhook] Background scan error for user ${userId}:`, err);
          }
        });
      }

      res.status(200).json({
        message: emailSelector ? "User selectors created. Scan initiated." : "User selectors created.",
        userId,
        selectors: selectors.length,
      });
    } catch (err) {
      console.error("[webhook] Unhandled error:", err);
      res.status(500).json({ error: "Internal server error." });
    }
  });

  return router;
}
