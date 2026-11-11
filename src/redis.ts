import { Redis } from "@upstash/redis";
import { Ratelimit } from "@upstash/ratelimit";
import dotenv from "dotenv";

dotenv.config();

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

/**
 * Full on-demand scans (POST /scan/:userId), keyed per user.
 * Each scan runs Maigret once per selector (minutes each), so this is
 * deliberately tight.
 */
const scanRatelimit = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(3, "1 h"),
  analytics: true,
  prefix: "ratelimit:scan",
});

/**
 * Public teaser scans (POST /api/scan/teaser), keyed per client IP.
 * Unauthenticated, starts a Maigret run and can send an email, so it must be
 * limited to stop abuse.
 */
const teaserRatelimit = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(3, "1 h"),
  analytics: true,
  prefix: "ratelimit:teaser",
});

export { redis, scanRatelimit, teaserRatelimit };
