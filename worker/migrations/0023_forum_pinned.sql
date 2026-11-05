-- Подслушка: закреплённые владельцем посты.
ALTER TABLE forum_posts ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
