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

function rootFolderId(): string {
  const id = process.env.DRIVE_ROOT_FOLDER_ID;
  if (!id) throw new Error("Missing required env var: DRIVE_ROOT_FOLDER_ID");
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

// Walk the segments under the root folder, reusing cached ids and creating any
// missing level. Cache key is the cumulative path under the root, so the same
// folder name under two different agents never collides.
export async function resolveFolderPath(segments: string[]): Promise<string> {
  let parentId = rootFolderId();
  let pathKey = "";

  for (const segment of segments) {
    pathKey = pathKey ? `${pathKey}/${segment}` : segment;

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
