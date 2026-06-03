// Standalone probe. Run with `npm run probe`.
//
// Why this exists: CloudTalk's field names on the call object aren't documented
// in a fetchable form, so before writing the handler we confirm the real shape
// against a live response. This hits the calls index, prints the full JSON of
// the returned call(s), and lists the top-level keys so we can lock down types.ts.

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

  const url = `${BASE_URL}calls/index.json?page=1&limit=10`;
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

  // Expected shape per spec: { data: { items: [...], total: N } }.
  // Don't assume it — print what we actually got either way.
  const data = (parsed as { data?: { items?: unknown[]; total?: number } }).data;
  const items = data?.items;

  if (!Array.isArray(items) || items.length === 0) {
    console.error("No items found in response. Full payload below so we can see the real shape:");
    console.log(JSON.stringify(parsed, null, 2));
    return;
  }

  console.error(`total reported: ${data?.total ?? "(absent)"}`);
  console.error(`items returned: ${items.length}`);
  console.error("");

  const first = items[0];
  console.error("Top-level keys on the first call object:");
  console.error(JSON.stringify(Object.keys(first as object), null, 2));
  console.error("");
  console.error("Full JSON of the returned call object(s):");
  console.log(JSON.stringify(items, null, 2));
}

main().catch((err) => {
  console.error("Probe crashed:");
  console.error(err);
  process.exit(1);
});
