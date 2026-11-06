-- «Неделя магната»: личные ссылки и приглашённые.
CREATE TABLE IF NOT EXISTS ref_codes (
  tg_id    INTEGER PRIMARY KEY,
  code     TEXT NOT NULL UNIQUE,
  name     TEXT,
  username TEXT,
  created  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ref_hits (
  invitee   INTEGER PRIMARY KEY,
  referrer  INTEGER NOT NULL,
  at        TEXT NOT NULL,
  active    INTEGER NOT NULL DEFAULT 0,
  active_at TEXT
);
CREATE INDEX IF NOT EXISTS ref_hits_referrer ON ref_hits (referrer, active, active_at);
