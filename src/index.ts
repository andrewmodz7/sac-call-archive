// Express server. One webhook route plus a health check.
//
// Flow per CloudTalk's "recording uploaded" webhook:
//   1. verify the signature (stubbed for now, see cloudtalk.ts)
//   2. pull the call_id out of the payload
//   3. dedup against SQLite, return 200 immediately if seen
//   4. ack 200 fast so CloudTalk doesn't think we failed and retry
//   5. do the real work (route, download, upload) after the response, via setImmediate

import "dotenv/config";
import { timingSafeEqual } from "node:crypto";
import express, { type Request } from "express";
import { getCall, verifySignature } from "./cloudtalk.js";
import { isProcessed } from "./db.js";
import { log, processCall } from "./process.js";
import { runReminderOnce, startReminderScheduler } from "./scheduler.js";
import { runBackfill } from "./backfill.js";
import type { CloudtalkCall } from "./types.js";

const PORT = Number(process.env.PORT ?? 3000);
const WEBHOOK_SECRET = process.env.CLOUDTALK_WEBHOOK_SECRET ?? "";

// express.json buffers the body anyway; capture the raw bytes so signature
// verification can run against exactly what CloudTalk signed.
type RawRequest = Request & { rawBody?: Buffer };

const app = express();
app.use(
  express.json({
    verify: (req, _res, buf) => {
      (req as RawRequest).rawBody = buf;
    },
  }),
);

app.get("/health", (_req, res) => {
  res.status(200).json({ ok: true });
});

// Shared gate for the /admin routes. Returns true if the request is
// authorized; otherwise it has already written the response (404 when no token
// is configured, so the endpoint does not exist; 401 on a bad token). Both
// admin routes reuse ADMIN_TRIGGER_TOKEN.
function requireAdmin(req: Request, res: express.Response, action: string): boolean {
  const expected = process.env.ADMIN_TRIGGER_TOKEN ?? "";
  if (!expected) {
    res.status(404).json({ error: "not found" });
    return false;
  }
  const provided = req.header("x-admin-token") ?? "";
  if (!tokensMatch(provided, expected)) {
    log({ level: "warn", action });
    res.status(401).json({ error: "invalid token" });
    return false;
  }
  return true;
}

// Manual trigger for the daily reminder email, so the send can be tested
// without waiting for 8 PM. It sends a real email to the real recipients.
app.post("/admin/send-reminder", (req, res) => {
  if (!requireAdmin(req, res, "reminder_trigger_rejected")) return;

  // Awaited so the caller sees the actual result, which is the whole point of
  // a test trigger. runReminderOnce never throws.
  void runReminderOnce("manual_endpoint").then((ok) => {
    res.status(ok ? 200 : 500).json({ ok });
  });
});

// Manual trigger for the backfill, so it can run in-process where the Railway
// volume (and thus the dedup DB) is mounted, without railway ssh. Accepts
// `since` (YYYY-MM-DD) and `until` from either query string or JSON body, and
// `dryRun` (default TRUE — a real run must be asked for explicitly, so a bare
// call can never download or file anything by accident). Same dedup, rate
// limiting, and routing as the CLI.
app.post("/admin/backfill", (req, res) => {
  if (!requireAdmin(req, res, "backfill_trigger_rejected")) return;

  const body = (req.body ?? {}) as Record<string, unknown>;
  const since = pickParam(req, body, "since");
  const until = pickParam(req, body, "until");
  const dryRun = parseDryRun(req, body);

  log({ level: "info", action: "backfill_trigger", since, until, dry_run: dryRun });

  // A live run pages through CloudTalk with 1s sleeps and downloads recordings,
  // so it can take minutes. Respond when it finishes; the caller should use a
  // generous curl timeout.
  runBackfill({ since, until, dryRun })
    .then((summary) => {
      log({ level: "info", action: "backfill_trigger_complete", dry_run: dryRun });
      res.status(200).json({ ok: true, summary });
    })
    .catch((err) => {
      const error = err instanceof Error ? err.message : String(err);
      log({ level: "error", action: "backfill_trigger_failed", error });
      res.status(500).json({ ok: false, error });
    });
});

// Read a string param from the query string first, then the JSON body.
function pickParam(req: Request, body: Record<string, unknown>, name: string): string | undefined {
  const q = req.query[name];
  if (typeof q === "string" && q.length > 0) return q;
  const b = body[name];
  if (typeof b === "string" && b.length > 0) return b;
  return undefined;
}

// dryRun defaults to true. Only an explicit false (query ?dryRun=false or JSON
// {"dryRun": false}) opts into a real, downloading-and-filing run.
function parseDryRun(req: Request, body: Record<string, unknown>): boolean {
  const raw = req.query.dryRun ?? req.query.dry_run ?? body.dryRun ?? body.dry_run;
  if (raw === false || raw === "false" || raw === "0") return false;
  return true;
}

function tokensMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on length mismatch, so check that first. The length
  // itself is not secret.
  return a.length === b.length && timingSafeEqual(a, b);
}

// TODO(webhook-path): confirm this path when configuring the webhook in the
// CloudTalk dashboard, and update the README if it changes.
app.post("/webhooks/cloudtalk", (req, res) => {
  const rawBody = (req as RawRequest).rawBody;

  if (!verifySignature(rawBody, req.headers, WEBHOOK_SECRET)) {
    log({ level: "warn", action: "rejected_bad_signature" });
    res.status(401).json({ error: "invalid signature" });
    return;
  }

  const callId = extractCallId(req.body);
  if (!callId) {
    log({ level: "warn", action: "rejected_no_call_id" });
    res.status(400).json({ error: "missing call id" });
    return;
  }

  if (isProcessed(callId)) {
    log({ call_id: callId, action: "duplicate" });
    res.status(200).json({ ok: true, duplicate: true });
    return;
  }

  // Fast ack, then the slow work off the request path.
  res.status(200).json({ ok: true });

  setImmediate(async () => {
    try {
      // TODO(detail-endpoint): if the inline payload is missing/partial we fall
      // back to getCall(), but its calls/show.json/{id} endpoint does not exist.
      // Tomorrow's live webhook test tells us whether the payload carries the
      // full call inline (then we never need a detail fetch). If we do, point
      // getCall at the filtered list endpoint (GET /api/calls/index.json?call_id=)
      // which returns our existing list envelope. See cloudtalk.ts getCall().
      const inline = looksLikeCall(req.body) ? (req.body as CloudtalkCall) : null;
      const call = inline ?? (await getCall(callId));
      // Poll for the disposition tag: the webhook fires at call end, but agents
      // tag during the ~30s wrap-up window after. Backfill skips this.
      await processCall(call, { pollForTags: true });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log({ call_id: callId, action: "failed", error });
    }
  });
});

app.listen(PORT, () => {
  log({ level: "info", msg: `listening on ${PORT}` });
  // Daily reminder email. Registering it here keeps it inside this one
  // always-on service; it runs on its own timer and shares nothing with the
  // webhook path.
  startReminderScheduler();
});

// The webhook may carry the full call object or just an id. Try the known
// shapes; CloudTalk's exact payload gets confirmed during the live test.
function extractCallId(body: unknown): string | null {
  const b = body as Record<string, any> | null;
  const id =
    b?.Cdr?.id ?? b?.data?.Cdr?.id ?? b?.call_id ?? b?.callId ?? b?.id ?? null;
  return id != null ? String(id) : null;
}

function looksLikeCall(body: unknown): boolean {
  const b = body as Record<string, any> | null;
  return Boolean(b?.Cdr && b.Cdr.recording_link !== undefined);
}
