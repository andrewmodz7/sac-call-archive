// Routing decisions and naming. Pure functions, no IO. Given a call object this
// decides whether to archive (and into which folder) or skip (and why), and
// builds the Drive folder path + filename.

import type { CloudtalkCall, ProcessedAction } from "./types.js";

// Dispositions we archive. Key is the exact Tags[].name string from CloudTalk,
// value is the folder name (some labels have characters that break paths).
const ARCHIVE_DISPOSITIONS: Record<string, string> = {
  "Appointment Set": "Appointment Set",
  "Interested - No Book": "Interested - No Book",
  "Callback Requested": "Callback Requested",
  "Not Interested": "Not Interested",
  "Do Not Call": "Do Not Call",
  "Wrong Person / Bad Contact": "Wrong Person - Bad Contact", // slash breaks folder paths
};

// Dispositions we recognize but intentionally do not archive.
const SKIP_DISPOSITIONS = new Set([
  "Voicemail Message Left",
  "Voicemail No Message Left",
  "No Answer",
  "Ring Out",
  "User Cancel",
  "Number Not in Service",
  "Line Busy",
  "Call Blocked",
]);

export type RouteResult =
  | { kind: "archive"; folderName: string; disposition: string }
  | { kind: "skip"; action: ProcessedAction; disposition: string | null; tagNames: string[] };

export function routeCall(call: CloudtalkCall): RouteResult {
  const tagNames = (call.Tags ?? []).map((t) => t.name);

  // Order matters: recording flags first, then disposition. A call with no
  // recording or one flagged as voicemail never reaches a download.
  if (call.Cdr.recorded === false) {
    return { kind: "skip", action: "skipped_no_recording", disposition: null, tagNames };
  }
  if (call.Cdr.is_voicemail === true) {
    return { kind: "skip", action: "skipped_voicemail_flag", disposition: null, tagNames };
  }

  for (const name of tagNames) {
    const folder = ARCHIVE_DISPOSITIONS[name];
    if (folder) {
      return { kind: "archive", folderName: folder, disposition: name };
    }
  }

  for (const name of tagNames) {
    if (SKIP_DISPOSITIONS.has(name)) {
      return { kind: "skip", action: "skipped_disposition", disposition: name, tagNames };
    }
  }

  // No tag we recognize. Never guess a folder. Caller logs the full tag list.
  return { kind: "skip", action: "skipped_no_disposition", disposition: null, tagNames };
}

// CloudTalk timestamps carry a +02:00 offset. The archive is organized by the
// agent's local time (Eastern), so convert before deriving any date strings.
// Intl handles the DST math; no date library.
interface LocalParts {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
}

function easternParts(iso: string): LocalParts {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`invalid started_at: ${iso}`);
  }
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23", // 00-23, avoids the "24:00" midnight quirk
  }).formatToParts(d);

  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
  };
}

// Month folder, YYYY-MM so it sorts naturally.
export function monthFolder(startedAt: string): string {
  const p = easternParts(startedAt);
  return `${p.year}-${p.month}`;
}

export function buildFilename(call: CloudtalkCall): string {
  const p = easternParts(call.Cdr.started_at);
  const stamp = `${p.year}-${p.month}-${p.day}_${p.hour}-${p.minute}`;
  // CloudTalk serves WAV (confirmed live); we store the bytes as-is, no transcode.
  return `${nameComponent(call)}_${stamp}.wav`;
}

// Contact.name is a single string. Spaces become underscores, then strip
// anything outside [A-Za-z0-9_-]. If there's no usable name, fall back to the
// prospect's phone digits.
function nameComponent(call: CloudtalkCall): string {
  const raw = (call.Contact?.name ?? "").trim();
  if (raw) {
    const sanitized = raw.replace(/\s+/g, "_").replace(/[^A-Za-z0-9_-]/g, "");
    if (sanitized) return sanitized;
  }
  const digits = (call.Cdr.public_external ?? "").replace(/\D/g, "");
  return `Unknown_${digits}`;
}
