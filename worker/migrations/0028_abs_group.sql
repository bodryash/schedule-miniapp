-- Условия пропусков на всю группу (задаёт староста).
CREATE TABLE IF NOT EXISTS abs_group (
  grp     TEXT NOT NULL,
  subject TEXT NOT NULL,
  data    TEXT NOT NULL,
  updated TEXT NOT NULL,
  PRIMARY KEY (grp, subject)
);
