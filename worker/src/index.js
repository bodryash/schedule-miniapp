/**
 * Бот на вебхуке: Telegram сам стучится сюда, поэтому ничего крутить на
 * компьютере не нужно. Отвечает на /start сообщением с кнопкой,
 * открывающей мини-приложение, и на /stats — сводкой по открытиям.
 *
 * Второй маршрут — POST /hit: мини-приложение сообщает, что его открыли.
 * Считает обезличенно, см. schema.sql.
 */

import {
  addDays,
  answerInline,
  dateLabel,
  iso,
  loadGroups,
  normalize,
  parityOf,
  parseDay,
  today,
} from "./inline.js";
import {
  banCommand,
  bansList,
  canComment,
  commentCounts,
  commentsApi,
  deleteCommentCommand,
  listCommentsCommand,
  moderateComment,
  purgeAuthor,
  unbanCommand,
} from "./comments.js";

const WEB_APP_URL = "https://bodryash.github.io/schedule-miniapp/";

// Тестовая сборка: папка docs отдельным воркером, чтобы проверить новое до
// выкладки студентам. Обновить:
//   npx wrangler deploy --name fgp-schedule-beta --assets docs --compatibility-date 2026-09-11
const BETA_URL = "https://fgp-schedule-beta.bodryash.workers.dev/";

// Объявление само снимается через неделю: забытая плашка «пара перенесена»
// через месяц вводила бы в заблуждение сильнее, чем её отсутствие.
const NOTICE_DAYS = 7;

// Открытие засчитываем не чаще раза в час на человека, иначе тот, кто за
// пару десять раз посмотрел расписание, перевесит целую группу.
const HIT_COOLDOWN = 3600;

async function callTelegram(token, method, payload) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  // Telegram отвергает сообщение целиком из-за одной ошибки в разметке или
  // длины — без записи в журнал это выглядит как «бот молчит».
  if (!response.ok) {
    console.log(`${method} rejected ${response.status}`, (await response.clone().text()).slice(0, 300));
  }
  return response;
}

async function hmac(key, message) {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    typeof key === "string" ? new TextEncoder().encode(key) : key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(message))
  );
}

function toHex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Проверяет подпись initData мини-приложения. Без неё эндпоинт открыт
 * всему интернету и счётчики можно накрутить одной командой.
 */
async function verifyInitData(initData, token) {
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");

  const checkString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  const secret = await hmac("WebAppData", token);
  const expected = toHex(await hmac(secret, checkString));
  if (expected !== hash) return null;

  // Свежесть: подписанную строку нельзя переиспользовать бесконечно.
  const authDate = Number(params.get("auth_date") || 0);
  if (!authDate || Date.now() / 1000 - authDate > 86400) return null;

  try {
    return JSON.parse(params.get("user") || "null");
  } catch {
    return null;
  }
}

async function recordOpen(env, user, group) {
  if (!env.STATS || !user?.id) return;

  // Идентификатор Telegram не храним: только хэш с серверным секретом.
  const uid = toHex(await hmac(env.STATS_SALT || "salt", String(user.id))).slice(0, 32);
  const now = Math.floor(Date.now() / 1000);
  const today = new Date().toISOString().slice(0, 10);

  const seen = await env.STATS.prepare("SELECT last FROM people WHERE uid = ?")
    .bind(uid)
    .first();
  const lastSeen = seen ? Math.floor(new Date(seen.last).getTime() / 1000) : 0;

  const stamp = new Date().toISOString();
  await env.STATS.prepare(
    `INSERT INTO people (uid, first, last, grp, tg_id, name, username)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(uid) DO UPDATE SET
       last = excluded.last, grp = excluded.grp,
       name = excluded.name, username = excluded.username`
  )
    .bind(
      uid,
      stamp,
      stamp,
      group.id || null,
      user.id,
      [user.first_name, user.last_name].filter(Boolean).join(" ") || null,
      user.username || null
    )
    .run();

  if (now - lastSeen < HIT_COOLDOWN) return;

  // «zh-hans» и «zh» — один язык.
  const lang = String(user.language_code || "—").toLowerCase().split("-")[0];
  await env.STATS.batch([
    env.STATS.prepare(
      `INSERT INTO opens (day, grp, course, level, count) VALUES (?, ?, ?, ?, 1)
       ON CONFLICT(day, grp) DO UPDATE SET count = count + 1`
    ).bind(today, group.id || "—", group.course ?? null, group.level ?? null),
    env.STATS.prepare(
      `INSERT INTO langs (day, lang, count) VALUES (?, ?, 1)
       ON CONFLICT(day, lang) DO UPDATE SET count = count + 1`
    ).bind(today, lang),
  ]);
}

const LANG_NAMES = {
  ru: "русский", en: "английский", zh: "китайский", uk: "украинский",
  be: "белорусский", kk: "казахский", uz: "узбекский", ky: "киргизский",
  tg: "таджикский", az: "азербайджанский", hy: "армянский", ka: "грузинский",
  tr: "турецкий", ar: "арабский", fa: "персидский", ko: "корейский",
  ja: "японский", vi: "вьетнамский", mn: "монгольский", fr: "французский",
  de: "немецкий", es: "испанский", it: "итальянский", pt: "португальский",
  "—": "не указан",
};

/** Языки Telegram за неделю — доля открытий, чтобы решить про перевод. */
async function languageLines(env, since) {
  const { results = [] } = await env.STATS.prepare(
    `SELECT lang, SUM(count) AS n FROM langs WHERE day >= ?
     GROUP BY lang ORDER BY n DESC`
  )
    .bind(since)
    .all();
  if (!results.length) return ["", "<b>Языки Telegram</b>", "Данных пока нет — копятся с открытий."];

  const total = results.reduce((sum, r) => sum + r.n, 0);
  const shown = results.slice(0, 8).map((r) => {
    const share = Math.round((r.n / total) * 100);
    // «<1» пишем как &lt;1: иначе Telegram примет это за начало тега и
    // отвергнет всё сообщение целиком.
    return `${escape(LANG_NAMES[r.lang] || r.lang)} — ${r.n} (${share < 1 ? "&lt;1" : share}%)`;
  });
  const rest = results.slice(8).reduce((sum, r) => sum + r.n, 0);
  if (rest) shown.push(`другие — ${rest}`);
  return ["", "<b>Языки Telegram</b> (открытия за неделю)", ...shown];
}

const REPO = "bodryash/schedule-miniapp";

// За один запуск воркер успевает немного: обращений наружу разрешено около
// полусотни. Поэтому за раз рассылаем порцию, остальное — на следующей
// минуте.
const BATCH = 40;

/** Готовит черновик рассылки и показывает его с кнопками подтверждения. */
async function draftBroadcast(env, chatId, text, { button = false } = {}) {
  const { count } = await env.STATS.prepare(
    "SELECT COUNT(*) AS count FROM users"
  ).first();

  const draft = await env.STATS.prepare(
    "INSERT INTO broadcasts (text, created, button) VALUES (?, ?, ?) RETURNING id"
  )
    .bind(text, new Date().toISOString(), button ? 1 : 0)
    .first();

  const extra = button ? "\n(с кнопкой «📅 Открыть расписание»)" : "";
  await callTelegram(env.BOT_TOKEN, "sendMessage", {
    chat_id: chatId,
    text: `Разослать это ${count} получателям?${extra}\n\n———\n${text}\n———`,
    reply_markup: {
      inline_keyboard: [
        [
          { text: `Отправить (${count})`, callback_data: `send:${draft.id}` },
          { text: "Отмена", callback_data: `drop:${draft.id}` },
        ],
      ],
    },
  });
}

/**
 * Текст «расписание обновлено» на русском и английском; extra — от владельца.
 *
 * Без даты: в самом PDF дата утверждения не заполнена («"_____" августа»),
 * а дата разбора — это не версия деканата. К тому же сайт отдаёт данные с
 * кэшем, и бот читал старую дату: в рассылке висело 13 сентября при
 * опубликованном 16-м. Лучше без даты, чем с неверной.
 */
function updatedText(extra) {
  return [
    "📅 Расписание обновлено по последней версии из деканата.",
    "Проверьте свои пары: изменения уже в приложении.",
    ...(extra ? ["", extra] : []),
    "",
    "📅 The schedule has been updated to the latest version from the dean's office.",
    "Please check your classes: the changes are already in the app.",
  ].join("\n");
}

/** Кнопки под черновиком. Нажать может только владелец. */
async function handleButton(env, query) {
  const [action, rawId] = (query.data || "").split(":");
  const id = Number(rawId);
  const owner = String(query.from?.id) === String(env.OWNER_ID);

  let notice = "Недоступно";
  if (owner && id) {
    if (action === "drop") {
      await env.STATS.prepare(
        "UPDATE broadcasts SET status = 'cancelled' WHERE id = ? AND status = 'draft'"
      )
        .bind(id)
        .run();
      notice = "Отменено";
    } else if (action === "send") {
      // Очередь наполняем разом, а разбираем порциями по расписанию.
      await env.STATS.batch([
        env.STATS.prepare(
          "INSERT OR IGNORE INTO outbox (broadcast, chat_id) SELECT ?, id FROM users"
        ).bind(id),
        env.STATS.prepare(
          "UPDATE broadcasts SET status = 'sending' WHERE id = ? AND status = 'draft'"
        ).bind(id),
      ]);
      notice = "Отправляю";
    }
  }

  await callTelegram(env.BOT_TOKEN, "answerCallbackQuery", {
    callback_query_id: query.id,
    text: notice,
  });

  if (owner && id) {
    await callTelegram(env.BOT_TOKEN, "editMessageReplyMarkup", {
      chat_id: query.message.chat.id,
      message_id: query.message.message_id,
      reply_markup: { inline_keyboard: [] },
    });
  }
}

