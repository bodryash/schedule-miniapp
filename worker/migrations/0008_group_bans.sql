-- Запрет открывать расписание для группы, курса или всех (/block 311гэу).
CREATE TABLE IF NOT EXISTS app_group_bans (
  grp     TEXT PRIMARY KEY,
  reason  TEXT NOT NULL DEFAULT '',
  created TEXT NOT NULL,
  until   TEXT
);
