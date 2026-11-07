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
const dir = mkdtempSync(join(tmpdir(), "abs-"));
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
const PORT = 18700 + Math.floor(Math.random() * 100);
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
const ok = (c, n, e = "") => { console.log((c ? "✓ " : "✗ ") + n + (c ? "" : "  " + e)); if (!c) fail++; };
const save = async (id, body) => { const r = await fetch(`http://127.0.0.1:${PORT}/absrules`, { method: "POST", body: JSON.stringify({ initData: initData(id, "Тест"), group: "301", ...body }) }); return { status: r.status, ...(await r.json()) }; };
const notices = async (id) => (await fetch(`http://127.0.0.1:${PORT}/notices?group=301&initData=${encodeURIComponent(initData(id, "Тест"))}`)).json();
let r = await save(500, { subject: "Экономика", limit: 3, rules: [{ n: 2, label: "оценка 4" }] });
ok(r.status === 403, "не староста задать условия группе не может", JSON.stringify(r));
r = await save(OWNER, { subject: "Экономика", limit: 3, rules: [{ n: 2, label: "оценка 4" }, { n: 4, label: "оценка 3" }] });
ok(r.ok, "владелец (как староста) задаёт условия", JSON.stringify(r));
let n = await notices(500);
ok(n.absRules?.["Экономика"]?.rules?.length === 2 && n.absRules["Экономика"].limit === 3, "условия приходят всем в группе", JSON.stringify(n.absRules));
r = await save(OWNER, { subject: "Экономика", clear: true }); n = await notices(500);
ok(r.ok && !n.absRules?.["Экономика"], "условия можно убрать");
srv.kill(); stub.close(); rmSync(dir, { recursive: true, force: true });
if (fail) { console.log(log.slice(-2000)); process.exit(1); }
console.log("\nВСЕ ПРОВЕРКИ ПРОШЛИ");
