-- Напоминания: утреннее в 7:30 и за 15 минут до пары.
--
-- Личные настройки человека (языковая подгруппа, военная кафедра, МФК)
-- живут в приложении, поэтому оно само присылает свой план на две недели:
-- иначе бот напоминал бы о парах, на которые человек не ходит.
CREATE TABLE IF NOT EXISTS reminders (
  tg_id   INTEGER PRIMARY KEY,
  grp     TEXT NOT NULL DEFAULT '',
  morning INTEGER NOT NULL DEFAULT 1,  -- 1 — присылать утренний список
  before  INTEGER NOT NULL DEFAULT 15, -- за сколько минут до пары; 0 — не надо
  updated TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reminder_plan (
  tg_id   INTEGER NOT NULL,
  day     TEXT NOT NULL,   -- 2026-09-23
  start   TEXT NOT NULL,   -- 09:00
  end     TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL,
  room    TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (tg_id, day, start, subject)
);

CREATE INDEX IF NOT EXISTS reminder_plan_day ON reminder_plan (day, start);

-- Что уже отправлено: cron просыпается каждую минуту, и без этой записи
-- одно и то же напоминание ушло бы несколько раз.
CREATE TABLE IF NOT EXISTS reminder_sent (
  tg_id INTEGER NOT NULL,
  key   TEXT NOT NULL,     -- 2026-09-23|morning или 2026-09-23|09:00
  PRIMARY KEY (tg_id, key)
);
