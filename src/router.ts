// Routing decisions and naming. Pure functions, no IO. Given a call object this
// decides whether to archive (and into which folder) or skip (and why), and
// builds the Drive folder path + filename.
//
// Everything here keys off the *resolved* agent identity, not the raw CloudTalk
// firstname. See resolveAgentIdentity below.

import type { CloudtalkCall, ProcessedAction } from "./types.js";

// --- Agent identity ---------------------------------------------------------

// Joe (acquisitions cold calling) makes his calls while logged into Frank
// Deliessche's CloudTalk seat. There is no separate "Joe" user in CloudTalk, so
// every call that comes back with Agent.firstname === "Frank" is actually Joe's;
// Frank does not make these calls himself.
//
// This mapping is the ONLY place that fact lives. If Frank ever starts making
// his own calls, delete the entry and Frank routes as Frank again — nothing
// else needs to change. Historical rows already written as "Frank" are left
// alone on purpose; the override only affects calls processed from here on.
const AGENT_IDENTITY_OVERRIDES: Record<string, string> = {
  Frank: "Joe",
};

// Resolved identity constant. Joe gets his own disposition set, his own Drive
// root, and his own filename format; every other agent keeps the original
// behavior.
export const JOE = "Joe";

export function resolveAgentIdentity(rawFirstname: string | null | undefined): string | null {
  const raw = (rawFirstname ?? "").trim();
  if (!raw) return null;
  return AGENT_IDENTITY_OVERRIDES[raw] ?? raw;
}

function isJoe(agent: string | null): boolean {
  return agent === JOE;
}

// --- Dispositions -----------------------------------------------------------

// Dispositions we archive, per agent. Key is the exact Tags[].name string from
// CloudTalk, value is the folder name (some labels have characters that break
// paths). A tag absent from an agent's map is NOT archived: it either matches
// SKIP_DISPOSITIONS or falls through to skipped_no_disposition. Never guessed.

// Jay's set. Jay keeps his existing CloudTalk identity, folder structure and
// filename format; only this list changed.
const JAY_ARCHIVE_DISPOSITIONS: Record<string, string> = {
  "Brief Sent - Info Yes": "Brief Sent - Info Yes",
  "Appointment Set": "Appointment Set",
  "Newsletter Opt-in": "Newsletter Opt-in",
  "Callback Requested": "Callback Requested",
  "Wrong Person / Bad Contact": "Wrong Person - Bad Contact", // slash breaks folder paths
  "Not Interested": "Not Interested",
  "Do Not Call": "Do Not Call",
};

// Joe's set (the Frank seat). Note "Wrong Number", not "Wrong Person".
const JOE_ARCHIVE_DISPOSITIONS: Record<string, string> = {
  "Offer Appointment Set": "Offer Appointment Set",
  "Interested - More Info Needed": "Interested - More Info Needed",
  "Not Now - Nurture": "Not Now - Nurture",
  "Callback Requested": "Callback Requested",
  "Wrong Number / Bad Contact": "Wrong Number - Bad Contact", // slash breaks folder paths
  "Not Interested": "Not Interested",
  "Do Not Call": "Do Not Call",
};

// Jay's map is the default for every non-Joe agent, so routing stays correct
// whatever Jay's raw CloudTalk firstname turns out to be.
function archiveDispositions(agent: string | null): Record<string, string> {
  return isJoe(agent) ? JOE_ARCHIVE_DISPOSITIONS : JAY_ARCHIVE_DISPOSITIONS;
}

// Folder name for a disposition tag, if this agent archives it — the same
// mapping routeCall uses, exposed so the reminder email can resolve a
// disposition's Drive folder without duplicating (or drifting from) the
// slash-sanitization above. Undefined means the tag is skipped or
// unrecognized: no folder was ever going to exist for it.
export function archiveFolderName(agent: string | null, dispositionTagName: string): string | undefined {
  return archiveDispositions(agent)[dispositionTagName];
}

