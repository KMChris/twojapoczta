// SQLite storage on node:sqlite: schema setup and connection handling.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  login TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  signature TEXT NOT NULL DEFAULT '',
  theme TEXT NOT NULL DEFAULT 'system',
  created_at TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  is_blocked INTEGER NOT NULL DEFAULT 0,
  quota_mb INTEGER,
  last_login_at TEXT,
  alias_limit INTEGER DEFAULT 5,
  forward_to TEXT NOT NULL DEFAULT '',
  forward_keep INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  folder TEXT NOT NULL DEFAULT 'inbox',
  from_name TEXT NOT NULL DEFAULT '',
  from_addr TEXT NOT NULL,
  to_addr TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  snippet TEXT NOT NULL DEFAULT '',
  is_read INTEGER NOT NULL DEFAULT 0,
  is_starred INTEGER NOT NULL DEFAULT 0,
  is_priority INTEGER NOT NULL DEFAULT 0,
  sent_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_owner_folder
  ON messages(owner_id, folder, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS aliases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  alias TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS blobs (
  hash TEXT PRIMARY KEY,
  data BLOB NOT NULL,
  size INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  blob_hash TEXT NOT NULL REFERENCES blobs(hash)
);
CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments(message_id);

CREATE TABLE IF NOT EXISTS uploads (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  blob_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_login TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL DEFAULT '',
  details TEXT NOT NULL DEFAULT '',
  ip TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);

CREATE TABLE IF NOT EXISTS folders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE(user_id, name)
);
CREATE INDEX IF NOT EXISTS idx_folders_user ON folders(user_id, position);

CREATE TABLE IF NOT EXISTS teams (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  local_part TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS team_members (
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  can_send INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  PRIMARY KEY (team_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_team_members_user ON team_members(user_id);
`;

// Dostawia kolumnę do istniejącej bazy (migracja bez narzędzi zewnętrznych).
function ensureColumn(db, table, column, ddl) {
  const kolumny = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!kolumny.some((k) => k.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

export function openDb(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'twojapoczta.db'));
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

export function openMemoryDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

function migrate(db) {
  ensureColumn(db, 'messages', 'attachments_count', 'attachments_count INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'users', 'is_admin', 'is_admin INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'users', 'is_blocked', 'is_blocked INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'users', 'quota_mb', 'quota_mb INTEGER');
  ensureColumn(db, 'users', 'last_login_at', 'last_login_at TEXT');
  // DEFAULT 5 wypełnia istniejące konta piątką, więc limit sprzed panelu zostaje w mocy.
  ensureColumn(db, 'users', 'alias_limit', 'alias_limit INTEGER DEFAULT 5');
  ensureColumn(db, 'messages', 'body_html', "body_html TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'messages', 'cc_addr', "cc_addr TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'messages', 'bcc_addr', "bcc_addr TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'messages', 'scheduled_at', 'scheduled_at TEXT');
  ensureColumn(db, 'users', 'forward_to', "forward_to TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'users', 'forward_keep', 'forward_keep INTEGER NOT NULL DEFAULT 1');
  // Folder własny: wartownik folder='custom' + folder_id. Kolumna jest NULLowalna,
  // więc ALTER TABLE z REFERENCES przechodzi (SQLite wymaga tu domyślnego NULL).
  ensureColumn(db, 'messages', 'folder_id', 'folder_id INTEGER REFERENCES folders(id)');
  // Indeks musi powstać PO kolumnie, dlatego nie leży w SCHEMA.
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_messages_owner_folderid ON messages(owner_id, folder_id, sent_at DESC)'
  );
}

export function now() {
  return new Date().toISOString();
}
