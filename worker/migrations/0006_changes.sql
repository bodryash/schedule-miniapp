-- Замены на дату (/change): другой преподаватель, время или аудитория.
CREATE TABLE IF NOT EXISTS changes (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  grp          TEXT NOT NULL,
  day          TEXT NOT NULL,
  slots        TEXT NOT NULL,
  from_teacher TEXT NOT NULL DEFAULT '',
  teacher      TEXT NOT NULL DEFAULT '',
  room         TEXT NOT NULL DEFAULT '',
  start        TEXT NOT NULL DEFAULT '',
  reason       TEXT NOT NULL DEFAULT '',
  created      TEXT NOT NULL,
  removed      INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS changes_grp ON changes (grp, day);
