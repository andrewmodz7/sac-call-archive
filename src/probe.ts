// Standalone probe. Run with `npm run probe`.
//
// Why this exists: CloudTalk's field names on the call object aren't documented
// in a fetchable form, so before writing the handler we confirm the real shape
// against a live response. This hits the calls index, prints the full JSON of
// the returned call(s), and lists the top-level keys so we can lock down types.ts.
//
// It also prints two summaries needed to verify the Joe/Jay split before deploy:
//   - every distinct Agent.firstname seen, so we can confirm Jay's raw value
//     and that Joe's calls really do arrive as "Frank"
//   - every key on the Contact sub-object with a sample value, so we can
//     confirm which field supplies the address for Joe's filenames
// Pass a larger sample with `npm run probe -- --limit=100`.

import "dotenv/config";

const BASE_URL = "https://my.cloudtalk.io/api/";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required env var: ${name}`);
    console.error("Copy .env.example to .env and fill it in.");
    process.exit(1);
  }
  return value;
}

function authHeader(keyId: string, keySecret: string): string {
  const token = Buffer.from(`${keyId}:${keySecret}`).toString("base64");
  return `Basic ${token}`;
}

async function main(): Promise<void> {
  const keyId = requireEnv("CLOUDTALK_API_KEY_ID");
  const keySecret = requireEnv("CLOUDTALK_API_KEY_SECRET");

  const limit =
    process.argv
      .slice(2)
      .find((a) => a.startsWith("--limit="))
      ?.slice("--limit=".length) ?? "10";

  const url = `${BASE_URL}calls/index.json?page=1&limit=${encodeURIComponent(limit)}`;
  console.error(`GET ${url}`);

  const res = await fetch(url, {
    headers: {
      Authorization: authHeader(keyId, keySecret),
      Accept: "application/json",
    },
  });

  console.error(`Status: ${res.status} ${res.statusText}`);

  const text = await res.text();

  if (!res.ok) {
    console.error("Request failed. Raw body:");
    console.error(text);
    process.exit(1);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    console.error("Response was not valid JSON. Raw body:");
    console.error(text);
    process.exit(1);
  }

  // Real envelope, confirmed on a live run:
  //   { responseData: { itemsCount, pageCount, pageNumber, limit, data: [...] } }
  // Don't assume it — print what we actually got if it doesn't match.
  const rd = (parsed as { responseData?: { itemsCount?: number; data?: unknown[] } }).responseData;
  const items = rd?.data;

  if (!Array.isArray(items) || items.length === 0) {
    console.error("No items found in response. Full payload below so we can see the real shape:");
    console.log(JSON.stringify(parsed, null, 2));
    return;
  }

  console.error(`itemsCount reported: ${rd?.itemsCount ?? "(absent)"}`);
  console.error(`items returned: ${items.length}`);
  console.error("");

  const calls = items as Array<Record<string, any>>;

  const first = calls[0] as object;
  console.error("Top-level keys on the first call object:");
  console.error(JSON.stringify(Object.keys(first), null, 2));
  console.error("");

  // Agent identities. Confirms Jay's raw firstname and that Joe's calls really
  // do arrive as "Frank" (there is no Joe user in CloudTalk).
  const agentCounts = new Map<string, number>();
  for (const c of calls) {
    const name = c.Agent?.firstname ?? "(no Agent)";
    agentCounts.set(name, (agentCounts.get(name) ?? 0) + 1);
  }
  console.error("Distinct Agent.firstname values in this sample:");
  for (const [name, count] of [...agentCounts].sort((a, b) => b[1] - a[1])) {
    console.error(`  ${JSON.stringify(name)}  x${count}`);
  }
  console.error("");

  // Contact fields. Which keys exist at all, and a real non-empty sample for
  // each — this is what tells us the field that supplies Joe's address.
  const contactKeys = new Map<string, { present: number; nonEmpty: number; sample: unknown }>();
  for (const c of calls) {
    const contact = c.Contact;
    if (!contact || typeof contact !== "object") continue;
    for (const [key, value] of Object.entries(contact)) {
      const entry = contactKeys.get(key) ?? { present: 0, nonEmpty: 0, sample: null };
      entry.present++;
      if (value !== null && value !== "" && value !== undefined) {
        entry.nonEmpty++;
        if (entry.sample === null) entry.sample = value;
      }
      contactKeys.set(key, entry);
    }
  }
  console.error(`Contact sub-object keys (out of ${calls.length} calls):`);
  if (contactKeys.size === 0) {
    console.error("  (no Contact object on any call in this sample)");
  }
  for (const [key, entry] of [...contactKeys].sort()) {
    console.error(
      `  ${key}: present=${entry.present} non-empty=${entry.nonEmpty} ` +
        `sample=${JSON.stringify(entry.sample)}`,
    );
  }
  console.error("");

  console.error("Full JSON of the returned call object(s):");
  console.log(JSON.stringify(items, null, 2));
}

main().catch((err) => {
  console.error("Probe crashed:");
  console.error(err);
  process.exit(1);
});
