-- Подслушка: общий форум студентов (см. worker/src/forum.js).
-- ===== Подслушка: общий форум студентов всех вузов =====
-- Автора всегда знаем (tg_id), даже если пост показан как анонимный: без
-- этого нельзя ни банить, ни отвечать на жалобы. Наружу tg_id не отдаём.
CREATE TABLE IF NOT EXISTS forum_posts (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  tg_id    INTEGER NOT NULL,
  name     TEXT NOT NULL,
  username TEXT,
  anon     INTEGER NOT NULL DEFAULT 1,
  text     TEXT NOT NULL,
  created  TEXT NOT NULL,
  -- 0 — виден, 1 — скрыт жалобами, 2 — удалён, 3 — ждёт проверки владельца
  hidden   INTEGER NOT NULL DEFAULT 0,
  reports  INTEGER NOT NULL DEFAULT 0,
  likes    INTEGER NOT NULL DEFAULT 0,
  replies  INTEGER NOT NULL DEFAULT 0,
  -- Почему отправлен на проверку: «новичок», «стоп-слово: …» и т. п.
  held_for  TEXT NOT NULL DEFAULT '',
  -- Необязательная подпись автора («МГУ · ФГП»); чисто для красоты.
  tag       TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS forum_posts_feed ON forum_posts (hidden, id);
CREATE INDEX IF NOT EXISTS forum_posts_author ON forum_posts (tg_id, created);

CREATE TABLE IF NOT EXISTS forum_replies (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  post     INTEGER NOT NULL,
  tg_id    INTEGER NOT NULL,
  name     TEXT NOT NULL,
  username TEXT,
  anon     INTEGER NOT NULL DEFAULT 1,
  text     TEXT NOT NULL,
  created  TEXT NOT NULL,
  hidden   INTEGER NOT NULL DEFAULT 0,
  reports  INTEGER NOT NULL DEFAULT 0,
  held_for TEXT NOT NULL DEFAULT '',
  -- Ответ на чей-то ответ (id ответа) или 0 — на сам пост.
  parent   INTEGER NOT NULL DEFAULT 0,
  likes    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS forum_replies_post ON forum_replies (post, hidden, id);
CREATE INDEX IF NOT EXISTS forum_replies_author ON forum_replies (tg_id, created);

CREATE TABLE IF NOT EXISTS forum_likes (
  post  INTEGER NOT NULL,
  tg_id INTEGER NOT NULL,
  PRIMARY KEY (post, tg_id)
);

CREATE TABLE IF NOT EXISTS forum_reply_likes (
  reply INTEGER NOT NULL,
  tg_id INTEGER NOT NULL,
  PRIMARY KEY (reply, tg_id)
);

-- Жалоба на пост (kind = 'p') или ответ (kind = 'r'); один человек — одна.
CREATE TABLE IF NOT EXISTS forum_reports (
  kind  TEXT NOT NULL,
  item  INTEGER NOT NULL,
  tg_id INTEGER NOT NULL,
  -- Причина, которую выбрал пожаловавшийся: spam, abuse, private, danger, other.
  reason TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (kind, item, tg_id)
);

-- Настройки форума: forum_on, forum_newbie_hold, forum_slow.
CREATE TABLE IF NOT EXISTS forum_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Кому уже одобрили хотя бы один пост: их следующие посты проверки не ждут.
CREATE TABLE IF NOT EXISTS forum_trusted (
  tg_id   INTEGER PRIMARY KEY,
  created TEXT NOT NULL
);

-- Присылать ли в бота «вам ответили»: по умолчанию да, выключается в форуме.
CREATE TABLE IF NOT EXISTS forum_prefs (
  tg_id  INTEGER PRIMARY KEY,
  notify INTEGER NOT NULL DEFAULT 1
);
