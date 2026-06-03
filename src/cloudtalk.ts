// CloudTalk API client: auth header, list/show endpoints, recording download,
// and the webhook signature check (stubbed until we capture a real signed
// request, see below).

import type { CloudtalkCall, ResponseData } from "./types.js";

const BASE_URL = "https://my.cloudtalk.io/api/";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function authHeader(): string {
  const id = requireEnv("CLOUDTALK_API_KEY_ID");
  const secret = requireEnv("CLOUDTALK_API_KEY_SECRET");
  return `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`;
}

// List endpoint, one page. Used by the backfill.
export async function listCalls(page: number, limit: number): Promise<ResponseData> {
  const url = `${BASE_URL}calls/index.json?page=${page}&limit=${limit}`;
  const res = await fetch(url, {
    headers: { Authorization: authHeader(), Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`index.json page ${page} failed: ${res.status} ${res.statusText}`);
  }
  const json = (await res.json()) as { responseData?: ResponseData };
  if (!json.responseData) throw new Error(`index.json page ${page}: missing responseData`);
  return json.responseData;
}

// Single call. The webhook payload may not carry the full call object, so we
// fetch it here using the list endpoint filtered to one call_id — CloudTalk has
// no working single-call detail path (calls/show.json/{id} 404s under its
// CakePHP routing). Same collections envelope as listCalls; we take data[0].
export async function getCall(callId: string): Promise<CloudtalkCall> {
  const url = `${BASE_URL}calls/index.json?call_id=${encodeURIComponent(callId)}&limit=1`;
  const res = await fetch(url, {
    headers: { Authorization: authHeader(), Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`index.json call_id=${callId} failed: ${res.status} ${res.statusText}`);
  }
  const json = (await res.json()) as { responseData?: ResponseData };
  const call = json.responseData?.data?.[0];
  if (!call) throw new Error(`getCall(${callId}) returned no items`);
  return call;
}

// Result of a recording download attempt. On success the caller streams `body`
// straight into Drive; on failure it has enough to record the row and log why.
export interface RecordingSuccess {
  ok: true;
  status: number;
  contentType: string;
  body: ReadableStream<Uint8Array>;
}
export interface RecordingFailure {
  ok: false;
  status: number;
  gone: boolean; // 410: recording purged after CloudTalk's retention window
  errorJson: boolean; // content-type was application/json (a 404/410 error body)
  detail: string; // status + headers + first 200 chars of body, for the log line
}
export type RecordingResult = RecordingSuccess | RecordingFailure;

// Download the recording.
//
// The real endpoint (confirmed with a live curl: 200 OK, 671KB valid WAV) is
//   https://my.cloudtalk.io/api/calls/recording/{call_id}.json
// built from Cdr.id. We ignore Cdr.recording_link entirely: it's the
// https://my.cloudtalk.io/r/play/{id} play-page redirect, not the audio.
//
// Content-type quirk: CloudTalk's docs claim audio/x-wav, but the live response
// actually returns `application/octet-stream` for the WAV bytes. So we accept a
// response as a recording when ANY of these holds:
//   a. content-type is audio/*                                    (documented)
//   b. octet-stream AND content-disposition filename ends .wav/.mp3
//   c. octet-stream AND content-length > 1024  (small bodies are JSON errors)
// Otherwise it's not a recording (HTML login page, JSON error, empty body): we
// return a failure carrying a body sample so the caller can log it.
//
// Retry: CloudTalk now fires the webhook on "Call Ended", so the handler can run
// before the recording finishes uploading — that window returns 404. We treat
// 404 (and any 5xx) as transient and retry with exponential backoff up to the
// delays below (~2.25 min total). 410 (purged after retention) is permanent and
// every other failure (auth, malformed, HTML) is immediate. On exhaustion we
// return the last failure unchanged so process.ts logic is untouched.
const RETRY_DELAYS_MS = [5000, 10000, 20000, 40000, 60000];

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function downloadRecording(callId: string): Promise<RecordingResult> {
  const url = `${BASE_URL}calls/recording/${encodeURIComponent(callId)}.json`;

  for (let attempt = 0; ; attempt++) {
    const result = await attemptDownload(url);
    if (result.ok) return result;

    // 404 = not uploaded yet; 5xx = transient server error. Both retry on the
    // same backoff/cap. 410 and everything else fall through and return.
    const retriable = result.status === 404 || (result.status >= 500 && result.status <= 599);
    const nextDelayMs = RETRY_DELAYS_MS[attempt];
    if (retriable && nextDelayMs !== undefined) {
      console.log(
        JSON.stringify({
          ts: new Date().toISOString(),
          level: "info",
          msg: "recording not ready, retrying",
          call_id: callId,
          attempt: attempt + 1,
          next_delay_ms: nextDelayMs,
        }),
      );
      await sleep(nextDelayMs);
      continue;
    }
    return result;
  }
}

// A single download attempt. Returns the recording stream on success, or a
// failure carrying enough detail to log and to decide whether to retry.
async function attemptDownload(url: string): Promise<RecordingResult> {
  const res = await fetch(url, {
    headers: { Authorization: authHeader() },
    redirect: "follow",
  });

  const status = res.status;
  const contentType = res.headers.get("content-type") ?? "";
  const contentDisposition = res.headers.get("content-disposition") ?? "";
  const contentLengthHeader = res.headers.get("content-length");
  const contentLength = contentLengthHeader ? Number(contentLengthHeader) : NaN;

  const isAudio = /^audio\//i.test(contentType);
  const isOctetStream = /^application\/octet-stream/i.test(contentType);
  const dispositionIsAudioFile = /filename=[^;]*\.(wav|mp3)\b/i.test(contentDisposition);
  const bigEnoughForAudio = Number.isFinite(contentLength) && contentLength > 1024;

  const accepted =
    res.ok &&
    (isAudio ||
      (isOctetStream && dispositionIsAudioFile) ||
      (isOctetStream && bigEnoughForAudio));

  if (accepted && res.body) {
    return { ok: true, status, contentType, body: res.body };
  }

  // Not a recording. Read a sample of the body for the failure log.
  const sample = (await res.text()).slice(0, 200);
  return {
    ok: false,
    status,
    gone: status === 410,
    errorJson: /^application\/json/i.test(contentType),
    detail:
      `status=${status} content-type=${contentType || "(none)"} ` +
      `content-length=${contentLengthHeader ?? "(none)"} body=${sample}`,
  };
}

// TODO(signature): CloudTalk signs webhook payloads with CLOUDTALK_WEBHOOK_SECRET,
// but the exact scheme (which header carries the signature, and the HMAC
// construction) isn't documented in a form we can confirm without a live
// request. We'll capture a real signed webhook when wiring it up in the
// CloudTalk dashboard and implement the check here.
//
// Until then this is a pass-through that logs a warning so it's obvious in the
// logs that verification is not yet enforced. Do not ship to production with
// this stub in place. The signature comes from the raw request body, which is
// why index.ts captures req.rawBody.
export function verifySignature(
  _rawBody: Buffer | undefined,
  _headers: Record<string, string | string[] | undefined>,
  secret: string,
): boolean {
  console.warn(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: "warn",
      msg: "webhook signature verification is stubbed, accepting request unverified (TODO before prod)",
      secret_configured: secret.length > 0,
    }),
  );
  return true;
}
