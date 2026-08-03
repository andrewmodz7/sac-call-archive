// One-off manual send of the reminder email. Run with `npm run remind`.
//
// Use this to test the SMTP credentials without waiting for 8 PM. It sends a
// real email to the real recipients, so it is not a dry run. To see what would
// be sent without sending it, pass --preview. Preview pulls the real CloudTalk
// call counts (read-only) so you see the exact body that would go out.
//
// On Railway (where the credentials live), run it against the deployed env:
//   railway run npm run remind

import "dotenv/config";
import { isMailConfigured } from "./mailer.js";
import { log } from "./process.js";
import { buildReminder, fetchCallCountsSafe, reminderCc, reminderTo } from "./reminder.js";
import { runReminderOnce } from "./scheduler.js";

async function main(): Promise<void> {
  const preview = process.argv.slice(2).includes("--preview");

  if (preview) {
    const now = new Date();
    const counts = await fetchCallCountsSafe(now);
    const { subject, text } = buildReminder(now, counts);
    console.log(`To:      ${reminderTo()}`);
    console.log(`Cc:      ${reminderCc()}`);
    console.log(`Subject: ${subject}`);
    console.log("");
    console.log(text);
    return;
  }

  if (!isMailConfigured()) {
    log({
      level: "error",
      action: "reminder_manual_aborted",
      reason: "GMAIL_SMTP_USER / GMAIL_SMTP_APP_PASSWORD not set",
    });
    process.exit(1);
  }

  const ok = await runReminderOnce("manual_script");
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  log({
    level: "error",
    action: "reminder_manual_crashed",
    error: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});
