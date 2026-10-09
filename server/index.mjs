// Бот расписания на своём сервере. Тот же код, что в Cloudflare
// (worker/src/index.js), только вокруг него — обычный HTTP-сервер, файл
// SQLite и таймер раз в минуту вместо облачного расписания.
//
// Запуск: node --env-file=/etc/schedule/env server/index.mjs
import { createServer } from "node:http";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statfsSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase } from "./d1.mjs";

const here = dirname(fileURLToPath(import.meta.url));

// Адрес приложения бот читает при загрузке, поэтому сначала задаём его, а
// потом уже подключаем код бота.
globalThis.SCHEDULE_OWN_SERVER = true;
if (process.env.APP_URL) globalThis.SCHEDULE_APP_URL = process.env.APP_URL.replace(/\/?$/, "/");
const { default: worker } = await import("../worker/src/index.js");
const PORT = Number(process.env.PORT || 8787);
const DB_PATH = process.env.DB_PATH || join(here, "..", "data", "schedule.sqlite");
// Сколько тела запроса принимаем: самое большое — план напоминаний на две
// недели, это десятки килобайт. Больше — кто-то шлёт мусор.
const BODY_LIMIT = 512 * 1024;

for (const name of ["BOT_TOKEN", "OWNER_ID"]) {
  if (!process.env[name]) {
    console.error(`Не задано ${name} — см. deploy/env.example`);
    process.exit(1);
  }
}

mkdirSync(dirname(DB_PATH), { recursive: true });
const fresh = !existsSync(DB_PATH);
const STATS = openDatabase(DB_PATH);
// Пустая база — создаём таблицы. В готовой schema.sql ничего не трогает:
// там везде IF NOT EXISTS.
STATS.raw.exec(readFileSync(join(here, "..", "worker", "schema.sql"), "utf8"));
if (fresh) console.log(`Создана новая база: ${DB_PATH}`);

const env = {
  STATS,
  BOT_TOKEN: process.env.BOT_TOKEN,
  OWNER_ID: process.env.OWNER_ID,
  STATS_SALT: process.env.STATS_SALT,
  WEBHOOK_SECRET: process.env.WEBHOOK_SECRET,
  GITHUB_TOKEN: process.env.GITHUB_TOKEN,
};

