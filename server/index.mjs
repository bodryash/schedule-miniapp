// Бот расписания на своём сервере. Тот же код, что в Cloudflare
// (worker/src/index.js), только вокруг него — обычный HTTP-сервер, файл
// SQLite и таймер раз в минуту вместо облачного расписания.
//
// Запуск: node --env-file=/etc/schedule/env server/index.mjs
import { createServer } from "node:http";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statfsSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { cpus, freemem, loadavg, totalmem } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase } from "./d1.mjs";
import tls from "node:tls";

// Node 24 по умолчанию шлёт в начале TLS ещё и пост-квантовый ключ — первый
// пакет выходит крупным, и фильтр провайдера рвёт такие соединения с
// Cloudflare: бот переставал отвечать совсем, хотя curl проходил. С обычным
// набором ключей рукопожатие маленькое и проходит.
tls.DEFAULT_ECDH_CURVE = "X25519:P-256:P-384";

const here = dirname(fileURLToPath(import.meta.url));

// Адрес приложения бот читает при загрузке, поэтому сначала задаём его, а
// потом уже подключаем код бота.
globalThis.SCHEDULE_OWN_SERVER = true;
if (process.env.APP_URL) globalThis.SCHEDULE_APP_URL = process.env.APP_URL.replace(/\/?$/, "/");
// Запасной путь для календаря: файлы расписаний с диска сервера, если сайт
// приложения не ответил (см. worker/src/ics.js).
globalThis.SCHEDULE_READ_DATA = (path) => {
  try {
    const file = join(here, "..", "docs", ...String(path).split("/").filter((part) => part && part !== ".."));
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};
// Обход блокировки: с 22.10.2026 сервер не может подключиться к
// api.telegram.org. Если задан TELEGRAM_API_BASE (наш пересыльщик на
// Cloudflare, worker/tg-proxy.js), все запросы к Telegram идут через него.
const TELEGRAM_API = "https://api.telegram.org";
const TELEGRAM_BASE = (process.env.TELEGRAM_API_BASE || "").replace(/\/+$/, "");
if (TELEGRAM_BASE) {
  const direct = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    if (typeof input === "string" && input.startsWith(`${TELEGRAM_API}/`)) {
      input = TELEGRAM_BASE + input.slice(TELEGRAM_API.length);
    } else if (input instanceof URL && input.origin === TELEGRAM_API) {
      input = TELEGRAM_BASE + input.pathname + input.search;
    }
    return direct(input, init);
  };
}
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
// Столбцы, появившиеся позже таблиц: в старой базе их надо добавить.
for (const change of [
  "ALTER TABLE reminders ADD COLUMN shift INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE reminders ADD COLUMN wake INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE broadcasts ADD COLUMN audience TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE broadcasts ADD COLUMN media_kind TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE broadcasts ADD COLUMN media_id TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE reminders ADD COLUMN changes INTEGER NOT NULL DEFAULT 1",
  // Тема и надпись «на день» (день рождения): после until не показываются.
  "ALTER TABLE themes ADD COLUMN until TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE greetings ADD COLUMN until TEXT NOT NULL DEFAULT ''",
  // Подслушка: ответы на ответы, лайки ответов, причина жалобы.
  "ALTER TABLE forum_replies ADD COLUMN parent INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE forum_replies ADD COLUMN likes INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE forum_reports ADD COLUMN reason TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE forum_reports ADD COLUMN name TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE forum_posts ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE forum_posts ADD COLUMN edited TEXT",
  "ALTER TABLE forum_posts ADD COLUMN challenge TEXT",
  "ALTER TABLE forum_posts ADD COLUMN best INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE forum_replies ADD COLUMN edited TEXT",
  "ALTER TABLE forum_reports ADD COLUMN username TEXT",
  // Голосование стрелками: +1 «за», −1 «против». Прежние лайки остаются голосами «за».
  "ALTER TABLE forum_likes ADD COLUMN v INTEGER NOT NULL DEFAULT 1",
  "ALTER TABLE forum_reply_likes ADD COLUMN v INTEGER NOT NULL DEFAULT 1",
]) {
  try {
    STATS.raw.exec(change);
  } catch {
    // Уже есть.
  }
}
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
  // Ошибку сохранения не глотаем молча — иначе файлы пропадают незаметно.
  try {
    return await saveFile(document, from, caption);
  } catch (error) {
    console.error("Файл во входящие не сохранился:", document?.file_name || "", error);
    throw error;
  }
};

