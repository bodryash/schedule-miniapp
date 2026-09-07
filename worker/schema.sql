-- Обезличенная статистика открытий мини-приложения.
--
-- Имён и идентификаторов Telegram здесь нет: пользователь представлен
-- хэшем от своего id с серверным секретом. Истории просмотров тоже нет —
-- только «этот аноним заходил тогда-то с такой группой».

-- Сколько раз открывали расписание в этот день, по группам.
CREATE TABLE IF NOT EXISTS opens (
  day    TEXT NOT NULL,          -- 2026-09-07
  grp    TEXT NOT NULL,
  course INTEGER,
  level  TEXT,
  count  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, grp)
);

-- Кто заходил, чтобы отличить 200 открытий одним человеком от 200 человек.
CREATE TABLE IF NOT EXISTS people (
  uid   TEXT PRIMARY KEY,        -- хэш, не идентификатор Telegram
  first TEXT NOT NULL,
  last  TEXT NOT NULL,
  grp   TEXT
);

CREATE INDEX IF NOT EXISTS people_last ON people (last);
CREATE INDEX IF NOT EXISTS opens_day ON opens (day);
