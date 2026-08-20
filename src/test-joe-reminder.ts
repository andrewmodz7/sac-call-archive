// Manual eyeball check for buildJoeReminder's formatting. Not a test suite,
// just prints the text body for a few fake counts/links scenarios so
// formatting can be reviewed before the cron is wired up.
//
// Run with: npx tsx src/test-joe-reminder.ts

import { buildJoeReminder } from "./reminder.js";
import type { CallCounts } from "./call-counts.js";
import { NO_DISPOSITION } from "./call-counts.js";
import { JOE } from "./router.js";

// buildJoeReminder requires JOE_DRIVE_ROOT_FOLDER_ID. Fill in a fake one so
// this script runs standalone, without needing a real .env.
process.env.JOE_DRIVE_ROOT_FOLDER_ID ||= "FAKE_JOE_ROOT_FOLDER_ID";

const now = new Date();

function printScenario(label: string, counts: CallCounts | null, links: Record<string, Record<string, string | null>>): void {
  console.log(`--- ${label} ---`);
  const { subject, text } = buildJoeReminder(now, counts, links);
  console.log(`Subject: ${subject}`);
  console.log("");
  console.log(text);
  console.log("");
}

// A normal day: one resolved folder link, one disposition archived but not
// yet filed today, and an untagged bucket that never gets a link attempt.
printScenario(
  "normal day, mixed link states",
  {
    byAgent: { Jay: 40, [JOE]: 12 },
    dispositionsByAgent: {
      Jay: { "Not Interested": 20, "Appointment Set": 5, [NO_DISPOSITION]: 15 },
      [JOE]: {
        "Offer Appointment Set": 3,
        "Not Interested": 4,
        [NO_DISPOSITION]: 5,
      },
    },
    total: 52,
  },
  {
    [JOE]: {
      "Offer Appointment Set": "1AbCdEfGhIjKlMnOpQrStUvWxYz",
      "Not Interested": null,
    },
  },
);

// Joe has made zero calls today. Email must still send with total 0, not be
// skipped.
printScenario(
  "joe has zero calls today",
  {
    byAgent: { Jay: 18 },
    dispositionsByAgent: { Jay: { "Not Interested": 18 } },
    total: 18,
  },
  {},
);

// CloudTalk fetch failed. counts is null, so the body degrades to "count
// unavailable" instead of blocking the send.
printScenario("counts fetch failed", null, {});
