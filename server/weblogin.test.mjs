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
const dir = mkdtempSync(join(tmpdir(), "web-"));
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
const PORT = 18650 + Math.floor(Math.random() * 100);
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
let fail = 0;
const ok = (c, n, e = "") => { console.log((c ? "✓ " : "✗ ") + n + (c ? "" : "  " + e)); if (!c) fail++; };
const now = Math.floor(Date.now() / 1000);
let r = await ref(web({ id: 777, first_name: "Аня", username: "anya", auth_date: now }));
ok(r.ok && /r_/.test(r.link), "вход с сайта принимается", JSON.stringify(r));
r = await ref(web({ id: 777, first_name: "Аня", auth_date: now }, "999:WRONG"));
ok(r.status === 401, "чужая подпись не принимается", JSON.stringify(r));
r = await ref(web({ id: 777, first_name: "Аня", auth_date: now - 40 * 86400 }));
ok(r.status === 401, "старый вход (40 дней) не принимается", JSON.stringify(r));
srv.kill(); stub.close(); rmSync(dir, { recursive: true, force: true });
if (fail) { console.log(log.slice(-1500)); process.exit(1); }
console.log("\nВСЕ ПРОВЕРКИ ПРОШЛИ");
