-- Удалённую очередь владелец видит в приложении, пока не уберёт её сам.
-- В /queues она остаётся в любом случае.
ALTER TABLE queues ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;
