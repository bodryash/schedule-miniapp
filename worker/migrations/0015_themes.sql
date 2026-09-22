-- Особые темы оформления: выдаёт владелец командой /theme.
-- target — «user:<id>», группа, «курс:…» или «*».
CREATE TABLE IF NOT EXISTS themes (
  target  TEXT PRIMARY KEY,
  theme   TEXT NOT NULL,
  created TEXT NOT NULL
);
