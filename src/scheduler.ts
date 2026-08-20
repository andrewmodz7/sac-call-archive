// In-process scheduler for the daily reminder email. Runs inside the existing
// Express service, no separate cron service or deployment.
//
// node-cron resolves the timezone through Intl.DateTimeFormat with
// timeZoneName: "shortOffset", so it recomputes the UTC offset per fire rather
// than holding a fixed one. 8:00 PM Eastern stays 8:00 PM Eastern across both
// DST transitions. (Nothing lands in a DST gap either way: the transitions
// happen at 2 AM.)

import cron from "node-cron";
import { isMailConfigured } from "./mailer.js";
import { log } from "./process.js";
import { sendJoeReminder, sendReviewReminder } from "./reminder.js";

// Minute 0, hour 20, Monday through Friday.
export const REMINDER_CRON = "0 20 * * 1-5";
export const REMINDER_TIMEZONE = "America/New_York";

// Run the reminder once and log the outcome. Never throws: this is a side
// feature and it must not be able to affect the webhook or call-processing
// path. Returns whether the send succeeded, for the manual trigger.
export async function runReminderOnce(trigger: string): Promise<boolean> {
  const start = Date.now();
  log({ level: "info", action: "reminder_fired", trigger });

  if (!isMailConfigured()) {
    log({
      level: "warn",
      action: "reminder_skipped",
      trigger,
      reason: "GMAIL_SMTP_USER / GMAIL_SMTP_APP_PASSWORD not set",
    });
    return false;
  }

  try {
    const result = await sendReviewReminder();
    log({
      level: "info",
      action: "reminder_sent",
      trigger,
      to: result.to,
      cc: result.cc,
      subject: result.subject,
      message_id: result.message_id,
      duration_ms: Date.now() - start,
    });
    return true;
  } catch (err) {
    // Logged and dropped on purpose. No retry: the next weekday run is the
    // retry, and a missed reminder is not worth risking the process over.
    log({
      level: "error",
      action: "reminder_failed",
      trigger,
      error: err instanceof Error ? err.message : String(err),
      duration_ms: Date.now() - start,
    });
    return false;
  }
}

// Run Joe's reminder once and log the outcome. Same never-block-anything
// contract as runReminderOnce, kept as its own function (rather than folded
// into runReminderOnce) so a failure on one job never affects the other and
// so the two are distinguishable in logs by action name. Returns whether the
// send succeeded, for the manual trigger.
export async function runJoeReminderOnce(trigger: string): Promise<boolean> {
  const start = Date.now();
  log({ level: "info", action: "joe_reminder_fired", trigger });

  if (!isMailConfigured()) {
    log({
      level: "warn",
      action: "joe_reminder_skipped",
      trigger,
      reason: "GMAIL_SMTP_USER / GMAIL_SMTP_APP_PASSWORD not set",
    });
    return false;
  }

  try {
    const result = await sendJoeReminder();
    log({
      level: "info",
      action: "joe_reminder_sent",
      trigger,
      to: result.to,
      subject: result.subject,
      message_id: result.message_id,
      duration_ms: Date.now() - start,
    });
    return true;
  } catch (err) {
    // Logged and dropped on purpose, same as runReminderOnce: the next
    // weekday run is the retry.
    log({
      level: "error",
      action: "joe_reminder_failed",
      trigger,
      error: err instanceof Error ? err.message : String(err),
      duration_ms: Date.now() - start,
    });
    return false;
  }
}

// Register both schedules. Call once at startup.
export function startReminderScheduler(): void {
  if (!isMailConfigured()) {
    // Not an error. Local dev has no SMTP credentials, and firing a failing
    // send every evening there would be noise, not signal.
    log({
      level: "warn",
      action: "reminder_scheduler_disabled",
      reason: "GMAIL_SMTP_USER / GMAIL_SMTP_APP_PASSWORD not set",
    });
    return;
  }

  cron.schedule(REMINDER_CRON, () => void runReminderOnce("schedule"), {
    timezone: REMINDER_TIMEZONE,
  });
  cron.schedule(REMINDER_CRON, () => void runJoeReminderOnce("schedule"), {
    timezone: REMINDER_TIMEZONE,
  });

  log({
    level: "info",
    action: "reminder_scheduler_started",
    cron: REMINDER_CRON,
    timezone: REMINDER_TIMEZONE,
  });
}
