-- Очередь можно привязать к паре: тогда видно, к какому семинару она.
ALTER TABLE queues ADD COLUMN subject TEXT NOT NULL DEFAULT '';
