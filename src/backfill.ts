// One-shot backfill. Server-side filtered and order-agnostic in every mode:
//
//   npm run backfill                              -> rolling window: date_from = 7 days ago
//   npm run backfill -- --until=2026-06-04T16:30:00Z
//                                                 -> hard cutoff: date_to = the timestamp,
//                                                    NO date_from, so CloudTalk returns every
//                                                    call it has up to the cutoff
//   npm run backfill -- --since=2026-07-13        -> date_from = midnight Eastern on that date,
//                                                    date_to left open (i.e. up to now)
//   --since and --until can be combined for a closed window.
//   --dry-run                                     -> page through and report what WOULD happen,
//                                                    broken down by resolved agent. Downloads
//                                                    nothing, uploads nothing, writes no rows.
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
import { pathToFileURL } from "node:url";
import { buildListCallsUrl, listCalls, type ListCallsFilters } from "./cloudtalk.js";
import { getProcessed, type ProcessedRow } from "./db.js";
import { log, processCall } from "./process.js";
import { resolveAgentIdentity, routeCall } from "./router.js";

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

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv
    .slice(2)
    .find((a) => a.startsWith(prefix))
    ?.slice(prefix.length);
}

// UTC offset in minutes for America/New_York at a given instant, read from Intl
// rather than hardcoded, so it is correct on both sides of a DST change. Same
// approach as easternParts in router.ts.
function easternOffsetMinutes(at: Date): number {
  const name =
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      timeZoneName: "longOffset",
    })
      .formatToParts(at)
      .find((p) => p.type === "timeZoneName")?.value ?? "GMT+00:00";
  const m = /GMT([+-])(\d{2}):(\d{2})/.exec(name);
  if (!m) return 0;
  const sign = m[1] === "-" ? -1 : 1;
  return sign * (Number(m[2]) * 60 + Number(m[3]));
}

// Midnight Eastern on a YYYY-MM-DD, as a UTC instant. The archive is organized
// by Eastern date, so --since=2026-07-13 means the start of July 13 Eastern.
// Reading it as 00:00 UTC would reach back into the evening of July 12.
function easternMidnightIso(day: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    throw new Error(`--since must be YYYY-MM-DD: ${day}`);
  }
  const baseMs = Date.parse(`${day}T00:00:00Z`);
  if (Number.isNaN(baseMs)) throw new Error(`--since is not a valid date: ${day}`);
  // Sample the offset at midday, safely clear of the 2 AM DST transitions.
  const offsetMin = easternOffsetMinutes(new Date(`${day}T12:00:00Z`));
  return new Date(baseMs - offsetMin * 60_000).toISOString();
}

async function buildFilters(sinceArg?: string, untilArg?: string): Promise<ListCallsFilters> {
  if (!sinceArg && !untilArg) {
    // Default: rolling 7-day window, as before.
    return { dateFrom: new Date(Date.now() - SEVEN_DAYS_MS).toISOString() };
  }

  const filters: ListCallsFilters = {};

  if (sinceArg) {
    filters.dateFrom = easternMidnightIso(sinceArg);
    log({
      level: "info",
      msg: "backfill since mode",
      since: sinceArg,
      date_from: filters.dateFrom,
      note: "date_to left open",
    });
  }

  if (untilArg) {
    const cutoff = new Date(untilArg);
    if (Number.isNaN(cutoff.getTime())) {
      throw new Error(`--until is not a parseable timestamp: ${untilArg}`);
    }
    const isoUtc = cutoff.toISOString().slice(0, 19); // YYYY-MM-DDTHH:MM:SS
    filters.dateTo = await pickDateTo(cutoff.getTime(), [
      `${isoUtc}Z`, // ISO 8601 with T
      isoUtc.replace("T", " "), // docs format: "2017-12-24 12:22:00"
    ]);
    log({ level: "info", msg: "backfill cutoff mode", until: untilArg, date_to: filters.dateTo });
  }

  return filters;
}

// Dry-run accounting. Counts what a real run would do, without downloading,
// uploading, or writing a row.
type Tally = Record<string, number>;

function bump(t: Tally, key: string): void {
  t[key] = (t[key] ?? 0) + 1;
}

export interface BackfillOptions {
  since?: string; // YYYY-MM-DD, date_from at midnight Eastern
  until?: string; // parseable timestamp, date_to
  dryRun?: boolean;
}

// Machine-readable result, so callers (the HTTP trigger) can return it as JSON
// instead of only emitting log lines.
export interface BackfillSummary {
  dryRun: boolean;
  candidates: number; // rows that were not already definitively done
  processed: number;
  archived: number;
  failed: number;
  alreadyDone: number;
  retriedNoDisposition: number;
  wouldArchiveTotal: number;
  wouldArchiveByAgent: Tally;
  wouldArchiveByDisposition: Tally;
  wouldSkipByAction: Tally;
  unrecognizedTags: Tally;
  pagesRead: number;
  oldestSeenCall: string | null;
  newestSeenCall: string | null;
}

