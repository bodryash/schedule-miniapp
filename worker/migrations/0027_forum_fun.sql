-- Подслушка: «Задание дня» и лучший ответ.
ALTER TABLE forum_posts ADD COLUMN challenge TEXT;
ALTER TABLE forum_posts ADD COLUMN best INTEGER NOT NULL DEFAULT 0;
