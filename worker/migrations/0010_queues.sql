-- Очереди: доклады, сдачи, отработки — всё, где важен порядок. Заводит
-- староста группы или владелец, записываются сами студенты.
CREATE TABLE IF NOT EXISTS queues (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  grp     TEXT NOT NULL,
  title   TEXT NOT NULL,
  day     TEXT NOT NULL DEFAULT '',   -- ISO-дата или пусто
  slots   INTEGER NOT NULL DEFAULT 0, -- 0 — без ограничения
  author  INTEGER NOT NULL,
  created TEXT NOT NULL,
  closed  INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS queues_grp ON queues (grp, closed);

-- Место в очереди. Номер не храним: он считается по времени записи, иначе
-- после выхода одного человека пришлось бы перенумеровывать всех.
CREATE TABLE IF NOT EXISTS queue_spots (
  queue    INTEGER NOT NULL,
  tg_id    INTEGER NOT NULL,
  name     TEXT NOT NULL DEFAULT '',
  username TEXT,
  note     TEXT NOT NULL DEFAULT '',
  created  TEXT NOT NULL,
  PRIMARY KEY (queue, tg_id)
);

CREATE INDEX IF NOT EXISTS queue_spots_queue ON queue_spots (queue, created);
