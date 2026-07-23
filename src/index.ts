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

// Manual trigger for the daily reminder email, so the send can be tested
// without waiting for 6 PM. Disabled entirely unless ADMIN_TRIGGER_TOKEN is
// set, and requires that token in the x-admin-token header. It sends a real
// email to the real recipients.
app.post("/admin/send-reminder", (req, res) => {
  const expected = process.env.ADMIN_TRIGGER_TOKEN ?? "";
  if (!expected) {
    // No token configured means the endpoint does not exist.
    res.status(404).json({ error: "not found" });
    return;
  }

  const provided = req.header("x-admin-token") ?? "";
  if (!tokensMatch(provided, expected)) {
    log({ level: "warn", action: "reminder_trigger_rejected" });
    res.status(401).json({ error: "invalid token" });
    return;
  }

  // Awaited so the caller sees the actual result, which is the whole point of
  // a test trigger. runReminderOnce never throws.
  void runReminderOnce("manual_endpoint").then((ok) => {
    res.status(ok ? 200 : 500).json({ ok });
  });
});

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