/** Разбирает очередь порциями. Вызывается задачей по расписанию. */
async function drainOutbox(env) {
  const job = await env.STATS.prepare(
    "SELECT id, text, button FROM broadcasts WHERE status = 'sending' ORDER BY id LIMIT 1"
  ).first();
  if (!job) return;

  const { results = [] } = await env.STATS.prepare(
    "SELECT chat_id FROM outbox WHERE broadcast = ? AND state = 'pending' LIMIT ?"
  )
    .bind(job.id, BATCH)
    .all();

  if (!results.length) {
    const totals = await env.STATS.prepare(
      `SELECT SUM(state = 'sent') AS sent, SUM(state = 'failed') AS failed
       FROM outbox WHERE broadcast = ?`
    )
      .bind(job.id)
      .first();

    await env.STATS.prepare(
      "UPDATE broadcasts SET status = 'done', sent = ?, failed = ? WHERE id = ?"
    )
      .bind(totals.sent || 0, totals.failed || 0, job.id)
      .run();

    await callTelegram(env.BOT_TOKEN, "sendMessage", {
      chat_id: env.OWNER_ID,
      text: `Рассылка закончена. Доставлено ${totals.sent || 0}, не дошло ${totals.failed || 0}.`,
    });
    return;
  }

  for (const row of results) {
    let state = "sent";
    try {
      const response = await callTelegram(env.BOT_TOKEN, "sendMessage", {
        chat_id: row.chat_id,
        text: job.text,
        // Рассылка идёт в личные чаты — там кнопка web_app разрешена.
        reply_markup: job.button
          ? { inline_keyboard: [[{ text: "📅 Открыть расписание", web_app: { url: WEB_APP_URL } }]] }
          : undefined,
      });
      // Заблокировавшие бота и удалённые аккаунты — не ошибка рассылки.
      if (!response.ok) state = "failed";
    } catch {
      state = "failed";
    }
    await env.STATS.prepare(
      "UPDATE outbox SET state = ? WHERE broadcast = ? AND chat_id = ?"
    )
      .bind(state, job.id, row.chat_id)
      .run();
  }
}

/**
 * Запускает сборку на GitHub: разбор PDF живёт там, потому что парсер
 * написан на Python, а здесь JavaScript.
 */
async function startUpdate(env, document) {
  if (!env.GITHUB_TOKEN) return "Обновление не настроено: нет доступа к GitHub.";

  const response = await fetch(`https://api.github.com/repos/${REPO}/dispatches`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "user-agent": "fgp-schedule-bot",
    },
    body: JSON.stringify({
      event_type: "new-schedule",
      client_payload: { file_id: document.file_id },
    }),
  });

  if (!response.ok) {
    return `GitHub отказал: ${response.status}. Проверьте права токена.`;
  }
  return `Принял «${document.file_name || "файл"}». Разбираю и проверяю, отчитаюсь через пару минут.`;
}

function daysAgo(count) {
  return new Date(Date.now() - count * 86400000).toISOString().slice(0, 10);
}

async function buildStats(env) {
  if (!env.STATS) return "Статистика не подключена.";

  const today = new Date().toISOString().slice(0, 10);
  const week = daysAgo(7);

  const [todayRow, weekRow, people, top, total, fresh, wrote] = await Promise.all([
    env.STATS.prepare("SELECT COALESCE(SUM(count), 0) AS n FROM opens WHERE day = ?")
      .bind(today)
      .first(),
    env.STATS.prepare("SELECT COALESCE(SUM(count), 0) AS n FROM opens WHERE day >= ?")
      .bind(week)
      .first(),
    env.STATS.prepare(
      "SELECT COUNT(*) AS n FROM people WHERE last >= ?"
    )
      .bind(week)
      .first(),
    env.STATS.prepare(
      `SELECT grp, SUM(count) AS n FROM opens WHERE day >= ?
       GROUP BY grp ORDER BY n DESC LIMIT 8`
    )
      .bind(week)
      .all(),
    env.STATS.prepare(
      `SELECT COUNT(*) AS people, COALESCE(
         (SELECT SUM(count) FROM opens), 0) AS opens FROM people`
    ).first(),
    env.STATS.prepare("SELECT COUNT(*) AS n FROM people WHERE first >= ?")
      .bind(today)
      .first(),
    // Писали боту — это другая величина: кнопка меню открывает приложение
    // мимо бота, а часть людей наоборот только нажала /start и не вернулась.
    env.STATS.prepare("SELECT COUNT(*) AS n FROM users").first(),
  ]);

  const lines = [
    `<b>За всё время</b>`,
    `Людей: ${total.people}, открытий: ${total.opens}`,
    `Писали боту: ${wrote ? wrote.n : "—"}`,
    "",
    `<b>Открытия</b>`,
    `Сегодня: ${todayRow.n}${fresh.n ? `, новых людей ${fresh.n}` : ""}`,
    `За неделю: ${weekRow.n}, людей ${people.n}`,
  ];

  if (top.results?.length) {
    lines.push("", "<b>Активнее всех</b>");
    lines.push(top.results.map((r) => `${r.grp} — ${r.n}`).join("\n"));
  } else {
    lines.push("", "Пока ни одного открытия.");
  }

  lines.push(...(await languageLines(env, week)));

  // Молчащие группы — самое полезное здесь: они отвечают на вопрос, до кого
  // ссылка не дошла. Целый курс без единого открытия — это не про
  // приложение, а про то, что старосте забыли написать.
  const silent = await silentGroups(env, week);
  if (silent === null) {
    lines.push("", "Список групп недоступен.");
  } else if (silent.length) {
    lines.push("", `<b>Ни разу не заходили</b> (${silent.length})`);
    lines.push(silent.slice(0, 25).join(", "));
    if (silent.length > 25) lines.push(`… и ещё ${silent.length - 25}`);
  } else {
    lines.push("", "Заходили из всех групп.");
  }

  return lines.join("\n");
}

/** Поимённый список заходивших. `/who 311гэу` — только по этой группе. */
async function buildWho(env, filter) {
  if (!env.STATS) return "Статистика не подключена.";

  const limit = 60;
  const query = filter
    ? env.STATS.prepare(
        `SELECT name, username, grp, last FROM people
         WHERE grp = ? ORDER BY last DESC LIMIT ?`
      ).bind(filter, limit + 1)
    : env.STATS.prepare(
        `SELECT name, username, grp, last FROM people
         ORDER BY last DESC LIMIT ?`
      ).bind(limit + 1);

  const { results = [] } = await query.all();
  if (!results.length) {
    return filter ? `Из ${escape(filter)} никто не заходил.` : "Пока никто не заходил.";
  }

  const head = filter ? `<b>Заходили из ${escape(filter)}</b>` : "<b>Кто заходил</b>";
  const lines = results.slice(0, limit).map((row) => {
    const who = row.username ? `@${row.username}` : escape(row.name || "без имени");
    const where = filter ? "" : ` · ${escape(row.grp || "—")}`;
    return `${who}${where} · ${row.last.slice(0, 10)}`;
  });

  if (results.length > limit) lines.push(`… показаны последние ${limit}`);
  return [head, "", ...lines].join("\n");
}

function escape(text) {
  return String(text).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c]);
}

async function silentGroups(env, since) {
  let groups;
  try {
    const response = await fetch(`${WEB_APP_URL}data/groups.json`);
    if (!response.ok) return null;
    groups = await response.json();
  } catch {
    return null;
  }

  const active = await env.STATS.prepare(
    "SELECT DISTINCT grp FROM opens WHERE day >= ?"
  )
    .bind(since)
    .all();
  const seen = new Set((active.results || []).map((r) => r.grp));
  return groups.map((g) => g.id).filter((id) => !seen.has(id));
}

// Объявление на курс хранится одной записью с таким ключом, а не копией на
// каждую группу: снимается одной командой, и новая группа курса его тоже видит.
const courseKey = (level, course) => `курс:${level}:${course}`;

function courseLabel(key) {
  const [, level, course] = key.split(":");
  return level === "магистратура" ? `маг${course}` : `${course}курс`;
}

/**
 * «3 курс» и «маг 1» пишут с пробелом, а адресат — первое слово команды:
 * без склейки «курс» ушёл бы в текст, а «3» не нашлось бы как группа.
 */
const glueCourse = (body) =>
  body
    .replace(/^(\d)\s+курс(?=[\s,]|$)/i, "$1курс")
    .replace(/^маг(?:истратура)?\s+(\d)(?=[\s,]|$)/i, "маг$1");

/** «3курс», «3 курс», «маг1», «1маг» → ключ курса; иначе null. */
function parseCourse(name) {
  const key = normalize(name);
  let match = key.match(/^(\d)курс$/);
  if (match) return courseKey("бакалавриат", Number(match[1]));
  match = key.match(/^маг(?:истратура)?(\d)$/) || key.match(/^(\d)маг(?:истратура)?$/);
  if (match) return courseKey("магистратура", Number(match[1]));
  return null;
}

const courseOf = (group) =>
  group.level && group.course ? courseKey(group.level, group.course) : "—";

/**
 * Отмены пар группы — с позавчерашнего дня по Москве: часы телефона могут
 * отставать от сервера, и вчерашняя отмена не должна исчезнуть раньше срока.
 */
async function activeCancels(env, group) {
  if (!env.STATS || !group?.id) return [];
  const { results = [] } = await env.STATS.prepare(
    `SELECT id, day, slots, reason, subject, subgroup FROM cancels
     WHERE grp IN (?, ?, '*') AND removed = 0 AND day >= ?
     ORDER BY day, id LIMIT 40`
  )
    .bind(group.id, courseOf(group), iso(addDays(today(), -1)))
    .all();
  return results.map((c) => ({ ...c, slots: c.slots ? c.slots.split(",").map(Number) : [] }));
}

/** Замены пар группы (/change) — с позавчерашнего дня, как отмены. */
async function activeChanges(env, group) {
  if (!env.STATS || !group?.id) return [];
  const { results = [] } = await env.STATS.prepare(
    `SELECT id, day, slots, from_teacher, teacher, room, start, reason FROM changes
     WHERE grp IN (?, ?, '*') AND removed = 0 AND day >= ?
     ORDER BY day, id LIMIT 40`
  )
    .bind(group.id, courseOf(group), iso(addDays(today(), -1)))
    .all();
  return results.map((c) => ({ ...c, slots: c.slots.split(",").map(Number) }));
}

/** Объявления группы: её собственные, её курса и общие для всех. */
/**
 * Объявления группы: её собственные, её курса, общие для всех и — если
 * известен человек — личные. Личные передаём только в приложение: карточку
 * расписания из чатов пересылают в общие беседы, там им не место.
 */
