// Еженедельные дедлайны на настоящем сервере с пустой базой и заглушкой Telegram.
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
const dir = mkdtempSync(join(tmpdir(), "dl-"));
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

import { createHash, createHmac as hm } from "node:crypto";
const web = (fields, token = TOKEN) => {
  const check = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join("\n");
  const hash = hm("sha256", createHash("sha256").update(token).digest()).update(check).digest("hex");
  return new URLSearchParams({ web: "1", ...fields, hash }).toString();
};
const ref = async (init) => { const r = await fetch(`http://127.0.0.1:${PORT}/ref`, { method: "POST", body: JSON.stringify({ initData: init }) }); return { status: r.status, ...(await r.json()) }; };
const call = async (body) => { const r = await fetch(`http://127.0.0.1:${PORT}/deadline`, { method: "POST", body: JSON.stringify(body) }); return { status: r.status, ...(await r.json()) }; };
let fail = 0;
const ok = (c, n, e = "") => { console.log((c ? "✓ " : "✗ ") + n + (c ? "" : "  " + e)); if (!c) fail++; };
const now = Math.floor(Date.now() / 1000);
const owner = web({ id: OWNER, first_name: "Владелец", auth_date: now });
const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
let r = await call({ initData: owner, group: "g1", title: "Лабораторная", due: day(-10), every: "week" });
ok(r.ok, "еженедельный дедлайн сохраняется", JSON.stringify(r));
r = await call({ initData: owner, group: "g1", title: "Разовый старый", due: day(-10) });
r = await call({ initData: owner, group: "g1", title: "Разовый новый", due: day(3) });
const titles = (r.deadlines || []).map((d) => d.title + ":" + (d.every || ""));
ok(titles.includes("Лабораторная:week"), "еженедельный не пропадает, даже если первый срок прошёл", titles.join());
ok(!titles.some((x) => x.startsWith("Разовый старый")), "разовый старый скрыт", titles.join());
ok(titles.includes("Разовый новый:"), "разовый новый на месте", titles.join());
const weekly = r.deadlines.find((d) => d.title === "Лабораторная");
r = await call({ initData: owner, group: "g1", id: weekly.id, title: "Лабораторная", due: day(-10), every: "" });
ok(!(r.deadlines || []).some((d) => d.title === "Лабораторная"), "повтор можно выключить", JSON.stringify(r.deadlines));

// Напоминание накануне: еженедельный срок «завтра» — по дню недели.
srv.kill();
await new Promise((res) => setTimeout(res, 300));
const { DatabaseSync } = await import("node:sqlite");
const db = new DatabaseSync(join(dir, "t.sqlite"));
db.prepare("INSERT INTO deadlines (grp, title, subject, due, author, created, every) VALUES ('g2', 'Еженедельный', '', ?, 0, '', 'week')").run(day(-6));
db.prepare("INSERT INTO deadlines (grp, title, subject, due, author, created, every) VALUES ('g2', 'Не в тот день', '', ?, 0, '', 'week')").run(day(-5));
const tomorrow = day(1);
const rows = db.prepare(`SELECT title FROM deadlines d WHERE d.grp = 'g2' AND (substr(d.due, 1, 10) = ?1
  OR (d.every = 'week' AND substr(d.due, 1, 10) < ?1 AND strftime('%w', substr(d.due, 1, 10)) = strftime('%w', ?1)))`).all(tomorrow).map((x) => x.title);
ok(rows.length === 1 && rows[0] === "Еженедельный", "бот напомнит накануне каждую неделю в тот же день", rows.join());
stub.close(); rmSync(dir, { recursive: true, force: true });
if (fail) { console.log(log.slice(-1500)); process.exit(1); }
console.log("\nВСЕ ПРОВЕРКИ ПРОШЛИ");
