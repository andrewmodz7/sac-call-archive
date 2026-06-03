# sac-call-archive

Webhook receiver that listens for CloudTalk's "recording uploaded" event,
downloads the call recording, and files it into Google Drive organized by
agent, disposition, and month. Built for Shore Acres Capital to keep a
searchable archive of cold-call recordings segmented by outcome.

```
/CloudTalk Recordings/{Agent}/{Disposition}/{YYYY-MM}/{Name}_{YYYY-MM-DD}_{HH-MM}.mp3
```

## How it works

CloudTalk sends a webhook when a recording finishes uploading. The handler:

1. verifies the signature (see the open TODO below)
2. pulls the `call_id`, dedups against SQLite, and returns 200 immediately
3. acks fast, then does the download + Drive upload off the request path
4. routes by disposition (the call's `Tags[].name`): archive, skip, or flag as
   an unrecognized disposition

Recordings for non-productive outcomes (voicemail, no answer, busy, etc.) are
skipped and never downloaded. Calls with a disposition we don't recognize are
logged loudly with the full tag list and never guessed into a folder.

Every call produces one structured JSON log line and one row in `processed_calls`.

## Stack

TypeScript on Node 20, Express, better-sqlite3, googleapis. Deploys to Railway.

## Setup

### 1. Install and configure

```
npm install
cp .env.example .env
```

Fill in `.env`. Each var is covered below.

### 2. CloudTalk API key

In the CloudTalk dashboard: **Settings → API keys → Add new key**. You get a key
ID and a secret. Put them in:

```
CLOUDTALK_API_KEY_ID=
CLOUDTALK_API_KEY_SECRET=
```

These authenticate both the API calls and the recording downloads (HTTP basic
auth, base64 of `id:secret`).

Confirm the key works before anything else:

```
npm run probe
```

That hits the calls index and prints a recent call's JSON. If you get a 401, the
key is wrong or not enabled.

### 3. Google service account + Drive folder

The uploader authenticates as a Google service account, not as a person.

1. In the [Google Cloud Console](https://console.cloud.google.com/), create (or
   pick) a project.
2. **APIs & Services → Library →** enable the **Google Drive API**.
3. **APIs & Services → Credentials → Create credentials → Service account.**
   Name it something like `cloudtalk-archiver`.
4. Open the service account, **Keys → Add key → Create new key → JSON**. A JSON
   file downloads. This is the credential.
5. In Google Drive, create the root folder **CloudTalk Recordings**. Open it and
   note the folder id from the URL (`drive.google.com/drive/folders/<THIS>`).
6. Share that folder with the service account's email (the `client_email` field
   in the JSON, looks like
   `cloudtalk-archiver@yourproject.iam.gserviceaccount.com`) as **Editor**.
   Without this share the service account can't see or write to the folder.

Then set the env vars. `GOOGLE_SERVICE_ACCOUNT_JSON` is the entire JSON file
contents on a single line:

```
GOOGLE_SERVICE_ACCOUNT_JSON={"type":"service_account","project_id":...}
DRIVE_ROOT_FOLDER_ID=<the folder id from step 5>
```

To flatten the JSON to one line:

```
cat service-account.json | jq -c .
```

### 4. CloudTalk webhook

In the CloudTalk dashboard, add a webhook on the **recording uploaded** trigger
(not "call ended", the recording URL isn't valid until the upload finishes).

- URL: `https://<your-deploy-host>/webhooks/cloudtalk`
- Set a signing secret and put the same value in `CLOUDTALK_WEBHOOK_SECRET`.

> Open item: signature verification is stubbed (`verifySignature` in
> `src/cloudtalk.ts`). It accepts every request and logs a warning. We lock the
> real algorithm in once we capture a live signed request from the dashboard.
> Do not treat this as production-ready until that's done.

## Running

Local dev (reloads on change):

```
npm run dev
```

Production build:

```
npm run build
npm run start
```

Health check is at `GET /health`.

## Backfill

To archive recent calls that predate the webhook (last 7 days):

```
npm run backfill
```

It pages through the calls index, skips anything already processed, and runs
each call through the same router and uploader the webhook uses. It sleeps 1s
between pages to stay under the 60 req/min limit.

## Test locally with ngrok

CloudTalk needs a public URL. Point ngrok at the local server:

```
npm run dev
ngrok http 3000
```

Use the `https://...ngrok...` URL as the webhook target in CloudTalk
(`https://<id>.ngrok.io/webhooks/cloudtalk`). Place a test call, set a
disposition that's in the archive list, and watch the logs.

## Deploy to Railway

1. Push this repo to GitHub and create a Railway project from it. `railway.json`
   sets the build (Nixpacks) and start command, with a health check on `/health`.
2. Add all the env vars from `.env.example` in the Railway service settings.
3. **Attach a volume** and set `DB_PATH` to a path on it (for example
   `/data/calls.db`). The container filesystem is ephemeral, so without a volume
   the dedup and folder-cache tables reset on every redeploy, which means
   re-downloads and duplicate Drive uploads.
4. Use the Railway-provided public URL as the CloudTalk webhook target.

## Open TODOs

Both get resolved during the live test when wiring the webhook in CloudTalk:

- **Signature verification** (`src/cloudtalk.ts`) — capture a real signed
  request, then implement the check. Currently a pass-through stub.
- **Recording download auth** (`src/cloudtalk.ts`) — confirm whether
  `recording_link` accepts the API basic-auth header or needs a signed URL. The
  content-type guard already marks the call failed if it gets HTML instead of
  audio, so a misconfiguration won't archive junk.

## Layout

```
src/
  index.ts       express server, webhook route
  cloudtalk.ts   api client, auth, recording download, signature check
  drive.ts       drive client, lazy folder resolver with cache, upload
  router.ts      disposition map, skip list, folder + filename logic
  process.ts     one call end to end, shared by webhook and backfill
  db.ts          sqlite init + helpers
  backfill.ts    7-day catch-up script
  probe.ts       standalone: dump a call's json to confirm field names
  types.ts       shared types
```
