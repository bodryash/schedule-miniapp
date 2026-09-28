-- Важные пары: владелец помечает преподавателя (по фамилии) или предмет,
-- и их пары у всех студентов выделяются красным.
CREATE TABLE IF NOT EXISTS important (
  value   TEXT PRIMARY KEY COLLATE NOCASE,
  kind    TEXT NOT NULL DEFAULT 'teacher',  -- teacher | subject
  created TEXT NOT NULL
);
