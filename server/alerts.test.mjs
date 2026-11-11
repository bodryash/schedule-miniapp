// Тексты рассылок: обед не называется окном, отменённая пара не стоит в
// утреннем списке и о ней не напоминают, уведомление об отмене не уходит
// дважды при параллельных минутных задачах.
// Запуск: node server/alerts.test.mjs
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "./d1.mjs";

const sent = [];
const stub = createServer((req, res) => {
  let b = "";
  req.on("data", (c) => (b += c));
  req.on("end", () => {
    if (req.url.endsWith("/sendMessage")) sent.push(JSON.parse(b || "{}"));
    setTimeout(() => {
      res.setHeader("content-type", "application/json");
      res.end('{"ok":true,"result":{"message_id":1}}');
    }, 20);
  });
});
await new Promise((r) => stub.listen(0, "127.0.0.1", r));
const realFetch = globalThis.fetch;
globalThis.fetch = (url, opts) => realFetch(String(url).replace("https://api.telegram.org", `http://127.0.0.1:${stub.address().port}`), opts);

const dir = mkdtempSync(join(tmpdir(), "alr-"));
const db = openDatabase(join(dir, "t.sqlite"));
db.raw.exec(readFileSync(new URL("../worker/schema.sql", import.meta.url), "utf8"));
// Расписание и звонки — из файлов репозитория, как на своём сервере.
globalThis.SCHEDULE_READ_DATA = (path) => {
  try { return JSON.parse(readFileSync(new URL(`../docs/${path}`, import.meta.url), "utf8")); } catch { return null; }
};
// Колонки, которые на живой базе добавлены миграциями.
for (const sql of ["ALTER TABLE reminders ADD COLUMN changes INTEGER NOT NULL DEFAULT 1", "ALTER TABLE cancels ADD COLUMN subject TEXT NOT NULL DEFAULT ''", "ALTER TABLE cancels ADD COLUMN subgroup INTEGER NOT NULL DEFAULT 0", "ALTER TABLE cancels ADD COLUMN teacher TEXT NOT NULL DEFAULT ''"]) {
  try { db.raw.exec(sql); } catch {}
}
const { dueReminders, runAlerts } = await import("../worker/src/index.js");
const env = { STATS: db, BOT_TOKEN: "x", OWNER_ID: "1" };

let fail = 0;
const ok = (c, n, e = "") => {
  console.log((c ? "✓ " : "✗ ") + n + (c ? "" : "  " + e));
  if (!c) fail++;
};

// ФГП, группа 101: пары 09:00, 10:45, после обеда 13:00 (перерыв 45 мин), 16:30 (окно).
const day = "2026-11-16";
const run = (sql, ...args) => db.raw.prepare(sql).run(...args);
run("INSERT INTO reminders (tg_id, grp, morning, before, updated, shift, wake, changes) VALUES (10, '101', 1, 15, 'x', 0, 0, 1)");
for (const [start, end, subject] of [
  ["09:00", "10:30", "Экономика"],
  ["10:45", "12:15", "История"],
  ["13:00", "14:30", "Право"],
  ["16:30", "18:00", "География"],
]) {
  run("INSERT INTO reminder_plan (tg_id, day, start, end, subject, room) VALUES (10, ?, ?, ?, ?, '509')", day, start, end, subject);
}
// Вторая пара (10:45) отменена.
run("INSERT INTO cancels (grp, day, slots, reason, created, subject, subgroup, teacher) VALUES ('101', ?, '2', 'болезнь', 'x', '', 0, '')", day);

const morning = (await dueReminders(env, { day, minutes: 7 * 60 + 30 }, 0, 50)).find((m) => m.key.endsWith("|morning"));
ok(Boolean(morning), "утренняя сводка собрана");
const text = morning?.text || "";
ok(!/окно 12:15/.test(text) && !/обед 12:15/.test(text), "отменённой пары нет — и перерыва вокруг неё тоже", text);
ok(!/10:45–12:15 · История/.test(text), "отменённая пара не стоит в списке", text);
ok(/отменено/.test(text), "строка «отменено» есть", text);
ok(/☕ окно 14:30–16:30/.test(text), "перерыв в 2 часа — окно", text);

// Обед: без отмены перерыв 45 минут — «обед», а не «окно».
run("UPDATE cancels SET removed = 1");
run("DELETE FROM reminder_sent");
const morning2 = (await dueReminders(env, { day, minutes: 7 * 60 + 30 }, 0, 50)).find((m) => m.key.endsWith("|morning"));
ok(/🍽 обед 12:15–13:00/.test(morning2?.text || "") && !/окно 12:15/.test(morning2?.text || ""), "перерыв 45 минут — обед", morning2?.text);

// «Скоро пара» не зовёт на отменённую.
run("UPDATE cancels SET removed = 0");
const soon = await dueReminders(env, { day, minutes: 10 * 60 + 35 }, 0, 50);
ok(!soon.some((m) => /История/.test(m.text)), "нет «через 10 минут» про отменённую пару", JSON.stringify(soon.map((m) => m.text)));

// Уведомление об отмене: две минутные задачи параллельно — одно сообщение.
run("INSERT INTO alert_marks (kind, last) VALUES ('cancels', 0), ('changes', 0), ('notices', 0)");
const soonDay = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
run("INSERT INTO cancels (grp, day, slots, reason, created, subject, subgroup, teacher) VALUES ('101', ?, '1', '', 'x', '', 0, '')", soonDay);
sent.length = 0;
await Promise.all([runAlerts(env), runAlerts(env), runAlerts(env)]);
const toTen = sent.filter((m) => String(m.chat_id) === "10").map((m) => m.text);
ok(toTen.length === new Set(toTen).size && toTen.length >= 1, "каждое уведомление об отмене — один раз при трёх параллельных задачах", JSON.stringify(toTen));

stub.close();
rmSync(dir, { recursive: true, force: true });
if (fail) process.exit(1);
console.log("\nВСЕ ПРОВЕРКИ ПРОШЛИ");