async function activeNotices(env, group, userId = null) {
  if (!env.STATS || !group?.id) return [];
  const course = courseOf(group);
  const personal = userId ? `user:${userId}` : "—";
  const { results = [] } = await env.STATS.prepare(
    `SELECT id, text, created, color, grp LIKE 'user:%' AS personal FROM notices
     WHERE grp IN (?, ?, '*', ?) AND expires > ? ORDER BY id DESC LIMIT 10`
  )
    .bind(group.id, course, personal, new Date().toISOString())
    .all();
  return results.map((n) => ({ ...n, color: n.color || "yellow", personal: Boolean(n.personal) }));
}

async function groupOfUser(env, userId) {
  if (!env.STATS || !userId) return null;
  const row = await env.STATS.prepare(
    "SELECT grp FROM people WHERE tg_id = ? ORDER BY last DESC LIMIT 1"
  )
    .bind(userId)
    .first();
  return row?.grp || null;
}

// Цвет объявления — первым словом после адресата: «#красный» или кружок.
const NOTICE_COLORS = new Map([
  ["#жёлтый", "yellow"], ["#желтый", "yellow"], ["🟡", "yellow"],
  ["#красный", "red"], ["🔴", "red"],
  ["#зелёный", "green"], ["#зеленый", "green"], ["🟢", "green"],
  ["#синий", "blue"], ["🔵", "blue"],
  ["#серый", "gray"], ["⚪", "gray"],
]);
const COLOR_DOT = { yellow: "🟡", red: "🔴", green: "🟢", blue: "🔵", gray: "⚪" };

const NOTICE_HELP = [
  "<b>Объявления</b> — плашка в приложении, висит неделю. Можно несколько сразу.",
  "",
  "/notice 311гэу Пара в четверг переносится в 614",
  "/notice 311гэу #красный Пара отменена — цветом",
  "/notice 311гэу,312гэу Текст — нескольким группам",
  "/notice 3курс Текст — курсу бакалавриата (1курс … 4курс)",
  "/notice маг1 Текст — курсу магистратуры (маг1, маг2)",
  "/notice @ivanov Текст — одному человеку (или id)",
  "/notice все Текст — всему факультету",
  "/unnotice 12 — снять объявление №12",
  "/unnotice все — снять все разом",
  "",
  "Цвета: #жёлтый (обычный), #красный, #зелёный, #синий, #серый — или 🟡🔴🟢🔵⚪.",
].join("\n");

/* ---------- Домашка и старосты ---------- */

const HOMEWORK_MAX = 1000;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

// Больше двух недель за запрос не отдаём: приложение показывает по неделе,
// а без предела один запрос мог бы вычитать всю таблицу.
const HOMEWORK_SPAN_DAYS = 14;

/**
 * Диапазон дат из запроса. Приложение просит неделю, которую показывает;
 * без диапазона (старые версии) — неделя назад и неделя вперёд.
 */
function homeworkRange(from, to) {
  if (ISO_DAY.test(from || "") && ISO_DAY.test(to || "") && from <= to) {
    const span = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000;
    if (span <= HOMEWORK_SPAN_DAYS) return { from, to };
  }
  const now = today();
  return { from: iso(addDays(now, -7)), to: iso(addDays(now, 7)) };
}

async function groupHomework(env, groupId, range) {
  if (!env.STATS || !groupId) return [];
  const { from, to } = range || homeworkRange();
  const { results = [] } = await env.STATS.prepare(
    `SELECT subject, subgroup, day, text FROM homework
     WHERE grp = ? AND day >= ? AND day <= ? ORDER BY day LIMIT 200`
  )
    .bind(groupId, from, to)
    .all();
  return results;
}

const isOwner = (env, id) => String(id) === String(env.OWNER_ID);

/** Может ли человек с этой подписью Telegram вносить домашку группе. */
async function canEditHomework(env, initData, groupId) {
  if (!groupId) return false;
  const user = await verifyInitData(initData, env.BOT_TOKEN);
  if (!user?.id) return false;
  // Владелец может везде — чтобы проверить и чтобы подменить старосту.
  if (isOwner(env, user.id)) return true;
  const row = await env.STATS.prepare("SELECT 1 AS ok FROM starostas WHERE grp = ? AND tg_id = ?")
    .bind(groupId, user.id)
    .first();
  return Boolean(row);
}

async function saveHomework(env, body) {
  const groupId = String(body.group || "");
  const subject = String(body.subject || "").trim();
  const subgroup = Number(body.subgroup) || 0;
  const day = String(body.day || "");
  const text = String(body.text || "").trim();

  if (!groupId || !subject || subject.length > 200 || !ISO_DAY.test(day)) {
    return { ok: false, error: "bad request" };
  }
  if (!Number.isInteger(subgroup) || subgroup < 0 || subgroup > 30) return { ok: false, error: "bad subgroup" };
  if (text.length > HOMEWORK_MAX) return { ok: false, error: "too long" };

  const user = await verifyInitData(body.initData || "", env.BOT_TOKEN);
  if (!user?.id) return { ok: false, error: "unauthorized" };
  if (!(await canEditHomework(env, body.initData, groupId))) return { ok: false, error: "forbidden" };

  if (!text) {
    await env.STATS.prepare("DELETE FROM homework WHERE grp = ? AND subject = ? AND subgroup = ? AND day = ?")
      .bind(groupId, subject, subgroup, day)
      .run();
  } else {
    await env.STATS.prepare(
      `INSERT INTO homework (grp, subject, subgroup, day, text, author, updated)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(grp, subject, subgroup, day) DO UPDATE SET
         text = excluded.text, author = excluded.author, updated = excluded.updated`
    )
      .bind(groupId, subject, subgroup, day, text, user.id, new Date().toISOString())
      .run();
  }
  // Возвращаем только этот день: приложение заменит его у себя, остальное
  // у него уже есть.
  return { ok: true, day, homework: await groupHomework(env, groupId, { from: day, to: day }) };
}

/** «@ivanov» или числовой id → человек из тех, кто писал боту или открывал приложение. */
async function findPerson(env, token) {
  const raw = String(token || "").trim();
  if (/^\d+$/.test(raw)) {
    const row =
      (await env.STATS.prepare("SELECT id AS tg_id, name, username FROM users WHERE id = ?").bind(Number(raw)).first()) ||
      (await env.STATS.prepare("SELECT tg_id, name, username FROM people WHERE tg_id = ? LIMIT 1").bind(Number(raw)).first());
    return row || { tg_id: Number(raw), name: null, username: null };
  }
  const username = raw.replace(/^@/, "");
  if (!/^\w{3,32}$/.test(username)) return null;
  return (
    (await env.STATS.prepare(
      "SELECT id AS tg_id, name, username FROM users WHERE lower(username) = lower(?) LIMIT 1"
    ).bind(username).first()) ||
    (await env.STATS.prepare(
      "SELECT tg_id, name, username FROM people WHERE lower(username) = lower(?) AND tg_id IS NOT NULL LIMIT 1"
    ).bind(username).first())
  );
}

const personLabel = (p) => (p.username ? `@${p.username}` : p.name || `id ${p.tg_id}`);

const STAROSTA_HELP = [
  "<b>Старосты</b> — вносят домашку своей группе прямо в расписании.",
  "",
  "/starosta 311гэу @ivanov — назначить",
  "/unstarosta @ivanov — снять со всех групп",
  "/unstarosta @ivanov 311гэу — снять с одной",
  "/starosta — список",
  "",
  "Человек должен хоть раз написать боту или открыть расписание — иначе Telegram не даёт узнать его по @username. Можно указать и числовой id.",
].join("\n");

async function handleStarosta(env, text) {
  const [, groupName, who] = text.trim().split(/\s+/);

  if (!groupName) {
    const { results = [] } = await env.STATS.prepare(
      "SELECT grp, tg_id, name, username FROM starostas ORDER BY grp, created"
    ).all();
    const list = results.map((r) => `${escape(r.grp)} — ${escape(personLabel(r))}`);
    return [STAROSTA_HELP, "", list.length ? list.join("\n") : "Старост пока нет."].join("\n");
  }
  if (!who) return `Не хватает человека.\n\n${STAROSTA_HELP}`;

  let groups;
  try {
    groups = await loadGroups();
  } catch {
    return "Не удалось загрузить список групп. Попробуйте позже.";
  }
  const group = groups.find((g) => normalize(g.id) === normalize(groupName));
  if (!group) return `Не нашёл группу ${escape(groupName)}. Пишите полностью, например 311гэу.`;

  const person = await findPerson(env, who);
  if (!person) {
    return `Не нашёл ${escape(who)}. Пусть сначала напишет боту /start или откроет расписание, затем повторите.`;
  }

  await env.STATS.prepare(
    `INSERT INTO starostas (grp, tg_id, name, username, created) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(grp, tg_id) DO UPDATE SET name = excluded.name, username = excluded.username`
  )
    .bind(group.id, person.tg_id, person.name || null, person.username || null, new Date().toISOString())
    .run();

  // Предупреждаем самого старосту. Не дошло — не беда: кнопка и так появится.
  await callTelegram(env.BOT_TOKEN, "sendMessage", {
    chat_id: person.tg_id,
    text: `Вас назначили старостой группы ${group.title}.\n\nОткройте расписание: у пар появилась кнопка «＋ ДЗ». Домашку увидит вся группа.`,
    reply_markup: { inline_keyboard: [[{ text: "📅 Открыть расписание", web_app: { url: WEB_APP_URL } }]] },
  }).catch(() => null);

  return `Готово: ${escape(personLabel(person))} — староста ${escape(group.title)}. Кнопка «＋ ДЗ» появится у него при следующем открытии расписания.`;
}

async function handleUnstarosta(env, text) {
  const [, who, groupName] = text.trim().split(/\s+/);
  if (!who) return `Укажите человека.\n\n${STAROSTA_HELP}`;
  const person = await findPerson(env, who);
  if (!person) return `Не нашёл ${escape(who)}.`;

  const result = groupName
    ? await env.STATS.prepare("DELETE FROM starostas WHERE tg_id = ? AND lower(grp) = lower(?)")
        .bind(person.tg_id, groupName)
        .run()
    : await env.STATS.prepare("DELETE FROM starostas WHERE tg_id = ?").bind(person.tg_id).run();
  const count = result.meta?.changes || 0;
  return count
    ? `${escape(personLabel(person))} больше не староста${groupName ? ` ${escape(groupName)}` : ""}. Внесённая домашка остаётся.`
    : `${escape(personLabel(person))} не был старостой${groupName ? ` ${escape(groupName)}` : ""}.`;
}

