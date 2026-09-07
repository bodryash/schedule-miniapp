-- Статистика открытий мини-приложения.
--
-- Кто заходил — видно поимённо: владелец попросил именно так. Истории
-- просмотров всё равно нет — только «этот человек заходил тогда-то с такой
-- группой». Кто НЕ заходил, отсюда не узнать: про человека, ни разу не
-- открывшего приложение, здесь нет вообще ничего.

-- Сколько раз открывали расписание в этот день, по группам.
CREATE TABLE IF NOT EXISTS opens (
  day    TEXT NOT NULL,          -- 2026-09-07
  grp    TEXT NOT NULL,
  course INTEGER,
  level  TEXT,
  count  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, grp)
);

-- Кто заходил: и чтобы отличить 200 открытий одним человеком от 200 людей,
-- и чтобы видеть поимённо.
CREATE TABLE IF NOT EXISTS people (
  uid      TEXT PRIMARY KEY,     -- хэш id, ключ остался прежним
  first    TEXT NOT NULL,
  last     TEXT NOT NULL,
  grp      TEXT,
  tg_id    INTEGER,
  name     TEXT,
  username TEXT
);

CREATE INDEX IF NOT EXISTS people_last ON people (last);
CREATE INDEX IF NOT EXISTS opens_day ON opens (day);
