-- Слово недели: одно слово на весь факультет, первый угадавший забирает
-- корону себе и своей группе. Сами слова лежат только здесь, в базе:
-- репозиторий открытый, в коде их прочёл бы любой.
CREATE TABLE IF NOT EXISTS word_list (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  word TEXT NOT NULL,
  hint TEXT NOT NULL DEFAULT '',
  week TEXT                       -- понедельник недели, на которую слово выпало
);

CREATE TABLE IF NOT EXISTS word_guesses (
  week    TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  n       INTEGER NOT NULL,
  guess   TEXT NOT NULL,
  marks   TEXT NOT NULL,          -- по букве: g — на месте, y — есть в слове, x — нет
  day     TEXT NOT NULL,
  PRIMARY KEY (week, user_id, n)
);

CREATE TABLE IF NOT EXISTS word_wins (
  week    TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  name    TEXT NOT NULL DEFAULT '',
  grp     TEXT NOT NULL DEFAULT '',
  created TEXT NOT NULL
);
