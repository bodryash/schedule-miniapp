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
  parseDay,
  today,
} from "./inline.js";

const WEB_APP_URL = "https://bodryash.github.io/schedule-miniapp/";

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
async function draftBroadcast(env, chatId, text) {
  const { count } = await env.STATS.prepare(
    "SELECT COUNT(*) AS count FROM users"
  ).first();

  const draft = await env.STATS.prepare(
    "INSERT INTO broadcasts (text, created) VALUES (?, ?) RETURNING id"
  )
    .bind(text, new Date().toISOString())
    .first();

  await callTelegram(env.BOT_TOKEN, "sendMessage", {
    chat_id: chatId,
    text: `Разослать это ${count} получателям?\n\n———\n${text}\n———`,
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
    "SELECT id, text FROM broadcasts WHERE status = 'sending' ORDER BY id LIMIT 1"
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
    `SELECT id, day, slots, reason FROM cancels
     WHERE grp IN (?, ?, '*') AND removed = 0 AND day >= ?
     ORDER BY day, id LIMIT 40`
  )
    .bind(group.id, courseOf(group), iso(addDays(today(), -1)))
    .all();
  return results.map((c) => ({ ...c, slots: c.slots ? c.slots.split(",").map(Number) : [] }));
}

/** Объявления группы: её собственные, её курса и общие для всех. */
async function activeNotices(env, group) {
  if (!env.STATS || !group?.id) return [];
  const course = courseOf(group);
  const { results = [] } = await env.STATS.prepare(
    `SELECT id, text, created FROM notices
     WHERE grp IN (?, ?, '*') AND expires > ? ORDER BY id DESC LIMIT 5`
  )
    .bind(group.id, course, new Date().toISOString())
    .all();
  return results;
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

const NOTICE_HELP = [
  "<b>Объявления</b> — плашка в приложении у группы, висит неделю.",
  "",
  "/notice 311гэу Пара в четверг переносится в 614",
  "/notice 311гэу,312гэу Текст — нескольким группам",
  "/notice 3курс Текст — курсу бакалавриата (1курс … 4курс)",
  "/notice маг1 Текст — курсу магистратуры (маг1, маг2)",
  "/notice все Текст — всему факультету",
  "/unnotice 12 — снять объявление №12",
  "/unnotice все — снять все разом",
].join("\n");

/** «311гэу,312гэу», «3курс», «маг1», «все» → ключи адресатов для /notice и /cancel. */
async function resolveTargets(target) {
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
    const course = parseCourse(name);
    const id = course && courses.has(course) ? course : byName.get(normalize(name));
    if (id) ids.push(id);
    else unknown.push(name);
  }
  if (unknown.length) {
    return {
      error: `Не нашёл: ${escape(unknown.join(", "))}. Пишите группу полностью (311гэу), курс (3курс, маг1) или «все».`,
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
  "/uncancel 7 — вернуть пару",
  "",
  "Порядок: кому, день, номера пар, причина. Кому — как в /notice. День — 14.09, сегодня, завтра или пн…сб. Без номеров отменяется весь день. Причину можно не писать.",
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
      `SELECT id, grp, day, slots, reason FROM cancels
       WHERE removed = 0 AND day >= ? ORDER BY day, id LIMIT 30`
    )
      .bind(iso(today()))
      .all();
    const list = results.map((c) => {
      const date = new Date(`${c.day}T00:00:00Z`);
      const slots = c.slots ? c.slots.split(",").map(Number) : [];
      const reason = c.reason ? `\n${escape(c.reason)}` : "";
      return `№${c.id} · ${escape(targetLabel(c.grp))} · ${dateLabel(date)} · ${slotsLabel(slots)}${reason}`;
    });
    return [CANCEL_HELP, "", list.length ? list.join("\n\n") : "Отменённых пар впереди нет."].join("\n");
  }

  const words = body.split(/\s+/);
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

async function handleUncancel(env, text) {
  const id = Number(text.split(/\s+/)[1]);
  if (!id) return "Укажите номер: /uncancel 7. Список — /cancel";
  const result = await env.STATS.prepare(
    "UPDATE cancels SET removed = 1 WHERE id = ? AND removed = 0"
  )
    .bind(id)
    .run();
  return result.meta?.changes ? `Отмена №${id} снята — пара снова в расписании.` : `Действующей отмены №${id} нет.`;
}

/** `/notice` без текста — список действующих; с текстом — новое объявление. */
async function handleNotice(env, text) {
  const body = glueCourse(text.replace(/^\/notice(@\w+)?/, "").trim());
  const now = new Date();

  if (!body) {
    const { results = [] } = await env.STATS.prepare(
      "SELECT id, grp, text, expires FROM notices WHERE expires > ? ORDER BY id DESC LIMIT 30"
    )
      .bind(now.toISOString())
      .all();
    const list = results.map(
      (n) => `№${n.id} · ${escape(targetLabel(n.grp))} · до ${n.expires.slice(5, 10)}\n${escape(n.text)}`
    );
    return [NOTICE_HELP, "", list.length ? list.join("\n\n") : "Действующих объявлений нет."].join("\n");
  }

  const [target, ...words] = body.split(/\s+/);
  const message = body.slice(target.length).trim();
  if (!message) return `Не хватает текста.\n\n${NOTICE_HELP}`;
  if (message.length > 500) return "Слишком длинно: до 500 знаков.";

  const resolved = await resolveTargets(target);
  if (resolved.error) return resolved.error;
  const { ids } = resolved;

  const expires = new Date(now.getTime() + NOTICE_DAYS * 86400000);
  const created = await env.STATS.batch(
    ids.map((grp) =>
      env.STATS.prepare(
        "INSERT INTO notices (grp, text, created, expires) VALUES (?, ?, ?, ?) RETURNING id"
      ).bind(grp, message, now.toISOString(), expires.toISOString())
    )
  );
  const numbers = created.map((r) => r.results[0].id);
  const whom = ids.map(targetLabel).join(", ");
  return [
    `Готово: объявление для ${escape(whom)}, висит до ${expires.toISOString().slice(0, 10)}.`,
    "Появится у студентов при следующем открытии приложения и в расписании в чатах.",
    `Снять: ${numbers.map((n) => `/unnotice ${n}`).join(", ")}`,
  ].join("\n");
}

function targetLabel(grp) {
  if (grp === "*") return "всех групп";
  return grp.startsWith("курс:") ? courseLabel(grp) : grp;
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
    if (url.pathname === "/notices" && request.method === "GET") {
      const group = {
        id: url.searchParams.get("group"),
        level: url.searchParams.get("level"),
        course: Number(url.searchParams.get("course")) || null,
      };
      // Без объявлений и отмен расписание всё равно должно открыться.
      const [notices, cancels] = await Promise.all([
        activeNotices(env, group).catch(() => []),
        activeCancels(env, group).catch(() => []),
      ]);
      return new Response(JSON.stringify({ notices, cancels }), {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "access-control-allow-origin": "*",
          "cache-control": "public, max-age=60",
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
          cancels: (group) => activeCancels(env, group).catch(() => []),
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
      // Китайский — сам по языку Telegram. Английский только подсказкой:
      // многие русские студенты держат Telegram на английском.
      const code = String(message.from?.language_code || "").toLowerCase();
      const zh = code.startsWith("zh");
      const greeting = zh
        ? "打开课表 👇\n语言可在“设置”中切换。"
        : code.startsWith("en")
          ? "Открывай расписание 👇\n\nOpen the schedule 👇 English: Настройки → Language."
          : "Открывай расписание 👇";
      await callTelegram(env.BOT_TOKEN, "sendMessage", {
        chat_id: message.chat.id,
        text: greeting,
        reply_markup: {
          inline_keyboard: [
            [{ text: zh ? "📅 打开课表" : "📅 Открыть расписание", web_app: { url: WEB_APP_URL } }],
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

    // Отмена пар меняет расписание всем — только владелец.
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