/**
 * /inbox: файлы из входящих, которые ещё не ушли на разбор, — владельцу в
 * чат (так у них появляется свой file_id) и оттуда на GitHub в ветку inbox.
 */
let inboxRunning = false;
globalThis.SCHEDULE_INBOX_SYNC = async (botEnv, sendToInbox) => {
  if (inboxRunning) return "Уже отправляю — подождите итога прошлого запуска.";
  inboxRunning = true;
  try {
    return await inboxSync(botEnv, sendToInbox);
  } finally {
    inboxRunning = false;
  }
};
async function inboxSync(botEnv, sendToInbox) {
  if (!botEnv.GITHUB_TOKEN) return "На сервере нет GITHUB_TOKEN — отправить на разбор не получится.";
  mkdirSync(INBOX, { recursive: true });
  const names = readdirSync(INBOX).filter((n) => !n.endsWith(".json") && !n.endsWith(".synced"));
  const todo = names.filter((n) => !existsSync(join(INBOX, `${n}.synced`))).sort().slice(-15);
  if (!names.length) return "Во входящих пусто.";
  if (!todo.length) return `Все ${names.length} файл(ов) уже отправлены на разбор.`;
  const report = [];
  for (const name of todo) {
    const path = join(INBOX, name);
    let who = "";
    try {
      const meta = JSON.parse(readFileSync(`${path}.json`, "utf8"));
      who = [meta.from?.name, meta.from?.username && `@${meta.from.username}`].filter(Boolean).join(" ") + (meta.caption ? ` · ${meta.caption}` : "");
    } catch {}
    // Помечаем сразу: если запуск оборвётся или придёт повторная команда, файл не уйдёт дважды.
    writeFileSync(`${path}.synced`, "в работе");
    try {
      const data = readFileSync(path);
      if (data.length > 20 * 1024 * 1024) throw new Error("больше 20 МБ");
      const form = new FormData();
      form.append("chat_id", String(botEnv.OWNER_ID));
      form.append("caption", `Из входящих: ${name.replace(/^[0-9T-]+_[^_]*_/, "")}`.slice(0, 200));
      form.append("document", new Blob([data]), name.replace(/^[0-9T-]+_[^_]*_/, "") || name);
      const res = await (await fetch(`https://api.telegram.org/bot${botEnv.BOT_TOKEN}/sendDocument`, { method: "POST", body: form, signal: AbortSignal.timeout(60000) })).json();
      const fileId = res?.result?.document?.file_id;
      if (!fileId) throw new Error(res?.description || "Telegram не принял файл");
      if (!(await sendToInbox(botEnv, fileId, name.replace(/^[0-9T-]+_[^_]*_/, ""), who))) throw new Error("GitHub не принял");
      writeFileSync(`${path}.synced`, new Date().toISOString());
      report.push(`✔ ${name.replace(/^[0-9T-]+_[^_]*_/, "")}`);
    } catch (error) {
      try { unlinkSync(`${path}.synced`); } catch {}
      report.push(`✖ ${name.replace(/^[0-9T-]+_[^_]*_/, "")}: ${String(error.message).slice(0, 80)}`);
    }
  }
  return `Отправил на разбор:\n${report.join("\n")}`;
}

/**
 * Фото профиля для аватарок Подслушки: качаем так же кусками (через
 * пересыльщик целиком не проходит) и держим в памяти 6 часов.
 */
const photoCache = new Map();
globalThis.SCHEDULE_TG_PHOTO = async (key, filePath, size) => {
  const hit = photoCache.get(key);
  if (hit && Date.now() - hit.at < 6 * 3600000) return hit.data;
  const data = await downloadTelegramFile(`https://api.telegram.org/file/bot${env.BOT_TOKEN}/${filePath}`, size || 0);
  if (photoCache.size > 400) photoCache.delete(photoCache.keys().next().value);
  photoCache.set(key, { at: Date.now(), data });
  return data;
};

/**
 * Файл из Telegram. Через пересыльщик на Cloudflare длинное скачивание из
 * России обрывается (соединение душат после ~16 КБ), поэтому качаем кусками
 * по 12 КБ, каждый — отдельным соединением. Напрямую (без пересыльщика) —
 * одним запросом.
 */
