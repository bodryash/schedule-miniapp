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
  failed  INTEGER NOT NULL DEFAULT 0,
  -- 1 — под сообщением кнопка «Открыть расписание». В уже созданную базу
  -- столбец добавляет migrations/0002_broadcast_button.sql.
  button  INTEGER NOT NULL DEFAULT 0
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

-- Язык Telegram при открытии: только сумма за день, без людей. Нужна,
-- чтобы понять, стоит ли переводить приложение (иностранцы, китайцы).
CREATE TABLE IF NOT EXISTS langs (
  day   TEXT NOT NULL,
  lang  TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, lang)
);

-- Старосты: назначает владелец командой /starosta. Только они вносят
-- домашку своей группы. У группы может быть несколько старост.
CREATE TABLE IF NOT EXISTS starostas (
  grp      TEXT NOT NULL,
  tg_id    INTEGER NOT NULL,
  name     TEXT,
  username TEXT,
  created  TEXT NOT NULL,
  PRIMARY KEY (grp, tg_id)
);

CREATE INDEX IF NOT EXISTS starostas_user ON starostas (tg_id);

-- Домашка: одна запись на предмет, подгруппу и дату пары. subgroup 0 —
-- всей группе. Пустой текст из приложения удаляет запись.
CREATE TABLE IF NOT EXISTS homework (
  grp      TEXT NOT NULL,
  subject  TEXT NOT NULL,
  subgroup INTEGER NOT NULL DEFAULT 0,
  day      TEXT NOT NULL,
  text     TEXT NOT NULL,
  author   INTEGER NOT NULL,
  updated  TEXT NOT NULL,
  PRIMARY KEY (grp, subject, subgroup, day)
);

CREATE INDEX IF NOT EXISTS homework_grp ON homework (grp, day);

-- Комментарии к паре в конкретный день. Пишет и читает своя группа, с
-- именем из Telegram. hidden: 0 — виден, 1 — скрыт жалобами до решения
-- владельца, 2 — удалён.
CREATE TABLE IF NOT EXISTS comments (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  grp     TEXT NOT NULL,
  day     TEXT NOT NULL,
  subject TEXT NOT NULL,
  tg_id   INTEGER NOT NULL,
  name    TEXT NOT NULL,
  text    TEXT NOT NULL,
  created TEXT NOT NULL,
  hidden  INTEGER NOT NULL DEFAULT 0,
  reports INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS comments_lesson ON comments (grp, day, subject, hidden);
CREATE INDEX IF NOT EXISTS comments_author ON comments (tg_id, created);
CREATE INDEX IF NOT EXISTS comments_group_day ON comments (grp, created);

-- Счётчики «💬 N» под парами: отдельной таблицей, чтобы открытие
-- расписания не пересчитывало комментарии, а читало по строке на пару.
CREATE TABLE IF NOT EXISTS comment_counts (
  grp     TEXT NOT NULL,
  day     TEXT NOT NULL,
  subject TEXT NOT NULL,
  count   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (grp, day, subject)
);

-- Кто на что пожаловался: один голос на человека.
CREATE TABLE IF NOT EXISTS comment_reports (
  comment INTEGER NOT NULL,
  tg_id   INTEGER NOT NULL,
  PRIMARY KEY (comment, tg_id)
);

-- Отменённые пары: /cancel. grp — как в notices. day — ISO-дата,
-- slots — номера пар через запятую, пусто — весь день.
CREATE TABLE IF NOT EXISTS cancels (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  grp     TEXT NOT NULL,
  day     TEXT NOT NULL,
  slots   TEXT NOT NULL DEFAULT '',
  reason  TEXT NOT NULL DEFAULT '',
  created TEXT NOT NULL,
  removed INTEGER NOT NULL DEFAULT 0,
  -- Точная отмена по преподавателю: один предмет и подгруппа (0 — все).
  -- В уже созданную базу — migrations/0003_cancel_precise.sql.
  subject  TEXT NOT NULL DEFAULT '',
  subgroup INTEGER NOT NULL DEFAULT 0,
  teacher  TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS cancels_grp ON cancels (grp, day);
CREATE INDEX IF NOT EXISTS outbox_pending ON outbox (broadcast, state);
CREATE INDEX IF NOT EXISTS people_last ON people (last);
CREATE INDEX IF NOT EXISTS opens_day ON opens (day);
