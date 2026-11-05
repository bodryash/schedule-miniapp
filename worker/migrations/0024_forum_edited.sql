-- Подслушка: правка своих постов и ответов.
ALTER TABLE forum_posts ADD COLUMN edited TEXT;
ALTER TABLE forum_replies ADD COLUMN edited TEXT;
