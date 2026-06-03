// SQLite is the only persistence: dedup tracking plus a folder-id cache so we
// don't re-query Drive for the same folder on every call.
//
// On Railway the container filesystem is ephemeral. Attach a volume and point
// DB_PATH at it, otherwise the dedup table resets on every redeploy. See README.

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ProcessedAction } from "./types.js";

const DB_PATH = process.env.DB_PATH ?? "data/calls.db";
mkdirSync(dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS processed_calls (
    call_id TEXT PRIMARY KEY,
    agent_name TEXT,
    disposition TEXT,
    -- ProcessedAction (see types.ts): archived | skipped_no_recording |
    -- skipped_voicemail_flag | skipped_disposition | skipped_no_disposition |
    -- skipped_expired (410 gone) | failed
    action TEXT,
    drive_file_id TEXT,
    processed_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS folder_cache (
    folder_path TEXT PRIMARY KEY,
    drive_folder_id TEXT NOT NULL,
    cached_at TEXT NOT NULL
  );
`);

export function isProcessed(callId: string): boolean {
  const row = db.prepare("SELECT 1 FROM processed_calls WHERE call_id = ?").get(callId);
  return row !== undefined;
}

export interface ProcessedRow {
  call_id: string;
  agent_name: string | null;
  disposition: string | null;
  action: ProcessedAction;
  drive_file_id: string | null;
}

export function recordResult(row: ProcessedRow): void {
  db.prepare(
    `INSERT OR REPLACE INTO processed_calls
       (call_id, agent_name, disposition, action, drive_file_id, processed_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    row.call_id,
    row.agent_name,
    row.disposition,
    row.action,
    row.drive_file_id,
    new Date().toISOString(),
  );
}

export function getCachedFolder(folderPath: string): string | undefined {
  const row = db
    .prepare("SELECT drive_folder_id FROM folder_cache WHERE folder_path = ?")
    .get(folderPath) as { drive_folder_id: string } | undefined;
  return row?.drive_folder_id;
}

export function cacheFolder(folderPath: string, driveFolderId: string): void {
  db.prepare(
    `INSERT OR REPLACE INTO folder_cache (folder_path, drive_folder_id, cached_at)
     VALUES (?, ?, ?)`,
  ).run(folderPath, driveFolderId, new Date().toISOString());
}
