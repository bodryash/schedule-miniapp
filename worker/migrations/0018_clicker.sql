-- Кликер посвящения: кто сколько раз нажал на праздничную плашку.
-- Имя и группа — для таблицы лидеров. username — только владельцу, чтобы
-- выдать приз. active — сколько секунд человек кликал: по нему видно
-- автокликер (живой палец не жмёт по 20 раз в секунду часами).
CREATE TABLE IF NOT EXISTS clicker (
  event    TEXT NOT NULL,
  user_id  INTEGER NOT NULL,
  name     TEXT NOT NULL DEFAULT '',
  username TEXT NOT NULL DEFAULT '',
  grp      TEXT NOT NULL DEFAULT '',
  taps     INTEGER NOT NULL DEFAULT 0,
  active   INTEGER NOT NULL DEFAULT 0,
  updated  INTEGER NOT NULL DEFAULT 0,
  banned   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (event, user_id)
);