/** «311гэу,312гэу», «3курс», «маг1», «все» → ключи адресатов для /notice и /cancel. */
async function resolveTargets(target, env = null) {
  if (["все", "всем", "*"].includes(target.toLowerCase())) return { ids: ["*"] };

  let groups;
  try {
    groups = await loadGroups();
  } catch {
    return { error: "Не удалось загрузить список групп. Попробуйте позже." };
  }
  // Только точное совпадение: «31» не должно уйти десятку групп разом.
  const byName = new Map(groups.map((g) => [normalize(g.id), g.id]));
  const courses = new Set(groups.map((g) => courseKey(g.level, g.course)));
  const ids = [];
  const unknown = [];
  for (const name of target.split(",").filter(Boolean)) {
    // Человек — только там, где передан env: объявление одному можно, а
    // отменить пару одному человеку смысла нет.
    if (env && (name.startsWith("@") || /^\d{5,}$/.test(name))) {
      const person = await findPerson(env, name);
      if (person?.tg_id) ids.push(`user:${person.tg_id}`);
      else unknown.push(name);
      continue;
    }
    const course = parseCourse(name);
    const id = course && courses.has(course) ? course : byName.get(normalize(name));
    if (id) ids.push(id);
    else unknown.push(name);
  }
  if (unknown.length) {
    const people = env ? ", человека (@username или id)" : "";
    const hint = env ? " Человек должен хоть раз написать боту или открыть расписание." : "";
    return {
      error: `Не нашёл: ${escape(unknown.join(", "))}. Пишите группу полностью (311гэу), курс (3курс, маг1)${people} или «все».${hint}`,
    };
  }
  return { ids: [...new Set(ids)] };
}

const CANCEL_HELP = [
  "<b>Отмена пар</b> — пара зачёркивается в приложении и в расписании в чатах.",
  "",
  "/cancel 311гэу 14.09 3 Преподаватель заболел",
  "/cancel 3курс завтра — весь день",
  "/cancel 311гэу,312гэу пт 1-2",
  "/cancel все 15.09 5,6",
  "/cancel преп Шестова 14.09 Заболела — все пары преподавателя",
  "/cancel преп Иванов А.А. пт 3-4 — однофамильцев различают инициалы",
  "/cancel 3курс преп Шестова ср — только у курса или групп (101,102)",
  "/uncancel 7 — вернуть пару, /uncancel 7,8,9 — несколько",
  "",
  "Порядок: кому, день, номера пар, причина. Кому — как в /notice. День — 14.09, сегодня, завтра или пн…сб. Без номеров отменяется весь день. Причину можно не писать.",
  "По преподавателю отменяются только его пары — предмет и подгруппа, а не вся пара группы.",
].join("\n");

const SLOT_LIST = /^\d(?:[-–,]\d)*$/;

function parseSlots(token) {
  const slots = new Set();
  for (const part of token.split(",")) {
    const [from, to = from] = part.split(/[-–]/).map(Number);
    for (let n = Math.min(from, to); n <= Math.max(from, to); n++) slots.add(n);
  }
  return [...slots].sort((a, b) => a - b);
}

function slotsLabel(slots) {
  if (!slots.length) return "весь день";
  return `${slots.join(", ")} ${slots.length === 1 ? "пара" : "пары"}`;
}

async function handleCancel(env, text) {
  const body = glueCourse(text.replace(/^\/cancel(@\w+)?/, "").trim());

  if (!body) {
    const { results = [] } = await env.STATS.prepare(
      `SELECT id, grp, day, slots, reason, subject, subgroup, teacher FROM cancels
       WHERE removed = 0 AND day >= ? ORDER BY day, id LIMIT 30`
    )
      .bind(iso(today()))
      .all();
    const list = results.map((c) => {
      const date = new Date(`${c.day}T00:00:00Z`);
      const slots = c.slots ? c.slots.split(",").map(Number) : [];
      const reason = c.reason ? `\n${escape(c.reason)}` : "";
      const who = c.teacher
        ? ` · ${escape(c.teacher)}: ${escape(c.subject)}${c.subgroup ? ` (гр. ${c.subgroup})` : ""}`
        : "";
      return `№${c.id} · ${escape(targetLabel(c.grp))} · ${dateLabel(date)} · ${slotsLabel(slots)}${who}${reason}`;
    });
    return [CANCEL_HELP, "", list.length ? list.join("\n\n") : "Отменённых пар впереди нет."].join("\n");
  }

  const words = body.split(/\s+/);
  if (TEACHER_WORDS.has(words[0].toLowerCase())) return cancelByTeacher(env, words.slice(1));
  // «/cancel 3курс преп Шестова ср» — преподаватель, но только у этих групп.
  if (words[1] && TEACHER_WORDS.has(words[1].toLowerCase())) {
    return cancelByTeacher(env, words.slice(2), words[0]);
  }
  const [target, dayWord, slotWord] = words;
  if (!dayWord) return `Не хватает дня.\n\n${CANCEL_HELP}`;

  const date = parseDay(dayWord);
  if (!date) return `Не понял день «${escape(dayWord)}». Пишите 14.09, завтра или чт.`;
  if (date < today()) return "Эта дата уже прошла.";
  if (date.getUTCDay() === 0) return `${dateLabel(date)} — пар нет.`;

  let slots = [];
  let rest = words.slice(2);
  if (slotWord && SLOT_LIST.test(slotWord)) {
    slots = parseSlots(slotWord);
    rest = words.slice(3);
    if (slots.some((n) => n < 1 || n > 7)) return "Номера пар — от 1 до 7.";
  }
  const reason = rest.join(" ");
  if (reason.length > 200) return "Причина слишком длинная: до 200 знаков.";

  const resolved = await resolveTargets(target);
  if (resolved.error) return resolved.error;

  const stamp = new Date().toISOString();
  const created = await env.STATS.batch(
    resolved.ids.map((grp) =>
      env.STATS.prepare(
        "INSERT INTO cancels (grp, day, slots, reason, created) VALUES (?, ?, ?, ?, ?) RETURNING id"
      ).bind(grp, iso(date), slots.join(","), reason, stamp)
    )
  );
  const numbers = created.map((r) => r.results[0].id);
  return [
    `Отменено: ${escape(resolved.ids.map(targetLabel).join(", "))} · ${dateLabel(date)} · ${slotsLabel(slots)}${reason ? ` · ${escape(reason)}` : ""}.`,
    "В приложении и в расписании в чатах пара уже зачёркнута.",
    `Вернуть: ${numbers.map((n) => `/uncancel ${n}`).join(", ")}`,
  ].join("\n");
}

/**
 * Отмена из приложения: только владельцу. action cancel — отменить предмет
 * в этих парах у группы или всего её курса; restore — вернуть по номерам.
 */
async function appCancel(env, body) {
  const user = await verifyInitData(body.initData || "", env.BOT_TOKEN);
  if (!user || !isOwner(env, user.id)) return { ok: false, error: "forbidden" };
  if (body.action === "restore") {
    const ids = (body.ids || []).map(Number).filter(Boolean).slice(0, 20);
    if (!ids.length) return { ok: false, error: "no ids" };
    await env.STATS.batch(
      ids.map((id) => env.STATS.prepare("UPDATE cancels SET removed = 1 WHERE id = ?").bind(id))
    );
    return { ok: true };
  }
  const day = String(body.day || "");
  const slots = (body.slots || []).map(Number).filter((n) => n >= 1 && n <= 7);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !slots.length || !body.group) return { ok: false, error: "bad lesson" };
  const grp =
    body.scope === "course" && body.level && body.course ? courseKey(body.level, Number(body.course)) : String(body.group);
  await env.STATS.prepare(
    `INSERT INTO cancels (grp, day, slots, reason, created, subject, subgroup, teacher)
     VALUES (?, ?, ?, ?, ?, ?, 0, '')`
  )
    .bind(grp, day, slots.join(","), String(body.reason || "").slice(0, 200), new Date().toISOString(), String(body.subject || ""))
    .run();
  return { ok: true };
}

/* ---------- Запрет открывать расписание ---------- */

const DAY_MS = 24 * 60 * 60 * 1000;

const BLOCK_HELP = [
  "<b>Запрет открывать расписание</b> — у человека вместо пар экран с блокировкой.",
  "",
  "/block @ivanov 3 Спам в комментариях — на 3 дня",
  "/block 1144406244 — навсегда, по id",
  "/block 311гэу 1 — всей группе на день",
  "/block 3курс — всему курсу; ещё бывает маг1 и «все»",
  "/unblock @ivanov, /unblock 311гэу — снять",
  "/blocks — список",
].join("\n");

/**
 * Действует ли запрет — на человека или на всю его группу или курс.
 * Возвращает { until, reason } или null.
 */
async function appBan(env, userId, group = null) {
  if (!env.STATS) return null;
  const now = new Date().toISOString();
  if (userId) {
    const row = await env.STATS.prepare("SELECT reason, until FROM app_bans WHERE tg_id = ?")
      .bind(userId)
      .first();
    if (row && (!row.until || row.until > now)) return { until: row.until || null, reason: row.reason || "" };
  }
  if (group?.id) {
    const row = await env.STATS.prepare(
      `SELECT reason, until FROM app_group_bans
       WHERE grp IN (?, ?, '*') AND (until IS NULL OR until > ?) ORDER BY created DESC LIMIT 1`
    )
      .bind(group.id, courseOf(group), now)
      .first();
    if (row) return { until: row.until || null, reason: row.reason || "" };
  }
  return null;
}