// The whole run, parameterized. Shared verbatim by the CLI and the HTTP
// trigger so both behave identically. Rate limiting, dedup via
// isDefinitivelyDone, and tag-poll-disabled behavior are unchanged.
export async function runBackfill(options: BackfillOptions = {}): Promise<BackfillSummary> {
  const dryRun = options.dryRun === true;
  const filters = await buildFilters(options.since, options.until);

  if (dryRun) {
    log({ level: "info", msg: "DRY RUN: no downloads, no uploads, no rows written" });
  }

  // Dry-run tallies.
  const wouldArchiveByAgent: Tally = {};
  const wouldArchiveByDisposition: Tally = {};
  const wouldSkipByAction: Tally = {};
  const unrecognizedTags: Tally = {};
  let wouldArchiveTotal = 0;

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

  // Diagnostic accounting: every id the API returned and every id the loop
  // actually iterated, so a missing call is provably either absent from the
  // responses or dropped by our own code.
  const receivedIds: string[] = [];
  const iteratedIds = new Set<string>();
  let itemsIterated = 0;

  do {
    const url = buildListCallsUrl(page, PAGE_LIMIT, filters);
    log({ level: "info", msg: "fetching page", url, page, limit: PAGE_LIMIT });

    const rd = await listCalls(page, PAGE_LIMIT, filters);
    pageCount = rd.pageCount || 1;
    const items = rd.data ?? [];
    pagesRead++;
    for (const c of items) receivedIds.push(String(c.Cdr.id));

    for (const call of items) {
      log({
        level: "debug",
        msg: "page item",
        call_id: String(call.Cdr.id),
        started_at: call.Cdr.started_at,
        tags_count: (call.Tags ?? []).length,
        recorded: call.Cdr.recorded,
      });
      iteratedIds.add(String(call.Cdr.id));
      itemsIterated++;

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
        log({ level: "info", msg: "dedup skip", call_id: id, prior_action: existing?.action });
        alreadyDone++;
        continue;
      }
      if (existing?.action === "skipped_no_disposition") retriedNoDisposition++;

      if (dryRun) {
        // Same pure decisions the real run makes, minus the IO.
        const agent = resolveAgentIdentity(call.Agent?.firstname) ?? "(no agent)";
        const route = routeCall(call);
        if (route.kind === "archive") {
          wouldArchiveTotal++;
          bump(wouldArchiveByAgent, agent);
          bump(wouldArchiveByDisposition, `${agent} / ${route.disposition}`);
        } else {
          bump(wouldSkipByAction, route.action);
          if (route.action === "skipped_no_disposition") {
            for (const tag of route.tagNames) bump(unrecognizedTags, tag);
          }
        }
        processed++;
        continue;
      }

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

  // Diagnostic: received vs iterated must match; anything the API returned but
  // the loop never touched is a bug in our code, not CloudTalk's.
  if (receivedIds.length !== itemsIterated) {
    log({
      level: "warn",
      msg: "items received vs iterated mismatch",
      items_received: receivedIds.length,
      items_iterated: itemsIterated,
      missing_ids: receivedIds.filter((id) => !iteratedIds.has(id)),
    });
  }

  const summary: BackfillSummary = {
    dryRun,
    candidates: processed,
    processed,
    archived,
    failed,
    alreadyDone,
    retriedNoDisposition,
    wouldArchiveTotal,
    wouldArchiveByAgent,
    wouldArchiveByDisposition,
    wouldSkipByAction,
    unrecognizedTags,
    pagesRead,
    oldestSeenCall,
    newestSeenCall,
  };

  if (dryRun) {
    log({
      level: "info",
      msg: "DRY RUN complete: nothing downloaded, uploaded, or written",
      candidates: processed,
      alreadyDone,
      retriedNoDisposition,
      would_archive_total: wouldArchiveTotal,
      would_archive_by_agent: wouldArchiveByAgent,
      would_archive_by_disposition: wouldArchiveByDisposition,
      would_skip_by_action: wouldSkipByAction,
      unrecognized_tags: unrecognizedTags,
      pagesRead,
      oldestSeenCall,
      newestSeenCall,
    });
    return summary;
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
  return summary;
}

// CLI entry. Only runs when this file is executed directly (npm run backfill),
// not when index.ts imports runBackfill for the HTTP trigger.
async function cli(): Promise<void> {
  await runBackfill({
    since: argValue("since"),
    until: argValue("until"),
    dryRun: process.argv.slice(2).includes("--dry-run"),
  });
}

const isDirectRun =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  cli().catch((err) => {
    log({
      level: "error",
      msg: "backfill crashed",
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  });
}
