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
const dir = mkdtempSync(join(tmpdir(), "game-"));
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
import { newGame, move, spawn as addTile, canMove, replay } from "../docs/game-core.mjs";

const api = async (action, body, id = 100, first = "Иван") => {
  const r = await fetch(`http://127.0.0.1:${PORT}/game/${action}`, { method: "POST", body: JSON.stringify({ initData: initData(id, first), ...body }) });
  return { status: r.status, ...(await r.json()) };
};
let fail = 0;
const ok = (cond, name, extra = "") => { console.log((cond ? "✓ " : "✗ ") + name + (cond ? "" : "  " + extra)); if (!cond) fail++; };

/** Играет «жадно»: перебирает направления, пока поле не кончится. */
function play(seed, limit = 100000) {
  const g = newGame(seed);
  while (g.moves.length < limit && canMove(g.board)) {
    let moved = false;
    for (const d of "DLRU") {
      if (move(g, d).moved) { addTile(g); moved = true; break; }
    }
    if (!moved) break;
  }
  return g;
}

// ядро: одна и та же запись ходов — один и тот же результат
const g1 = play(12345);
const again = replay(12345, g1.moves);
ok(again.ok && again.score === g1.score && again.over, "запись ходов воспроизводится один в один", JSON.stringify({ a: again.score, b: g1.score }));
ok(!replay(12345, g1.moves + "L").ok, "лишний ход после конца отклоняется");
ok(!replay(12345, "LX").ok, "мусор в ходах отклоняется");

// до запуска играет только владелец
const tg = (text, from = OWNER) => fetch(`http://127.0.0.1:${PORT}/`, { method: "POST", headers: { "x-telegram-bot-api-secret-token": "w", "content-type": "application/json" }, body: JSON.stringify({ update_id: Math.floor(Math.random() * 1e9), message: { message_id: 1, from: { id: from, first_name: "O" }, chat: { id: from, type: "private" }, text } }) });
let r0 = await api("start", { tenant: "msu-fgp", fac: "МГУ · ФГП" }, 100, "Аня");
ok(r0.status === 403 && r0.error === "soon", "до /g2048 start играть нельзя", JSON.stringify(r0));
r0 = await api("start", { tenant: "msu-fgp", fac: "МГУ · ФГП" }, OWNER, "Владелец");
ok(r0.ok, "владелец может проверить до запуска");
sent.length = 0; await tg("/g2048 start"); await new Promise((r) => setTimeout(r, 300));
ok(sent.some((m) => /запущена/.test(m.text || "")), "/g2048 start запускает турнир");

// партия: старт, чекпоинт, конец
let r = await api("start", { tenant: "msu-fgp", fac: "МГУ · ФГП" }, 100, "Аня");
ok(r.ok && r.id && Number.isInteger(r.seed), "партия начинается, сервер выдаёт зерно", JSON.stringify(r));
const run = r;
const game = play(run.seed);
const half = game.moves.slice(0, Math.floor(game.moves.length / 2));
r = await api("save", { id: run.id, moves: half }, 100, "Аня");
ok(r.ok && !r.over && r.score === replay(run.seed, half).score, "чекпоинт: сервер сам считает счёт", JSON.stringify(r));
r = await api("save", { id: run.id, moves: half.slice(0, -3) }, 100, "Аня");
ok(r.status === 422, "запись ходов не может стать короче");
r = await api("save", { id: run.id, moves: game.moves, score: 99999999 }, 100, "Аня");
ok(r.ok && r.over && r.score === game.score && r.score !== 99999999, "конец партии: присланный «счёт» игнорируется", JSON.stringify(r));
r = await api("save", { id: run.id, moves: game.moves + "L" }, 100, "Аня");
ok(r.ok && r.already, "законченную партию не дописать");
r = await api("save", { id: run.id, moves: game.moves }, 200, "Чужой");
ok(r.status === 404, "чужую партию не сохранить");

// второй игрок того же факультета и игрок другого
r = await api("start", { tenant: "msu-fgp", fac: "МГУ · ФГП" }, 101, "Петя");
const g2 = play(r.seed, 60); await api("save", { id: r.id, moves: g2.moves, final: true }, 101, "Петя");
r = await api("start", { tenant: "mgimo-mo", fac: "МГИМО · МО" }, 102, "Оля");
const g3 = play(r.seed); await api("save", { id: r.id, moves: g3.moves }, 102, "Оля");
r = await api("board", {}, 100, "Аня");
const fgp = r.facs.find((f) => f.tenant === "msu-fgp");
ok(fgp && fgp.players === 2 && fgp.total === game.score + g2.score, "счёт факультета — сумма рекордов его игроков", JSON.stringify(r.facs));
ok(r.players.length === 3 && r.players[0].best >= r.players[1].best, "таблица игроков по убыванию", JSON.stringify(r.players));
ok(r.me && r.me.best === game.score && r.me.place >= 1, "своё место и рекорд видны", JSON.stringify(r.me));
ok(!JSON.stringify(r).includes('"tg_id"'), "id игроков наружу не отдаются");
// рекорд не падает от худшей партии
r = await api("start", { tenant: "msu-fgp", fac: "МГУ · ФГП" }, 100, "Аня");
await api("save", { id: r.id, moves: play(r.seed, 5).moves, final: true }, 100, "Аня");
r = await api("board", {}, 100, "Аня");
ok(r.me.best === game.score && r.me.games === 2, "худшая партия рекорд не портит", JSON.stringify(r.me));

// без подписи Telegram — нельзя
const bad = await fetch(`http://127.0.0.1:${PORT}/game/start`, { method: "POST", body: "{}" });
ok(bad.status === 401, "без подписи Telegram — 401");

srv.kill();
stub.close();
rmSync(dir, { recursive: true, force: true });
if (fail) {
  console.log(`\nНЕ ПРОШЛО: ${fail}\n` + log.slice(-2000));
  process.exit(1);
}
console.log("\nВСЕ ПРОВЕРКИ ПРОШЛИ");