// Расписания новых факультетов, которые студенты присылают боту, кладём в
// папку рядом с базой: файл и рядом — кто и когда прислал.
const INBOX = join(dirname(DB_PATH), "inbox");
globalThis.SCHEDULE_SAVE_FILE = async (document, from, caption) => {
  if (!document?.file_id || (document.file_size || 0) > 20 * 1024 * 1024) return;
  const info = await (await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/getFile?file_id=${encodeURIComponent(document.file_id)}`, { signal: AbortSignal.timeout(15000) })).json();
  if (!info.ok) return;
  const file = await fetch(`https://api.telegram.org/file/bot${env.BOT_TOKEN}/${info.result.file_path}`, { signal: AbortSignal.timeout(60000) });
  if (!file.ok) return;
  mkdirSync(INBOX, { recursive: true });
  // Имя файла — чужое: оставляем только безопасные знаки.
  const safe = String(document.file_name || "file").replace(/[^\p{L}\p{N}._ -]/gu, "_").slice(-80);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  writeFileSync(join(INBOX, `${stamp}_${safe}`), Buffer.from(await file.arrayBuffer()));
  writeFileSync(
    join(INBOX, `${stamp}_${safe}.json`),
    JSON.stringify({ at: new Date().toISOString(), from: { id: from?.id, name: [from?.first_name, from?.last_name].filter(Boolean).join(" "), username: from?.username || "" }, caption, name: document.file_name, size: document.file_size }, null, 2)
  );
};

// Слова, которые студенты пишут боту: одной строкой на сообщение.
globalThis.SCHEDULE_SAVE_NOTE = async (from, text, withFile) => {
  mkdirSync(INBOX, { recursive: true });
  appendFileSync(
    join(INBOX, "messages.jsonl"),
    JSON.stringify({ at: new Date().toISOString(), id: from?.id, name: [from?.first_name, from?.last_name].filter(Boolean).join(" "), username: from?.username || "", text: String(text || "").slice(0, 1000), file: withFile }) + "\n"
  );
};

// В Cloudflare фоновую работу доживает сама платформа. Здесь процесс живёт
// постоянно, так что достаточно не потерять ошибку.
const ctx = {
  waitUntil(promise) {
    Promise.resolve(promise).catch((error) => console.error("Фоновая задача упала:", error));
  },
  passThroughOnException() {},
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        reject(new Error("too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const stats = { started: Date.now(), requests: 0, errors: 0, slow: 0 };

// Что видит сторож снаружи: место на диске, возраст ночной копии, когда
// последний раз отработала минутная задача и доходит ли бот до Telegram.
const watch = { tick: 0, telegram: 0, telegramOk: null };

function vitals() {
  const out = { tickAge: watch.tick ? Math.round((Date.now() - watch.tick) / 1000) : null, telegramOk: watch.telegramOk };
  try {
    const disk = statfsSync(dirname(DB_PATH));
    out.diskFree = Math.round((Number(disk.bavail) / Number(disk.blocks)) * 100);
  } catch {
    out.diskFree = null;
  }
  try {
    const dir = join(dirname(DB_PATH), "backups");
    const newest = Math.max(0, ...readdirSync(dir).map((name) => statSync(join(dir, name)).mtimeMs));
    out.backupAge = newest ? Math.round((Date.now() - newest) / 3600000) : null;
  } catch {
    out.backupAge = null;
  }
  return out;
}

/** Раз в пять минут — достаёт ли бот до Telegram: без этого не уйдут напоминания. */
async function checkTelegram() {
  if (Date.now() - watch.telegram < 5 * 60000) return;
  watch.telegram = Date.now();
  try {
    const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/getMe`, { signal: AbortSignal.timeout(10000) });
    watch.telegramOk = res.ok;
  } catch {
    watch.telegramOk = false;
  }
}

const server = createServer(async (req, res) => {
  const startedAt = performance.now();
  stats.requests += 1;
  try {
    // Проверка «жив ли» — для автоматического перезапуска и мониторинга.
    if (req.url === "/healthz") {
      STATS.raw.prepare("SELECT 1").get();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, uptime: Math.round((Date.now() - stats.started) / 1000), ...stats, ...vitals() }));
      return;
    }

    const body = req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req);
    const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost";
    const request = new Request(`https://${host}${req.url}`, { method: req.method, headers: req.headers, body });
    const response = await worker.fetch(request, env, ctx);

    const headers = {};
    response.headers.forEach((value, key) => (headers[key] = value));
    res.writeHead(response.status, headers);
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    stats.errors += 1;
    console.error(`${req.method} ${req.url}:`, error);
    if (!res.headersSent) res.writeHead(error.message === "too large" ? 413 : 500, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "server error" }));
  } finally {
    if (performance.now() - startedAt > 1000) stats.slow += 1;
  }
});

// Раз в минуту, ровно в начале минуты: напоминания привязаны ко времени.
let ticking = false;
async function tick() {
  if (ticking) return; // прошлый запуск ещё идёт — не наслаиваем
  ticking = true;
  watch.tick = Date.now();
  checkTelegram();
  try {
    await new Promise((resolve) => {
      const pending = [];
      const cronCtx = { ...ctx, waitUntil: (promise) => pending.push(Promise.resolve(promise).catch((e) => console.error("Расписание упало:", e))) };
      Promise.resolve(worker.scheduled({ cron: "* * * * *", scheduledTime: Date.now() }, env, cronCtx))
        .catch((error) => console.error("Расписание упало:", error))
        .finally(() => Promise.all(pending).finally(resolve));
    });
  } finally {
    ticking = false;
  }
}

function scheduleTick() {
  setTimeout(() => {
    tick();
    scheduleTick();
  }, 60000 - (Date.now() % 60000) + 50);
}

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Бот слушает 127.0.0.1:${PORT}, база ${DB_PATH}`);
  if (process.env.NO_CRON !== "1") scheduleTick();
});

// Перезапуск службы: дообслужить начатое и аккуратно закрыть базу.
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    server.close(() => {
      STATS.raw.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
