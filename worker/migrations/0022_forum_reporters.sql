-- Подслушка: кто пожаловался (виден только владельцу).
ALTER TABLE forum_reports ADD COLUMN name TEXT NOT NULL DEFAULT '';
ALTER TABLE forum_reports ADD COLUMN username TEXT;
