// Перенос базы из Cloudflare D1 в файл SQLite на сервере.
//
//   cd worker && npx wrangler d1 export schedule-stats --remote --output dump.sql
//   node server/import.mjs dump.sql data/schedule.sqlite
//
// D1 — тот же SQLite, поэтому выгрузка ложится как есть. В конце сверяем
// число строк в каждой таблице с тем, что было в выгрузке.
import { existsSync, readFileSync } from "node:fs";
import { createHmac } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const [dump, target] = process.argv.slice(2);
if (!dump || !target) {
  console.error("Нужно: node server/import.mjs <выгрузка.sql> <база.sqlite>");
  process.exit(1);
}
if (existsSync(target)) {
  console.error(`${target} уже есть. Переносим только в новую базу — удалите или укажите другое имя.`);
  process.exit(1);
}

const sql = readFileSync(dump, "utf8");
const db = new DatabaseSync(target);
db.exec("PRAGMA journal_mode = WAL;");
// Внешние ключи на время заливки выключены: таблицы идут в выгрузке в
// произвольном порядке.
db.exec("PRAGMA foreign_keys = OFF;");
db.exec("BEGIN");
try {
  db.exec(sql);
  db.exec("COMMIT");
} catch (error) {
  db.exec("ROLLBACK");
  console.error("Заливка не прошла, база не создана:", error.message);
  process.exit(1);
}

// Сколько строк на каждую таблицу было в выгрузке.
const expected = new Map();
for (const match of sql.matchAll(/^INSERT INTO "?([A-Za-z_0-9]+)"?/gm)) {
  expected.set(match[1], (expected.get(match[1]) || 0) + 1);
}
const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name != 'd1_migrations' ORDER BY name")
  .all()
  .map((row) => row.name);

let bad = 0;
let total = 0;
for (const name of tables) {
  const got = db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get().n;
  const want = expected.get(name) || 0;
  total += got;
  if (got !== want) {
    bad += 1;
    console.log(`✗ ${name}: в выгрузке ${want}, в базе ${got}`);
  }
}
// Ключ строки «кто заходил» — хэш id с серверным секретом. Секрет на новом
// сервере свой, поэтому пересчитываем ключи: иначе при первом же заходе
// каждый человек записался бы второй раз.
if (process.env.STATS_SALT) {
  const rows = db.prepare("SELECT uid, tg_id FROM people WHERE tg_id IS NOT NULL").all();
  const update = db.prepare("UPDATE people SET uid = ? WHERE uid = ?");
  db.exec("BEGIN");
  for (const row of rows) {
    const uid = createHmac("sha256", process.env.STATS_SALT).update(String(row.tg_id)).digest("hex").slice(0, 32);
    if (uid !== row.uid) update.run(uid, row.uid);
  }
  db.exec("COMMIT");
  console.log(`Ключи заходов пересчитаны: ${rows.length}`);
}
const check = db.prepare("PRAGMA integrity_check").get();
db.close();
console.log(`Таблиц: ${tables.length}, строк: ${total}, проверка целостности: ${Object.values(check)[0]}`);
if (bad) {
  console.error(`Расхождения в ${bad} таблицах — переключаться нельзя.`);
  process.exit(1);
}
console.log("Число строк во всех таблицах совпало с выгрузкой.");
