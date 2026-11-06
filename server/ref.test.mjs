// Проверка «Сессии 2048» на настоящем сервере с пустой базой и заглушкой Telegram.
// Запуск: node server/game.test.mjs
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const TOKEN = "123456:TESTTOKEN";
const OWNER = 1;
const dir = mkdtempSync(join(tmpdir(), "ref-"));
const sent = [];
const stub = createServer((req, res) => {
  let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
    const method = req.url.split("/").pop();
    try { sent.push({ method, ...JSON.parse(b || "{}") }); } catch {}
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, result: { message_id: 1 } }));
  });
});
await new Promise((r) => stub.listen(0, "127.0.0.1", r));
const stubPort = stub.address().port;
const PORT = 18900 + Math.floor(Math.random() * 100);
const srv = spawn("node", [fileURLToPath(new URL("./index.mjs", import.meta.url))], {
  env: { ...process.env, BOT_TOKEN: TOKEN, OWNER_ID: String(OWNER), STATS_SALT: "s", WEBHOOK_SECRET: "w", DB_PATH: join(dir, "t.sqlite"), PORT: String(PORT), NO_CRON: "1", TELEGRAM_API_BASE: `http://127.0.0.1:${stubPort}` },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = ""; srv.stdout.on("data", (d) => (log += d)); srv.stderr.on("data", (d) => (log += d));
for (let i = 0; i < 60; i++) { try { await fetch(`http://127.0.0.1:${PORT}/healthz`); break; } catch { await new Promise((r) => setTimeout(r, 250)); } }

const initData = (id, first = "Иван", username = null) => {
  const user = JSON.stringify({ id, first_name: first, username: username || undefined });
  const p = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), user });
  const check = [...p.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(TOKEN).digest();
  p.set("hash", createHmac("sha256", secret).update(check).digest("hex"));
  return p.toString();
};
import { newGame, move, spawn as addTile, canMove, replay } from "../docs/game-core.mjs";
let fail = 0;
const ok = (cond, name, extra = "") => { console.log((cond ? "✓ " : "✗ ") + name + (cond ? "" : "  " + extra)); if (!cond) fail++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tg = (text, from = OWNER, first = "O") => fetch(`http://127.0.0.1:${PORT}/`, { method: "POST", headers: { "x-telegram-bot-api-secret-token": "w", "content-type": "application/json" }, body: JSON.stringify({ update_id: Math.floor(Math.random() * 1e9), message: { message_id: 1, from: { id: from, first_name: first }, chat: { id: from, type: "private" }, text } }) });
const ref = async (id, first = "Иван") => { const r = await fetch(`http://127.0.0.1:${PORT}/ref`, { method: "POST", body: JSON.stringify({ initData: initData(id, first) }) }); return { status: r.status, ...(await r.json()) }; };
const hit = (id, first, group = { id: "301" }) => fetch(`http://127.0.0.1:${PORT}/hit`, { method: "POST", body: JSON.stringify({ initData: initData(id, first), group }) });

let r = await ref(200, "Аня Петрова");
ok(r.ok && /start=r_[a-z0-9]{6}$/.test(r.link) && r.live === false, "до запуска ссылка уже есть, конкурс не идёт", JSON.stringify(r));
const code = r.link.split("r_")[1];
r = await ref(200, "Аня Петрова"); ok(r.link.endsWith(code), "ссылка у человека постоянная");
sent.length = 0; await tg("/ref start"); await sleep(300);
ok(sent.some((m) => /запущена/.test(m.text || "")), "/ref start запускает неделю");
await tg("/ref start", 999); await sleep(200);

// новый друг: пришёл по ссылке и открыл приложение с группой
sent.length = 0; await tg(`/start r_${code}`, 300, "Боря"); await sleep(300);
ok(sent.some((m) => m.chat_id === 300 && /позвал Аня/.test(m.text || "")), "другу бот говорит, кто его позвал", JSON.stringify(sent.map((m) => m.text)));
await hit(300, "Боря Сидоров"); await sleep(300);
ok(sent.some((m) => m.chat_id === 200 && /пришёл Боря С\./.test(m.text || "")), "пригласившему приходит радость", JSON.stringify(sent.map((m) => [m.chat_id, m.text])));
r = await ref(200, "Аня Петрова");
ok(r.live && r.count === 1 && r.place === 1 && r.top[0].name === "Аня П." && r.top[0].me, "друг засчитан, в таблице имя без фамилии", JSON.stringify(r));

// накрутки
await hit(400, "Вика"); await tg(`/start r_${code}`, 400, "Вика"); await hit(400, "Вика"); await sleep(200);
await tg(`/start r_${code}`, 200, "Аня"); await hit(200, "Аня Петрова");
await tg(`/start r_${code}`, 500, "Гоша"); await sleep(200);
r = await ref(200, "Аня Петрова");
ok(r.count === 1, "старый пользователь, сам себя и не открывший приложение — не считаются", JSON.stringify(r));
const other = (await ref(600, "Дима")).link.split("r_")[1];
await tg(`/start r_${other}`, 300, "Боря"); await hit(300, "Боря Сидоров"); await sleep(200);
r = await ref(600, "Дима"); ok(r.count === 0, "одного друга нельзя засчитать второй раз", JSON.stringify(r));
await tg(`/start r_zzzzzz`, 700, "Ева"); await hit(700, "Ева"); await sleep(200);
ok(true, "несуществующий код не роняет бота");

sent.length = 0; await tg("/ref"); await sleep(300);
ok(sent.some((m) => /Аня Петрова — 1/.test(m.text || "") && /Всего приведено: 1/.test(m.text || "")), "/ref показывает таблицу владельцу", JSON.stringify(sent.map((m) => m.text)));
sent.length = 0; await tg("/ref", 300); await sleep(200);
ok(sent.some((m) => /недоступна/.test(m.text || "")), "/ref чужим недоступна");

srv.kill(); stub.close(); rmSync(dir, { recursive: true, force: true });
if (fail) { console.log(log.slice(-3000)); console.log(`\nПРОВАЛЕНО: ${fail}`); process.exit(1); }
console.log("\nВСЕ ПРОВЕРКИ ПРОШЛИ");
