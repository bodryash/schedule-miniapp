-- Приветствие на заставке приложения: владелец задаёт свою надпись
-- человеку, группе, курсу или всем командой /hello.
-- target — «user:<id>», группа, «курс:…» или «*».
CREATE TABLE IF NOT EXISTS greetings (
  target  TEXT PRIMARY KEY,
  text    TEXT NOT NULL,
  created TEXT NOT NULL
);
