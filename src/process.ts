// One call, end to end: route it, and if it's archivable download the recording
// (a WAV) and stream it into Drive. Every call produces exactly one log line
// and one row in processed_calls. Shared by the webhook handler and the backfill
// so both behave identically.

import { Readable } from "node:stream";
import { downloadRecording, getCall } from "./cloudtalk.js";
import { recordResult } from "./db.js";
import { resolveFolderPath, uploadMp3 } from "./drive.js";
import {
  buildFilename,
  driveRootEnvVar,
  folderSegments,
  resolveAgentIdentity,
  routeCall,
} from "./router.js";
import type { CloudtalkCall, ProcessedAction } from "./types.js";

export function log(fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...fields }));
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Agents tag the disposition during a ~30s wrap-up window AFTER the call ends,
// but CloudTalk fires the "Call Ended" webhook the instant it ends — so the
// first fetch often sees an empty Tags[]. Same shape as the recording-download
// retry in cloudtalk.ts: poll the call detail with backoff (~3 min total,
// covering the wrap-up window plus a late-tagging buffer) before giving up.
const TAG_POLL_DELAYS_MS = [15000, 15000, 30000, 60000, 60000];

// Only poll calls that ended recently. Anything older either has its tag
// already or never will.
const TAG_POLL_MAX_AGE_MS = 5 * 60 * 1000;

// When the call ended. If ended_at is missing or unparseable, assume it just
// ended: polling only runs for webhook-triggered calls, and the webhook fires
// at call end.
function endedAtMs(call: CloudtalkCall): number {
  const raw = call.Cdr.ended_at;
  if (raw) {
    const ms = new Date(raw).getTime();
    if (!Number.isNaN(ms)) return ms;
  }
  return Date.now();
}

// Re-fetch the call until Tags[] is non-empty or the delays run out. Returns
// the freshest call object either way; the caller routes whatever comes back.
async function pollForTags(call: CloudtalkCall, start: number): Promise<CloudtalkCall> {
  const callId = String(call.Cdr.id);

  for (let attempt = 0; attempt < TAG_POLL_DELAYS_MS.length; attempt++) {
    const nextDelayMs = TAG_POLL_DELAYS_MS[attempt] as number;
    log({
      level: "info",
      msg: "tag not present yet, polling",
      call_id: callId,
      attempt: attempt + 1,
      next_delay_ms: nextDelayMs,
      elapsed_ms: Date.now() - start,
    });
    await sleep(nextDelayMs);

    try {
      const fresh = await getCall(callId);
      if ((fresh.Tags ?? []).length > 0) {
        log({
          level: "info",
          msg: "tag appeared on retry",
          call_id: callId,
          attempt: attempt + 1,
          elapsed_ms: Date.now() - start,
          tag_names: fresh.Tags.map((t) => t.name),
        });
        return fresh;
      }
      call = fresh;
    } catch (err) {
      // A transient fetch failure shouldn't abort the call: keep the last good
      // object and let the remaining attempts try again.
      log({
        level: "warn",
        msg: "tag poll fetch failed",
        call_id: callId,
        attempt: attempt + 1,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return call;
}

export interface ProcessOutcome {
  call_id: string;
  agent: string | null;
  disposition: string | null;
  action: ProcessedAction;
  drive_file_id: string | null;
  duration_ms: number;
  error?: string;
}

export async function processCall(
  call: CloudtalkCall,
  options: { pollForTags?: boolean } = {},
): Promise<ProcessOutcome> {
  const start = Date.now();
  const callId = String(call.Cdr.id);

  // Webhook-triggered calls may arrive before the agent has tagged the
  // disposition (see TAG_POLL_DELAYS_MS above). Backfill passes no options:
  // its calls are old enough that the tag is either set or never coming, and
  // polling would add minutes per untagged call.
  if (
    options.pollForTags &&
    (call.Tags ?? []).length === 0 &&
    Date.now() - endedAtMs(call) < TAG_POLL_MAX_AGE_MS
  ) {
    call = await pollForTags(call, start);
  }

  // Resolved identity, not the raw CloudTalk firstname: calls made from Frank's
  // seat are Joe's. This is what gets written to processed_calls.agent_name and
  // what drives the folder path, so reporting stays accurate going forward.
  // Rows already written as "Frank" are left untouched.
  const agent = resolveAgentIdentity(call.Agent?.firstname);
  const route = routeCall(call);

  const finish = (
    action: ProcessedAction,
    disposition: string | null,
    driveFileId: string | null,
    extra?: { error?: string; tags?: string[]; filename?: string },
  ): ProcessOutcome => {
    recordResult({
      call_id: callId,
      agent_name: agent,
      disposition,
      action,
      drive_file_id: driveFileId,
    });
    const outcome: ProcessOutcome = {
      call_id: callId,
      agent,
      disposition,
      action,
      drive_file_id: driveFileId,
      duration_ms: Date.now() - start,
    };
    if (extra?.error) outcome.error = extra.error;
    const line: Record<string, unknown> = { ...outcome };
    if (extra?.tags) line.tags = extra.tags;
    if (extra?.filename) line.filename = extra.filename;
    log(line);
    return outcome;
  };

  if (route.kind === "skip") {
    // No recognized disposition is the one case worth a louder record: keep the
    // full tag list so we can spot a new UI label we haven't mapped yet.
    const extra = route.action === "skipped_no_disposition" ? { tags: route.tagNames } : undefined;
    return finish(route.action, route.disposition, null, extra);
  }

  // Archive path.
  try {
    // Joe files under his own Drive root with no agent level; everyone else
    // keeps {Agent}/{Disposition}/{YYYY-MM} under the shared root.
    const segments = folderSegments(agent, route.folderName, call.Cdr.started_at);
    const folderId = await resolveFolderPath(segments, driveRootEnvVar(agent));
    const filename = buildFilename(call);

    const result = await downloadRecording(callId);
    if (!result.ok) {
      if (result.status === 410) {
        // Recording purged after CloudTalk's retention window. Store the row and
        // do not retry: the audio is gone for good.
        return finish("skipped_expired", route.disposition, null, {
          error: `recording expired (410 gone): ${result.detail}`,
        });
      }
      // Anything else is a genuine failure. JSON bodies are the clearest signal
      // the API returned an error (this is how 404s surface).
      const label = result.errorJson ? "api returned error json" : "bad recording response";
      return finish("failed", route.disposition, null, {
        error: `${label}: ${result.detail}`,
      });
    }

    // Stream the web ReadableStream straight into the Drive upload, no buffering.
    const stream = Readable.fromWeb(result.body as Parameters<typeof Readable.fromWeb>[0]);
    const fileId = await uploadMp3({ folderId, filename, body: stream });

    // filename in the log line: the only way to confirm from prod logs that
    // Contact.address actually resolved for Joe's calls rather than silently
    // falling back to Unknown_{digits}.
    return finish("archived", route.disposition, fileId, { filename });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return finish("failed", route.disposition, null, { error });
  }
}
