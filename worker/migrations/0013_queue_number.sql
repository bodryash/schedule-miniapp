-- Номер семинара («семинар 7») и мягкое удаление: снесённую очередь
-- владелец должен видеть вместе со всеми, кто в ней стоял.
ALTER TABLE queues ADD COLUMN number INTEGER NOT NULL DEFAULT 0;
ALTER TABLE queues ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0;