// Dispositions we recognize but intentionally do not archive, for every agent.
// "No Answer" stays here deliberately for both Jay and Joe: it is never
// downloaded and never filed, whatever other reference material may suggest.
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
  // Derived, not passed in, so the archive map can never disagree with the
  // identity used for the folder path and the agent_name row.
  const dispositions = archiveDispositions(resolveAgentIdentity(call.Agent?.firstname));

  // Order matters: recording flags first, then disposition. A call with no
  // recording or one flagged as voicemail never reaches a download.
  if (call.Cdr.recorded === false) {
    return { kind: "skip", action: "skipped_no_recording", disposition: null, tagNames };
  }
  if (call.Cdr.is_voicemail === true) {
    return { kind: "skip", action: "skipped_voicemail_flag", disposition: null, tagNames };
  }

  for (const name of tagNames) {
    const folder = dispositions[name];
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

// Day folder, MM-DD-YYYY. Merged directly into the disposition segment below
// (not a separate path level), so each disposition gets one folder per day.
export function dayFolder(startedAt: string): string {
  const p = easternParts(startedAt);
  return `${p.month}-${p.day}-${p.year}`;
}

// --- Drive location ---------------------------------------------------------

// Which env var holds the Drive root for this agent. Joe's recordings go to a
// completely separate Drive folder, not nested under the shared root at all.
export function driveRootEnvVar(agent: string | null): string {
  return isJoe(agent) ? "JOE_DRIVE_ROOT_FOLDER_ID" : "DRIVE_ROOT_FOLDER_ID";
}

// Folder segments beneath that root.
//   Jay (and any other agent): {Agent}/{Disposition MM-DD-YYYY}
//   Joe:                       {Disposition MM-DD-YYYY}   — his root is
//                              already agent-specific, so no agent level.
// Disposition and date are merged into a single segment (rather than nested
// disposition-then-month levels) so a day's recordings for a disposition live
// in one folder the reminder email can link to directly.
export function folderSegments(
  agent: string | null,
  folderName: string,
  startedAt: string,
): string[] {
  const dispositionDay = `${folderName} ${dayFolder(startedAt)}`;
  if (isJoe(agent)) return [dispositionDay];
  return [agent ?? "Unknown Agent", dispositionDay];
}

// --- Filenames --------------------------------------------------------------

export function buildFilename(call: CloudtalkCall): string {
  const agent = resolveAgentIdentity(call.Agent?.firstname);
  const p = easternParts(call.Cdr.started_at);
  const date = `${p.year}-${p.month}-${p.day}`;

  // CloudTalk serves WAV (confirmed live); we store the bytes as-is, no transcode.
  if (isJoe(agent)) {
    // Joe works from property addresses, so the address is the identifying
    // part of the name. No time component by request — see the collision note
    // in the README.
    return `${addressComponent(call)}_${date}.wav`;
  }

  // State leads the name so files in a folder group by state alphabetically.
  return `${stateComponent(call)}_${nameComponent(call)}_${date}_${p.hour}-${p.minute}.wav`;
}

// Contact.address, sanitized exactly like the name component. Missing/empty
// falls back to the prospect's phone digits, same shape as nameComponent.
function addressComponent(call: CloudtalkCall): string {
  const raw = (call.Contact?.address ?? "").trim();
  if (raw) {
    const sanitized = raw.replace(/\s+/g, "_").replace(/[^A-Za-z0-9_-]/g, "");
    if (sanitized) return sanitized;
  }
  const digits = (call.Cdr.public_external ?? "").replace(/\D/g, "");
  return `Unknown_${digits}`;
}

// Contact.state sanitized like the name. Missing/empty falls back to the literal
// "Unknown" (never skipped) so the filename keeps a consistent segment count.
function stateComponent(call: CloudtalkCall): string {
  const raw = (call.Contact?.state ?? "").trim();
  if (raw) {
    const sanitized = raw.replace(/\s+/g, "_").replace(/[^A-Za-z0-9_-]/g, "");
    if (sanitized) return sanitized;
  }
  return "Unknown";
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
