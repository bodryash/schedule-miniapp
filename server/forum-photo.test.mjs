// Проверка фото в Подслушке на настоящем сервере с пустой базой и заглушкой Telegram.
// Запуск: node server/forum-photo.test.mjs
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const TOKEN = "123456:TESTTOKEN";
const OWNER = 1;
const dir = mkdtempSync(join(tmpdir(), "forum-photo-"));
const sent = [];
const stub = createServer((req, res) => {
  let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
    const method = req.url.split("/").pop();
    try { sent.push({ method, ...JSON.parse(b || "{}") }); } catch { sent.push({ method, raw: b.length }); }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, result: { message_id: 1 } }));
  });
});
await new Promise((r) => stub.listen(0, "127.0.0.1", r));
const stubPort = stub.address().port;
const PORT = 18800 + Math.floor(Math.random() * 100);
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

let r;
console.error = () => {};
// Открываем форум всем и сразу доверяем автору текста (фото это не касается).
await new Promise((res) => setTimeout(res, 300));
await tg("/forum all").catch((e) => { console.log(log); throw e; });
await tg("/forum newbie off");
await settle();

// Настоящий маленький JPEG (белый квадрат 64×64) из байтов, + добивка до 2 КБ.
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2048, 7), Buffer.from([0xff, 0xd9])]);
const photo = `data:image/jpeg;base64,${jpeg.toString("base64")}`;

// 1. Фото без текста — принимается и уходит на проверку (режим all).
r = await api("post", { text: "", photo }, 200, "Аня");
ok(r.ok && r.pending && r.post.photo?.startsWith("/forum/img/"), "фото без текста принято и ждёт проверки", JSON.stringify(r));
const path = r.post.photo;
const id1 = r.post.id;
await settle();
ok(sent.some((m) => m.method === "sendPhoto"), "владельцу пришло само фото на проверку");

// 2. Чужой не видит фото на проверке, автор видит, файл по адресу отдаётся.
let l = await api("list", { sort: "new" }, 300, "Боря");
ok(!(l.posts || []).some((p) => p.id === id1), "посторонним пост с фото на проверке не виден");
let img = await fetch(`http://127.0.0.1:${PORT}${path}`);
ok(img.status === 200 && img.headers.get("content-type") === "image/jpeg", "файл отдаётся как JPEG");
ok((await fetch(`http://127.0.0.1:${PORT}/forum/img/${"0".repeat(32)}.jpg`)).status === 404, "несуществующее фото — 404");

// 3. Не картинка — отказ.
r = await api("post", { text: "смотрите", photo: `data:image/jpeg;base64,${Buffer.alloc(3000, 65).toString("base64")}` }, 201, "Вика");
ok(!r.ok && r.error === "photo", "не-JPEG отклонён", JSON.stringify(r));

// 4. Пауза между фото — 10 минут.
r = await api("post", { text: "ещё одно фото", photo }, 200, "Аня");
ok(!r.ok && r.error === "slow", "второе фото подряд — подождать", JSON.stringify(r));

// 5. Владелец одобряет — пост виден всем вместе с фото.
const fok = await fetch(`http://127.0.0.1:${PORT}/`, { method: "POST", headers: { "x-telegram-bot-api-secret-token": "w", "content-type": "application/json" }, body: JSON.stringify({ update_id: 77, callback_query: { id: "q", from: { id: OWNER }, data: `fok:p:${id1}`, message: { message_id: 5, chat: { id: OWNER } } } }) });
await settle();
l = await api("list", { sort: "new" }, 300, "Боря");
const seen = (l.posts || []).find((p) => p.id === id1);
ok(fok.status === 200 && seen?.photo === path, "после одобрения фото видно всем", JSON.stringify(l).slice(0, 300));

// 6. Две жалобы на пост с фото — скрыт (у текста нужно три).
await api("report", { kind: "p", id: id1, reason: "photo" }, 301, "Гоша");
await api("report", { kind: "p", id: id1, reason: "photo" }, 302, "Дима");
l = await api("list", { sort: "new" }, 300, "Боря");
ok(!(l.posts || []).some((p) => p.id === id1), "после двух жалоб пост с фото скрыт");

// 7. Удаление — файл стирается с сервера.
await fetch(`http://127.0.0.1:${PORT}/`, { method: "POST", headers: { "x-telegram-bot-api-secret-token": "w", "content-type": "application/json" }, body: JSON.stringify({ update_id: 78, callback_query: { id: "q2", from: { id: OWNER }, data: `fdl:p:${id1}`, message: { message_id: 6, chat: { id: OWNER } } } }) });
await settle();
ok((await fetch(`http://127.0.0.1:${PORT}${path}`)).status === 404, "после удаления файла нет");

// 8. /forum photo off — фото не принимаются.
await tg("/forum photo off");
await settle();
r = await api("post", { text: "фото выключены?", photo }, 203, "Женя");
ok(!r.ok && r.error === "photo", "при /forum photo off фото не принимаются", JSON.stringify(r));

srv.kill();
stub.close();
rmSync(dir, { recursive: true, force: true });
if (fail) {
  console.log(log.slice(-2000));
  console.log(`ПРОВАЛЕНО: ${fail}`);
  process.exit(1);
}
console.log("ВСЕ ПРОВЕРКИ ПРОШЛИ");