async function downloadTelegramFile(url, size) {
  if (!TELEGRAM_BASE) {
    const file = await fetch(url, { signal: AbortSignal.timeout(120000) });
    if (!file.ok) throw new Error(`HTTP ${file.status}`);
    return Buffer.from(await file.arrayBuffer());
  }
  const target = new URL(TELEGRAM_BASE + url.slice(TELEGRAM_API.length));
  // https — в работе; http — только у заглушки Telegram в проверках.
  const { request } = await import(target.protocol === "http:" ? "node:http" : "node:https");
  const piece = (from, to) =>
    new Promise((resolve, reject) => {
      const req = request(
        target,
        { agent: false, headers: { range: `bytes=${from}-${to}` }, timeout: 20000 },
        (res) => {
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () => {
            if (res.statusCode !== 206 && res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
            const total = Number(String(res.headers["content-range"] || "").split("/")[1]) || null;
            resolve({ body: Buffer.concat(chunks), total });
          });
          res.on("error", reject);
        }
      );
      req.on("timeout", () => req.destroy(new Error("кусок: соединение молчит 20 с")));
      // Жёсткий предел: соединение могут не рвать, а еле-еле цедить данные —
      // тогда timeout выше не срабатывает, и скачивание висело бесконечно.
      const hard = setTimeout(() => req.destroy(new Error("кусок не скачался за 25 с")), 25000);
      req.on("close", () => clearTimeout(hard));
      req.on("error", reject);
      req.end();
    });
  const STEP = 12 * 1024;
  const parts = [];
  let total = size || Infinity;
  const deadline = Date.now() + 10 * 60 * 1000;
  for (let from = 0; from < total; from += STEP) {
    if (Date.now() > deadline) throw new Error(`не уложились в 10 минут, скачано ${from} из ${total} байт`);
    let got;
    for (let attempt = 1; ; attempt++) {
      try {
        got = await piece(from, from + STEP - 1);
        break;
      } catch (error) {
        if (attempt >= 3) throw error;
      }
    }
    parts.push(got.body);
    if (got.total) total = got.total;
    if (!got.body.length) break;
  }
  return Buffer.concat(parts);
}

async function saveFile(document, from, caption) {
  if (!document?.file_id || (document.file_size || 0) > 20 * 1024 * 1024) return;
  const t0 = Date.now();
  let info;
  try {
    info = await (await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/getFile?file_id=${encodeURIComponent(document.file_id)}`, { signal: AbortSignal.timeout(30000) })).json();
  } catch (error) {
    throw new Error(`getFile за ${Date.now() - t0} мс: ${error.message}`);
  }
  if (!info.ok) throw new Error(`getFile: ${info.description || "не ok"}`);
  const t1 = Date.now();
  let data;
  try {
    data = await downloadTelegramFile(`https://api.telegram.org/file/bot${env.BOT_TOKEN}/${info.result.file_path}`, document.file_size || info.result.file_size || 0);
  } catch (error) {
    throw new Error(`скачивание ${document.file_size || "?"} байт за ${Date.now() - t1} мс: ${error.message}`);
  }
  mkdirSync(INBOX, { recursive: true });
  // Имя файла — чужое: оставляем только безопасные знаки.
  const safe = String(document.file_name || "file").replace(/[^\p{L}\p{N}._ -]/gu, "_").slice(-80);
  // Несколько фото одним сообщением приходят в одну и ту же секунду и все
  // зовутся photo.jpg — без метки файла второе затирало первое.
  // Метка — код файла целиком: у разных фото совпадают и начало, и конец кода.
  const mark = String(document.file_unique_id || Math.random().toString(36).slice(2, 8)).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40);
  const stamp = `${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}_${mark}`;
  writeFileSync(join(INBOX, `${stamp}_${safe}`), data);
  console.log(`Файл сохранён во входящие: ${stamp}_${safe} (${data.length} байт, ${Date.now() - t0} мс)`);
  writeFileSync(
    join(INBOX, `${stamp}_${safe}.json`),
    JSON.stringify({ at: new Date().toISOString(), from: { id: from?.id, name: [from?.first_name, from?.last_name].filter(Boolean).join(" "), username: from?.username || "" }, caption, name: document.file_name, size: document.file_size }, null, 2)
  );
}

