// The daily "review the recordings" email to Kenneth.
//
// Content is deliberately plain: short subject, no em dashes, no filler. Body
// is built with string concatenation, not a template engine, so there is only
// one way this email gets assembled.

import { sendMail } from "./mailer.js";
import { monthFolder } from "./router.js";

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

export interface ReminderContent {
  subject: string;
  text: string;
  html: string;
}

export function buildReminder(now: Date): ReminderContent {
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
    `<p>Date: ${date}</p>`,
  ].join("\n");

  return { subject: reminderSubject(now), text, html };
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
  const { subject, text, html } = buildReminder(now);

  const messageId = await sendMail({ to, cc, subject, text, html });
  return { to, cc, subject, message_id: messageId };
}
