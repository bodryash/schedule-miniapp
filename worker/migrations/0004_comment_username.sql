-- @username автора комментария — для /comments.
-- Выполнить один раз на рабочей базе:
--   npx wrangler d1 execute schedule-stats --remote --file migrations/0004_comment_username.sql
ALTER TABLE comments ADD COLUMN username TEXT;