// Слова, которые студенты пишут боту: одной строкой на сообщение.
globalThis.SCHEDULE_SAVE_NOTE = async (from, text, withFile) => {
  mkdirSync(INBOX, { recursive: true });
  appendFileSync(
    join(INBOX, "messages.jsonl"),
    JSON.stringify({ at: new Date().toISOString(), id: from?.id, name: [from?.first_name, from?.last_name].filter(Boolean).join(" "), username: from?.username || "", text: String(text || "").slice(0, 1000), file: withFile }) + "\n"
  );
};

// Чтение сообщений студентов для владельца и его помощника: ключ создаёт
// команда /readkey (бот присылает его только владельцу), хранится рядом с базой.
const READ_KEY_FILE = join(dirname(DB_PATH), "read.key");
globalThis.SCHEDULE_READ_KEY = async () => {
  const key = (await import("node:crypto")).randomBytes(24).toString("hex");
  writeFileSync(READ_KEY_FILE, key, { mode: 0o600 });
  return key;
};
globalThis.SCHEDULE_READ_NOTES = (limit = 20) => {
  const file = join(INBOX, "messages.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").trim().split("\n").filter(Boolean).slice(-limit).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
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

const stats = { started: Date.now(), requests: 0, errors: 0, slow: 0, limited: 0 };

/* ---------- Защита от потока запросов ----------
 * Один адрес — не больше LIMIT_PER_MINUTE запросов в минуту. Живому
 * человеку и десятка хватает, но из общежития или университетского Wi-Fi
 * сотни студентов выходят с одного адреса — поэтому запас большой. Тысячи
 * в минуту — это уже скрипт или атака.
 * Telegram (вебхук с секретом) и проверку «жив ли» не ограничиваем.
 */
const LIMIT_PER_MINUTE = 3000;
const hits = new Map();

function clientIp(req) {
  return String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
}

function limited(req) {
  if (env.WEBHOOK_SECRET && req.headers["x-telegram-bot-api-secret-token"] === env.WEBHOOK_SECRET) return false;
  const ip = clientIp(req);
  if (!ip) return false;
  const minute = Math.floor(Date.now() / 60000);
  const entry = hits.get(ip);
  if (!entry || entry.minute !== minute) {
    hits.set(ip, { minute, count: 1 });
    return false;
  }
  entry.count += 1;
  return entry.count > LIMIT_PER_MINUTE;
}

// Счётчики забываем каждую минуту: иначе таблица адресов росла бы бесконечно.
setInterval(() => {
  const minute = Math.floor(Date.now() / 60000);
  for (const [ip, entry] of hits) if (entry.minute < minute) hits.delete(ip);
}, 60000).unref();

// Что видит сторож снаружи: место на диске, возраст ночной копии, когда
// последний раз отработала минутная задача и доходит ли бот до Telegram.
const watch = { tick: 0, telegram: 0, telegramOk: null };

function vitals() {
  const out = { tickAge: watch.tick ? Math.round((Date.now() - watch.tick) / 1000) : null, telegramOk: watch.telegramOk };
  // Железо и запас: по ним видно, сколько людей выдержит сервер.
  out.cpuCores = cpus().length;
  out.loadAvg = loadavg().map((n) => Math.round(n * 100) / 100).join(" ");
  out.ramTotalMb = Math.round(totalmem() / 1048576);
  out.ramFreeMb = Math.round(freemem() / 1048576);
  out.botRssMb = Math.round(process.memoryUsage().rss / 1048576);
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
  // Что с сайтом bodryash.ru (пишет deploy/update.sh раз в минуту).
  try {
    out.site = readFileSync(join(dirname(DB_PATH), "caddy-status.txt"), "utf8").slice(-2500);
  } catch {
    out.site = null;
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
  if (req.url !== "/healthz" && limited(req)) {
    stats.limited += 1;
    if (String(req.url).startsWith("/ics/")) console.log(`ICS limited ${String(req.url).split("?")[0]}`);
    res.writeHead(429, { "content-type": "application/json", "retry-after": "60" });
    res.end(JSON.stringify({ ok: false, error: "too many requests" }));
    return;
  }
  try {
    // Проверка «жив ли» — для автоматического перезапуска и мониторинга.
    if (req.url === "/healthz") {
      STATS.raw.prepare("SELECT 1").get();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, uptime: Math.round((Date.now() - stats.started) / 1000), ...stats, ...vitals(), avatars: globalThis.SCHEDULE_AVA_STATS || null }));
      return;
    }

    // Закрытые адреса для владельца и его помощника — только по ключу (/readkey):
    // сообщения студентов боту, список входящих файлов и сами файлы (фото,
    // скрины расписаний), чтобы разбирать их без пересылки.
    if (String(req.url).startsWith("/admin/inbox")) {
      let key = "";
      try { key = readFileSync(READ_KEY_FILE, "utf8").trim(); } catch {}
      const given = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
      if (!key || given.length !== key.length || !(await import("node:crypto")).timingSafeEqual(Buffer.from(given), Buffer.from(key))) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false }));
        return;
      }
      const url = new URL(req.url, "http://x");
      const name = url.searchParams.get("file");
      if (name) {
        // Только имя из папки входящих — без путей.
        if (!/^[^/\\]+$/.test(name) || name.startsWith(".") || !existsSync(join(INBOX, name))) {
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false }));
          return;
        }
        res.writeHead(200, { "content-type": "application/octet-stream" });
        res.end(readFileSync(join(INBOX, name)));
        return;
      }
      mkdirSync(INBOX, { recursive: true });
      const files = readdirSync(INBOX)
        .filter((n) => !n.endsWith(".json") && !n.endsWith(".synced") && n !== "messages.jsonl")
        .sort()
        .slice(-Math.min(200, Number(url.searchParams.get("limit")) || 50))
        .map((n) => {
          let meta = null;
          try { meta = JSON.parse(readFileSync(join(INBOX, `${n}.json`), "utf8")); } catch {}
          return { name: n, size: statSync(join(INBOX, n)).size, from: meta?.from || null, caption: meta?.caption || "", at: meta?.at || meta?.saved || "" };
        });
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, files }));
      return;
    }

    // Закрытый адрес: последние сообщения студентов боту. Только по ключу.
    if (String(req.url).startsWith("/admin/messages")) {
      let key = "";
      try { key = readFileSync(READ_KEY_FILE, "utf8").trim(); } catch {}
      const given = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
      if (!key || given.length !== key.length || !(await import("node:crypto")).timingSafeEqual(Buffer.from(given), Buffer.from(key))) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false }));
        return;
      }
      const limit = Math.min(500, Math.max(1, Number(new URL(req.url, "http://x").searchParams.get("limit")) || 100));
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, messages: globalThis.SCHEDULE_READ_NOTES(limit) }));
      return;
    }

    // Закрытый адрес: забрать страницу расписания с сайта вуза. Многие сайты
    // вузов открываются только из России — сервер стоит здесь. Только по
    // ключу, только GET и только с сайтов из списка.
    if (String(req.url).startsWith("/admin/fetch")) {
      let key = "";
      try { key = readFileSync(READ_KEY_FILE, "utf8").trim(); } catch {}
      const given = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
      if (!key || given.length !== key.length || !(await import("node:crypto")).timingSafeEqual(Buffer.from(given), Buffer.from(key))) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false }));
        return;
      }
      const FETCH_HOSTS = ["rgsu.net", "lk.gubkin.ru", "gubkin.ru", "mpgu.su", "mgmsu.ru", "msmsu.ru"];
      let target;
      try { target = new URL(new URL(req.url, "http://x").searchParams.get("url") || ""); } catch {}
      if (!target || !["http:", "https:"].includes(target.protocol) || !FETCH_HOSTS.some((h) => target.hostname === h || target.hostname.endsWith(`.${h}`))) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "host not allowed" }));
        return;
      }
      try {
        const r = await fetch(target, { headers: { "user-agent": "Mozilla/5.0 (schedule-bot)" }, redirect: "follow", signal: AbortSignal.timeout(25000) });
        const buf = Buffer.from(await r.arrayBuffer());
        res.writeHead(200, { "content-type": "application/octet-stream", "x-upstream-status": String(r.status), "x-upstream-type": r.headers.get("content-type") || "" });
        res.end(buf.subarray(0, 20 * 1024 * 1024));
      } catch (e) {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: String(e).slice(0, 200) }));
      }
      return;
    }

    // Закрытый адрес: расписание подключено — отправителям спасибо и тема волонтёра.
    // POST {"ids":[…], "title":"МПГУ, менеджмент"}. Только по ключу.
    if (String(req.url).startsWith("/admin/connected") && req.method === "POST") {
      let key = "";
      try { key = readFileSync(READ_KEY_FILE, "utf8").trim(); } catch {}
      const given = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
      if (!key || given.length !== key.length || !(await import("node:crypto")).timingSafeEqual(Buffer.from(given), Buffer.from(key))) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false }));
        return;
      }
      const data = JSON.parse(Buffer.from((await readBody(req)) || "{}").toString("utf8"));
      const result = await globalThis.SCHEDULE_NOTIFY_CONNECTED(env, Array.isArray(data.ids) ? data.ids.slice(0, 50) : [], String(data.title || "").slice(0, 120));
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, result }));
      return;
    }

    const body = req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req);
    const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost";
    const request = new Request(`https://${host}${req.url}`, { method: req.method, headers: req.headers, body });
    // Сообщение от Telegram отвечаем «принято» не дольше чем через 5 с, а
    // разбор доживает в фоне: иначе медленный ответ (сеть до Telegram,
    // скачивание файла) Telegram считает ошибкой, копит очередь и шлёт
    // те же сообщения заново.
    const fromTelegram = req.method === "POST" && req.headers["x-telegram-bot-api-secret-token"];
    // Временно: видно, что приходит от Telegram (тип сообщения, без текста).
    if (fromTelegram) {
      try {
        const update = JSON.parse(Buffer.from(body || "").toString("utf8"));
        const m = update.message || update.edited_message || {};
        const kind = m.document ? `документ ${m.document.mime_type || ""}` : m.photo ? "фото" : m.text ? "текст" : Object.keys(update).filter((k) => k !== "update_id").join(",");
        const where = m.chat ? (m.chat.type === "private" ? "в личке" : `в чате ${m.chat.type} «${m.chat.title || ""}» (${m.chat.id})`) : "";
        console.log(`TG ${kind}${m.forward_origin || m.forward_date ? " (пересланное)" : ""} от ${m.from?.id === Number(env.OWNER_ID) ? "владельца" : `${m.from?.id || "?"}`} ${where}`);
      } catch {
        // не JSON — пропускаем
      }
    }
    const handling = worker.fetch(request, env, ctx);
    let response;
    if (fromTelegram) {
      const late = Symbol("late");
      const first = await Promise.race([handling, new Promise((resolve) => setTimeout(() => resolve(late), 5000))]);
      if (first === late) {
        handling.catch((error) => console.error("Сообщение Telegram разбиралось с ошибкой:", error));
        response = new Response("ok");
      } else {
        response = first;
      }
    } else {
      response = await handling;
    }

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
    // Временно: разбираемся, почему iPhone не подписывается на календарь.
    // Пишем только метод, адрес без настроек, программу, ответ и время — без IP.
    if (String(req.url).startsWith("/ics/")) {
      console.log(`ICS ${req.method} ${String(req.url).split("?")[0]}${String(req.url).includes("open=1") ? " open" : ""} ${res.statusCode} ${Math.round(performance.now() - startedAt)}ms ua=${String(req.headers["user-agent"] || "").slice(0, 120)}`);
    }
  }
});