async function blockCommand(env, text) {
  const [, who, ...rest] = glueCourse(String(text).trim()).split(/\s+/);
  if (!who) return BLOCK_HELP;
  // Группа, курс или «все» — ключи те же, что у объявлений.
  if (!who.startsWith("@") && !/^\d{5,}$/.test(who)) return blockGroups(env, who, rest);
  const person = await findPerson(env, who);
  if (!person?.tg_id) return `Не нашёл ${escape(who)}. Человек должен хоть раз открыть расписание.`;
  if (isOwner(env, person.tg_id)) return "Себя заблокировать нельзя.";

  let days = null;
  if (rest[0] && /^\d{1,4}$/.test(rest[0])) days = Number(rest.shift());
  const reason = rest.join(" ").slice(0, 200);
  const until = days ? new Date(Date.now() + days * DAY_MS).toISOString() : null;
  await env.STATS.prepare(
    `INSERT INTO app_bans (tg_id, name, username, reason, created, until) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(tg_id) DO UPDATE SET name = excluded.name, username = excluded.username,
       reason = excluded.reason, created = excluded.created, until = excluded.until`
  )
    .bind(person.tg_id, person.name || null, person.username || null, reason, new Date().toISOString(), until)
    .run();
  return [
    `⛔ ${escape(person.name || `id ${person.tg_id}`)} — расписание закрыто ${until ? `на ${days} дн.` : "навсегда"}.`,
    reason ? `Причина: ${escape(reason)}` : null,
    `Снять: /unblock ${person.username ? `@${escape(person.username)}` : person.tg_id}`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** /block 311гэу 3 причина — закрывает расписание всей группе или курсу. */
async function blockGroups(env, target, rest) {
  const resolved = await resolveTargets(target);
  if (resolved.error) return resolved.error;
  let days = null;
  if (rest[0] && /^\d{1,4}$/.test(rest[0])) days = Number(rest.shift());
  const reason = rest.join(" ").slice(0, 200);
  const until = days ? new Date(Date.now() + days * DAY_MS).toISOString() : null;
  const now = new Date().toISOString();
  await env.STATS.batch(
    resolved.ids.map((grp) =>
      env.STATS.prepare(
        `INSERT INTO app_group_bans (grp, reason, created, until) VALUES (?, ?, ?, ?)
         ON CONFLICT(grp) DO UPDATE SET reason = excluded.reason, created = excluded.created, until = excluded.until`
      ).bind(grp, reason, now, until)
    )
  );
  return [
    `⛔ ${escape(resolved.ids.map(targetLabel).join(", "))} — расписание закрыто ${until ? `на ${days} дн.` : "навсегда"}.`,
    reason ? `Причина: ${escape(reason)}` : null,
    `Снять: /unblock ${escape(target)}`,
  ]
    .filter(Boolean)
    .join("\n");
}

async function unblockCommand(env, text) {
  const who = glueCourse(String(text).trim()).split(/\s+/)[1];
  if (!who) return "Укажите кого: /unblock @ivanov. Список — /blocks";
  if (!who.startsWith("@") && !/^\d{5,}$/.test(who)) {
    const resolved = await resolveTargets(who);
    if (resolved.error) return resolved.error;
    const done = await env.STATS.batch(
      resolved.ids.map((grp) => env.STATS.prepare("DELETE FROM app_group_bans WHERE grp = ?").bind(grp))
    );
    const removed = done.reduce((sum, r) => sum + (r.meta?.changes || 0), 0);
    return removed ? `Расписание снова открыто: ${escape(resolved.ids.map(targetLabel).join(", "))}.` : "Эти группы не заблокированы.";
  }
  const person = await findPerson(env, who);
  if (!person?.tg_id) return `Не нашёл ${escape(who)}.`;
  const result = await env.STATS.prepare("DELETE FROM app_bans WHERE tg_id = ?").bind(person.tg_id).run();
  return result.meta?.changes
    ? `${escape(person.name || `id ${person.tg_id}`)} снова может открывать расписание.`
    : "Этот человек не заблокирован.";
}

async function blocksList(env) {
  const { results = [] } = await env.STATS.prepare(
    `SELECT tg_id, name, username, reason, until FROM app_bans
     WHERE until IS NULL OR until > ? ORDER BY created DESC LIMIT 60`
  )
    .bind(new Date().toISOString())
    .all();
  const { results: groups = [] } = await env.STATS.prepare(
    `SELECT grp, reason, until FROM app_group_bans
     WHERE until IS NULL OR until > ? ORDER BY created DESC LIMIT 60`
  )
    .bind(new Date().toISOString())
    .all();
  if (!results.length && !groups.length) return `${BLOCK_HELP}\n\nЗаблокированных нет.`;
  const list = results.map(
    (b) =>
      `⛔ ${escape(b.name || `id ${b.tg_id}`)}${b.username ? ` @${escape(b.username)}` : ""} · id ${b.tg_id} · ${b.until ? `до ${b.until.slice(0, 10)}` : "навсегда"}${b.reason ? ` · ${escape(b.reason)}` : ""}`
  );
  const groupList = groups.map(
    (b) => `⛔ ${escape(targetLabel(b.grp))} · ${b.until ? `до ${b.until.slice(0, 10)}` : "навсегда"}${b.reason ? ` · ${escape(b.reason)}` : ""}`
  );
  return [BLOCK_HELP, "", ...groupList, ...list].join("\n");
}

/* ---------- Замены на дату ---------- */

const CHANGE_HELP = [
  "<b>Замены</b> — меняют пару на одну дату в приложении и в расписании в чатах.",
  "",
  "/change 3курс преп Пфандер 22.09 3 на Батурина В.Н. — другой преподаватель",
  "/change 3курс преп Пфандер 27.09 3-4 с 12:00 — сдвиг времени (обе пары)",
  "/change 311гэу 22.09 3 ауд 614 — другая аудитория",
  "/unchange 7 — убрать замену, /unchange 7,8 — несколько",
  "",
  "Порядок: кому, [преп Фамилия — чью пару], день, номера пар, что меняем. Можно совместить: «на Батурина В.Н. с 12:00 ауд 614». Остальные слова — пометка на карточке.",
].join("\n");

async function handleChange(env, text) {
  const body = glueCourse(text.replace(/^\/change(@\w+)?/, "").trim());
  if (!body) {
    const { results = [] } = await env.STATS.prepare(
      `SELECT * FROM changes WHERE removed = 0 AND day >= ? ORDER BY day, id LIMIT 30`
    )
      .bind(iso(today()))
      .all();
    const list = results.map((c) => `№${c.id} · ${escape(targetLabel(c.grp))} · ${dateLabel(new Date(`${c.day}T00:00:00Z`))} · ${slotsLabel(c.slots.split(",").map(Number))}${c.from_teacher ? ` · ${escape(c.from_teacher)}` : ""} → ${escape(changeLabel(c))}`);
    return [CHANGE_HELP, "", list.length ? list.join("\n") : "Замен впереди нет."].join("\n");
  }

  const words = body.split(/\s+/);
  const target = words.shift();
  let fromTeacher = "";
  if (words[0] && TEACHER_WORDS.has(words[0].toLowerCase())) {
    words.shift();
    fromTeacher = (words.shift() || "").replace(/ё/g, "е").replace(/Ё/g, "Е");
    if (words[0] && /^[А-ЯЁ]\.\s*[А-ЯЁ]?\.?$/.test(words[0])) words.shift();
  }
  const date = parseDay(words.shift() || "");
  if (!date) return `Не понял день.\n\n${CHANGE_HELP}`;
  if (date < today()) return "Эта дата уже прошла.";
  if (!words[0] || !SLOT_LIST.test(words[0])) return `Нужны номера пар.\n\n${CHANGE_HELP}`;
  const slots = parseSlots(words.shift());
  if (slots.some((n) => n < 1 || n > 7)) return "Номера пар — от 1 до 7.";

  const change = { teacher: "", room: "", start: "" };
  const note = [];
  const KEYS = new Set(["на", "с", "ауд"]);
  while (words.length) {
    const word = words.shift();
    const key = word.toLowerCase();
    if (key === "с" && /^\d{1,2}[:.]\d{2}$/.test(words[0] || "")) {
      const [h, m] = words.shift().split(/[:.]/);
      change.start = `${h.padStart(2, "0")}:${m}`;
    } else if (key === "ауд" && words[0]) {
      change.room = words.shift();
    } else if (key === "на" && words[0]) {
      const name = [];
      while (words.length && !KEYS.has(words[0].toLowerCase()) && name.length < 3) name.push(words.shift());
      change.teacher = name.join(" ");
    } else {
      note.push(word);
    }
  }
  if (!change.teacher && !change.room && !change.start) return `Что меняем? «на Фамилия», «с 12:00» или «ауд 614».\n\n${CHANGE_HELP}`;
  const reason = note.join(" ") || (change.teacher ? "Замена преподавателя" : change.start ? "Перенос времени" : "Другая аудитория");
  if (reason.length > 200) return "Пометка слишком длинная: до 200 знаков.";

  const resolved = await resolveTargets(target);
  if (resolved.error) return resolved.error;

  const stamp = new Date().toISOString();
  const created = await env.STATS.batch(
    resolved.ids.map((grp) =>
      env.STATS.prepare(
        `INSERT INTO changes (grp, day, slots, from_teacher, teacher, room, start, reason, created)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
      ).bind(grp, iso(date), slots.join(","), fromTeacher, change.teacher, change.room, change.start, reason, stamp)
    )
  );
  const numbers = created.map((r) => r.results[0].id);
  return [
    `Замена: ${escape(resolved.ids.map(targetLabel).join(", "))} · ${dateLabel(date)} · ${slotsLabel(slots)}${fromTeacher ? ` · пары ${escape(fromTeacher)}` : ""} → ${escape(changeLabel(change))} · «${escape(reason)}».`,
    `Убрать: /unchange ${numbers.join(",")}`,
  ].join("\n");
}

function changeLabel(c) {
  return [c.teacher && `ведёт ${c.teacher}`, c.start && `с ${c.start}`, c.room && `ауд. ${c.room}`].filter(Boolean).join(", ");
}

async function handleUnchange(env, text) {
  const ids = [...new Set(text.replace(/^\/unchange(@\w+)?/, "").split(/[\s,]+/).map(Number).filter(Boolean))];
  if (!ids.length) return "Укажите номер: /unchange 7. Список — /change";
  const done = await env.STATS.batch(
    ids.map((id) => env.STATS.prepare("UPDATE changes SET removed = 1 WHERE id = ? AND removed = 0").bind(id))
  );
  const removed = done.reduce((sum, r) => sum + (r.meta?.changes || 0), 0);
  return removed ? `Убрано замен: ${removed}.` : "Таких действующих замен нет.";
}

/* ---------- Отмена по преподавателю ---------- */

const TEACHER_WORDS = new Set(["преп", "препод", "преподаватель", "преподавателя"]);
const WEEK_CODES = { odd: 1, even: 2 };

/** «Шестова» и «шестова», «Королёва» и «Королева» — одно и то же. */
const nameKey = (text) => String(text).toLowerCase().replace(/ё/g, "е").replace(/[.\s]/g, "");

/**
 * /cancel преп Шестова [Т.Л.] 14.09 [3-4] [причина] — находит по указателю
 * все пары преподавателя в этот день и отменяет именно их: предмет и
 * подгруппу, а не всю пару группы.
 */
async function cancelByTeacher(env, words, target = null) {
  // Адресат перед «преп» — группы и курсы, как в /notice. Разбираем до
  // указателя: на опечатку в группе ответ нужен раньше, чем поиск фамилии.
  let allowed = null;
  if (target) {
    const resolved = await resolveTargets(target);
    if (resolved.error) return resolved.error;
    if (!resolved.ids.includes("*")) {
      const groups = await loadGroups();
      allowed = new Set(
        groups
          .filter((g) => resolved.ids.includes(g.id) || resolved.ids.includes(courseKey(g.level, g.course)))
          .map((g) => g.id)
      );
    }
  }
  const whom = target && allowed ? ` у ${escape(glueCourse(target))}` : "";

  const dayAt = words.findIndex((word, i) => i > 0 && parseDay(word));
  if (!words.length || dayAt < 1) {
    return `Нужны фамилия и день: /cancel преп Шестова 14.09 Заболела\n\n${CANCEL_HELP}`;
  }
  const nameWords = words.slice(0, dayAt);
  const date = parseDay(words[dayAt]);
  if (date < today()) return "Эта дата уже прошла.";
  if (date.getUTCDay() === 0) return `${dateLabel(date)} — пар нет.`;

  let rest = words.slice(dayAt + 1);
  let slots = [];
  if (rest[0] && SLOT_LIST.test(rest[0])) {
    slots = parseSlots(rest[0]);
    if (slots.some((n) => n < 1 || n > 7)) return "Номера пар — от 1 до 7.";
    rest = rest.slice(1);
  }
  const reason = rest.join(" ");
  if (reason.length > 200) return "Причина слишком длинная: до 200 знаков.";

  let index;
  try {
    const response = await fetch(`${WEB_APP_URL}data/teachers.json`, {
      cf: { cacheTtl: 300, cacheEverything: true },
    });
    if (!response.ok) throw new Error(response.status);
    index = await response.json();
  } catch {
    return "Не удалось загрузить список преподавателей. Попробуйте позже.";
  }

  // Фамилия — первое слово, остальное — инициалы, если указаны.
  const surname = nameKey(nameWords[0]);
  const initials = nameKey(nameWords.slice(1).join(""));
  const people = index.teachers.map((name, i) => {
    const [last, ...tail] = name.split(" ");
    return { i, name, last: nameKey(last), initials: nameKey(tail.join("")) };
  });
  let found = people.filter((p) => p.last === surname);
  // Точной нет — по началу фамилии, но не по двум буквам.
  if (!found.length && surname.length >= 4) found = people.filter((p) => p.last.startsWith(surname));
  if (initials) found = found.filter((p) => p.initials.startsWith(initials));

  const typed = escape(nameWords.join(" "));
  if (!found.length) return `Не нашёл преподавателя «${typed}» в расписании.`;
  if (found.length > 1) {
    const names = found.map((p) => p.name).join(", ");
    return `Под «${typed}» подходят: ${escape(names)}\nУточните инициалы, например: /cancel преп ${escape(found[0].name)} ${words[dayAt]}`;
  }
  const teacher = found[0];

  const parity = parityOf(index.weeks, date);
  const lessons = index.lessons.filter(
    ([t, , day, slot, week]) =>
      t === teacher.i &&
      day === date.getUTCDay() &&
      (week === 0 || parity === null || week === WEEK_CODES[parity]) &&
      (!slots.length || slots.includes(slot))
  );
  const scoped = allowed ? lessons.filter(([, g]) => allowed.has(index.groups[g])) : lessons;
  const when = `${dateLabel(date)}${slots.length ? `, ${slotsLabel(slots)}` : ""}`;
  if (!lessons.length) return `У ${escape(teacher.name)} ${when} пар по расписанию нет.`;
  if (!scoped.length) {
    // Пары у него есть, но у других — подскажем у каких, чтобы не гадать.
    const elsewhere = [...new Set(lessons.map(([, g]) => index.groups[g]))].join(", ");
    return `У ${escape(teacher.name)} ${when}${whom} пар нет. В этот день пары у групп: ${escape(elsewhere)}.`;
  }

  // Одна запись на группу, предмет и подгруппу — со всеми парами дня.
  const groups = new Map();
  for (const [, g, , slot, , s, subgroup] of scoped) {
    const key = `${g}|${s}|${subgroup}`;
    if (!groups.has(key)) {
      groups.set(key, { grp: index.groups[g], subject: index.subjects[s], subgroup, slots: [] });
    }
    groups.get(key).slots.push(slot);
  }
  const items = [...groups.values()].sort((a, b) => a.grp.localeCompare(b.grp, "ru", { numeric: true }));

  const stamp = new Date().toISOString();
  const created = await env.STATS.batch(
    items.map((item) =>
      env.STATS.prepare(
        `INSERT INTO cancels (grp, day, slots, reason, created, subject, subgroup, teacher)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
      ).bind(
        item.grp,
        iso(date),
        [...new Set(item.slots)].sort((a, b) => a - b).join(","),
        reason,
        stamp,
        item.subject,
        item.subgroup,
        teacher.name
      )
    )
  );
  const numbers = created.map((r) => r.results[0].id);

  const lines = items.map((item) => {
    const pairs = slotsLabel([...new Set(item.slots)].sort((a, b) => a - b));
    const sub = item.subgroup ? ` (гр. ${item.subgroup})` : "";
    return `• ${escape(item.grp)} — ${escape(item.subject)}${sub} · ${pairs}`;
  });
  return [
    `Отменены пары ${escape(teacher.name)}${whom} · ${dateLabel(date)}${reason ? ` · ${escape(reason)}` : ""}:`,
    ...lines,
    "",
    "В приложении и в расписании в чатах они уже зачёркнуты.",
    `${numbers.length > 1 ? "Вернуть все" : "Вернуть"}: /uncancel ${numbers.join(",")}`,
  ].join("\n");
}

async function handleUncancel(env, text) {
  // Номера через запятую или пробел: отмена по преподавателю даёт несколько.
  const ids = [...new Set(text.replace(/^\/uncancel(@\w+)?/, "").split(/[\s,]+/).map(Number).filter(Boolean))];
  if (!ids.length) return "Укажите номер: /uncancel 7 или /uncancel 7,8,9. Список — /cancel";
  if (ids.length > 50) return "За раз — не больше 50 номеров.";

  const results = await env.STATS.batch(
    ids.map((id) => env.STATS.prepare("UPDATE cancels SET removed = 1 WHERE id = ? AND removed = 0").bind(id))
  );
  const done = ids.filter((_, i) => results[i].meta?.changes);
  const missing = ids.filter((id) => !done.includes(id));
  if (ids.length === 1) {
    return done.length ? `Отмена №${ids[0]} снята — пара снова в расписании.` : `Действующей отмены №${ids[0]} нет.`;
  }
  const lines = [];
  if (done.length) lines.push(`Сняты отмены: ${done.map((n) => `№${n}`).join(", ")} — пары снова в расписании.`);
  if (missing.length) lines.push(`Не было действующих: ${missing.map((n) => `№${n}`).join(", ")}.`);
  return lines.join("\n");
}

/** `/notice` без текста — список действующих; с текстом — новое объявление. */
async function handleNotice(env, text) {
  const body = glueCourse(text.replace(/^\/notice(@\w+)?/, "").trim());
  const now = new Date();

  if (!body) {
    const { results = [] } = await env.STATS.prepare(
      "SELECT id, grp, text, expires, color FROM notices WHERE expires > ? ORDER BY id DESC LIMIT 30"
    )
      .bind(now.toISOString())
      .all();
    const people = await peopleLabels(env, results.map((n) => n.grp));
    const list = results.map(
      (n) =>
        `${COLOR_DOT[n.color] || COLOR_DOT.yellow} №${n.id} · ${escape(targetLabel(n.grp, people))} · до ${n.expires.slice(5, 10)}\n${escape(n.text)}`
    );
    return [NOTICE_HELP, "", list.length ? list.join("\n\n") : "Действующих объявлений нет."].join("\n");
  }

  const [target] = body.split(/\s+/);
  let message = body.slice(target.length).trim();
  let color = "yellow";
  const colorWord = (message.split(/\s+/)[0] || "").toLowerCase();
  if (NOTICE_COLORS.has(colorWord)) {
    color = NOTICE_COLORS.get(colorWord);
    message = message.slice(colorWord.length).trim();
  } else if (colorWord.startsWith("#")) {
    return `Не знаю цвет «${escape(colorWord)}». Цвета: #жёлтый, #красный, #зелёный, #синий, #серый.`;
  }
  if (!message) return `Не хватает текста.\n\n${NOTICE_HELP}`;
  if (message.length > 500) return "Слишком длинно: до 500 знаков.";

  const resolved = await resolveTargets(target, env);
  if (resolved.error) return resolved.error;
  const { ids } = resolved;

  const expires = new Date(now.getTime() + NOTICE_DAYS * 86400000);
  const created = await env.STATS.batch(
    ids.map((grp) =>
      env.STATS.prepare(
        "INSERT INTO notices (grp, text, created, expires, color) VALUES (?, ?, ?, ?, ?) RETURNING id"
      ).bind(grp, message, now.toISOString(), expires.toISOString(), color)
    )
  );
  const numbers = created.map((r) => r.results[0].id);
  const people = await peopleLabels(env, ids);
  const whom = ids.map((id) => targetLabel(id, people)).join(", ");
  const onlyPeople = ids.every((id) => id.startsWith("user:"));
  return [
    `${COLOR_DOT[color]} Готово: объявление для ${escape(whom)}, висит до ${expires.toISOString().slice(0, 10)}.`,
    onlyPeople
      ? "Появится у человека при следующем открытии приложения. В расписание для чатов личные объявления не попадают."
      : "Появится у студентов при следующем открытии приложения и в расписании в чатах.",
    `Снять: ${numbers.map((n) => `/unnotice ${n}`).join(", ")}`,
  ].join("\n");
}

function targetLabel(grp, people = new Map()) {
  if (grp === "*") return "всех групп";
  if (grp.startsWith("user:")) return people.get(grp) || `id ${grp.slice(5)}`;
  return grp.startsWith("курс:") ? courseLabel(grp) : grp;
}

/** «user:123» → «@ivanov» или имя — для ответов владельцу. */
async function peopleLabels(env, keys) {
  const ids = [...new Set(keys.filter((k) => k.startsWith("user:")).map((k) => k.slice(5)))];
  const labels = new Map();
  for (const id of ids) {
    const person = await findPerson(env, id);
    labels.set(`user:${id}`, person?.username ? `@${person.username}` : person?.name || `id ${id}`);
  }
  return labels;
}

async function handleUnnotice(env, text) {
  const arg = (text.split(/\s+/)[1] || "").toLowerCase();
  if (["все", "всё", "all"].includes(arg)) {
    const now = new Date().toISOString();
    const result = await env.STATS.prepare("UPDATE notices SET expires = ? WHERE expires > ?")
      .bind(now, now)
      .run();
    const count = result.meta?.changes || 0;
    return count ? `Сняты все объявления: ${count}.` : "Действующих объявлений нет.";
  }

  const id = Number(arg);
  if (!id) return "Укажите номер: /unnotice 12. Список — /notice";
  const result = await env.STATS.prepare(
    "UPDATE notices SET expires = ? WHERE id = ? AND expires > ?"
  )
    .bind(new Date().toISOString(), id, new Date().toISOString())
    .run();
  return result.meta?.changes ? `Объявление №${id} снято.` : `Действующего объявления №${id} нет.`;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Приложение спрашивает объявления своей группы. Сайт на другом адресе,
    // поэтому разрешаем чтение отовсюду: здесь только публичные тексты.
    // GET — от старых версий приложения, которые Telegram ещё держит в кэше.
    // POST — с подписью Telegram в теле: по ней понимаем, староста ли это.
    // В адрес подпись не кладём — адреса оседают в журналах.
    if (url.pathname === "/notices" && (request.method === "GET" || request.method === "POST")) {
      let source = url.searchParams;
      let initData = "";
      if (request.method === "POST") {
        try {
          const body = JSON.parse(await request.text());
          source = new Map(Object.entries(body).map(([k, v]) => [k, v == null ? null : String(v)]));
          initData = body.initData || "";
        } catch {
          source = new Map();
        }
      }
      const group = {
        id: source.get("group"),
        level: source.get("level"),
        course: Number(source.get("course")) || null,
      };
      // Без объявлений, отмен и домашки расписание всё равно должно открыться.
      const range = homeworkRange(source.get("from"), source.get("to"));
      const user = initData ? await verifyInitData(initData, env.BOT_TOKEN).catch(() => null) : null;
      const ban = await appBan(env, user?.id || null, group).catch(() => null);
      if (ban) {
        return new Response(JSON.stringify({ ban }), {
          headers: {
            "content-type": "application/json; charset=utf-8",
            "access-control-allow-origin": "*",
            "cache-control": "no-store",
          },
        });
      }
      const [notices, cancels, changes, homework, canEdit, commenter] = await Promise.all([
        activeNotices(env, group, user?.id).catch(() => []),
        activeCancels(env, group).catch(() => []),
        activeChanges(env, group).catch(() => []),
        groupHomework(env, group.id, range).catch(() => []),
        user ? canEditHomework(env, initData, group.id).catch(() => false) : false,
        user ? canComment(env, user, group.id).catch(() => false) : false,
      ]);
      // Счётчики комментариев — только своей группе: чужим они ни к чему.
      const comments = commenter ? await commentCounts(env, group.id, range).catch(() => []) : [];
      const payload = { notices, cancels, changes, owner: Boolean(user && isOwner(env, user.id)), homework, canEdit, canComment: commenter, comments };
      return new Response(JSON.stringify(payload), {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "access-control-allow-origin": "*",
          // Ответ с правами старосты — личный, общий кэш его не должен хранить.
          "cache-control": request.method === "GET" ? "public, max-age=60" : "no-store",
        },
      });
    }

    // Домашка другой недели — когда её пролистали. Читать может любой:
    // домашку и так видит вся группа, подпись здесь не нужна.
    if (url.pathname === "/homework/list" && request.method === "POST") {
      let homework = [];
      let comments = [];
      try {
        const body = JSON.parse(await request.text());
        const groupId = String(body.group || "");
        const range = homeworkRange(body.from, body.to);
        homework = await groupHomework(env, groupId, range);
        // Счётчики комментариев следующей недели — тем же запросом, своей группе.
        const user = body.initData ? await verifyInitData(body.initData, env.BOT_TOKEN) : null;
        if (user && (await canComment(env, user, groupId))) {
          comments = await commentCounts(env, groupId, range);
        }
      } catch {
        // Не догрузилось — пары всё равно на месте, просто без домашки.
      }
      return new Response(JSON.stringify({ homework, comments }), {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "access-control-allow-origin": "*",
          "cache-control": "no-store",
        },
      });
    }

    // Комментарии к парам: список, новый, удалить, пожаловаться.
    const commentAction = url.pathname.match(/^\/comments\/(list|add|delete|report)$/)?.[1];
    if (commentAction && request.method === "POST") {
      let result;
      try {
        const body = JSON.parse(await request.text());
        const user = await verifyInitData(body.initData || "", env.BOT_TOKEN);
        const notify = (text, keyboard) =>
          callTelegram(env.BOT_TOKEN, "sendMessage", {
            chat_id: env.OWNER_ID,
            text,
            parse_mode: "HTML",
            reply_markup: { inline_keyboard: keyboard },
          });
        result = await commentsApi(env, commentAction, body, user, notify);
      } catch {
        result = { status: 400, json: { ok: false, error: "bad request" } };
      }
      return new Response(JSON.stringify(result.json), {
        status: result.status,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "access-control-allow-origin": "*",
          "cache-control": "no-store",
        },
      });
    }

    // Староста вносит, меняет или удаляет домашку своей группы.
    // Отмена пары владельцем прямо из приложения — без команды /cancel.
    if (url.pathname === "/cancel" && request.method === "POST") {
      let result;
      try {
        result = await appCancel(env, JSON.parse(await request.text()));
      } catch {
        result = { ok: false, error: "bad request" };
      }
      return new Response(JSON.stringify(result), {
        status: result.ok ? 200 : 400,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "access-control-allow-origin": "*",
          "cache-control": "no-store",
        },
      });
    }

    if (url.pathname === "/homework" && request.method === "POST") {
      let result;
      try {
        result = await saveHomework(env, JSON.parse(await request.text()));
      } catch {
        result = { ok: false, error: "bad request" };
      }
      return new Response(JSON.stringify(result), {
        status: result.ok ? 200 : 400,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "access-control-allow-origin": "*",
          "cache-control": "no-store",
        },
      });
    }

    // Мини-приложение сообщает, что его открыли.
    if (url.pathname === "/hit" && request.method === "POST") {
      try {
        const body = JSON.parse(await request.text());
        const user = await verifyInitData(body.initData || "", env.BOT_TOKEN);
        if (user) await recordOpen(env, user, body.group || {});
      } catch {
        // Счётчик не должен ронять ничего и никого.
      }
      return new Response("ok");
    }

    // Адрес воркера публичный, поэтому проверяем секрет из заголовка:
    // без него кто угодно мог бы слать боту поддельные апдейты.
    if (request.method !== "POST") return new Response("ok");
    if (
      request.headers.get("X-Telegram-Bot-Api-Secret-Token") !==
      env.WEBHOOK_SECRET
    ) {
      return new Response("forbidden", { status: 403 });
    }

    let update;
    try {
      update = await request.json();
    } catch {
      return new Response("ok");
    }

    // «Удалить все его комментарии» под ответом на /ban.
    const purge = update.callback_query?.data?.match(/^cmpurge:(\d+)$/);
    if (purge) {
      const query = update.callback_query;
      const owner = isOwner(env, query.from?.id);
      const removed = owner ? await purgeAuthor(env, Number(purge[1])) : 0;
      await callTelegram(env.BOT_TOKEN, "answerCallbackQuery", {
        callback_query_id: query.id,
        text: owner ? `Удалено: ${removed}` : "Недоступно",
      });
      if (owner && query.message) {
        await callTelegram(env.BOT_TOKEN, "editMessageReplyMarkup", {
          chat_id: query.message.chat.id,
          message_id: query.message.message_id,
          reply_markup: { inline_keyboard: [] },
        });
      }
      return new Response("ok");
    }

    // «Вернуть» / «Удалить» под уведомлением о скрытом жалобами комментарии.
    const moderation = update.callback_query?.data?.match(/^(cmr|cmd):(\d+)$/);
    if (moderation) {
      const query = update.callback_query;
      const owner = isOwner(env, query.from?.id);
      const answer = owner ? await moderateComment(env, moderation[1], Number(moderation[2])) : "Недоступно";
      await callTelegram(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: query.id, text: answer });
      if (owner && query.message) {
        await callTelegram(env.BOT_TOKEN, "editMessageReplyMarkup", {
          chat_id: query.message.chat.id,
          message_id: query.message.message_id,
          reply_markup: { inline_keyboard: [] },
        });
      }
      return new Response("ok");
    }

    // «📢 Сообщить студентам» под отчётом об обновлении расписания.
    if (update.callback_query?.data === "upd") {
      const query = update.callback_query;
      const owner = isOwner(env, query.from?.id);
      await callTelegram(env.BOT_TOKEN, "answerCallbackQuery", {
        callback_query_id: query.id,
        text: owner ? "Черновик рассылки ниже" : "Недоступно",
      });
      if (owner && query.message) {
        // Кнопку убираем, чтобы второй черновик не сделать случайно.
        await callTelegram(env.BOT_TOKEN, "editMessageReplyMarkup", {
          chat_id: query.message.chat.id,
          message_id: query.message.message_id,
          reply_markup: { inline_keyboard: [] },
        });
        await draftBroadcast(env, query.message.chat.id, await updatedText(""), { button: true });
      }
      return new Response("ok");
    }

    if (update.callback_query) {
      await handleButton(env, update.callback_query);
      return new Response("ok");
    }

    // «@FGPshedulebot 311гэу завтра» в любом чате.
    if (update.inline_query) {
      try {
        const payload = await answerInline(update.inline_query, {
          groupOf: (id) => groupOfUser(env, id).catch(() => null),
          notices: (group) => activeNotices(env, group).catch(() => []),
          // Замены едут вместе с отменами: так их не надо протаскивать
          // отдельным параметром через все виды карточек.
          cancels: async (group) => {
            const [list, changes] = await Promise.all([
              activeCancels(env, group).catch(() => []),
              activeChanges(env, group).catch(() => []),
            ]);
            list.changes = changes;
            return list;
          },
        });
        const response = await callTelegram(env.BOT_TOKEN, "answerInlineQuery", payload);
        // Telegram отвергает ответ целиком из-за одной ошибки в разметке —
        // без записи в журнал это выглядит как «бот молчит».
        if (!response.ok) console.log("inline rejected", await response.text());
      } catch (error) {
        console.log("inline failed", String(error?.stack || error));
      }
      return new Response("ok");
    }

    const message = update.message;
    const text = message?.text ?? "";

    // Запоминаем, кому потом можно написать. Telegram список пользователей
    // не отдаёт, так что кроме этой записи взять его неоткуда. Лежит в базе,
    // а не в KV: там всего тысяча записей в сутки, и в день массовой раздачи
    // ссылки лишние молча не попали бы в список.
    if (message?.chat?.id && env.STATS) {
      const stamp = new Date().toISOString();
      await env.STATS.prepare(
        `INSERT INTO users (id, name, username, first, last)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name, username = excluded.username,
           last = excluded.last`
      )
        .bind(
          message.chat.id,
          [message.chat.first_name, message.chat.last_name]
            .filter(Boolean)
            .join(" ") || null,
          message.chat.username || null,
          stamp,
          stamp
        )
        .run();
    }

    // Отвечаем только на команды; на всё остальное молчим, но подтверждаем
    // приём — иначе Telegram будет слать этот апдейт снова и снова.
    if (message && text.startsWith("/start")) {
      // Китайский и корейский — сами по языку Telegram. Английский только
      // подсказкой: многие русские студенты держат Telegram на английском.
      const code = String(message.from?.language_code || "").toLowerCase();
      const zh = code.startsWith("zh");
      const ko = code.startsWith("ko");
      const greeting = zh
        ? "打开课表 👇\n语言可在“设置”中切换。"
        : ko
          ? "시간표 열기 👇\n언어는 “설정”에서 바꿀 수 있습니다."
          : code.startsWith("en")
            ? "Открывай расписание 👇\n\nOpen the schedule 👇 English: Настройки → Language."
            : "Открывай расписание 👇";
      await callTelegram(env.BOT_TOKEN, "sendMessage", {
        chat_id: message.chat.id,
        text: greeting,
        reply_markup: {
          inline_keyboard: [
            [{ text: zh ? "📅 打开课表" : ko ? "📅 시간표 열기" : "📅 Открыть расписание", web_app: { url: WEB_APP_URL } }],
          ],
        },
      });
    }

    // Присланный PDF обновляет расписание. Только от владельца: иначе кто
    // угодно опубликовал бы поддельное расписание для всего факультета.
    const document = message?.document;
    if (document) {
      const owner = String(message.chat.id) === String(env.OWNER_ID);
      const pdf =
        document.mime_type === "application/pdf" ||
        (document.file_name || "").toLowerCase().endsWith(".pdf");

      let reply = "Файлы принимаю только от владельца.";
      if (owner) {
        reply = pdf
          ? await startUpdate(env, document)
          : "Это не PDF. Пришлите файл расписания.";
      }
      await callTelegram(env.BOT_TOKEN, "sendMessage", {
        chat_id: message.chat.id,
        text: reply,
      });
    }

    // Рассылка: сперва черновик с кнопками, отправка — только по нажатию.
    // Отозвать её нельзя, поэтому подтверждение обязательно.
    if (message && text.startsWith("/broadcast")) {
      const owner = String(message.chat.id) === String(env.OWNER_ID);
      const body = text.slice("/broadcast".length).trim();
      if (!owner) {
        await callTelegram(env.BOT_TOKEN, "sendMessage", {
          chat_id: message.chat.id,
          text: "Команда недоступна.",
        });
      } else if (!body) {
        await callTelegram(env.BOT_TOKEN, "sendMessage", {
          chat_id: message.chat.id,
          text: "Напишите текст следом: /broadcast Завтра занятий нет.",
        });
      } else {
        await draftBroadcast(env, message.chat.id, body);
      }
    }

    // «Расписание обновлено» всем — готовый текст на двух языках, с датой
    // версии и кнопкой. Тоже через черновик: отозвать рассылку нельзя.
    if (message && text.startsWith("/updated")) {
      if (!isOwner(env, message.chat.id)) {
        await callTelegram(env.BOT_TOKEN, "sendMessage", {
          chat_id: message.chat.id,
          text: "Команда недоступна.",
        });
      } else {
        const extra = text.replace(/^\/updated(@\w+)?/, "").trim();
        await draftBroadcast(env, message.chat.id, await updatedText(extra), { button: true });
      }
    }

    // Тестовая версия приложения — только владельцу. Кнопка web_app, а не
    // ссылка: так приложение получает подпись Telegram, как настоящее.
    if (message && text.startsWith("/beta")) {
      const owner = isOwner(env, message.chat.id);
      await callTelegram(env.BOT_TOKEN, "sendMessage", {
        chat_id: message.chat.id,
        text: owner ? "Тестовая версия расписания. Студенты её не видят." : "Команда недоступна.",
        reply_markup: owner
          ? { inline_keyboard: [[{ text: "🧪 Открыть тестовую версию", web_app: { url: BETA_URL } }]] }
          : undefined,
      });
    }

    // Удалить комментарий по номеру — только владелец.
    if (message && text.startsWith("/delcomment")) {
      const reply = isOwner(env, message.chat.id)
        ? await deleteCommentCommand(env, text)
        : "Команда недоступна.";
      await callTelegram(env.BOT_TOKEN, "sendMessage", { chat_id: message.chat.id, text: reply });
    }

    // Бан в комментариях — только владелец. Сверяем целое слово: «/bans»
    // начинается с «/ban».
    const banCmd = text.match(/^\/(ban|unban|bans)(?:@\w+)?(?:\s|$)/)?.[1];
    if (message && banCmd) {
      let reply = { text: "Команда недоступна." };
      if (isOwner(env, message.chat.id)) {
        if (banCmd === "ban") reply = await banCommand(env, text, findPerson);
        else if (banCmd === "unban") reply = { text: await unbanCommand(env, text, findPerson) };
        else reply = { text: await bansList(env) };
      }
      await callTelegram(env.BOT_TOKEN, "sendMessage", {
        chat_id: message.chat.id,
        text: reply.text,
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        reply_markup: reply.keyboard ? { inline_keyboard: reply.keyboard } : undefined,
      });
    }

    // Кто, куда и что писал — только владелец.
    if (message && text.startsWith("/comments")) {
      const replies = isOwner(env, message.chat.id)
        ? await listCommentsCommand(env, text)
        : ["Команда недоступна."];
      for (const reply of replies) {
        await callTelegram(env.BOT_TOKEN, "sendMessage", {
          chat_id: message.chat.id,
          text: reply,
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
        });
      }
    }

    // Назначать старост может только владелец.
    if (message && (text.startsWith("/starosta") || text.startsWith("/unstarosta"))) {
      let reply = "Команда недоступна.";
      if (isOwner(env, message.chat.id)) {
        reply = text.startsWith("/unstarosta")
          ? await handleUnstarosta(env, text)
          : await handleStarosta(env, text);
      }
      await callTelegram(env.BOT_TOKEN, "sendMessage", {
        chat_id: message.chat.id,
        text: reply,
        parse_mode: "HTML",
      });
    }

    // Отмена пар меняет расписание всем — только владелец.
    if (message && /^\/(block|unblock|blocks)(?:@\w+)?(?:\s|$)/.test(text)) {
      const owner = String(message.chat.id) === String(env.OWNER_ID);
      let reply = "Команда недоступна.";
      if (owner) {
        reply = text.startsWith("/blocks")
          ? await blocksList(env)
          : text.startsWith("/unblock")
            ? await unblockCommand(env, text)
            : await blockCommand(env, text);
      }
      await callTelegram(env.BOT_TOKEN, "sendMessage", {
        chat_id: message.chat.id,
        text: reply,
        parse_mode: "HTML",
      });
    }

    if (message && (text.startsWith("/change") || text.startsWith("/unchange"))) {
      const owner = String(message.chat.id) === String(env.OWNER_ID);
      let reply = "Команда недоступна.";
      if (owner) {
        reply = text.startsWith("/unchange") ? await handleUnchange(env, text) : await handleChange(env, text);
      }
      await callTelegram(env.BOT_TOKEN, "sendMessage", {
        chat_id: message.chat.id,
        text: reply,
        parse_mode: "HTML",
      });
    }

    if (message && (text.startsWith("/cancel") || text.startsWith("/uncancel"))) {
      const owner = String(message.chat.id) === String(env.OWNER_ID);
      let reply = "Команда недоступна.";
      if (owner) {
        reply = text.startsWith("/uncancel")
          ? await handleUncancel(env, text)
          : await handleCancel(env, text);
      }
      await callTelegram(env.BOT_TOKEN, "sendMessage", {
        chat_id: message.chat.id,
        text: reply,
        parse_mode: "HTML",
      });
    }

    // Объявления публикуются от имени расписания — тоже только владелец.
    if (message && (text.startsWith("/notice") || text.startsWith("/unnotice"))) {
      const owner = String(message.chat.id) === String(env.OWNER_ID);
      let reply = "Команда недоступна.";
      if (owner) {
        reply = text.startsWith("/unnotice")
          ? await handleUnnotice(env, text)
          : await handleNotice(env, text);
      }
      await callTelegram(env.BOT_TOKEN, "sendMessage", {
        chat_id: message.chat.id,
        text: reply,
        parse_mode: "HTML",
      });
    }

    // Сводка и список — только владельцу: данные чужие.
    if (message && (text.startsWith("/stats") || text.startsWith("/who"))) {
      const allowed = String(message.chat.id) === String(env.OWNER_ID);
      let reply = "Команда недоступна.";
      if (allowed) {
        reply = text.startsWith("/stats")
          ? await buildStats(env)
          : await buildWho(env, text.split(/\s+/)[1] || null);
      }
      await callTelegram(env.BOT_TOKEN, "sendMessage", {
        chat_id: message.chat.id,
        text: reply,
        parse_mode: "HTML",
      });
    }

    return new Response("ok");
  },

  // Раз в минуту разбираем очередь рассылки.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(drainOutbox(env));
  },
};
