-- «Сессия 2048»: см. worker/schema.sql (game_runs, game_best).
-- «Сессия 2048»: партии (зерно и запись ходов — сервер сам считает счёт).
CREATE TABLE IF NOT EXISTS game_runs (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  event    TEXT NOT NULL,
  tg_id    INTEGER NOT NULL,
  seed     INTEGER NOT NULL,
  tenant   TEXT NOT NULL DEFAULT '',
  fac      TEXT NOT NULL DEFAULT '',
  started  TEXT NOT NULL,
  updated  TEXT,
  moves    TEXT NOT NULL DEFAULT '',
  score    INTEGER NOT NULL DEFAULT 0,
  max_tile INTEGER NOT NULL DEFAULT 2,
  over     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS game_runs_user ON game_runs (event, tg_id);

-- Лучший результат игрока за турнир (по нему таблицы игроков и факультетов).
CREATE TABLE IF NOT EXISTS game_best (
  event    TEXT NOT NULL,
  tg_id    INTEGER NOT NULL,
  name     TEXT NOT NULL,
  tenant   TEXT NOT NULL DEFAULT '',
  fac      TEXT NOT NULL DEFAULT '',
  best     INTEGER NOT NULL DEFAULT 0,
  max_tile INTEGER NOT NULL DEFAULT 2,
  games    INTEGER NOT NULL DEFAULT 0,
  updated  TEXT,
  PRIMARY KEY (event, tg_id)
);
CREATE INDEX IF NOT EXISTS game_best_rank ON game_best (event, best DESC);