/* ---------- Сигналы владельцу ----------
 * Раз в пять минут сервер сам смотрит на себя и пишет владельцу в
 * Telegram, если что-то вышло за предел: диск, память, процессор, поток
 * запросов, ошибки, очередь уведомлений, ночная копия. Об одном и том же —
 * не чаще раза в три часа; когда всё вернулось в норму — короткое «прошло».
 */
const ALARM_EVERY = 5 * 60000;
const ALARM_REPEAT = 12 * 3600000;
// Проблема должна держаться столько минут подряд, и столько же минут без
// неё — чтобы написать «прошло». Минутные моргания не тревожат.
const ALARM_HOLD = 15;
const alarms = new Map();
const streaks = new Map();
const calm = new Map();
let lastAlarmCheck = 0;
let windowFound = new Map();
let lastCounts = { requests: 0, errors: 0, limited: 0 };

function memInfo() {
  try {
    const text = readFileSync("/proc/meminfo", "utf8");
    const get = (name) => Number((text.match(new RegExp(`^${name}:\\s+(\\d+)`, "m")) || [])[1] || 0) * 1024;
    return { total: get("MemTotal"), available: get("MemAvailable"), swapUsed: get("SwapTotal") - get("SwapFree") };
  } catch {
    return null;
  }
}

