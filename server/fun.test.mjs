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
const dir = mkdtempSync(join(tmpdir(), "forum-"));
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
const PORT = 18950 + Math.floor(Math.random() * 100);
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
const day = new Date(Date.now() + 3 * 3600000).toISOString().slice(0, 10);
let r = await api("list", {}, 300, "Аня");
ok(r.ok && r.challenge?.day === day && r.challenge.text.length > 10, "в ленте есть задание дня", JSON.stringify(r.challenge));
ok(r.me?.icon === "🌱" && r.me.karma === 0 && r.me.next?.need === 20, "новичок видит свой уровень и сколько до следующего", JSON.stringify(r.me));
// человек «доверенный», чтобы пост не ушёл на проверку
r = await api("post", { text: "Мой совет: ставить будильник на 7:30 и читать расписание с вечера", anon: false, challenge: day }, OWNER, "Владелец");
ok(r.ok && r.post.challenge === true, "ответ на задание помечен", JSON.stringify(r).slice(0, 200));
const pid = r.post.id;
r = await api("post", { text: "Обычный пост про столовую второго корпуса", anon: true }, OWNER, "Владелец");
for (const voter of [301, 302, 303, 304, 305]) await api("vote", { post: pid, v: 1 }, voter, "Голос");
await new Promise((res) => setTimeout(res, 61000));
r = await api("list", {}, OWNER, "Владелец");
const named = r.posts.find((p) => p.id === pid), anonP = r.posts.find((p) => p.id !== pid && !p.pinned);
ok(named?.level?.icon && anonP && anonP.level === undefined, "уровень у имени только у постов под именем", JSON.stringify({ n: named?.level, a: anonP?.level }));
ok(r.me.karma >= 2 * 2 + 5 * 3, "карма растёт за посты и плюсы", JSON.stringify(r.me));
r = await api("post", { text: "Ответ на чужой день задания не засчитывается", anon: true, challenge: "2000-01-01" }, OWNER, "Владелец");
ok(r.ok && !r.post.challenge, "задание за другой день не засчитывается");
srv.kill(); stub.close(); rmSync(dir, { recursive: true, force: true });
if (fail) { console.log(log.slice(-3000)); console.log(`\nПРОВАЛЕНО: ${fail}`); process.exit(1); }
console.log("\nВСЕ ПРОВЕРКИ ПРОШЛИ");
