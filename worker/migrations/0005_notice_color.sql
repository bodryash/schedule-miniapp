-- Цвет объявления (/notice 311гэу #красный …).
-- Выполнить один раз на рабочей базе:
--   npx wrangler d1 execute schedule-stats --remote --file migrations/0005_notice_color.sql
ALTER TABLE notices ADD COLUMN color TEXT NOT NULL DEFAULT 'yellow';
