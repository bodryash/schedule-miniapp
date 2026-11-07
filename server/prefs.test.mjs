// Синхронизация настроек на настоящем сервере с пустой базой и заглушкой Telegram.
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
const dir = mkdtempSync(join(tmpdir(), "prefs-"));
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
const PORT = 18850 + Math.floor(Math.random() * 100);
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
const sync = async (body) => { const r = await fetch(`http://127.0.0.1:${PORT}/prefs`, { method: "POST", body: JSON.stringify(body) }); return { status: r.status, ...(await r.json()) }; };
let fail = 0;
const ok = (c, n, e = "") => { console.log((c ? "✓ " : "✗ ") + n + (c ? "" : "  " + e)); if (!c) fail++; };
const now = Math.floor(Date.now() / 1000);
const me = web({ id: 777, first_name: "Аня", auth_date: now });
let r = await sync({ initData: me });
ok(r.ok && r.updated === 0 && r.data === null, "пусто у нового человека", JSON.stringify(r));
r = await sync({ initData: me, set: { updated: 1000, data: { "schedule.scheme": "dark" } } });
ok(r.ok && r.updated === 1000, "сохранил с компьютера", JSON.stringify(r));
r = await sync({ initData: me, set: { updated: 500, data: { "schedule.scheme": "light" } } });
ok(r.ok && r.updated === 1000 && r.data["schedule.scheme"] === "dark", "старая версия не затирает свежую", JSON.stringify(r));
r = await sync({ initData: web({ id: 777, first_name: "Аня", auth_date: now }) });
ok(r.data?.["schedule.scheme"] === "dark", "телефон получает тему с компьютера", JSON.stringify(r));
r = await sync({ initData: web({ id: 888, first_name: "Боб", auth_date: now }) });
ok(r.data === null, "чужие настройки не видны", JSON.stringify(r));
r = await sync({ initData: web({ id: 777, first_name: "Аня", auth_date: now }, "999:WRONG") });
ok(r.status === 400 && !r.data, "без подписи — ничего", JSON.stringify(r));
r = await sync({ initData: me, set: { updated: 2000, data: { big: "x".repeat(20000) } } });
ok(!r.ok, "слишком большие настройки не принимаются", JSON.stringify(r));
srv.kill(); stub.close(); rmSync(dir, { recursive: true, force: true });
if (fail) { console.log(log.slice(-1500)); process.exit(1); }
console.log("\nВСЕ ПРОВЕРКИ ПРОШЛИ");