async function tellOwner(text) {
  try {
    await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: env.OWNER_ID, text }),
      signal: AbortSignal.timeout(10000),
    });
  } catch (error) {
    console.error("Не удалось написать владельцу:", error);
  }
}

async function checkAlarms() {
  const found = new Map();
  const v = vitals();
  if (v.diskFree !== null && v.diskFree < 20) found.set("disk", `💾 Диск заполнен на ${100 - v.diskFree}%`);
  const mem = memInfo();
  if (mem?.total) {
    const used = Math.round((1 - mem.available / mem.total) * 100);
    if (used > 85) found.set("memory", `🧠 Память занята на ${used}%`);
    if (mem.swapUsed > 300 * 1024 * 1024) found.set("swap", `🧠 Подкачка: ${Math.round(mem.swapUsed / 1048576)} МБ — оперативной памяти не хватает`);
  }
  const rss = process.memoryUsage().rss;
  if (rss > 700 * 1024 * 1024) found.set("rss", `🤖 Бот занял ${Math.round(rss / 1048576)} МБ памяти`);
  const load = loadavg()[1];
  if (load > 0.9) found.set("cpu", `🔥 Процессор загружен: ${Math.round(load * 100)}% за 5 минут`);
  // Поток и ошибки — окнами по пять минут: их и так сглаживает окно.
  if (Date.now() - lastAlarmCheck >= ALARM_EVERY) {
    lastAlarmCheck = Date.now();
    const requests = stats.requests - lastCounts.requests;
    const errors = stats.errors - lastCounts.errors;
    const blocked = stats.limited - lastCounts.limited;
    lastCounts = { requests: stats.requests, errors: stats.errors, limited: stats.limited };
    windowFound = new Map();
    if (requests > 5000) windowFound.set("flood", `🌊 Необычно много запросов: ${requests} за 5 минут (обычно — сотни)`);
    if (blocked > 100) windowFound.set("limited", `🛡 Отбито ${blocked} запросов за 5 минут — кто-то шлёт слишком часто`);
    if (errors > 20) windowFound.set("errors", `⚠️ Ошибок сервера: ${errors} за 5 минут`);
  }
  if (v.backupAge !== null && v.backupAge > 30) found.set("backup", `🗄 Ночная копия базы не делалась ${v.backupAge} ч`);
  if (watch.telegramOk === false) found.set("telegram", "📡 Бот не достучался до Telegram — напоминания могут не уходить");
  try {
    const queue = STATS.raw.prepare("SELECT COUNT(*) AS n FROM alerts WHERE sent = 0").get().n;
    if (queue > 3000) found.set("queue", `📨 В очереди уведомлений ${queue} сообщений`);
  } catch {
    // Таблицы ещё нет — нечего проверять.
  }
  // Состояние должно держаться ALARM_HOLD минут подряд; окна — сразу.
  for (const key of [...streaks.keys()]) if (!found.has(key)) streaks.delete(key);
  for (const key of found.keys()) streaks.set(key, (streaks.get(key) || 0) + 1);
  const firing = new Map([...found].filter(([key]) => streaks.get(key) >= ALARM_HOLD));
  for (const [key, text] of windowFound) firing.set(key, text);
  for (const [key, text] of firing) {
    calm.delete(key);
    const last = alarms.get(key);
    if (!last || Date.now() - last > ALARM_REPEAT) {
      alarms.set(key, Date.now());
      await tellOwner(`${text}\n\nСервер расписания, ${new Date().toLocaleString("ru-RU", { timeZone: "Europe/Moscow" })}`);
    }
  }
  for (const key of [...alarms.keys()]) {
    if (!firing.has(key) && !found.has(key)) {
      // «Прошло» — только после ALARM_HOLD спокойных минут подряд.
      calm.set(key, (calm.get(key) || 0) + 1);
      if (calm.get(key) < ALARM_HOLD) continue;
      calm.delete(key);
      alarms.delete(key);
      await tellOwner(`✅ Прошло: ${key === "disk" ? "диск" : key === "memory" || key === "swap" || key === "rss" ? "память" : key === "cpu" ? "процессор" : key === "flood" || key === "limited" ? "поток запросов" : key === "errors" ? "ошибки" : key === "backup" ? "ночная копия" : key === "queue" ? "очередь уведомлений" : "связь с Telegram"} — снова в норме`);
    }
  }
}

// Раз в минуту, ровно в начале минуты: напоминания привязаны ко времени.
let ticking = false;
async function tick() {
  if (ticking) return; // прошлый запуск ещё идёт — не наслаиваем
  ticking = true;
  watch.tick = Date.now();
  checkTelegram();
  checkAlarms().catch((error) => console.error("Сигналы упали:", error));
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
