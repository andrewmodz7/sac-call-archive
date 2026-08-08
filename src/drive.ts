// Google Drive client. Resolves the nested folder path (creating folders lazily
// and caching their ids in SQLite) and uploads the mp3 by streaming.

import type { Readable } from "node:stream";
import { google, type drive_v3 } from "googleapis";
import { cacheFolder, getCachedFolder } from "./db.js";

let driveClient: drive_v3.Drive | null = null;

function getDrive(): drive_v3.Drive {
  if (driveClient) return driveClient;

  const json = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!json) throw new Error("Missing required env var: GOOGLE_SERVICE_ACCOUNT_JSON");

  let credentials: Record<string, unknown>;
  try {
    credentials = JSON.parse(json);
  } catch {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON");
  }

  // Full drive scope: the root folder is shared with the service account
  // manually, and drive.file only grants access to files the app itself
  // created, which wouldn't include that pre-existing shared folder.
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/drive"],
  });
  driveClient = google.drive({ version: "v3", auth });
  return driveClient;
}

// There is more than one root now: the shared "CloudTalk Recordings" folder
// (DRIVE_ROOT_FOLDER_ID) and Joe's separate folder (JOE_DRIVE_ROOT_FOLDER_ID),
// which is not nested under it. The caller names the env var; router.ts decides
// which one applies. Both are shared with the service account manually.
function rootFolderId(envVar: string): string {
  const id = process.env[envVar];
  if (!id) throw new Error(`Missing required env var: ${envVar}`);
  return id;
}

async function findChildFolder(parentId: string, name: string): Promise<string | undefined> {
  const escaped = name.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const res = await getDrive().files.list({
    q: `'${parentId}' in parents and name = '${escaped}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: "files(id, name)",
    pageSize: 10,
    // Work whether the root lives in My Drive or a Shared Drive.
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  return res.data.files?.[0]?.id ?? undefined;
}

async function createFolder(parentId: string, name: string): Promise<string> {
  const res = await getDrive().files.create({
    requestBody: {
      name,
      mimeType: "application/vnd.google-apps.folder",
      parents: [parentId],
    },
    fields: "id",
    supportsAllDrives: true,
  });
  const id = res.data.id;
  if (!id) throw new Error(`failed to create folder: ${name}`);
  return id;
}

// Walk the segments under the given root folder, reusing cached ids and
// creating any missing level.
//
// Cache key is the root folder id plus the cumulative path under it. The root
// id has to be part of the key: Joe's root has "Not Interested/2026-07" at the
// top level, and so would any future root, so a path-only key would hand back
// the wrong folder id across roots. Existing folder_cache rows written under
// the old path-only key are simply never hit again — the first lookup per path
// re-resolves against Drive, finds the folder that is already there, and
// re-caches it under the new key. No duplicate folders, no migration.
export async function resolveFolderPath(
  segments: string[],
  rootEnvVar = "DRIVE_ROOT_FOLDER_ID",
): Promise<string> {
  const rootId = rootFolderId(rootEnvVar);
  let parentId = rootId;
  let pathKey = rootId;

  for (const segment of segments) {
    pathKey = `${pathKey}/${segment}`;

    const cached = getCachedFolder(pathKey);
    if (cached) {
      parentId = cached;
      continue;
    }

    const existing = await findChildFolder(parentId, segment);
    const id = existing ?? (await createFolder(parentId, segment));
    cacheFolder(pathKey, id);
    parentId = id;
  }

  return parentId;
}

// Read-only counterpart to resolveFolderPath: walks the same segment path,
// reusing the same cache, but never creates a missing folder. Returns
// undefined the moment any segment in the path doesn't exist yet, rather than
// materializing it — used by the reminder email, which must never leave an
// empty folder behind just because it asked about a disposition that hasn't
// been archived yet today. A full-path hit is still written to folder_cache,
// since that lookup is exactly as valid to reuse as one from archiving.
export async function findFolderReadOnly(
  segments: string[],
  rootEnvVar = "DRIVE_ROOT_FOLDER_ID",
): Promise<string | undefined> {
  const rootId = rootFolderId(rootEnvVar);
  let parentId = rootId;
  let pathKey = rootId;

  for (const segment of segments) {
    pathKey = `${pathKey}/${segment}`;

    const cached = getCachedFolder(pathKey);
    if (cached) {
      parentId = cached;
      continue;
    }

    const existing = await findChildFolder(parentId, segment);
    if (!existing) return undefined;
    cacheFolder(pathKey, existing);
    parentId = existing;
  }

  return parentId;
}

export async function uploadMp3(args: {
  folderId: string;
  filename: string;
  body: Readable;
}): Promise<string> {
  const res = await getDrive().files.create({
    requestBody: { name: args.filename, parents: [args.folderId] },
    media: { mimeType: "audio/wav", body: args.body },
    fields: "id",
    supportsAllDrives: true,
  });
  const id = res.data.id;
  if (!id) throw new Error("drive upload returned no file id");
  return id;
}
