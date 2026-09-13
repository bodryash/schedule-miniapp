-- Точная отмена (/cancel преп Фамилия …): не вся пара группы, а один
-- предмет и, для языков, одна подгруппа. Пустой предмет и подгруппа 0 —
-- как раньше, вся пара. teacher — для списка /cancel.
-- Выполнить один раз на рабочей базе:
--   npx wrangler d1 execute schedule-stats --remote --file migrations/0003_cancel_precise.sql
ALTER TABLE cancels ADD COLUMN subject TEXT NOT NULL DEFAULT '';
ALTER TABLE cancels ADD COLUMN subgroup INTEGER NOT NULL DEFAULT 0;
ALTER TABLE cancels ADD COLUMN teacher TEXT NOT NULL DEFAULT '';
