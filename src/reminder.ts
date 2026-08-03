// The daily "review the recordings" email to Kenneth.
//
// Content is deliberately plain: short subject, no em dashes, no filler. Body
// is built with string concatenation, not a template engine, so there is only
// one way this email gets assembled.

import { countTodaysCallsByAgent, type CallCounts } from "./call-counts.js";
import { sendMail } from "./mailer.js";
import { log } from "./process.js";
import { JOE, monthFolder } from "./router.js";

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

// Jay's and Joe's views for the day. Joe's total is his own resolved count and
// Jay's is "everything else" (total minus Joe), matching how mergedDispositions
// splits the per-disposition maps, so each agent's breakdown sums to their total.
function agentViews(counts: CallCounts): AgentCallView[] {
  const joeTotal = counts.byAgent[JOE] ?? 0;
  return [
    { label: "Jay", total: counts.total - joeTotal, dispositions: mergedDispositions(counts, false) },
    { label: "Joe", total: joeTotal, dispositions: mergedDispositions(counts, true) },
  ];
}

// The plain-text "calls made today" block: per agent, the total then the full
// disposition breakdown (no cap, no "Other" rollup). An agent with no calls
// shows "0 calls" and no list. `null` means the CloudTalk fetch failed; per the
// never-block-the-send rule the email still goes out, with a short unavailable
// note instead of numbers.
function callCountTextLines(counts: CallCounts | null): string[] {
  if (!counts) return ["Calls made today: count unavailable"];
  const lines = ["Calls made today:"];
  for (const view of agentViews(counts)) {
    lines.push("", `${view.label}: ${view.total} calls`);
    for (const [name, n] of view.dispositions) lines.push(`  - ${name}: ${n}`);
  }
  return lines;
}

// Same block for the HTML part: each agent's breakdown is a <ul> so it renders
// as an indented list in Gmail. Disposition names come from the CloudTalk API,
// so they are HTML-escaped before interpolation.
function callCountHtmlLines(counts: CallCounts | null): string[] {
  if (!counts) return ["<p>Calls made today: count unavailable</p>"];
  const lines = ["<p>Calls made today:</p>"];
  for (const view of agentViews(counts)) {
    lines.push(`<p>${view.label}: ${view.total} calls</p>`);
    if (view.dispositions.length > 0) {
      lines.push("<ul>");
      for (const [name, n] of view.dispositions) {
        lines.push(`<li>${escapeHtml(name)}: ${n}</li>`);
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
// (the send is never blocked on it). Defaults to null so a caller that only
// wants the recordings body can omit it.
export function buildReminder(now: Date, counts: CallCounts | null = null): ReminderContent {
  const jayLink = folderLink(jayFolderId());
  const joeLink = folderLink(requireEnv("JOE_DRIVE_ROOT_FOLDER_ID"));
  const date = displayDate(now);
  // Reuse the router's month folder so the email names the same folder the
  // uploader just wrote into.
  const month = monthFolder(now.toISOString());

  const text = [
    "Kenneth,",
    "",
    "Today's call recordings are ready to review.",
    "",
    `Jay: ${jayLink}`,
    `Joe: ${joeLink}`,
    "",
    `Both are organized by disposition, then by month (${month}).`,
    "",
    ...callCountTextLines(counts),
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
    `<p>Both are organized by disposition, then by month (${month}).</p>`,
    ...callCountHtmlLines(counts),
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
  const { subject, text, html } = buildReminder(now, counts);

  const messageId = await sendMail({ to, cc, subject, text, html });
  return { to, cc, subject, message_id: messageId };
}
