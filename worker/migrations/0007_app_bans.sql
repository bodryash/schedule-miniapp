-- Запрет открывать расписание (/block). until пустой — навсегда.
CREATE TABLE IF NOT EXISTS app_bans (
  tg_id    INTEGER PRIMARY KEY,
  name     TEXT,
  username TEXT,
  reason   TEXT NOT NULL DEFAULT '',
  created  TEXT NOT NULL,
  until    TEXT
);
