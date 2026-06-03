// One-shot backfill. Pages through the calls index for the last 7 days and runs
// any call not already in processed_calls through the same router and uploader
// as the webhook. Run with `npm run backfill`.
//
// Rate limit is 60 req/min, so sleep 1s between pages.

import "dotenv/config";
import { listCalls } from "./cloudtalk.js";
import { isProcessed } from "./db.js";
import { log, processCall } from "./process.js";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const PAGE_LIMIT = 100;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const cutoff = Date.now() - SEVEN_DAYS_MS;
  let page = 1;
  let pageCount = 1;
  let processed = 0;
  let alreadyDone = 0;
  let outOfRange = 0;

  do {
    const rd = await listCalls(page, PAGE_LIMIT);
    pageCount = rd.pageCount || 1;
    const items = rd.data ?? [];

    let inRangeOnPage = 0;
    for (const call of items) {
      const startedMs = new Date(call.Cdr.started_at).getTime();
      if (Number.isNaN(startedMs) || startedMs < cutoff) {
        outOfRange++;
        continue;
      }
      inRangeOnPage++;

      const id = String(call.Cdr.id);
      if (isProcessed(id)) {
        alreadyDone++;
        continue;
      }
      await processCall(call);
      processed++;
    }

    log({ level: "info", msg: "backfill page done", page, pageCount, inRangeOnPage });

    // CloudTalk returns calls newest-first. Once a full page is entirely older
    // than the cutoff, everything after it is older too, so stop.
    if (inRangeOnPage === 0 && page > 1) break;

    page++;
    if (page <= pageCount) await sleep(1000);
  } while (page <= pageCount);

  log({ level: "info", msg: "backfill complete", processed, alreadyDone, outOfRange });
}

main().catch((err) => {
  log({
    level: "error",
    msg: "backfill crashed",
    error: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});
