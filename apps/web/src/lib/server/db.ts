import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

import { dataRootDir } from "@/lib/vod";

let dbSingleton: Database.Database | null = null;

function openDatabase(): Database.Database {
  const dbPath = path.join(dataRootDir(), "app.db");
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);

    CREATE TABLE IF NOT EXISTS user_profiles (
      user_id TEXT PRIMARY KEY,
      long_term_cache_json TEXT NOT NULL,
      bots_json TEXT NOT NULL,
      emotes_json TEXT NOT NULL,
      twitch_channel_url TEXT NOT NULL DEFAULT '',
      stream_questionnaire_json TEXT NOT NULL DEFAULT '{}',
      updated_at INTEGER NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS live_contexts (
      user_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      live_context_json TEXT NOT NULL DEFAULT '{}',
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, session_id),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_live_contexts_user_updated ON live_contexts(user_id, updated_at);

    CREATE TABLE IF NOT EXISTS user_vods (
      user_id TEXT NOT NULL,
      vod_id TEXT NOT NULL,
      vod_name TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, vod_id),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_user_vods_user_created ON user_vods(user_id, created_at);

    CREATE TABLE IF NOT EXISTS user_live_metric_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      ts_ms INTEGER NOT NULL,
      seen_delta INTEGER NOT NULL DEFAULT 0,
      filtered_delta INTEGER NOT NULL DEFAULT 0,
      highlighted_delta INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_user_live_metric_events_user_ts
      ON user_live_metric_events(user_id, ts_ms);
    CREATE INDEX IF NOT EXISTS idx_user_live_metric_events_user_session
      ON user_live_metric_events(user_id, session_id);
  `);

  const columns = db.prepare("PRAGMA table_info(user_profiles)").all() as Array<{ name: string }>;
  const hasTwitchColumn = columns.some((c) => c.name === "twitch_channel_url");
  if (!hasTwitchColumn) {
    db.exec("ALTER TABLE user_profiles ADD COLUMN twitch_channel_url TEXT NOT NULL DEFAULT ''");
  }
  const hasStreamQuestionnaireColumn = columns.some((c) => c.name === "stream_questionnaire_json");
  if (!hasStreamQuestionnaireColumn) {
    db.exec("ALTER TABLE user_profiles ADD COLUMN stream_questionnaire_json TEXT NOT NULL DEFAULT '{}'");
  }
  const userVodColumns = db.prepare("PRAGMA table_info(user_vods)").all() as Array<{ name: string }>;
  const hasVodNameColumn = userVodColumns.some((c) => c.name === "vod_name");
  if (!hasVodNameColumn) {
    db.exec("ALTER TABLE user_vods ADD COLUMN vod_name TEXT NOT NULL DEFAULT ''");
  }
  db.exec("UPDATE user_vods SET vod_name = 'VOD ' || vod_id WHERE TRIM(COALESCE(vod_name, '')) = ''");
}

export function getDb(): Database.Database {
  if (dbSingleton) return dbSingleton;
  const db = openDatabase();
  migrate(db);
  dbSingleton = db;
  return dbSingleton;
}
