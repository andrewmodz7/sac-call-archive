// One-shot backfill. Two modes, both server-side filtered and order-agnostic:
//
//   npm run backfill                              -> rolling window: date_from = 7 days ago
//   npm run backfill -- --until=2026-06-04T16:30:00Z
//                                                 -> hard cutoff: date_to = the timestamp,
//                                                    NO date_from, so CloudTalk returns every
//                                                    call it has up to the cutoff
//
// Runs any call not definitively done through the same router and uploader as
// the webhook. "Definitively done" = archived with a Drive file id, or skipped
// for a reason that can't change (skipped_disposition / skipped_no_recording /
// skipped_voicemail_flag / skipped_expired). skipped_no_disposition rows are
// re-evaluated — the agent may have tagged the call after we first saw it —
// and failed rows get another attempt.
//
// Pagination: CloudTalk's pageCount is the authoritative exit signal (we page
// while pageNumber < pageCount); we never exit early on a short page. MAX_PAGES
// is only a runaway guard.
//
// Rate limit is 60 req/min, so sleep 1s between pages.

import "dotenv/config";
import { listCalls, type ListCallsFilters } from "./cloudtalk.js";
import { getProcessed, type ProcessedRow } from "./db.js";
import { log, processCall } from "./process.js";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const PAGE_LIMIT = 1000; // CloudTalk supports up to 1000 per page
const MAX_PAGES = 500; // runaway guard only; pageCount drives the loop

// Skip instantly when a prior run reached a terminal state that can't change.
const DEFINITIVE_SKIPS = new Set([
  "skipped_disposition",
  "skipped_no_recording",
  "skipped_voicemail_flag",
  "skipped_expired", // recording purged for good; retrying can't succeed
]);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function isDefinitivelyDone(row: ProcessedRow | undefined): boolean {
  if (!row) return false;
  if (row.action === "archived" && row.drive_file_id) return true;
  return DEFINITIVE_SKIPS.has(row.action);
}

// CloudTalk's docs show date filters as "2017-12-24 12:22:00" (space-separated)
// but ISO 8601 with T should be equivalent. Probe page 1 with each candidate
// and pick the first whose results look sane: the request succeeds, items come
// back, and nothing returned starts after the cutoff (a violation means the
// filter was ignored or misparsed). Logs which format is being sent.
async function pickDateTo(cutoffMs: number, candidates: string[]): Promise<string> {
  for (const candidate of candidates) {
    try {
      const rd = await listCalls(1, 10, { dateTo: candidate });
      const items = rd.data ?? [];
      const allInRange = items.every((c) => {
        const ms = new Date(c.Cdr.started_at).getTime();
        return !Number.isNaN(ms) && ms <= cutoffMs;
      });
      if (rd.itemsCount > 0 && allInRange) {
        log({
          level: "info",
          msg: "date_to format accepted",
          date_to: candidate,
          items_count: rd.itemsCount,
        });
        return candidate;
      }
      log({
        level: "warn",
        msg: "date_to format gave weird results",
        date_to: candidate,
        items_count: rd.itemsCount,
        first_started_at: items[0]?.Cdr.started_at ?? null,
      });
    } catch (err) {
      log({
        level: "warn",
        msg: "date_to probe failed",
        date_to: candidate,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    await sleep(1000);
  }
  // Neither candidate validated. Proceed with the docs' format anyway; the
  // summary's oldest/newest seen calls will reveal the actual coverage.
  const fallback = candidates[candidates.length - 1] as string;
  log({ level: "warn", msg: "no date_to format validated, proceeding with docs format", date_to: fallback });
  return fallback;
}

async function buildFilters(): Promise<ListCallsFilters> {
  const untilArg = process.argv
    .slice(2)
    .find((a) => a.startsWith("--until="))
    ?.slice("--until=".length);

  if (!untilArg) {
    // Default: rolling 7-day window, as before.
    return { dateFrom: new Date(Date.now() - SEVEN_DAYS_MS).toISOString() };
  }

  const cutoff = new Date(untilArg);
  if (Number.isNaN(cutoff.getTime())) {
    throw new Error(`--until is not a parseable timestamp: ${untilArg}`);
  }

  const isoUtc = cutoff.toISOString().slice(0, 19); // YYYY-MM-DDTHH:MM:SS
  const dateTo = await pickDateTo(cutoff.getTime(), [
    `${isoUtc}Z`, // ISO 8601 with T
    isoUtc.replace("T", " "), // docs format: "2017-12-24 12:22:00"
  ]);
  log({ level: "info", msg: "backfill cutoff mode", until: untilArg, date_to: dateTo });
  return { dateTo };
}

async function main(): Promise<void> {
  const filters = await buildFilters();

  let page = 1;
  let pageCount = 1;
  let pagesRead = 0;
  let processed = 0;
  let archived = 0;
  let alreadyDone = 0;
  let retriedNoDisposition = 0;
  let failed = 0;
  let oldestSeenCall: string | null = null;
  let newestSeenCall: string | null = null;
  let oldestMs = Infinity;
  let newestMs = -Infinity;

  do {
    const rd = await listCalls(page, PAGE_LIMIT, filters);
    pageCount = rd.pageCount || 1;
    const items = rd.data ?? [];
    pagesRead++;

    for (const call of items) {
      const startedAt = call.Cdr.started_at;
      const startedMs = new Date(startedAt).getTime();
      if (!Number.isNaN(startedMs)) {
        if (startedMs < oldestMs) {
          oldestMs = startedMs;
          oldestSeenCall = startedAt;
        }
        if (startedMs > newestMs) {
          newestMs = startedMs;
          newestSeenCall = startedAt;
        }
      }

      const id = String(call.Cdr.id);
      const existing = getProcessed(id);
      if (isDefinitivelyDone(existing)) {
        alreadyDone++;
        continue;
      }
      if (existing?.action === "skipped_no_disposition") retriedNoDisposition++;

      const outcome = await processCall(call);
      processed++;
      if (outcome.action === "archived") archived++;
      if (outcome.action === "failed") failed++;
    }

    if (page % 5 === 0) {
      log({
        level: "info",
        msg: "backfill progress",
        page,
        pageCount,
        processed,
        alreadyDone,
      });
    }

    page++;
    if (page <= pageCount && page <= MAX_PAGES) await sleep(1000);
  } while (page <= pageCount && page <= MAX_PAGES);

  if (pageCount > MAX_PAGES) {
    log({ level: "warn", msg: "hit MAX_PAGES before exhausting pageCount", pageCount, MAX_PAGES });
  }

  log({
    level: "info",
    msg: "backfill complete",
    processed,
    archived,
    alreadyDone,
    retriedNoDisposition,
    failed,
    pagesRead,
    oldestSeenCall,
    newestSeenCall,
  });
}

main().catch((err) => {
  log({
    level: "error",
    msg: "backfill crashed",
    error: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});
