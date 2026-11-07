// Проверка Подслушки на настоящем сервере с пустой базой и заглушкой Telegram.
// Запуск: node server/forum.test.mjs
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const TOKEN = "123456:TESTTOKEN";
const OWNER = 1;
const dir = mkdtempSync(join(tmpdir(), "karma-"));
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
const PORT = 19150 + Math.floor(Math.random() * 100);
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
const api = async (action, body, id = 100, first = "Иван", uname) => {
  const r = await fetch(`http://127.0.0.1:${PORT}/forum/${action}`, { method: "POST", body: JSON.stringify({ initData: initData(id, first, uname), ...body }) });
  return { status: r.status, ...(await r.json()) };
};
const tg = async (text, from = OWNER) => {
  const r = await fetch(`http://127.0.0.1:${PORT}/`, { method: "POST", headers: { "x-telegram-bot-api-secret-token": "w", "content-type": "application/json" }, body: JSON.stringify({ update_id: Math.floor(Math.random() * 1e9), message: { message_id: 1, from: { id: from, first_name: "O" }, chat: { id: from, type: "private" }, text } }) });
  return r.status;
};
const lastSent = (n = 1) => sent.slice(-n);
const settle = () => new Promise((r) => setTimeout(r, 200));
let fail = 0;
const ok = (cond, name, extra = "") => { console.log((cond ? "✓ " : "✗ ") + name + (cond ? "" : "  " + extra)); if (!cond) fail++; };
await tg("/forum all"); await settle();
// Человек с ником пишет боту — так сервер узнаёт его @ник.
const tgFrom = async (text, from, username) => {
  await fetch(`http://127.0.0.1:${PORT}/`, { method: "POST", headers: { "x-telegram-bot-api-secret-token": "w", "content-type": "application/json" }, body: JSON.stringify({ update_id: Math.floor(Math.random() * 1e9), message: { message_id: 1, from: { id: from, first_name: "Б", username }, chat: { id: from, type: "private" }, text } }) });
  await settle();
};
await tgFrom("/start", 777, "bblame");
// И открывает приложение — заход пишет его в people с ником.
await fetch(`http://127.0.0.1:${PORT}/hit`, { method: "POST", body: JSON.stringify({ initData: initData(777, "Б", "bblame"), group: "101" }) });
await settle();
let before = await api("list", {}, 777, "Б", "bblame");
const k0 = before.me?.karma ?? 0;
await tg("/karma @bblame 25"); await settle();
const reply = lastSent()[0]?.text || "";
ok(/Выдал 25 кармы: @bblame/.test(reply), "владелец выдаёт карму по нику", reply);
let after = await api("list", {}, 777, "Б", "bblame");
ok((after.me?.karma ?? 0) === k0 + 25, "карма выросла на 25", JSON.stringify(after.me));
await tg("/karma @bblame -5"); await settle();
after = await api("list", {}, 777, "Б", "bblame");
ok((after.me?.karma ?? 0) === k0 + 20, "можно и снять", JSON.stringify(after.me));
await tg("/karma @bblame 25", 555); await settle();
ok(/недоступна/.test(lastSent()[0]?.text || ""), "не владельцу — недоступно", lastSent()[0]?.text);
after = await api("list", {}, 777, "Б", "bblame");
ok((after.me?.karma ?? 0) === k0 + 20, "чужая команда ничего не изменила", JSON.stringify(after.me));
await tg("/karma @nobody_here 25"); await settle();
ok(/Не нашёл/.test(lastSent()[0]?.text || ""), "незнакомый ник — понятный ответ", lastSent()[0]?.text);
srv.kill(); stub.close(); rmSync(dir, { recursive: true, force: true });
if (fail) process.exit(1);
console.log("\nВСЕ ПРОВЕРКИ ПРОШЛИ");
