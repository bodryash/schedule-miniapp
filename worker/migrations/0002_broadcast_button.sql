-- Кнопка «Открыть расписание» под рассылкой (/updated).
-- Выполнить один раз на рабочей базе:
--   npx wrangler d1 execute schedule-stats --remote --file migrations/0002_broadcast_button.sql
-- Повторный запуск упадёт с «duplicate column» — это значит, уже применено.
ALTER TABLE broadcasts ADD COLUMN button INTEGER NOT NULL DEFAULT 0;
