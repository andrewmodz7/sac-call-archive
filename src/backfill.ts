// One-shot backfill. Asks CloudTalk for all calls in the last 7 days using the
// API's server-side date_from filter, then runs any call not already in
// processed_calls through the same router and uploader as the webhook. Run with
// `npm run backfill`.
//
// We deliberately make no assumptions about pagination ordering: every returned
// item is already in range (CloudTalk filters server-side), and we keep paging
// until a page comes back short of `limit`, capped at MAX_PAGES as a runaway
// guard.
//
// Rate limit is 60 req/min, so sleep 1s between pages.

import "dotenv/config";
import { listCalls } from "./cloudtalk.js";
import { isProcessed } from "./db.js";
import { log, processCall } from "./process.js";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const PAGE_LIMIT = 1000; // CloudTalk supports up to 1000 per page
const MAX_PAGES = 50;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const dateFrom = new Date(Date.now() - SEVEN_DAYS_MS).toISOString();
  let page = 1;
  let pagesRead = 0;
  let processed = 0;
  let alreadyDone = 0;

  for (; page <= MAX_PAGES; page++) {
    const rd = await listCalls(page, PAGE_LIMIT, dateFrom);
    const items = rd.data ?? [];
    pagesRead++;

    for (const call of items) {
      const id = String(call.Cdr.id);
      if (isProcessed(id)) {
        alreadyDone++;
        continue;
      }
      await processCall(call);
      processed++;
    }

    log({ level: "info", msg: "backfill page done", page, itemsOnPage: items.length });

    // A short page is the last page.
    if (items.length < PAGE_LIMIT) break;

    await sleep(1000);
  }

  log({ level: "info", msg: "backfill complete", processed, alreadyDone, pagesRead });
}

main().catch((err) => {
  log({
    level: "error",
    msg: "backfill crashed",
    error: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});
