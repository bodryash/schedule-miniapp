-- Номер в очереди выбирает сам записавшийся: 0 — «любой свободный».
ALTER TABLE queue_spots ADD COLUMN position INTEGER NOT NULL DEFAULT 0;
