-- Чаты, за которыми следит бот: там куратор выкладывает PDF расписания.
-- Бот в эти чаты ничего не пишет, только забирает файл.
CREATE TABLE IF NOT EXISTS watched_chats (
  chat_id INTEGER PRIMARY KEY,
  title   TEXT NOT NULL DEFAULT '',
  added   TEXT NOT NULL
);

-- Присланные файлы ждут подтверждения владельца: file_id длиннее, чем
-- влезает в кнопку, поэтому в кнопке только номер этой записи.
CREATE TABLE IF NOT EXISTS pending_pdfs (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id TEXT NOT NULL,
  name    TEXT NOT NULL DEFAULT '',
  sender  TEXT NOT NULL DEFAULT '',
  created TEXT NOT NULL
);
