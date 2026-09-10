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

-- Кому можно написать. Telegram список пользователей бота не отдаёт, так
-- что кроме этой записи взять его неоткуда. Раньше лежало в KV, но там
-- всего 1000 записей в сутки — в день массовой раздачи ссылки лишние
-- молча не попали бы в список.
CREATE TABLE IF NOT EXISTS users (
  id       INTEGER PRIMARY KEY,   -- chat_id
  name     TEXT,
  username TEXT,
  first    TEXT,
  last     TEXT
);

-- Рассылка. Отправляем не сразу: воркеру нельзя делать больше полусотни
-- обращений наружу за один запрос, а получателей сотни. Поэтому письма
-- складываются в очередь, а разбирает её задача по расписанию.
CREATE TABLE IF NOT EXISTS broadcasts (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  text    TEXT NOT NULL,
  created TEXT NOT NULL,
  status  TEXT NOT NULL DEFAULT 'draft',  -- draft | sending | done | cancelled
  sent    INTEGER NOT NULL DEFAULT 0,
  failed  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS outbox (
  broadcast INTEGER NOT NULL,
  chat_id   INTEGER NOT NULL,
  state     TEXT NOT NULL DEFAULT 'pending',  -- pending | sent | failed
  PRIMARY KEY (broadcast, chat_id)
);

-- Объявления об изменениях: владелец пишет /notice, приложение показывает
-- плашку у группы. grp = '*' — для всех. Сами исчезают после expires.
CREATE TABLE IF NOT EXISTS notices (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  grp     TEXT NOT NULL,
  text    TEXT NOT NULL,
  created TEXT NOT NULL,
  expires TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS notices_grp ON notices (grp, expires);
CREATE INDEX IF NOT EXISTS outbox_pending ON outbox (broadcast, state);
CREATE INDEX IF NOT EXISTS people_last ON people (last);
CREATE INDEX IF NOT EXISTS opens_day ON opens (day);
