// Express server. One webhook route plus a health check.
//
// Flow per CloudTalk's "recording uploaded" webhook:
//   1. verify the signature (stubbed for now, see cloudtalk.ts)
//   2. pull the call_id out of the payload
//   3. dedup against SQLite, return 200 immediately if seen
//   4. ack 200 fast so CloudTalk doesn't think we failed and retry
//   5. do the real work (route, download, upload) after the response, via setImmediate

import "dotenv/config";
import express, { type Request } from "express";
import { getCall, verifySignature } from "./cloudtalk.js";
import { isProcessed } from "./db.js";
import { log, processCall } from "./process.js";
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
      await processCall(call);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log({ call_id: callId, action: "failed", error });
    }
  });
});

app.listen(PORT, () => {
  log({ level: "info", msg: `listening on ${PORT}` });
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
