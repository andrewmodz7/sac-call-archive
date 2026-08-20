// One-off manual send of the reminder email. Run with `npm run remind`.
//
// Use this to test the SMTP credentials without waiting for 8 PM. It sends a
// real email to the real recipients, so it is not a dry run. To see what would
// be sent without sending it, pass --preview. Preview pulls the real CloudTalk
// call counts (read-only) so you see the exact body that would go out.
//
// Pass --joe to target Joe's summary instead of Kenneth's, in either mode.
//
// On Railway (where the credentials live), run it against the deployed env:
//   railway run npm run remind

import "dotenv/config";
import { isMailConfigured } from "./mailer.js";
import { log } from "./process.js";
import {
  buildJoeReminder,
  buildReminder,
  fetchCallCountsSafe,
  fetchFolderLinksSafe,
  joeReminderTo,
  reminderCc,
  reminderTo,
} from "./reminder.js";
import { runJoeReminderOnce, runReminderOnce } from "./scheduler.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const preview = args.includes("--preview");
  const joe = args.includes("--joe");

  if (preview) {
    const now = new Date();
    const counts = await fetchCallCountsSafe(now);
    const links = counts ? await fetchFolderLinksSafe(counts, now) : {};
    const { subject, text } = joe ? buildJoeReminder(now, counts, links) : buildReminder(now, counts, links);
    console.log(`To:      ${joe ? joeReminderTo() : reminderTo()}`);
    if (!joe) console.log(`Cc:      ${reminderCc()}`);
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

  const ok = joe ? await runJoeReminderOnce("manual_script") : await runReminderOnce("manual_script");
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
