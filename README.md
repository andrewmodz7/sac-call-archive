# sac-call-archive

Webhook receiver that listens for CloudTalk's "recording uploaded" event,
downloads the call recording, and files it into Google Drive organized by
agent, disposition, and month. Built for Shore Acres Capital to keep a
searchable archive of cold-call recordings segmented by outcome.

Two agents, two layouts. Jay files under the shared root; Joe files under his
own separate Drive root with a different filename format:

```
Jay:  /CloudTalk Recordings/{Agent}/{Disposition}/{YYYY-MM}/{State}_{Name}_{YYYY-MM-DD}_{HH-MM}.wav
Joe:  /{Joe root}/{Disposition}/{YYYY-MM}/{Address}_{YYYY-MM-DD}.wav
```

### Agent identity

Joe makes his calls while logged into Frank Deliessche's CloudTalk seat, so
every call CloudTalk reports with `Agent.firstname === "Frank"` is really Joe's.
`resolveAgentIdentity` in `src/router.ts` maps `Frank -> Joe`, and that resolved
name is what drives the disposition set, the Drive root, the folder path, the
filename format, and the `agent_name` column. Rows written before this change
still say `Frank`; they are deliberately left alone. Remove the entry from
`AGENT_IDENTITY_OVERRIDES` if Frank ever starts making his own calls.

Every agent other than Joe keeps the original behavior and Jay's disposition
set, so routing does not depend on Jay's exact CloudTalk firstname.

> **Filename collision risk (Joe only).** `{Address}_{YYYY-MM-DD}.wav` has no
> time component, so two calls to the same address on the same day produce the
> same filename — and Drive allows duplicate names in a folder, so the second
> upload silently lands beside the first rather than replacing it or erroring.
> Both recordings are kept and both are reachable, but they are not
> distinguishable by name. Accepted as-is; add a time component if that becomes
> a problem.

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
JOE_DRIVE_ROOT_FOLDER_ID=<folder id of Joe's separate root folder>
```

`JOE_DRIVE_ROOT_FOLDER_ID` is an independent root, not a subfolder of
`DRIVE_ROOT_FOLDER_ID`. It needs the same **Editor** share with the service
account as step 6.

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

Flags:

```
npm run backfill                       # rolling window: date_from = 7 days ago
npm run backfill -- --since=2026-07-13 # date_from = midnight Eastern on that date, date_to open
npm run backfill -- --until=2026-06-04T16:30:00Z  # date_to cutoff, no date_from
npm run backfill -- --dry-run          # report what WOULD happen, split by resolved agent;
                                       # downloads nothing, uploads nothing, writes no rows
```

`--since` and `--until` combine for a closed window. `--since` is read as
midnight in `America/New_York` (the archive is organized by Eastern date), with
the offset taken from `Intl` so it is correct on both sides of a DST change.

Dedup uses the `processed_calls` table, so a backfill only re-touches calls that
were never definitively filed (`skipped_no_disposition` and `failed` rows, plus
anything never seen). Already-archived rows with a `drive_file_id` are left
alone. This means it must run where the SQLite volume is mounted; against an
empty local DB every call looks new and would be re-downloaded and re-filed.

### Backfill over HTTP

To run the backfill inside the deployed service (where the volume is mounted)
without shell access, there is a token-gated endpoint, same auth as the reminder
trigger (`ADMIN_TRIGGER_TOKEN`, `x-admin-token` header):

```
POST /admin/backfill
```

It takes `since`, `until`, and `dryRun` from the query string or a JSON body.
**`dryRun` defaults to true** — a real run must be asked for with an explicit
`dryRun=false`, so a bare call can never download or file anything by accident.
The response is `{ ok, summary }` where `summary` carries the same counts the
`--dry-run` CLI logs, including `wouldArchiveByAgent` and
`wouldArchiveByDisposition`. A live run pages with 1s sleeps and downloads
recordings, so use a generous client timeout.

```
# dry run (counts only)
curl -X POST "https://<your-deploy-host>/admin/backfill?since=2026-07-13" \
  -H "x-admin-token: <ADMIN_TRIGGER_TOKEN>"

