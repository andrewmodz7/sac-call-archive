// The daily "review the recordings" email to Kenneth.
//
// Content is deliberately plain: short subject, no em dashes, no filler. Body
// is built with string concatenation, not a template engine, so there is only
// one way this email gets assembled.

import { countTodaysCallsByAgent, NO_DISPOSITION, type CallCounts } from "./call-counts.js";
import { findFolderReadOnly } from "./drive.js";
import { sendMail } from "./mailer.js";
import { log } from "./process.js";
import { archiveFolderName, driveRootEnvVar, folderSegments, JOE } from "./router.js";

// Per (agent, disposition) with at least one call today: the Drive folder id
// if one already exists (string), null if the disposition is archived but no
// folder has been created yet today, or the key is simply absent if this
// disposition is never archived for this agent (e.g. "No Answer") — nothing
// was ever going to exist there, so no lookup is attempted.
type FolderLinks = Record<string, Record<string, string | null>>;

// Recipients are env vars with the known-good addresses as defaults, so a
// change is a Railway env edit rather than a deploy.
const DEFAULT_TO = "kdanna@shoreacrescapital.com";
const DEFAULT_CC = "amodzelewski@shoreacrescapital.com";

export function reminderTo(): string {
  return process.env.KENNETH_EMAIL || DEFAULT_TO;
}

