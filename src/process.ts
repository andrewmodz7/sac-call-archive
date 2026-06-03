// One call, end to end: route it, and if it's archivable download the recording
// (a WAV) and stream it into Drive. Every call produces exactly one log line
// and one row in processed_calls. Shared by the webhook handler and the backfill
// so both behave identically.

import { Readable } from "node:stream";
import { downloadRecording } from "./cloudtalk.js";
import { recordResult } from "./db.js";
import { resolveFolderPath, uploadMp3 } from "./drive.js";
import { buildFilename, monthFolder, routeCall } from "./router.js";
import type { CloudtalkCall, ProcessedAction } from "./types.js";

export function log(fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...fields }));
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

export async function processCall(call: CloudtalkCall): Promise<ProcessOutcome> {
  const start = Date.now();
  const callId = String(call.Cdr.id);
  const agent = call.Agent?.firstname ?? null;
  const route = routeCall(call);

  const finish = (
    action: ProcessedAction,
    disposition: string | null,
    driveFileId: string | null,
    extra?: { error?: string; tags?: string[] },
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
    const segments = [agent ?? "Unknown Agent", route.folderName, monthFolder(call.Cdr.started_at)];
    const folderId = await resolveFolderPath(segments);
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

    return finish("archived", route.disposition, fileId);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return finish("failed", route.disposition, null, { error });
  }
}