# live run
curl --max-time 1800 -X POST "https://<your-deploy-host>/admin/backfill" \
  -H "x-admin-token: <ADMIN_TRIGGER_TOKEN>" \
  -H "content-type: application/json" \
  -d '{"since":"2026-07-13","dryRun":false}'
```

## Daily reminder email

Monday through Friday at 6:00 PM `America/New_York`, the service emails Kenneth
a reminder to review the day's recordings, with links to both Drive roots. It
runs on an in-process `node-cron` schedule inside this same service, so there is
no second deployment and no external cron.

The timezone is handled by `node-cron`'s `timezone` option, which resolves the
offset through `Intl.DateTimeFormat` per fire rather than holding a fixed one,
so 6 PM stays 6 PM across both DST transitions.

### Setup

The sender is a Gmail account using an **App Password**, not the account
password. Generate one at <https://myaccount.google.com/apppasswords> (the
account needs 2FA enabled), then set:

```
GMAIL_SMTP_USER=            # the sending gmail address, also used as the From
GMAIL_SMTP_APP_PASSWORD=    # the 16-character app password
```

Recipients default to the addresses below and only need setting to change them:

```
KENNETH_EMAIL=kdanna@shoreacrescapital.com          # To:
ANDREW_EMAIL_CC=amodzelewski@shoreacrescapital.com  # Cc:
```

The email links to `DRIVE_ROOT_FOLDER_ID` (Jay) and `JOE_DRIVE_ROOT_FOLDER_ID`
(Joe), so both must be set for the send to succeed.

To point Kenneth straight at Jay's folder instead of the shared root one level
above it, set the folder id directly:

```
JAY_DRIVE_FOLDER_ID=        # optional. Jay's folder inside DRIVE_ROOT_FOLDER_ID
```

Unset, the Jay link falls back to `DRIVE_ROOT_FOLDER_ID`. This is a separate var
because Jay's subfolder id is not derivable without hardcoding his CloudTalk
firstname. It only affects the reminder email; call filing still resolves the
folder itself and is unchanged.

If `GMAIL_SMTP_USER` / `GMAIL_SMTP_APP_PASSWORD` are missing the scheduler does
not start at all, and logs `reminder_scheduler_disabled` once at boot. That is
the expected state in local dev.

### Sending a test

Two ways, both send a real email to the real recipients.

A one-off script, run against the deployed environment so it picks up the
Railway env:

```
railway run npm run remind
```

Add `--preview` to print the message and send nothing:

```
npm run remind -- --preview
```

Or an HTTP trigger, which is disabled and returns 404 unless
`ADMIN_TRIGGER_TOKEN` is set to any random string:

```
ADMIN_TRIGGER_TOKEN=<random string>
```

```
curl -X POST https://<your-deploy-host>/admin/send-reminder \
  -H "x-admin-token: <that same string>"
```

`{"ok":true}` with 200 means it sent, `{"ok":false}` with 500 means it did not
and the reason is in the logs.

### Reliability

The reminder is a side feature and is isolated from call archiving. A failed
send logs `reminder_failed` with the error and is dropped; there is no retry
beyond the next weekday's run, and nothing in this path can throw into the
webhook or the uploader. Log lines are the same JSON-per-line format as
everything else: `reminder_fired`, `reminder_sent`, `reminder_skipped`,
`reminder_failed`, `reminder_scheduler_started`, `reminder_scheduler_disabled`.

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
  router.ts      agent identity, per-agent disposition maps, skip list,
                 folder + filename logic
  process.ts     one call end to end, shared by webhook and backfill
  db.ts          sqlite init + helpers
  backfill.ts    7-day catch-up script
  mailer.ts      gmail smtp transport (nodemailer)
  reminder.ts    the daily reminder email, content + send
  scheduler.ts   in-process mon-fri 6pm ET schedule
  send-reminder.ts  one-off manual send, `npm run remind`
  probe.ts       standalone: dump a call's json to confirm field names
  types.ts       shared types
```