export function reminderCc(): string {
  return process.env.ANDREW_EMAIL_CC || DEFAULT_CC;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function folderLink(folderId: string): string {
  return `https://drive.google.com/drive/folders/${folderId}`;
}

// Jay's recordings sit one level down, at {DRIVE_ROOT_FOLDER_ID}/{Agent}/, and
// that subfolder's Drive id can't be derived without hardcoding his CloudTalk
// firstname. So it is supplied directly when we want the email to land in his
// folder rather than the shared root. Optional: unset falls back to the root,
// which is one click away from the same place.
function jayFolderId(): string {
  return process.env.JAY_DRIVE_FOLDER_ID || requireEnv("DRIVE_ROOT_FOLDER_ID");
}

// "July 23, 2026" in Eastern time. Same Intl-with-timeZone approach as
// easternParts in router.ts: no hardcoded offset, so it stays correct across
// both DST transitions.
export function displayDate(now: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(now);
}

export function reminderSubject(now: Date): string {
  return `Call Recordings - ${displayDate(now)}`;
}

// One agent's view of the day: label, total, and every disposition that had at
// least one call, highest count first.
interface AgentCallView {
  label: string;
  total: number;
  dispositions: Array<[string, number]>; // [name, count], sorted count desc
  folderLinks: Record<string, string | null>; // disposition name -> folder id, see FolderLinks
}

// Merge the disposition maps of a set of resolved agents into one, then sort
// count-descending (name ascending as a stable tiebreak). `wantJoe` selects
// Joe's own map when true, and every other agent's maps when false. This mirrors
// the total split: Joe is the one special-cased agent (Frank's seat, folded to
// "Joe" by resolveAgentIdentity) and everyone else folds to Jay, so the label
// stays correct whatever Jay's raw CloudTalk firstname is.
function mergedDispositions(counts: CallCounts, wantJoe: boolean): Array<[string, number]> {
  const merged: Record<string, number> = {};
  for (const [agent, byDisposition] of Object.entries(counts.dispositionsByAgent)) {
    if ((agent === JOE) !== wantJoe) continue;
    for (const [name, n] of Object.entries(byDisposition)) {
      merged[name] = (merged[name] ?? 0) + n;
    }
  }
  return Object.entries(merged).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

// Same split as mergedDispositions, applied to the folder-link results instead
// of the counts, so each view's disposition list and its links come from the
// same agent partition. A disposition present under more than one raw agent
// (not expected today, but not structurally impossible) prefers whichever
// resolved an actual folder id over a still-pending one.
function mergedFolderLinks(links: FolderLinks, counts: CallCounts, wantJoe: boolean): Record<string, string | null> {
  const merged: Record<string, string | null> = {};
  for (const agent of Object.keys(counts.dispositionsByAgent)) {
    if ((agent === JOE) !== wantJoe) continue;
    for (const [name, folderId] of Object.entries(links[agent] ?? {})) {
      if (merged[name] === undefined || folderId) merged[name] = folderId;
    }
  }
  return merged;
}

// Jay's and Joe's views for the day. Joe's total is his own resolved count and
// Jay's is "everything else" (total minus Joe), matching how mergedDispositions
// splits the per-disposition maps, so each agent's breakdown sums to their total.
function agentViews(counts: CallCounts, links: FolderLinks): AgentCallView[] {
  const joeTotal = counts.byAgent[JOE] ?? 0;
  return [
    {
      label: "Jay",
      total: counts.total - joeTotal,
      dispositions: mergedDispositions(counts, false),
      folderLinks: mergedFolderLinks(links, counts, false),
    },
    {
      label: "Joe",
      total: joeTotal,
      dispositions: mergedDispositions(counts, true),
      folderLinks: mergedFolderLinks(links, counts, true),
    },
  ];
}

// For each (agent, disposition) with at least one call today, resolve the
// Drive folder id if one already exists. Segments and root env var are built
// with the exact same router functions the archiver uses (folderSegments,
// driveRootEnvVar, archiveFolderName), so a hit lands on the folder_cache row
// archiving itself already wrote today and costs no extra Drive API call.
// A disposition this agent never archives (e.g. "No Answer") is skipped
// outright — no folder was ever going to exist for it. A single lookup
// failure degrades just that entry to "pending" rather than losing every
// link; fetchFolderLinksSafe is the outer guard against anything unexpected.
async function findDispositionFolderLinks(counts: CallCounts, now: Date): Promise<FolderLinks> {
  const startedAt = now.toISOString();
  const links: FolderLinks = {};

  for (const [agent, byDisposition] of Object.entries(counts.dispositionsByAgent)) {
    for (const [disposition, count] of Object.entries(byDisposition)) {
      if (count < 1 || disposition === NO_DISPOSITION) continue;

      const folderName = archiveFolderName(agent, disposition);
      if (!folderName) continue;

      const segments = folderSegments(agent, folderName, startedAt);
      let folderId: string | undefined;
      try {
        folderId = await findFolderReadOnly(segments, driveRootEnvVar(agent));
      } catch (err) {
        log({
          level: "warn",
          action: "reminder_folder_lookup_failed",
          agent,
          disposition,
          error: err instanceof Error ? err.message : String(err),
        });
        folderId = undefined;
      }
      (links[agent] ??= {})[disposition] = folderId ?? null;
    }
  }

  return links;
}

// Never-block-the-send wrapper, same pattern as fetchCallCountsSafe: any
// unexpected failure (auth, network, a bug in the lookup) is logged and
// swallowed, degrading every disposition line to plain text rather than
// blocking the send or throwing out of buildReminder.
export async function fetchFolderLinksSafe(counts: CallCounts, now: Date): Promise<FolderLinks> {
  try {
    return await findDispositionFolderLinks(counts, now);
  } catch (err) {
    log({
      level: "error",
      action: "reminder_folder_links_failed",
      error: err instanceof Error ? err.message : String(err),
    });
    return {};
  }
}

// One disposition line, plain-text part. Three states: a resolved folder id
// gets a link, `null` (archived disposition, folder not created yet) gets a
// note, and an absent entry (never archived, e.g. "No Answer") gets neither.
function dispositionLineText(name: string, n: number, folderId: string | null | undefined): string {
  if (folderId) return `  - ${name}: ${n} - ${folderLink(folderId)}`;
  if (folderId === null) return `  - ${name}: ${n} (folder not yet available)`;
  return `  - ${name}: ${n}`;
}

// Same three states for the HTML part.
function dispositionLineHtml(name: string, n: number, folderId: string | null | undefined): string {
  const escaped = escapeHtml(name);
  if (folderId) return `<a href="${folderLink(folderId)}">${escaped}</a>: ${n}`;
  if (folderId === null) return `${escaped}: ${n} (folder not yet available)`;
  return `${escaped}: ${n}`;
}

// The plain-text "calls made today" block: per agent, the total then the full
// disposition breakdown (no cap, no "Other" rollup). An agent with no calls
// shows "0 calls" and no list. `null` means the CloudTalk fetch failed; per the
// never-block-the-send rule the email still goes out, with a short unavailable
// note instead of numbers.
function callCountTextLines(counts: CallCounts | null, links: FolderLinks): string[] {
  if (!counts) return ["Calls made today: count unavailable"];
  const lines = ["Calls made today:"];
  for (const view of agentViews(counts, links)) {
    lines.push("", `${view.label}: ${view.total} calls`);
    for (const [name, n] of view.dispositions) {
      lines.push(dispositionLineText(name, n, view.folderLinks[name]));
    }
  }
  return lines;
}

// Same block for the HTML part: each agent's breakdown is a <ul> so it renders
// as an indented list in Gmail. Disposition names come from the CloudTalk API,
// so they are HTML-escaped before interpolation.
function callCountHtmlLines(counts: CallCounts | null, links: FolderLinks): string[] {
  if (!counts) return ["<p>Calls made today: count unavailable</p>"];
  const lines = ["<p>Calls made today:</p>"];
  for (const view of agentViews(counts, links)) {
    lines.push(`<p>${view.label}: ${view.total} calls</p>`);
    if (view.dispositions.length > 0) {
      lines.push("<ul>");
      for (const [name, n] of view.dispositions) {
        lines.push(`<li>${dispositionLineHtml(name, n, view.folderLinks[name])}</li>`);
      }
      lines.push("</ul>");
    }
  }
  return lines;
}

// Minimal escaping for disposition names interpolated into the HTML part. The
// known dispositions are plain (slashes, dashes) but the source is an external
// API, so guard against a tag that ever carries an HTML-special character.
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export interface ReminderContent {
  subject: string;
  text: string;
  html: string;
}

// `counts` is the day's call totals from CloudTalk, or null if the fetch failed
// (the send is never blocked on it). `links` is the day's per-disposition
// folder ids, or {} if that lookup failed or was skipped (no counts to drive
// it). Both default so a caller that only wants the recordings body can omit
// them.
export function buildReminder(
  now: Date,
  counts: CallCounts | null = null,
  links: FolderLinks = {},
): ReminderContent {
  const jayLink = folderLink(jayFolderId());
  const joeLink = folderLink(requireEnv("JOE_DRIVE_ROOT_FOLDER_ID"));
  const date = displayDate(now);

  const text = [
    "Kenneth,",
    "",
    "Today's call recordings are ready to review.",
    "",
    `Jay: ${jayLink}`,
    `Joe: ${joeLink}`,
    "",
    "Both are organized by disposition, then by day. Each disposition below links straight to today's folder once at least one call has been filed there.",
    "",
    ...callCountTextLines(counts, links),
    "",
    `Date: ${date}`,
    "",
  ].join("\n");

  // Same content as the text part, marked up only enough to make the folder
  // links clickable in Gmail.
  const html = [
    "<p>Kenneth,</p>",
    "<p>Today's call recordings are ready to review.</p>",
    "<p>",
    `Jay: <a href="${jayLink}">${jayLink}</a><br>`,
    `Joe: <a href="${joeLink}">${joeLink}</a>`,
    "</p>",
    "<p>Both are organized by disposition, then by day. Each disposition below links straight to today's folder once at least one call has been filed there.</p>",
    ...callCountHtmlLines(counts, links),
    `<p>Date: ${date}</p>`,
  ].join("\n");

  return { subject: reminderSubject(now), text, html };
}

// Fetch today's call counts, swallowing any failure. The count is a nice-to-have
// on top of the reminder, so per the never-block-the-send rule a CloudTalk or
// network error here is logged and turns into a null (rendered as "count
// unavailable"), never an exception that reaches the send.
export async function fetchCallCountsSafe(now: Date): Promise<CallCounts | null> {
  try {
    return await countTodaysCallsByAgent(now);
  } catch (err) {
    log({
      level: "error",
      action: "reminder_call_counts_failed",
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export interface ReminderResult {
  to: string;
  cc: string;
  subject: string;
  message_id: string;
}

// Build and send. Throws on failure; the scheduler and the manual trigger both
// catch and log, so a bad SMTP day never escapes this module.
export async function sendReviewReminder(now: Date = new Date()): Promise<ReminderResult> {
  const to = reminderTo();
  const cc = reminderCc();
  // Pull the day's counts first. fetchCallCountsSafe never throws, so a
  // CloudTalk hiccup degrades the email to "count unavailable" instead of
  // blocking the send.
  const counts = await fetchCallCountsSafe(now);
  // Folder links need the day's dispositions to know what to look up, so this
  // only runs when counts came back. fetchFolderLinksSafe never throws, so a
  // Drive hiccup degrades every disposition line to plain text instead of
  // blocking the send.
  const links = counts ? await fetchFolderLinksSafe(counts, now) : {};
  const { subject, text, html } = buildReminder(now, counts, links);

  const messageId = await sendMail({ to, cc, subject, text, html });
  return { to, cc, subject, message_id: messageId };
}
