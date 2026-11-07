// Утренние сводки не дублируются, даже если две минутные задачи шлют параллельно.
// Запуск: node server/remind.test.mjs
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "./d1.mjs";

const got = [];
const stub = createServer((req, res) => {
  let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
    got.push(JSON.parse(b || "{}").chat_id);
    // Telegram «думает» — чтобы вторая рассылка успела стартовать, пока идёт первая.
    setTimeout(() => { res.setHeader("content-type", "application/json"); res.end('{"ok":true,"result":{}}'); }, 30);
  });
});
await new Promise((r) => stub.listen(0, "127.0.0.1", r));
const realFetch = globalThis.fetch;
globalThis.fetch = (url, opts) => realFetch(String(url).replace("https://api.telegram.org", `http://127.0.0.1:${stub.address().port}`), opts);

const dir = mkdtempSync(join(tmpdir(), "rem-"));
const db = openDatabase(join(dir, "t.sqlite"));
db.raw.exec(readFileSync(new URL("../worker/schema.sql", import.meta.url), "utf8"));
const { deliverReminders } = await import("../worker/src/index.js");
const env = { STATS: db, BOT_TOKEN: "x" };
const outgoing = Array.from({ length: 20 }, (_, i) => ({ tg_id: 1000 + i, key: "2026-11-07|morning", text: "☀️ Сегодня одна пара" }));
const now = { minutes: 9999 };
await Promise.all([deliverReminders(env, outgoing, now), deliverReminders(env, outgoing, now), deliverReminders(env, outgoing, now)]);
await deliverReminders(env, outgoing, now);
let fail = 0;
const ok = (c, n, e = "") => { console.log((c ? "✓ " : "✗ ") + n + (c ? "" : "  " + e)); if (!c) fail++; };
ok(got.length === 20 && new Set(got).size === 20, "каждому ровно одна сводка при трёх параллельных рассылках и повторе", `ушло ${got.length}`);
stub.close(); rmSync(dir, { recursive: true, force: true });
if (fail) process.exit(1);
console.log("\nВСЕ ПРОВЕРКИ ПРОШЛИ");
