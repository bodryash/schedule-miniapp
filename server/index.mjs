// Бот расписания на своём сервере. Тот же код, что в Cloudflare
// (worker/src/index.js), только вокруг него — обычный HTTP-сервер, файл
// SQLite и таймер раз в минуту вместо облачного расписания.
//
// Запуск: node --env-file=/etc/schedule/env server/index.mjs
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase } from "./d1.mjs";

const here = dirname(fileURLToPath(import.meta.url));

// Адрес приложения бот читает при загрузке, поэтому сначала задаём его, а
// потом уже подключаем код бота.
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

const server = createServer(async (req, res) => {
  const startedAt = performance.now();
  stats.requests += 1;
  try {
    // Проверка «жив ли» — для автоматического перезапуска и мониторинга.
    if (req.url === "/healthz") {
      STATS.raw.prepare("SELECT 1").get();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, uptime: Math.round((Date.now() - stats.started) / 1000), ...stats }));
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
