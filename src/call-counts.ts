// Read-only daily call counts, pulled straight from the CloudTalk API for the
// reminder email. This deliberately does NOT read the local processed_calls
// table: a large share of calls never get archived (missing dispositions), so
// that table would badly undercount "calls made today". The CloudTalk call list
// is the source of truth for volume.
//
// Nothing here downloads recordings, writes a row, or touches Drive. It only
// pages the call list for today (Eastern) and tallies by resolved agent, so it
// can never affect the archiving/filing path.

import { listCalls, type ListCallsFilters } from "./cloudtalk.js";
import { resolveAgentIdentity } from "./router.js";

const PAGE_LIMIT = 1000; // one Eastern day of calls sits well under a single page
const MAX_PAGES = 50; // runaway guard only; pageCount drives the loop
const RATE_LIMIT_SLEEP_MS = 1000; // CloudTalk allows 60 req/min; match the backfill

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Bucket for a call whose Tags array is empty. Its own count is meaningful:
// Jay and Joe are known to leave calls untagged, so this is the size of that gap.
export const NO_DISPOSITION = "No Disposition";

export interface CallCounts {
  // Resolved agent identity -> number of calls today. "Frank" is folded into
  // "Joe" here because resolveAgentIdentity does the mapping.
  byAgent: Record<string, number>;
  // Resolved agent identity -> (disposition name -> count) for today. Each call
  // contributes to exactly one disposition (its first Tag, or NO_DISPOSITION if
  // it has none), so an agent's disposition counts sum to that agent's byAgent
  // total. Sorting/formatting is the caller's job.
  dispositionsByAgent: Record<string, Record<string, number>>;
  total: number;
}

// Today's Eastern calendar date as YYYY-MM-DD, read from Intl so it is correct
// across both DST transitions. Same timeZone approach as displayDate/easternParts.
export function easternDateString(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

// UTC offset in minutes for America/New_York at a given instant, read from Intl
// rather than hardcoded, so it is correct on both sides of a DST change. Same
// approach as easternOffsetMinutes in backfill.ts.
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

// Midnight Eastern on a YYYY-MM-DD, as a UTC instant. The day is organized by
// Eastern time, so "today" starts at 00:00 Eastern, not 00:00 UTC.
function easternMidnightIso(day: string): string {
  const baseMs = Date.parse(`${day}T00:00:00Z`);
  // Sample the offset at midday, safely clear of the 2 AM DST transitions.
  const offsetMin = easternOffsetMinutes(new Date(`${day}T12:00:00Z`));
  return new Date(baseMs - offsetMin * 60_000).toISOString();
}

// Count today's (Eastern) calls, grouped by resolved agent identity.
//
// date_from is midnight Eastern today; date_to is left open so the query
// captures the full day up to the moment it runs (the reminder fires at 8 PM,
// so this is effectively the whole working day). Pagination follows CloudTalk's
// pageCount, same as the backfill; a single day never approaches PAGE_LIMIT but
// the loop is correct if it ever did.
//
// Throws on any CloudTalk/network failure. The caller (the reminder) wraps this
// so a bad fetch can never block the send.
export async function countTodaysCallsByAgent(now: Date = new Date()): Promise<CallCounts> {
  const day = easternDateString(now);
  const filters: ListCallsFilters = { dateFrom: easternMidnightIso(day) };

  const byAgent: Record<string, number> = {};
  const dispositionsByAgent: Record<string, Record<string, number>> = {};
  let total = 0;
  let page = 1;
  let pageCount = 1;

  do {
    const rd = await listCalls(page, PAGE_LIMIT, filters);
    pageCount = rd.pageCount || 1;
    for (const call of rd.data ?? []) {
      // "Unknown" for a call with no agent, so it still shows up in the total.
      const agent = resolveAgentIdentity(call.Agent?.firstname) ?? "Unknown";
      byAgent[agent] = (byAgent[agent] ?? 0) + 1;
      total++;

      // One disposition per call so the per-agent breakdown sums to the agent's
      // total: the first Tag is the disposition (call.Tags carries dispositions,
      // not segmentation tags, per types.ts), and an untagged call is counted
      // under NO_DISPOSITION rather than dropped.
      const disposition = (call.Tags ?? [])[0]?.name ?? NO_DISPOSITION;
      const perAgent = (dispositionsByAgent[agent] ??= {});
      perAgent[disposition] = (perAgent[disposition] ?? 0) + 1;
    }
    page++;
    if (page <= pageCount && page <= MAX_PAGES) await sleep(RATE_LIMIT_SLEEP_MS);
  } while (page <= pageCount && page <= MAX_PAGES);

  return { byAgent, dispositionsByAgent, total };
}
