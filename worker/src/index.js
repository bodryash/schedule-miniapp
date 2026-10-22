/**
 * Бот на вебхуке: Telegram сам стучится сюда, поэтому ничего крутить на
 * компьютере не нужно. Отвечает на /start сообщением с кнопкой,
 * открывающей мини-приложение, и на /stats — сводкой по открытиям.
 *
 * Второй маршрут — POST /hit: мини-приложение сообщает, что его открыли.
 * Считает обезличенно, см. schema.sql.
 */

import { handleIcs } from "./ics.js";
import {
  addDays,
  answerInline,
  dateLabel,
  iso,
  loadGroups,
  loadJson,
  loadTenants,
  DEFAULT_TENANT,
  normalize,
  parityOf,
  parseDay,
  shiftOf,
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

// На своём сервере адрес приложения задаётся в настройках (APP_URL), в
// Cloudflare остаётся прежний.
const WEB_APP_URL = globalThis.SCHEDULE_APP_URL || "https://bodryash.github.io/schedule-miniapp/";

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

// Сколько дней хранится журнал заходов.
const VISITS_KEEP_DAYS = 30;

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

  // Журнал заходов для /visits: один заход — одна строка, не чаще, чем
  // счётчик открытий. Старше 30 дней стираем тут же.
  await env.STATS.batch([
    env.STATS.prepare("INSERT INTO visits (tg_id, at, grp) VALUES (?, ?, ?)").bind(user.id, stamp, group.id || null),
    env.STATS.prepare("DELETE FROM visits WHERE at < ?").bind(new Date(Date.now() - VISITS_KEEP_DAYS * 86400000).toISOString()),
  ]).catch(() => {});

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
// Порции отправки. В Cloudflare запуск ограничен 50 обращениями наружу,
// поэтому там порции маленькие. На своём сервере этого предела нет: шлём
// до 600 сообщений в минуту — это 10 в секунду, втрое ниже потолка
// Telegram, и порция успевает уйти до следующей минуты.
const OWN_SERVER = Boolean(globalThis.SCHEDULE_OWN_SERVER);
const BATCH = OWN_SERVER ? 600 : 40;
const SEND_BUDGET = OWN_SERVER ? 700 : 44;

/**
 * Получатели рассылки одному факультету — те, кто выбрал у него группу.
 * Группа ФГП записана без приставки («311гэу»), у остальных — «вуз/группа».
 * Кто группу ещё не выбирал, тот ничей: ему уходит только общая рассылка.
 */
const AUDIENCE_SQL = `SELECT DISTINCT u.id FROM users u JOIN people p ON p.tg_id = u.id
  WHERE p.grp IS NOT NULL AND p.grp != '' AND p.grp NOT LIKE 'преп:%'
    AND CASE WHEN instr(p.grp, '/') > 0 THEN substr(p.grp, 1, instr(p.grp, '/') - 1) ELSE 'msu-fgp' END = ?`;

// «Всем, кроме факультета»: у кого выбрана группа на любом другом факультете.
const AUDIENCE_EXCEPT_SQL = AUDIENCE_SQL.replace(/END = \?$/, "END != ?");

/**
 * Получатели рассылки: «msu-fgp» — один факультет, «!msu-fgp» — все, кроме
 * него, «in:msu-fgp,msu-law» — несколько факультетов (весь вуз).
 * Возвращает [запрос, ...значения для bind].
 */
function audienceQuery(audience) {
  if (audience.startsWith("in:")) {
    const ids = audience.slice(3).split(",").filter(Boolean);
    const sql = AUDIENCE_SQL.replace(/END = \?$/, `END IN (${ids.map(() => "?").join(", ")})`);
    return [sql, ...ids];
  }
  return audience.startsWith("!") ? [AUDIENCE_EXCEPT_SQL, audience.slice(1)] : [AUDIENCE_SQL, audience];
}

/** «#фгп», «#msu-fgp», «#Филфак» → факультет. Регистр и пробелы не важны. */
async function findAudience(word) {
  const want = normalize(word);
  const tenants = await loadTenants().catch(() => []);
  return tenants.find((t) => normalize(t.id) === want || normalize(t.short || "") === want) || null;
}

// Рассылка с вложением: чем отправлять и в каком поле лежит файл.
const MEDIA_SEND = {
  video: ["sendVideo", "video"],
  animation: ["sendAnimation", "animation"],
  photo: ["sendPhoto", "photo"],
  document: ["sendDocument", "document"],
};
// Столько знаков Telegram разрешает в подписи к вложению.
const CAPTION_MAX = 1024;

/** Видео, гифка, фото или файл из сообщения владельца — для рассылки. */
function mediaOf(message) {
  if (message.video) return { kind: "video", id: message.video.file_id };
  // У гифки Telegram дублирует файл в document — поэтому она раньше.
  if (message.animation) return { kind: "animation", id: message.animation.file_id };
  if (message.photo?.length) return { kind: "photo", id: message.photo.at(-1).file_id };
  if (message.document) return { kind: "document", id: message.document.file_id };
  return null;
}

/** Одно сообщение рассылки: текст или вложение с подписью. */
function sendCast(env, chatId, job, markup) {
  const send = MEDIA_SEND[job.media_kind];
  if (!send || !job.media_id) {
    return callTelegram(env.BOT_TOKEN, "sendMessage", { chat_id: chatId, text: job.text, reply_markup: markup });
  }
  return callTelegram(env.BOT_TOKEN, send[0], {
    chat_id: chatId,
    [send[1]]: job.media_id,
    caption: job.text || undefined,
    reply_markup: markup,
  });
}

/** Готовит черновик рассылки и показывает его с кнопками подтверждения. */
async function draftBroadcast(env, chatId, text, { button = false, audience = null, media = null } = {}) {
  const key = audience ? `${audience.except ? "!" : ""}${audience.id}` : "";
  const { count } = audience
    ? await env.STATS.prepare(`SELECT COUNT(*) AS count FROM (${audienceQuery(key)[0]})`).bind(...audienceQuery(key).slice(1)).first()
    : await env.STATS.prepare("SELECT COUNT(*) AS count FROM users").first();

  const draft = await env.STATS.prepare(
    "INSERT INTO broadcasts (text, created, button, audience, media_kind, media_id) VALUES (?, ?, ?, ?, ?, ?) RETURNING id"
  )
    .bind(text, new Date().toISOString(), button ? 1 : 0, key, media?.kind || "", media?.id || "")
    .first();

  // С вложением черновик — само сообщение в том виде, в каком его получат,
  // а вопрос с кнопками идёт следом отдельной строкой.
  if (media) {
    const shown = await sendCast(env, chatId, { text, media_kind: media.kind, media_id: media.id });
    if (!shown.ok) {
      await env.STATS.prepare("UPDATE broadcasts SET status = 'cancelled' WHERE id = ?").bind(draft.id).run();
      await callTelegram(env.BOT_TOKEN, "sendMessage", {
        chat_id: chatId,
        text: `Telegram не принял вложение: ${(await shown.json().catch(() => ({}))).description || "неизвестная ошибка"}. Ничего не отправлено.`,
      });
      return;
    }
  }

  const extra = button ? "\n(с кнопкой «📅 Открыть расписание»)" : "";
  const whom = audience?.except
    ? `Всем, КРОМЕ ${audience.university} · ${audience.short || audience.faculty}: ${count} получателям — тем, у кого выбрана группа на другом факультете.`
    : audience
    ? `Только ${audience.university} · ${audience.short || audience.faculty}: ${count} получателям — тем, кто выбрал там группу.`
    : `Разослать это ВСЕМ — ${count} получателям?`;
  await callTelegram(env.BOT_TOKEN, "sendMessage", {
    chat_id: chatId,
    text: media ? `${whom}${extra}\n\nСообщение — выше, ровно так его и получат.` : `${whom}${extra}\n\n———\n${text}\n———`,
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
      const draft = await env.STATS.prepare("SELECT audience FROM broadcasts WHERE id = ?").bind(id).first();
      await env.STATS.batch([
        draft?.audience
          ? env.STATS.prepare(
              `INSERT OR IGNORE INTO outbox (broadcast, chat_id) SELECT ?, id FROM (${audienceQuery(draft.audience)[0]})`
            ).bind(id, ...audienceQuery(draft.audience).slice(1))
          : env.STATS.prepare(
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
async function drainOutbox(env, limit = BATCH) {
  if (limit <= 0) return;
  const job = await env.STATS.prepare(
    "SELECT id, text, button, media_kind, media_id FROM broadcasts WHERE status = 'sending' ORDER BY id LIMIT 1"
  ).first();
  if (!job) return;

  const { results = [] } = await env.STATS.prepare(
    "SELECT chat_id FROM outbox WHERE broadcast = ? AND state = 'pending' LIMIT ?"
  )
    .bind(job.id, limit)
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
      const response = await sendCast(
        env,
        row.chat_id,
        job,
        // Рассылка идёт в личные чаты — там кнопка web_app разрешена.
        job.button
          ? { inline_keyboard: [[{ text: "📅 Открыть расписание", web_app: { url: WEB_APP_URL } }]] }
          : undefined
      );
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
/**
 * /who — кто заходил. Без слова — все; с группой — эта группа; «преп» —
 * все в режиме преподавателя; фамилия преподавателя — кто смотрит его
 * расписание; @username или имя — поиск конкретного человека.
 */
async function buildWho(env, filter) {
  if (!env.STATS) return "Статистика не подключена.";

  const limit = 60;
  const word = String(filter || "").trim();
  const lower = word.toLowerCase();
  let query;
  let head;
  if (!word) {
    query = env.STATS.prepare(
      `SELECT name, username, grp, last FROM people ORDER BY last DESC LIMIT ?`
    ).bind(limit + 1);
    head = "<b>Кто заходил</b>";
  } else if (["преп", "препод", "преподаватели", "преподаватель"].includes(lower)) {
    query = env.STATS.prepare(
      `SELECT name, username, grp, last FROM people WHERE grp LIKE 'преп:%'
       ORDER BY last DESC LIMIT ?`
    ).bind(limit + 1);
    head = "<b>Заходили в режиме преподавателя</b>";
  } else if (word.startsWith("@")) {
    query = env.STATS.prepare(
      `SELECT name, username, grp, last FROM people WHERE lower(username) = ?
       ORDER BY last DESC LIMIT ?`
    ).bind(lower.slice(1), limit + 1);
    head = `<b>${escape(word)}</b>`;
  } else {
    // Группа — точное совпадение; иначе ищем по фамилии преподавателя и по
    // имени человека: «/who Пфандер» найдёт и того, кто открыл её расписание.
    query = env.STATS.prepare(
      `SELECT name, username, grp, last FROM people
       WHERE grp = ? OR grp LIKE ? OR lower(name) LIKE ?
       ORDER BY last DESC LIMIT ?`
    ).bind(word, `преп:${word}%`, `%${lower}%`, limit + 1);
    head = `<b>Заходили: ${escape(word)}</b>`;
  }

  const { results = [] } = await query.all();
  if (!results.length) {
    return word ? `По «${escape(word)}» никто не заходил.` : "Пока никто не заходил.";
  }

  const lines = results.slice(0, limit).map((row) => {
    const who = row.username ? `@${row.username}` : escape(row.name || "без имени");
    // Режим преподавателя подписываем понятно, а не служебным ключом.
    const grp = String(row.grp || "—");
    const where = grp.startsWith("преп:") ? `👩‍🏫 ${grp.slice(5)}` : grp;
    return `${who} · ${escape(where)} · ${visitTime(row.last)}`;
  });

  if (results.length > limit) lines.push(`… показаны последние ${limit}`);
  return [head, "", ...lines].join("\n");
}

/** Время захода по Москве: «сегодня 09:41», «вчера 23:05», «03.10 14:20». */
function visitTime(iso) {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return String(iso || "").slice(0, 10);
  const moscow = (date) => new Date(date.getTime() + 3 * 3600000).toISOString();
  const stamp = moscow(at);
  const today = moscow(new Date()).slice(0, 10);
  const yesterday = moscow(new Date(Date.now() - 86400000)).slice(0, 10);
  const time = stamp.slice(11, 16);
  const day = stamp.slice(0, 10);
  if (day === today) return `сегодня ${time}`;
  if (day === yesterday) return `вчера ${time}`;
  return `${day.slice(8, 10)}.${day.slice(5, 7)} ${time}`;
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

/**
 * /dm @ivanov текст или /dm 123456 текст — сообщение одному человеку от
 * имени бота. Текст уходит как есть, без разметки: так в нём можно писать
 * любые знаки. Доставить можно только тем, кто хоть раз запускал бота.
 */
async function directMessage(env, text) {
  const body = String(text).replace(/^\/dm(@\w+)?/, "").trim();
  const match = body.match(/^(\S+)\s+([\s\S]+)$/);
  if (!match) {
    return "Кому и что: <code>/dm @ivanov Привет! Расписание вашей группы подключили.</code>\nМожно и по номеру: <code>/dm 123456789 текст</code>";
  }
  const person = await findPerson(env, match[1]);
  if (!person?.tg_id) {
    return `Не знаю человека ${escape(match[1])}: он не открывал расписание и не писал боту. Можно по номеру Telegram.`;
  }
  const message = match[2].trim().slice(0, 4000);
  let result = null;
  try {
    result = await (await callTelegram(env.BOT_TOKEN, "sendMessage", { chat_id: person.tg_id, text: message })).json();
  } catch {
    result = null;
  }
  if (!result?.ok) {
    return `Не доставлено ${escape(personLabel(person))}: ${escape(result?.description || "Telegram не ответил")}. Чаще всего человек не запускал бота или заблокировал его.`;
  }
  return `Отправлено ${escape(personLabel(person))}:\n\n${escape(message)}`;
}

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

/**
 * Заявка в старосты. Раньше человек писал «я староста», владелец выяснял
 * группу и набирал команду руками. Теперь группу бот берёт из того, что
 * человек сам выбрал в расписании, а владельцу приходит сообщение с двумя
 * кнопками. Права появляются только после его «Назначить».
 */
async function requestStarosta(env, from) {
  const open = { inline_keyboard: [[{ text: "📅 Открыть расписание", web_app: { url: WEB_APP_URL } }]] };
  const noGroup = {
    text: "Заявка подаётся на ту группу, которая выбрана у вас в расписании.\n\nОткройте расписание, выберите в настройках свой вуз, факультет и группу — и напишите сюда «я староста» ещё раз.",
    reply_markup: open,
  };
  const seen = await env.STATS.prepare(
    "SELECT grp FROM people WHERE tg_id = ? AND grp IS NOT NULL AND grp != '' ORDER BY last DESC LIMIT 1"
  )
    .bind(from.id)
    .first();
  if (!seen?.grp || seen.grp.startsWith("преп:")) return noGroup;
  const groups = await loadGroups().catch(() => []);
  const group = groups.find((g) => g.id === seen.grp);
  if (!group) return noGroup;

  const already = await env.STATS.prepare("SELECT 1 AS yes FROM starostas WHERE grp = ? AND tg_id = ?")
    .bind(group.id, from.id)
    .first();
  if (already) return { text: `Вы уже староста группы ${group.title}. Кнопка «＋ ДЗ» есть у пар в расписании.`, reply_markup: open };
  const pending = await env.STATS.prepare(
    "SELECT id FROM starosta_requests WHERE tg_id = ? AND grp = ? AND status = 'new'"
  )
    .bind(from.id, group.id)
    .first();
  if (pending) return { text: `Заявка на группу ${group.title} уже у владельца сервиса. Как только он ответит — напишу.` };

  const name = [from.first_name, from.last_name].filter(Boolean).join(" ") || null;
  await env.STATS.prepare(
    "INSERT INTO starosta_requests (tg_id, grp, name, username, created) VALUES (?, ?, ?, ?, ?)"
  )
    .bind(from.id, group.id, name, from.username || null, new Date().toISOString())
    .run();
  const request = await env.STATS.prepare(
    "SELECT id FROM starosta_requests WHERE tg_id = ? AND grp = ? AND status = 'new' ORDER BY id DESC LIMIT 1"
  )
    .bind(from.id, group.id)
    .first();
  const tenants = await loadTenants().catch(() => []);
  const tenant = tenants.find((t) => t.id === group.tenant);
  const where = tenant ? `${tenant.university} · ${tenant.short || tenant.faculty}` : "";
  const others = await env.STATS.prepare("SELECT COUNT(*) AS n FROM starostas WHERE grp = ?").bind(group.id).first();
  await callTelegram(env.BOT_TOKEN, "sendMessage", {
    chat_id: env.OWNER_ID,
    text: [
      "<b>Заявка в старосты</b>",
      "",
      `${escape(personLabel({ username: from.username, name, tg_id: from.id }))}${name && from.username ? ` (${escape(name)})` : ""} · id <code>${from.id}</code>`,
      `Группа: <b>${escape(group.title)}</b>${where ? ` — ${escape(where)}` : ""}`,
      others?.n ? `В этой группе уже есть старост: ${others.n}.` : "В этой группе старост пока нет.",
      "",
      "Группа взята из того, что человек сам выбрал в расписании — подтверждений, что он староста, у бота нет.",
    ].join("\n"),
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [[
        { text: "✅ Назначить", callback_data: `stok:${request.id}` },
        { text: "❌ Отклонить", callback_data: `stno:${request.id}` },
      ]],
    },
  });
  return {
    text: `Заявка отправлена: староста группы ${group.title}${where ? ` (${where})` : ""}.\n\nВладелец сервиса подтвердит — и у пар появится кнопка «＋ ДЗ». Если группа не та, смените её в настройках расписания и напишите «я староста» ещё раз.`,
  };
}

/** Владелец нажал кнопку под заявкой. */
async function decideStarosta(env, id, approve) {
  const request = await env.STATS.prepare("SELECT * FROM starosta_requests WHERE id = ?").bind(id).first();
  if (!request) return { note: "Заявка не найдена", line: "" };
  if (request.status !== "new") return { note: "Уже обработано", line: "" };
  const groups = await loadGroups().catch(() => []);
  const title = groups.find((g) => g.id === request.grp)?.title || request.grp;
  const who = personLabel(request);
  if (approve) {
    await env.STATS.batch([
      env.STATS.prepare(
        `INSERT INTO starostas (grp, tg_id, name, username, created) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(grp, tg_id) DO UPDATE SET name = excluded.name, username = excluded.username`
      ).bind(request.grp, request.tg_id, request.name, request.username, new Date().toISOString()),
      env.STATS.prepare("UPDATE starosta_requests SET status = 'ok' WHERE id = ?").bind(id),
    ]);
    await callTelegram(env.BOT_TOKEN, "sendMessage", {
      chat_id: request.tg_id,
      text: `Вас назначили старостой группы ${title} ✅\n\nОткройте расписание: у пар появилась кнопка «＋ ДЗ» — домашнее задание увидит вся группа.`,
      reply_markup: { inline_keyboard: [[{ text: "📅 Открыть расписание", web_app: { url: WEB_APP_URL } }]] },
    }).catch(() => null);
    return { note: "Назначен", line: `✅ Назначен: ${escape(who)} — староста ${escape(title)}` };
  }
  await env.STATS.prepare("UPDATE starosta_requests SET status = 'no' WHERE id = ?").bind(id).run();
  await callTelegram(env.BOT_TOKEN, "sendMessage", {
    chat_id: request.tg_id,
    text: `Заявку на старосту группы ${title} не подтвердили. Если это ошибка — напишите сюда, почему права нужны именно вам.`,
  }).catch(() => null);
  return { note: "Отклонено", line: `❌ Отклонено: ${escape(who)} — ${escape(title)}` };
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
    const uni = name.match(/^вуз:(.+)$/i);
    if (uni) {
      const tenants = await loadTenants().catch(() => []);
      const found = tenants.find((t) => normalize(t.university) === normalize(uni[1]));
      if (found) ids.push(`uni:${normalize(found.university)}`);
      else unknown.push(name);
      continue;
    }
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
/**
 * Отмена из приложения. Владелец — у любой группы и целого курса. Староста —
 * только у своей группы, только сегодня и на две недели вперёд и вернуть
 * может только отмены своей группы. О каждой отмене старосты бот пишет
 * владельцу, а группе — уведомление (см. «Уведомления об изменениях»).
 */
async function appCancel(env, body) {
  const user = await verifyInitData(body.initData || "", env.BOT_TOKEN);
  if (!user) return { ok: false, error: "forbidden" };
  const owner = isOwner(env, user.id);
  const group = String(body.group || "");
  if (!owner && !(await canEditHomework(env, body.initData || "", group))) return { ok: false, error: "forbidden" };
  if (body.action === "restore") {
    const ids = (body.ids || []).map(Number).filter(Boolean).slice(0, 20);
    if (!ids.length) return { ok: false, error: "no ids" };
    await env.STATS.batch(
      ids.map((id) =>
        owner
          ? env.STATS.prepare("UPDATE cancels SET removed = 1 WHERE id = ?").bind(id)
          : env.STATS.prepare("UPDATE cancels SET removed = 1 WHERE id = ? AND grp = ?").bind(id, group)
      )
    );
    if (!owner) await tellOwnerAbout(env, user, `↩️ вернул(а) пару · ${groupTitle(group)}`);
    return { ok: true };
  }
  const day = String(body.day || "");
  const slots = (body.slots || []).map(Number).filter((n) => n >= 1 && n <= 7);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !slots.length || !group) return { ok: false, error: "bad lesson" };
  if (!owner && (day < iso(today()) || day > iso(addDays(today(), 14)))) return { ok: false, error: "bad day" };
  const grp =
    owner && body.scope === "course" && body.level && body.course ? courseKey(body.level, Number(body.course)) : group;
  await env.STATS.prepare(
    `INSERT INTO cancels (grp, day, slots, reason, created, subject, subgroup, teacher)
     VALUES (?, ?, ?, ?, ?, ?, 0, '')`
  )
    .bind(grp, day, slots.join(","), String(body.reason || "").slice(0, 200), new Date().toISOString(), String(body.subject || ""))
    .run();
  if (!owner) {
    await tellOwnerAbout(
      env,
      user,
      `❌ отменил(а) · ${groupTitle(group)} · ${dateLabel(new Date(`${day}T00:00:00Z`))} · ${slotsLabel(slots)}${body.subject ? ` — ${body.subject}` : ""}`
    );
  }
  return { ok: true };
}

/** Владельцу — кто из старост что сделал: видно, если права используют не по делу. */
async function tellOwnerAbout(env, user, what) {
  const who = user.username ? `@${user.username}` : [user.first_name, user.last_name].filter(Boolean).join(" ") || `id ${user.id}`;
  await callTelegram(env.BOT_TOKEN, "sendMessage", { chat_id: env.OWNER_ID, text: `Староста ${who} ${what}` }).catch(() => {});
}

/* ---------- Уведомления об изменениях ----------
 * Отмены, замены и объявления появляются в базе разными путями: командами
 * бота, из приложения, отменой по преподавателю. Вместо того чтобы
 * вставлять рассылку в каждый, раз в минуту смотрим, что появилось нового
 * (отметка — последний разобранный номер), и складываем сообщения в очередь.
 * Получатели — у кого включены напоминания и не выключены изменения: они
 * уже разрешили боту писать.
 */

const ALERT_KINDS = ["cancels", "changes", "notices"];
const ALERT_BATCH = 200;
const ALERT_AHEAD_DAYS = 14;

/** «msu-mm/101» → «101»: человеку своя группа понятна и без факультета. */
const groupTitle = (grp) => (grp.includes("/") ? grp.slice(grp.indexOf("/") + 1) : grp);

/** Кому слать про запись для grp: сама группа, весь её курс или лично человек. */
async function alertRecipients(env, grp) {
  if (!grp || grp === "*" || grp.startsWith("uni:")) return [];
  if (grp.startsWith("user:")) {
    const id = Number(grp.slice(5));
    const row = await env.STATS.prepare("SELECT tg_id FROM reminders WHERE tg_id = ? AND changes = 1").bind(id).first();
    return row ? [{ id, grp: "" }] : [];
  }
  const { results = [] } = await env.STATS.prepare(
    "SELECT tg_id AS id, grp FROM reminders WHERE changes = 1 AND grp != ''"
  ).all();
  if (!grp.startsWith("курс:")) return results.filter((r) => r.grp === grp);
  const groups = new Map((await loadGroups().catch(() => [])).map((g) => [g.id, g]));
  return results.filter((r) => groups.has(r.grp) && courseOf(groups.get(r.grp)) === grp);
}

function alertText(kind, row) {
  const date = row.day ? dateLabel(new Date(`${row.day}T00:00:00Z`)) : "";
  const slots = row.slots ? row.slots.split(",").map(Number) : [];
  const where = (grp) => (grp.startsWith("курс:") ? courseLabel(grp) : groupTitle(grp));
  if (kind === "cancels") {
    const what = row.subject ? ` — ${row.subject}${row.subgroup ? ` (подгруппа ${row.subgroup})` : ""}` : "";
    return [`❌ Отмена · ${where(row.grp)} · ${date}`, `${slotsLabel(slots)}${what}`, row.reason].filter(Boolean).join("\n");
  }
  if (kind === "changes") {
    const from = row.from_teacher ? ` · пары ${row.from_teacher}` : "";
    return [`🔁 Замена · ${where(row.grp)} · ${date}`, `${slotsLabel(slots)}${from} → ${changeLabel(row)}`, row.reason].filter(Boolean).join("\n");
  }
  const text = String(row.text || "").slice(0, 700);
  return row.grp.startsWith("user:") ? `📢 Сообщение для вас\n${text}` : `📢 Объявление · ${where(row.grp)}\n${text}`;
}

// Пока функция на проверке, уведомления получает только владелец. На
// публикации — true.
const ALERTS_LIVE = true;

async function queueAlert(env, recipients, text) {
  if (!ALERTS_LIVE) recipients = recipients.filter((r) => String(r.id) === String(env.OWNER_ID));
  if (!recipients.length) return 0;
  const stamp = new Date().toISOString();
  const unique = [...new Set(recipients.map((r) => r.id))];
  for (let i = 0; i < unique.length; i += 100) {
    await env.STATS.batch(
      unique.slice(i, i + 100).map((id) =>
        env.STATS.prepare("INSERT INTO alerts (chat_id, text, created) VALUES (?, ?, ?)").bind(id, text, stamp)
      )
    );
  }
  return unique.length;
}

async function scanAlerts(env) {
  const from = iso(today());
  const until = iso(addDays(today(), ALERT_AHEAD_DAYS));
  for (const kind of ALERT_KINDS) {
    const mark = await env.STATS.prepare("SELECT last FROM alert_marks WHERE kind = ?").bind(kind).first();
    const top = await env.STATS.prepare(`SELECT COALESCE(MAX(id), 0) AS id FROM ${kind}`).first();
    if (!mark) {
      // Первый запуск: всё, что уже было, — не новость.
      await env.STATS.prepare("INSERT INTO alert_marks (kind, last) VALUES (?, ?)").bind(kind, top.id).run();
      continue;
    }
    if (top.id <= mark.last) continue;
    const { results = [] } = await env.STATS.prepare(`SELECT * FROM ${kind} WHERE id > ? ORDER BY id LIMIT 50`)
      .bind(mark.last)
      .all();
    for (const row of results) {
      const live = kind === "notices" ? row.expires > new Date().toISOString() : !row.removed && row.day >= from && row.day <= until;
      if (live) await queueAlert(env, await alertRecipients(env, row.grp), alertText(kind, row));
    }
    const last = results.length ? results[results.length - 1].id : mark.last;
    await env.STATS.prepare("UPDATE alert_marks SET last = ? WHERE kind = ?").bind(last, kind).run();
  }
}

async function drainAlerts(env) {
  const { results = [] } = await env.STATS.prepare(
    "SELECT id, chat_id, text FROM alerts WHERE sent = 0 ORDER BY id LIMIT ?"
  )
    .bind(ALERT_BATCH)
    .all();
  const open = { inline_keyboard: [[{ text: "📅 Открыть расписание", web_app: { url: WEB_APP_URL } }]] };
  for (const alert of results) {
    let ok = false;
    try {
      const reply = await callTelegram(env.BOT_TOKEN, "sendMessage", { chat_id: alert.chat_id, text: alert.text, reply_markup: open });
      ok = Boolean(reply?.ok);
    } catch {
      ok = false;
    }
    await env.STATS.prepare("UPDATE alerts SET sent = ? WHERE id = ?").bind(ok ? 1 : 2, alert.id).run();
  }
  await env.STATS.prepare("DELETE FROM alerts WHERE sent != 0 AND created < ?")
    .bind(new Date(Date.now() - 7 * 86400000).toISOString())
    .run();
}

/* Расписание на сайте вуза поменялось: дважды в день сверяем пары каждой
 * группы, у которой есть подписчики, на неделю вперёд с прошлым слепком.
 * Новых дней не замечаем — сообщаем, только если поменялся уже известный
 * день в ближайшие трое суток. Если поменялась бо́льшая часть групп
 * факультета разом — это переразбор файла, а не новость: молчим. */

const WATCH_TIMES = new Set(["08:10", "20:10"]);
const WATCH_AHEAD = 7;
const WATCH_TELL = 3;

function dayParity(weeks, day) {
  const found = (weeks || []).find((w) => w.from <= day && day <= w.to);
  return found ? found.parity : null;
}

function dayLessons(schedule, group, day) {
  const date = new Date(`${day}T00:00:00Z`);
  const weekday = date.getUTCDay();
  const parity = dayParity(schedule.weeks, day);
  const bells = new Map((schedule.bells || []).map((b) => [b.n, b]));
  const seen = new Set();
  const out = [];
  for (const l of schedule.lessons || []) {
    if (l.group !== group) continue;
    const on = l.dates ? l.dates.includes(day) : l.day === weekday && (l.week === "all" || !parity || l.week === parity);
    if (!on) continue;
    const start = l.start || bells.get(l.slot)?.start || "";
    const line = `${start} ${l.subject}${l.room ? ` · ${l.room}` : ""}`;
    if (seen.has(line)) continue;
    seen.add(line);
    out.push({ start, line, key: [start, l.end || "", l.subject, l.type || "", l.room || "", l.teacher || "", l.subgroup || 0, l.week].join("|") });
  }
  out.sort((a, b) => a.start.localeCompare(b.start) || a.line.localeCompare(b.line));
  return out;
}

function fingerprint(list) {
  const text = list.map((l) => l.key).sort().join("\n");
  let h = 0x811c9dc5;
  for (const char of text) h = Math.imul(h ^ char.codePointAt(0), 0x01000193) >>> 0;
  return `${list.length}:${h.toString(36)}`;
}

async function watchSchedules(env) {
  const { results = [] } = await env.STATS.prepare(
    "SELECT DISTINCT grp FROM reminders WHERE changes = 1 AND grp != ''"
  ).all();
  const byTenant = new Map();
  for (const { grp } of results) {
    const slash = grp.indexOf("/");
    const tenant = slash > 0 ? grp.slice(0, slash) : DEFAULT_TENANT;
    if (!byTenant.has(tenant)) byTenant.set(tenant, []);
    byTenant.get(tenant).push(grp);
  }
  const tenants = await loadJson("tenants.json").catch(() => []);
  const days = Array.from({ length: WATCH_AHEAD }, (_, i) => iso(addDays(today(), i))).filter(
    (day) => new Date(`${day}T00:00:00Z`).getUTCDay() !== 0
  );
  await env.STATS.prepare("DELETE FROM plan_hash WHERE day < ?").bind(days[0] || iso(today())).run();
  for (const [tenantId, groups] of byTenant) {
    const tenant = tenants.find((t) => t.id === tenantId);
    if (!tenant) continue;
    let schedule;
    try {
      schedule = await loadJson(`${tenant.path ? `${tenant.path}/` : ""}schedule.json`);
    } catch {
      continue;
    }
    const pending = [];
    let changed = 0;
    for (const grp of groups) {
      const raw = tenantId === DEFAULT_TENANT ? grp : grp.slice(tenantId.length + 1);
      let groupChanged = false;
      for (const day of days) {
        const list = dayLessons(schedule, raw, day);
        const hash = fingerprint(list);
        const old = await env.STATS.prepare("SELECT hash FROM plan_hash WHERE grp = ? AND day = ?").bind(grp, day).first();
        if (old?.hash === hash) continue;
        await env.STATS.prepare(
          "INSERT INTO plan_hash (grp, day, hash) VALUES (?, ?, ?) ON CONFLICT(grp, day) DO UPDATE SET hash = excluded.hash"
        )
          .bind(grp, day, hash)
          .run();
        if (!old) continue;
        groupChanged = true;
        if (days.indexOf(day) < WATCH_TELL) pending.push({ grp, day, list });
      }
      changed += groupChanged ? 1 : 0;
    }
    if (!pending.length) continue;
    if (groups.length >= 4 && changed / groups.length > 0.5) {
      await callTelegram(env.BOT_TOKEN, "sendMessage", { chat_id: env.OWNER_ID, text: `Сверка расписаний: у ${tenantId} изменились ${changed} из ${groups.length} групп разом — похоже на переразбор, уведомления не отправлял.` }).catch(() => {});
      continue;
    }
    for (const { grp, day, list } of pending) {
      const lines = list.slice(0, 8).map((l) => l.line);
      if (list.length > 8) lines.push(`…и ещё ${list.length - 8}`);
      const text = [
        `🗓 Расписание изменилось · ${groupTitle(grp)} · ${dateLabel(new Date(`${day}T00:00:00Z`))}`,
        lines.length ? `Теперь:\n${lines.join("\n")}` : "Теперь пар в этот день нет.",
      ].join("\n");
      await queueAlert(env, await alertRecipients(env, grp), text);
    }
  }
}

async function runAlerts(env) {
  await scanAlerts(env);
  const now = new Date(Date.now() + 3 * 3600000);
  const clock = `${String(now.getUTCHours()).padStart(2, "0")}:${String(now.getUTCMinutes()).padStart(2, "0")}`;
  if (WATCH_TIMES.has(clock)) await watchSchedules(env);
  await drainAlerts(env);
}

/** «09:05» → 545. */
function minutesOfDay(time) {
  const [h, m] = String(time).split(":").map(Number);
  return h * 60 + (m || 0);
}

/* ---------- Напоминания ---------- */

/**
 * Приложение присылает свой план на две недели: у каждого свои языки,
 * подгруппы и МФК, и восстановить их на стороне бота нельзя.
 */
async function saveReminders(env, body) {
  const user = await verifyInitData(body.initData || "", env.BOT_TOKEN);
  if (!user?.id) return { ok: false, error: "no user" };

  const morning = body.morning ? 1 : 0;
  const before = Math.min(60, Math.max(0, Number(body.before) || 0));
  // План приходит в местном времени вуза: запоминаем, на сколько часов он
  // впереди Москвы, чтобы напоминать по его часам, а не по московским.
  const shift = await shiftOf(body.group);
  // «Будильник» перед первой парой: от получаса до четырёх часов, 0 — выключен.
  const wake = Math.min(240, Math.max(0, Math.round(Number(body.wake) || 0)));
  // Уведомления об изменениях: старые версии приложения поля не шлют — включены.
  const changes = body.changes === false || body.changes === 0 ? 0 : 1;
  await env.STATS.prepare(
    `INSERT INTO reminders (tg_id, grp, morning, before, updated, shift, wake, changes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(tg_id) DO UPDATE SET grp = excluded.grp, morning = excluded.morning,
       before = excluded.before, updated = excluded.updated, shift = excluded.shift, wake = excluded.wake,
       changes = excluded.changes`
  )
    .bind(user.id, String(body.group || ""), morning, before, new Date().toISOString(), shift, wake, changes)
    .run();

  const plan = Array.isArray(body.plan) ? body.plan.slice(0, 240) : [];
  const from = iso(today());
  const writes = [
    env.STATS.prepare("DELETE FROM reminder_plan WHERE tg_id = ? OR day < ?").bind(user.id, from),
  ];
  for (const item of plan) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(item.day || "") || !/^\d{2}:\d{2}$/.test(item.start || "")) continue;
    writes.push(
      env.STATS.prepare(
        `INSERT OR REPLACE INTO reminder_plan (tg_id, day, start, end, subject, room)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).bind(
        user.id,
        item.day,
        item.start,
        String(item.end || "").slice(0, 5),
        String(item.subject || "").slice(0, 120),
        String(item.room || "").slice(0, 60)
      )
    );
  }
  await env.STATS.batch(writes);
  return { ok: true };
}

/**
 * Время, по которому живёт расписание: московское плюс сдвиг вуза в часах
 * (Оренбург — 2, Владивосток — 7). Воркер сам живёт по UTC.
 */
function moscowNow(shift = 0) {
  const now = new Date(Date.now() + (3 + shift) * 3600000);
  return {
    day: now.toISOString().slice(0, 10),
    minutes: now.getUTCHours() * 60 + now.getUTCMinutes(),
    hhmm: now.toISOString().slice(11, 16),
  };
}

// Один запуск воркера на бесплатном тарифе может сделать не больше 50
// обращений наружу. Раньше утреннее напоминание уходило всем разом, и после
// полусотни сообщений остальные просто не отправлялись — а окно было ровно
// в одну минуту, так что до них очередь уже не доходила. Теперь за запуск
// уходит не больше порции, остальные — в следующие минуты.
const REMIND_BATCH = OWN_SERVER ? 600 : 24;

// Утро — не одна минута, а окно: если в 7:30 не успели всем, дошлём до 8:30.
const MORNING_FROM = 7 * 60 + 30;
const MORNING_TO = 8 * 60 + 30;

// «Скоро пара» тоже с окном: крон бывает запаздывает на минуту-другую, и
// точное совпадение минут теряло напоминание целиком. Пишем, пока пара не
// началась, но не раньше чем за 3 минуты до срока.
const SOON_EARLY = 3;

const START_MINUTES = "(CAST(substr(p.start, 1, 2) AS INTEGER) * 60 + CAST(substr(p.start, 4, 2) AS INTEGER))";

/**
 * Сколько пар в блоке «с 9:00 до 12:15»: пара — полтора часа, перемена —
 * около пятнадцати минут. Сдвоенная пара приходит из приложения одной
 * записью, и без этого бот считал её за одну.
 */
function pairsIn(start, end) {
  const at = (time) => {
    const [h, m] = String(time || "").split(":").map(Number);
    return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null;
  };
  const from = at(start);
  const to = at(end);
  if (from === null || to === null || to <= from) return 1;
  return Math.max(1, Math.round((to - from + 15) / 105));
}

function pairsWord(n) {
  const tens = n % 100;
  const ones = n % 10;
  if (tens >= 11 && tens <= 14) return "пар";
  if (ones === 1) return "пара";
  if (ones >= 2 && ones <= 4) return "пары";
  return "пар";
}

function minutesWord(n) {
  const tens = n % 100;
  const ones = n % 10;
  if (tens >= 11 && tens <= 14) return "минут";
  if (ones === 1) return "минуту";
  if (ones >= 2 && ones <= 4) return "минуты";
  return "минут";
}

/** Раз в минуту: кому пора написать про утро и про ближайшую пару. */
async function sendReminders(env) {
  if (!env.STATS) return;
  const now = moscowNow();
  // У каждого часового пояса своё «сейчас» — собираем по поясам.
  const { results: zones = [] } = await env.STATS.prepare("SELECT DISTINCT shift FROM reminders").all();
  const outgoing = [];
  for (const { shift } of zones) {
    if (outgoing.length >= REMIND_BATCH) break;
    outgoing.push(...(await dueReminders(env, moscowNow(shift), shift, REMIND_BATCH - outgoing.length)));
  }
  return deliverReminders(env, outgoing, now);
}

/** Кому в этом часовом поясе пора написать: не больше limit сообщений. */
async function dueReminders(env, now, shift, limit) {
  const outgoing = [];

  // Сначала «скоро пара»: оно срочнее утреннего списка. Одно сообщение на
  // время начала — если без выбранного языка в одну пару стоят несколько
  // предметов, они идут одной строкой, а не пятью уведомлениями подряд.
  const { results: soon = [] } = await env.STATS.prepare(
    `SELECT p.tg_id, p.start, group_concat(p.subject, ' / ') AS subjects,
            max(p.room) AS room, max(p.end) AS end, ${START_MINUTES} AS at
     FROM reminder_plan p JOIN reminders r ON r.tg_id = p.tg_id
     WHERE p.day = ? AND r.before > 0 AND r.shift = ?
       AND ${START_MINUTES} - r.before <= ? + ?
       AND ${START_MINUTES} > ?
       AND NOT EXISTS (SELECT 1 FROM reminder_sent s WHERE s.tg_id = p.tg_id AND s.key = ? || p.start)
     GROUP BY p.tg_id, p.start
     ORDER BY at
     LIMIT ?`
  )
    .bind(now.day, shift, now.minutes, SOON_EARLY, now.minutes, `${now.day}|`, limit)
    .all();
  for (const row of soon) {
    const left = Math.max(1, row.at - now.minutes);
    outgoing.push({
      tg_id: row.tg_id,
      key: `${now.day}|${row.start}`,
      text: (() => {
        const pairs = pairsIn(row.start, row.end);
        return [
          `⏰ Через ${left} ${minutesWord(left)}: ${escape(row.subjects)}`,
          row.room ? `📍 ${escape(row.room)}` : "",
          pairs > 1
            ? `${pairs} ${pairsWord(pairs)} подряд: с ${row.start} до ${row.end}.`
            : `Начало в ${row.start}${row.end ? `, до ${row.end}` : ""}.`,
        ]
          .filter(Boolean)
          .join("\n");
      })(),
    });
  }

  // «Будильник»: один раз в день, за выбранное время до первой пары. Пишем,
  // пока пара не началась: если минута срока пропущена, сообщение не теряется.
  const wakeRoom = limit - outgoing.length;
  if (wakeRoom > 0) {
    const { results: wakes = [] } = await env.STATS.prepare(
      `SELECT r.tg_id, r.wake, f.start, f.at, f.pairs,
              (SELECT group_concat(p2.subject, ' / ') FROM reminder_plan p2
               WHERE p2.tg_id = r.tg_id AND p2.day = ?1 AND p2.start = f.start) AS subjects,
              (SELECT max(p3.room) FROM reminder_plan p3
               WHERE p3.tg_id = r.tg_id AND p3.day = ?1 AND p3.start = f.start) AS room
       FROM reminders r
       JOIN (SELECT p.tg_id, MIN(p.start) AS start, MIN(${START_MINUTES}) AS at, COUNT(DISTINCT p.start) AS pairs
             FROM reminder_plan p WHERE p.day = ?1 GROUP BY p.tg_id) f ON f.tg_id = r.tg_id
       WHERE r.wake > 0 AND r.shift = ?2
         AND f.at - r.wake <= ?3 AND f.at > ?3
         AND NOT EXISTS (SELECT 1 FROM reminder_sent s WHERE s.tg_id = r.tg_id AND s.key = ?4)
       LIMIT ?5`
    )
      .bind(now.day, shift, now.minutes, `${now.day}|wake`, wakeRoom)
      .all();
    for (const row of wakes) {
      const left = row.at - now.minutes;
      const hours = Math.floor(left / 60);
      const mins = left % 60;
      const span = [hours ? `${hours} ч` : "", mins ? `${mins} мин` : ""].filter(Boolean).join(" ") || "меньше минуты";
      outgoing.push({
        tg_id: row.tg_id,
        key: `${now.day}|wake`,
        text: [
          `⏰ Пора вставать: первая пара в ${row.start}, через ${span}`,
          escape(row.subjects || ""),
          row.room ? `📍 ${escape(row.room)}` : "",
          row.pairs > 1 ? `Всего сегодня занятий: ${row.pairs}.` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      });
    }
  }

  // Утро: сколько осталось места в порции.
  const room = limit - outgoing.length;
  if (room > 0 && now.minutes >= MORNING_FROM && now.minutes < MORNING_TO) {
    const { results: people = [] } = await env.STATS.prepare(
      `SELECT r.tg_id, r.grp FROM reminders r WHERE r.morning = 1 AND r.shift = ?
       AND EXISTS (SELECT 1 FROM reminder_plan p WHERE p.tg_id = r.tg_id AND p.day = ?)
       AND NOT EXISTS (SELECT 1 FROM reminder_sent s WHERE s.tg_id = r.tg_id AND s.key = ?)
       LIMIT ?`
    )
      .bind(shift, now.day, `${now.day}|morning`, room)
      .all();

    if (people.length) {
      // Планы всей порции — одним запросом, а не по запросу на человека.
      const ids = people.map((p) => p.tg_id);
      const { results: plan = [] } = await env.STATS.prepare(
        `SELECT tg_id, start, end, subject, room FROM reminder_plan
         WHERE day = ? AND tg_id IN (${ids.map(() => "?").join(",")})
         ORDER BY tg_id, start`
      )
        .bind(now.day, ...ids)
        .all();
      // Отмены на сегодня — строкой в утренней сводке: план их уже не
      // содержит, но человек должен знать, что пару убрали, а не забыли.
      const { results: cancelled = [] } = await env.STATS.prepare(
        "SELECT grp, slots, subject, subgroup, reason FROM cancels WHERE removed = 0 AND day = ?"
      )
        .bind(now.day)
        .all();
      const groups = cancelled.length ? new Map((await loadGroups().catch(() => [])).map((g) => [g.id, g])) : new Map();
      const grpOf = new Map(people.map((p) => [p.tg_id, p.grp]));

      for (const id of ids) {
        // Одно время — одна строка, даже если предметов в это время несколько.
        const byStart = new Map();
        for (const lesson of plan.filter((l) => l.tg_id === id)) {
          if (!byStart.has(lesson.start)) byStart.set(lesson.start, { ...lesson, subjects: [] });
          const block = byStart.get(lesson.start);
          block.subjects.push(lesson.subject);
          // Несколько предметов в одно время: блок кончается с самым длинным.
          if ((lesson.end || "") > (block.end || "")) block.end = lesson.end;
        }
        const lessons = [...byStart.values()];
        if (!lessons.length) continue;
        for (const l of lessons) l.pairs = pairsIn(l.start, l.end);
        const total = lessons.reduce((sum, l) => sum + l.pairs, 0);
        const lines = [];
        // Новое в сводке до публикации видит только владелец.
        const extras = ALERTS_LIVE || String(id) === String(env.OWNER_ID);
        lessons.forEach((l, i) => {
          // Окно между парами от 40 минут — отдельной строкой: его видно сразу.
          const prev = lessons[i - 1];
          if (extras && prev?.end && l.start) {
            const gap = minutesOfDay(l.start) - minutesOfDay(prev.end);
            if (gap >= 40) lines.push(`☕ окно ${prev.end}–${l.start}`);
          }
          lines.push(
            `${l.start}–${l.end || "?"} · ${escape(l.subjects.join(" / "))}` +
              (l.pairs > 1 ? ` (${l.pairs} ${pairsWord(l.pairs)} подряд)` : "") +
              (l.room ? `\n      📍 ${escape(l.room)}` : "")
          );
        });
        const grp = grpOf.get(id) || "";
        const group = groups.get(grp);
        const mine = extras ? cancelled.filter((c) => c.grp === grp || (group && c.grp === courseOf(group))) : [];
        const cancelLines = mine.map((c) => {
          const slots = c.slots ? c.slots.split(",").map(Number) : [];
          const what = c.subject ? ` — ${escape(c.subject)}${c.subgroup ? ` (подгруппа ${c.subgroup})` : ""}` : "";
          return `❌ отменено: ${slotsLabel(slots)}${what}${c.reason ? ` · ${escape(c.reason)}` : ""}`;
        });
        outgoing.push({
          tg_id: id,
          key: `${now.day}|morning`,
          text: [
            `☀️ Сегодня ${total === 1 ? "одна пара" : `пар: ${total}`}`,
            "",
            ...lines,
            ...(cancelLines.length ? ["", ...cancelLines] : []),
            "",
            `Начало в ${lessons[0].start}, конец в ${lessons.at(-1).end || "?"}.`,
          ].join("\n"),
        });
      }
    }
  }

  return outgoing;
}

async function deliverReminders(env, outgoing, now) {
  // Отправляем по одному. Отметку ставим и когда Telegram отказал (человек
  // заблокировал бота) — долбиться в него каждую минуту не надо. А если
  // упала сама отправка (кончился лимит обращений), дальше не шлём: эти
  // люди останутся без отметки и получат своё в следующую минуту.
  const sent = [];
  for (const item of outgoing) {
    try {
      await callTelegram(env.BOT_TOKEN, "sendMessage", {
        chat_id: item.tg_id,
        text: item.text,
        parse_mode: "HTML",
      });
      sent.push(item);
    } catch (error) {
      console.log("reminder stopped", String(error?.message || error));
      break;
    }
  }

  // Все отметки — одним пакетом: это одно обращение к базе, а не по одному
  // на сообщение.
  if (sent.length) {
    await env.STATS.batch(
      sent.map((item) =>
        env.STATS.prepare("INSERT OR IGNORE INTO reminder_sent (tg_id, key) VALUES (?, ?)").bind(
          item.tg_id,
          item.key
        )
      )
    );
  }
  if (outgoing.length) console.log(`reminders: sent ${sent.length} of ${outgoing.length}`);

  // Старые отметки не нужны: чистим раз в сутки, в начале утреннего окна.
  // Вчерашние оставляем: к западу от Москвы вчера ещё может длиться.
  if (now.minutes === MORNING_FROM) {
    const yesterday = new Date(Date.now() + 3 * 3600000 - 86400000).toISOString().slice(0, 10);
    await env.STATS.prepare("DELETE FROM reminder_sent WHERE key < ?").bind(yesterday).run();
  }
  return sent.length;
}

/* ---------- Важные пары ---------- */

const IMPORTANT_HELP = [
  "<b>Важные пары</b> — красная полоса и метка «важно» у всех студентов.",
  "",
  "/important Ильин — все пары преподавателя (по фамилии)",
  "/important предмет Теория международных отношений — все пары предмета",
  "/unimportant Ильин — снять",
  "/important — список",
].join("\n");

/** Весь список — он короткий и один на всех, приложение сверяет само. */
async function importantList(env) {
  if (!env.STATS) return [];
  const { results = [] } = await env.STATS.prepare(
    "SELECT kind, value FROM important ORDER BY created LIMIT 50"
  ).all();
  return results;
}

async function importantCommand(env, text) {
  const body = String(text).replace(/^\/(un)?important(@\w+)?/, "").trim();
  const remove = text.startsWith("/unimportant");
  if (!body) {
    const list = await importantList(env);
    const lines = list.map((row) => `• ${row.kind === "subject" ? "предмет" : "преподаватель"}: ${escape(row.value)}`);
    return [IMPORTANT_HELP, "", lines.length ? lines.join("\n") : "Пока ничего не помечено."].join("\n");
  }
  // «предмет …» — точное название, как в расписании; иначе — фамилия.
  const subject = body.match(/^предмет\s+(.+)$/i);
  const kind = subject ? "subject" : "teacher";
  const value = (subject ? subject[1] : body.split(/\s+/)[0]).trim().slice(0, 120);
  if (remove) {
    const result = await env.STATS.prepare("DELETE FROM important WHERE value = ? COLLATE NOCASE")
      .bind(value)
      .run();
    return result.meta?.changes ? `Снято: ${escape(value)}.` : `«${escape(value)}» не был помечен.`;
  }
  await env.STATS.prepare(
    `INSERT INTO important (kind, value, created) VALUES (?, ?, ?)
     ON CONFLICT(value) DO UPDATE SET kind = excluded.kind`
  )
    .bind(kind, value, new Date().toISOString())
    .run();
  return `🔴 Помечено как важное — ${kind === "subject" ? "предмет" : "преподаватель"}: ${escape(value)}.\nСтуденты увидят при следующем открытии расписания.`;
}

/* ---------- Темы оформления ---------- */

const THEME_NAMES = {
  гламур: "glam",
  glam: "glam",
  брутал: "brutal",
  brutal: "brutal",
  чемпион: "champion",
  champion: "champion",
  волонтёр: "volunteer",
  волонтер: "volunteer",
  зелёная: "volunteer",
  зеленая: "volunteer",
  volunteer: "volunteer",
  цска: "cska",
  cska: "cska",
  нокия: "nokia",
  нокиа: "nokia",
  nokia: "nokia",
  "8бит": "nokia",
  "8bit": "nokia",
  "океан": "ocean",
  ocean: "ocean",
  "голубая": "ocean",
  "закат": "sunset",
  sunset: "sunset",
  "оранжевая": "sunset",
  "мята": "mint",
  mint: "mint",
  "бирюзовая": "mint",
  "лаванда": "lavender",
  lavender: "lavender",
  "фиолетовая": "lavender",
  "графит": "graphite",
  graphite: "graphite",
  "серая": "graphite",
  "вишня": "cherry",
  cherry: "cherry",
  "красная": "cherry",
  "дьявол": "devil",
  "прада": "devil",
  "devil": "devil",
  "prada": "devil",
  "чёрно-красная": "devil",
  "черно-красная": "devil",
  "мгу": "msu",
  "msu": "msu",
  "высотка": "msu",
};

const THEME_HELP = [
  "<b>Темы оформления</b> — выдаёт только владелец, сам человек их не включает.",
  "",
  "/theme @ivanov гламур — розовые акценты",
  "/theme @ivanov брутал — чёрный с золотом",
  "/theme @ivanov чемпион — золото и корона, приз победителю кликера",
  "/theme @ivanov волонтёр — зелёная, тем, кто распространяет расписание; её человек может сам выключить в настройках",
  "/theme @ivanov цска — красно-синяя, для болельщиков",
  "/theme @ivanov нокия — 8-битная, как экран Nokia 3310",
  "/theme @ivanov океан — голубая",
  "/theme @ivanov закат — оранжево-розовая",
  "/theme @ivanov мята — бирюзовая",
  "/theme @ivanov лаванда — фиолетовая",
  "/theme @ivanov графит — строгая серая",
  "/theme @ivanov вишня — тёмно-красная",
  "/theme @ivanov дьявол — чёрная с красным, как с подиума",
  "/theme @ivanov мгу — синяя с золотом и силуэтом Главного здания",
  "/theme вуз:мгу мгу — всем, у кого выбран факультет МГУ",
  "/theme @ivanov снять — вернуть обычный вид",
  "/theme 311гэу гламур — всей группе, можно и курс («3курс», «все»)",
  "/themes — кому что выдано",
].join("\n");

/* ---------- Поделиться расписанием ---------- */

// Настройки (вуз, группа, языки, МФК) не влезают в ссылку Telegram: там
// 64 знака. Поэтому храним их у себя под коротким кодом, а в ссылке — код.
const SHARE_PER_USER = 20;
const SHARE_PREFS_MAX = 3000;

function shareCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return [...bytes].map((b) => "abcdefghijkmnpqrstuvwxyz23456789"[b % 32]).join("");
}

async function shareSave(env, body) {
  const user = await verifyInitData(body.initData || "", env.BOT_TOKEN);
  if (!user?.id) return { ok: false, error: "no user" };
  if (!body.prefs || typeof body.prefs !== "object" || Array.isArray(body.prefs)) return { ok: false, error: "no prefs" };
  const prefs = JSON.stringify(body.prefs);
  if (prefs.length > SHARE_PREFS_MAX) return { ok: false, error: "too big" };
  const name = String(body.name || "").replace(/\s+/g, " ").trim().slice(0, 24);
  const code = shareCode();
  await env.STATS.batch([
    env.STATS.prepare("INSERT INTO shares (code, owner, name, prefs, created) VALUES (?, ?, ?, ?, ?)").bind(
      code,
      user.id,
      name,
      prefs,
      new Date().toISOString()
    ),
    // У человека остаются последние ссылки: старые перестают работать.
    env.STATS.prepare(
      `DELETE FROM shares WHERE owner = ?1 AND code NOT IN
         (SELECT code FROM shares WHERE owner = ?1 ORDER BY created DESC LIMIT ?2)`
    ).bind(user.id, SHARE_PER_USER),
  ]);
  return { ok: true, code };
}

/* ---------- Приглашение группы ---------- */

// Ссылка на расписание группы целиком: открыл — и приложение сразу настроено
// на эту группу. Код зависит только от факультета и группы, поэтому у всей
// группы одна и та же ссылка, а записей в базе столько же, сколько групп.
async function inviteCode(tenantId, group) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${tenantId}|${group}`)));
  return [...digest.slice(0, 8)].map((b) => "abcdefghijkmnpqrstuvwxyz23456789"[b % 32]).join("");
}

async function inviteSave(env, body) {
  const tenantId = String(body.tenant || "").slice(0, 60);
  const group = String(body.group || "").slice(0, 160);
  if (!tenantId || !group) return { ok: false, error: "no group" };
  const tenants = await loadTenants().catch(() => []);
  if (tenants.length && !tenants.some((t) => t.id === tenantId)) return { ok: false, error: "no tenant" };
  const name = String(body.name || "").replace(/\s+/g, " ").trim().slice(0, 40);
  const code = await inviteCode(tenantId, group);
  await env.STATS.prepare("INSERT OR IGNORE INTO shares (code, owner, name, prefs, created) VALUES (?, 0, ?, ?, ?)")
    .bind(code, name, JSON.stringify({ tenant: tenantId, group }), new Date().toISOString())
    .run();
  return { ok: true, code };
}

async function shareLoad(env, code) {
  if (!/^[a-z0-9]{8}$/.test(code || "")) return { ok: false, error: "bad code" };
  const row = await env.STATS.prepare("SELECT name, prefs FROM shares WHERE code = ?").bind(code).first();
  if (!row) return { ok: false, error: "not found" };
  let prefs = null;
  try {
    prefs = JSON.parse(row.prefs);
  } catch {
    return { ok: false, error: "broken" };
  }
  return { ok: true, name: row.name, prefs };
}

/* ---------- Реклама и рост ---------- */

const ADS_HELP = [
    "<b>Рекламные метки</b> — чтобы видеть, откуда приходят люди.",
    "",
    "Ссылка для размещения: <code>https://t.me/FGPshedulebot?start=ad_МЕТКА</code>",
    "Метка — латиница, цифры, «_» и «-», до 40 знаков: <code>ad_mgimo_chat1</code>.",
    "",
    "/ads — сколько пришло по каждой метке",
    "/faculties — сколько людей на каждом факультете",
].join("\n");

/** Сколько людей пришло по каждой метке и сколько из них открыли расписание. */
async function adsReport(env) {
  const { results = [] } = await env.STATS.prepare(
    `SELECT s.label, COUNT(*) AS came,
            SUM(CASE WHEN p.tg_id IS NOT NULL THEN 1 ELSE 0 END) AS opened,
            SUM(CASE WHEN s.created >= ?1 THEN 1 ELSE 0 END) AS week,
            MIN(s.created) AS first
     FROM sources s LEFT JOIN (SELECT DISTINCT tg_id FROM people WHERE tg_id IS NOT NULL) p ON p.tg_id = s.tg_id
     GROUP BY s.label ORDER BY came DESC LIMIT 60`
  )
    .bind(new Date(Date.now() - 7 * 86400000).toISOString())
    .all();
  if (!results.length) return [ADS_HELP, "", "По меткам пока никто не приходил."].join("\n");
  const lines = results.map(
    (r) =>
      `<code>${escape(r.label)}</code> — пришло ${r.came}, открыли расписание ${r.opened}` +
      (r.week ? `, за неделю +${r.week}` : "") +
      ` · с ${String(r.first).slice(0, 10)}`
  );
  return ["<b>Рекламные метки</b>", "", ...lines, "", "«Пришло» — нажали «Запустить» по ссылке; «открыли» — после этого зашли в расписание."].join("\n");
}

/** Люди по факультетам: всего, новых и активных за неделю. */
async function facultiesReport(env) {
  const since = new Date(Date.now() - 7 * 86400000).toISOString();
  const { results = [] } = await env.STATS.prepare(
    `SELECT CASE WHEN grp LIKE 'преп:%' THEN '~teachers'
                 WHEN instr(grp, '/') > 0 THEN substr(grp, 1, instr(grp, '/') - 1)
                 ELSE 'msu-fgp' END AS tenant,
            COUNT(*) AS total,
            SUM(CASE WHEN first >= ?1 THEN 1 ELSE 0 END) AS fresh,
            SUM(CASE WHEN last >= ?1 THEN 1 ELSE 0 END) AS active
     FROM people WHERE grp IS NOT NULL AND grp != '' GROUP BY tenant ORDER BY total DESC`
  )
    .bind(since)
    .all();
  const tenants = await loadTenants().catch(() => []);
  const title = (id) => {
    if (id === "~teachers") return "Преподаватели (все вузы)";
    const t = tenants.find((x) => x.id === id);
    return t ? `${t.university} · ${t.short || t.faculty}` : id;
  };
  const sum = (key) => results.reduce((n, r) => n + (r[key] || 0), 0);
  const seen = new Set(results.map((r) => r.tenant));
  const empty = tenants.filter((t) => !seen.has(t.id)).map((t) => `${t.university} · ${t.short || t.faculty}`);
  return [
    "<b>Люди по факультетам</b>",
    `Всего ${sum("total")} · новых за неделю ${sum("fresh")} · заходили за неделю ${sum("active")}`,
    "",
    ...results.map((r) => `${escape(title(r.tenant))} — ${r.total}` + (r.fresh ? ` (+${r.fresh})` : "") + ` · активных ${r.active}`),
    ...(empty.length ? ["", `<i>Пока никого: ${escape(empty.join("; "))}</i>`] : []),
    "",
    "В скобках — новые за 7 дней. Считается по последней выбранной группе.",
  ].join("\n");
}

/* ---------- Заходы одного человека ---------- */

const VISITS_HELP = "Кого смотреть? <code>/visits @username</code> или <code>/visits 123456789</code>";

/** «13.10 в 14:05» по московскому времени и сколько это назад. */
function whenMsk(iso) {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "—";
  const msk = new Date(at.getTime() + 3 * 3600000);
  const two = (n) => String(n).padStart(2, "0");
  const ago = Math.max(0, Date.now() - at.getTime());
  const days = Math.floor(ago / 86400000);
  const since = days >= 1 ? `${days} дн. назад` : ago >= 3600000 ? `${Math.floor(ago / 3600000)} ч назад` : `${Math.max(1, Math.floor(ago / 60000))} мин назад`;
  return `${two(msk.getUTCDate())}.${two(msk.getUTCMonth() + 1)} в ${two(msk.getUTCHours())}:${two(msk.getUTCMinutes())} (${since})`;
}

/** Группа так, как её видит человек: «МГУ · ВМК · 107». */
async function groupLabel(grp) {
  if (!grp) return "группа не выбрана";
  if (grp.startsWith("преп:")) return `преподаватель ${grp.slice(5)}`;
  const slash = grp.indexOf("/");
  const tenantId = slash > 0 ? grp.slice(0, slash) : "msu-fgp";
  const name = slash > 0 ? grp.slice(slash + 1) : grp;
  const tenant = (await loadTenants().catch(() => [])).find((t) => t.id === tenantId);
  return tenant ? `${tenant.university} · ${tenant.short || tenant.faculty} · ${name}` : grp;
}

/** /visits — что известно о заходах одного человека. Только владельцу. */
async function visitsReport(env, who) {
  if (!who) return VISITS_HELP;
  const person = await findPerson(env, who);
  if (!person?.tg_id) {
    return `Не нашёл «${escape(who)}». Человек должен хоть раз открыть расписание или написать боту.`;
  }
  const id = person.tg_id;
  const { results: rows = [] } = await env.STATS.prepare(
    "SELECT first, last, grp, name, username FROM people WHERE tg_id = ? ORDER BY last DESC"
  ).bind(id).all();
  const known = rows[0] || {};
  const name = known.name || person.name || "";
  const nick = known.username || person.username || "";
  const lines = [
    `<b>${escape(name || "Без имени")}</b>${nick ? ` · @${escape(nick)}` : ""} · id <code>${id}</code>`,
  ];
  if (!rows.length) {
    lines.push("", "Расписание не открывал — только писал боту.");
    return lines.join("\n");
  }
  lines.push("", `Группа: ${escape(await groupLabel(known.grp || ""))}`);
  const first = rows.reduce((min, r) => (r.first < min ? r.first : min), rows[0].first);
  lines.push(`Первый заход: ${whenMsk(first)}`, `Последний заход: ${whenMsk(known.last)}`);

  const remind = await env.STATS.prepare("SELECT morning, before FROM reminders WHERE tg_id = ?").bind(id).first();
  const on = [remind?.morning ? "утром" : "", remind?.before ? `за ${remind.before} мин до пары` : ""].filter(Boolean);
  lines.push(`Напоминания: ${on.length ? on.join(", ") : "выключены"}`);
  const source = await env.STATS.prepare("SELECT label FROM sources WHERE tg_id = ? LIMIT 1").bind(id).first().catch(() => null);
  if (source?.label) lines.push(`Пришёл по метке: <code>${escape(source.label)}</code>`);
  const theme = await env.STATS.prepare("SELECT theme FROM themes WHERE target = ?").bind(`user:${id}`).first();
  if (theme?.theme) lines.push(`Тема: ${escape(theme.theme)}`);
  const starosta = await env.STATS.prepare("SELECT grp FROM starostas WHERE tg_id = ? LIMIT 1").bind(id).first().catch(() => null);
  if (starosta?.grp) lines.push(`Староста: ${escape(await groupLabel(starosta.grp))}`);
  // Журнал за последние 30 дней: по дням, со временем каждого захода.
  const { results: log = [] } = await env.STATS.prepare(
    "SELECT at FROM visits WHERE tg_id = ? AND at >= ? ORDER BY at DESC LIMIT 200"
  ).bind(id, new Date(Date.now() - VISITS_KEEP_DAYS * 86400000).toISOString()).all();
  if (log.length) {
    const days = new Map();
    for (const row of log) {
      const msk = new Date(new Date(row.at).getTime() + 3 * 3600000);
      const two = (n) => String(n).padStart(2, "0");
      const day = `${two(msk.getUTCDate())}.${two(msk.getUTCMonth() + 1)}`;
      if (!days.has(day)) days.set(day, []);
      days.get(day).push(`${two(msk.getUTCHours())}:${two(msk.getUTCMinutes())}`);
    }
    lines.push("", `<b>Заходы за ${VISITS_KEEP_DAYS} дней</b> — ${log.length}, дней с заходами — ${days.size}`);
    for (const [day, times] of [...days].slice(0, 30)) lines.push(`${day}: ${times.reverse().join(", ")}`);
  } else {
    lines.push("", `Журнал заходов пуст: он ведётся с 13 октября 2026 года и хранит ${VISITS_KEEP_DAYS} дней.`);
  }
  return lines.join("\n");
}

/* ---------- Удаление своих данных ---------- */

const FORGET_HELP = [
  "<b>Удаление данных</b>",
  "",
  "Бот хранит о вас: имя и ник из Telegram, группу, время заходов за последние 30 дней, настройки напоминаний, места в очередях, комментарии, попытки в играх.",
  "",
  "Чтобы стереть всё это, отправьте: <code>/forget да</code>",
  "Расписание после этого продолжит открываться — данные появятся снова, только если вы снова им воспользуетесь.",
].join("\n");

/**
 * Стирает всё, что бот знает о человеке. Блокировки не трогаем: иначе
 * забаненный снимал бы бан одной командой. Домашка, которую он вносил как
 * староста, остаётся группе — обезличенной.
 */
async function forgetUser(env, userId) {
  const id = Number(userId);
  const uid = toHex(await hmac(env.STATS_SALT || "salt", String(id))).slice(0, 32);
  const run = (sql, ...args) => env.STATS.prepare(sql).bind(...args);
  const results = await env.STATS.batch([
    run("DELETE FROM people WHERE tg_id = ? OR uid = ?", id, uid),
    run("DELETE FROM visits WHERE tg_id = ?", id),
    run("DELETE FROM users WHERE id = ?", id),
    run("DELETE FROM outbox WHERE chat_id = ?", id),
    run("DELETE FROM reminders WHERE tg_id = ?", id),
    run("DELETE FROM reminder_plan WHERE tg_id = ?", id),
    run("DELETE FROM reminder_sent WHERE tg_id = ?", id),
    run("DELETE FROM queue_spots WHERE tg_id = ?", id),
    run("DELETE FROM comments WHERE tg_id = ?", id),
    run("DELETE FROM comment_reports WHERE tg_id = ?", id),
    run("DELETE FROM clicker WHERE user_id = ?", id),
    run("DELETE FROM shares WHERE owner = ?", id),
    run("DELETE FROM sources WHERE tg_id = ?", id),
    run("DELETE FROM word_guesses WHERE user_id = ?", id),
    run("UPDATE word_wins SET name = '', user_id = 0 WHERE user_id = ?", id),
    run("DELETE FROM starostas WHERE tg_id = ?", id),
    run("DELETE FROM starosta_requests WHERE tg_id = ?", id),
    run("DELETE FROM themes WHERE target = ?", `user:${id}`),
    run("DELETE FROM greetings WHERE target = ?", `user:${id}`),
    run("DELETE FROM notices WHERE grp = ?", `user:${id}`),
    run("UPDATE homework SET author = 0 WHERE author = ?", id),
    run("UPDATE queues SET author = 0 WHERE author = ?", id),
  ]);
  return results.reduce((sum, r) => sum + (r.meta?.changes || 0), 0);
}

/* ---------- Приветствие на заставке ---------- */

const HELLO_MAX = 120;
const HELLO_HELP = [
  "<b>Приветствие на заставке</b> — надпись, которую человек видит при открытии расписания.",
  "",
  "/hello @ivanov Удачи на коллоквиуме! — одному человеку",
  "/hello 311гэу С днём группы! — группе, можно курс («3курс») и «все»",
  "/hello @ivanov снять — вернуть обычное приветствие",
  "/hellos — кому что написано",
  "",
  "«{имя}» в тексте заменится на имя из Telegram. Личная надпись важнее групповой. Человек увидит её со следующего открытия.",
].join("\n");

/** Надпись для человека: личная важнее групповой, та — курсовой и общей. */
async function helloFor(env, userId, group) {
  if (!env.STATS) return "";
  const row = await env.STATS.prepare(
    `SELECT text FROM greetings WHERE target IN (?, ?, ?, '*')
     ORDER BY CASE target WHEN ? THEN 0 WHEN ? THEN 1 WHEN ? THEN 2 ELSE 3 END LIMIT 1`
  )
    .bind(
      `user:${userId || 0}`,
      group?.id || "—",
      courseOf(group || {}),
      `user:${userId || 0}`,
      group?.id || "—",
      courseOf(group || {})
    )
    .first();
  return row?.text || "";
}

async function helloCommand(env, text) {
  const rest = glueCourse(String(text).replace(/^\/hello(@\w+)?/, "").trim());
  const [target = "", ...words] = rest.split(/\s+/).filter(Boolean);
  const body = words.join(" ").trim();
  if (!target || !body) return HELLO_HELP;
  const off = ["снять", "убрать", "off", "нет"].includes(body.toLowerCase());
  if (!off && body.length > HELLO_MAX) return `Слишком длинно: ${body.length} знаков, а на заставку влезает ${HELLO_MAX}.`;

  const resolved = await resolveTargets(target, env);
  if (resolved.error) return resolved.error;
  const now = new Date().toISOString();
  await env.STATS.batch(
    resolved.ids.map((id) =>
      off
        ? env.STATS.prepare("DELETE FROM greetings WHERE target = ?").bind(id)
        : env.STATS.prepare(
            `INSERT INTO greetings (target, text, created) VALUES (?, ?, ?)
             ON CONFLICT(target) DO UPDATE SET text = excluded.text, created = excluded.created`
          ).bind(id, body, now)
    )
  );
  const who = resolved.ids.map((id) => targetLabel(id)).join(", ");
  return off ? `Приветствие снято: ${escape(who)}.` : `Приветствие для ${escape(who)}:\n«${escape(body)}»`;
}

async function hellosList(env) {
  const { results = [] } = await env.STATS.prepare(
    "SELECT target, text FROM greetings ORDER BY created DESC LIMIT 60"
  ).all();
  if (!results.length) return `${HELLO_HELP}\n\nПока никому ничего не написано.`;
  const lines = results.map((row) => `• ${escape(targetLabel(row.target))} — «${escape(row.text)}»`);
  return [HELLO_HELP, "", ...lines].join("\n");
}

/** Тема человека: личная важнее групповой. */
async function themeFor(env, userId, group) {
  if (!env.STATS) return "";
  // Вуз группы: у ФГП в id нет факультета, у остальных — «факультет/группа».
  const tenantId = group?.id?.includes("/") ? group.id.split("/")[0] : "msu-fgp";
  const tenants = await loadTenants().catch(() => []);
  const university = tenants.find((t) => t.id === tenantId)?.university;
  const uni = university ? `uni:${normalize(university)}` : "—";
  const row = await env.STATS.prepare(
    `SELECT theme FROM themes WHERE target IN (?, ?, ?, ?, '*')
     ORDER BY CASE target WHEN ? THEN 0 WHEN ? THEN 1 WHEN ? THEN 2 WHEN ? THEN 3 ELSE 4 END LIMIT 1`
  )
    .bind(
      `user:${userId || 0}`,
      group?.id || "—",
      courseOf(group || {}),
      uni,
      `user:${userId || 0}`,
      group?.id || "—",
      courseOf(group || {}),
      uni
    )
    .first();
  return row?.theme || "";
}

async function themeCommand(env, text) {
  const words = glueCourse(String(text).replace(/^\/theme(@\w+)?/, "").trim()).split(/\s+/).filter(Boolean);
  if (!words.length) return THEME_HELP;
  const [target, name = ""] = words;
  const theme = THEME_NAMES[name.toLowerCase()] || "";
  const off = ["снять", "убрать", "off", "нет"].includes(name.toLowerCase());
  if (!theme && !off) return `Не понял тему «${escape(name)}».\n\n${THEME_HELP}`;

  const resolved = await resolveTargets(target, env);
  if (resolved.error) return resolved.error;
  const now = new Date().toISOString();
  await env.STATS.batch(
    resolved.ids.map((id) =>
      off
        ? env.STATS.prepare("DELETE FROM themes WHERE target = ?").bind(id)
        : env.STATS.prepare(
            `INSERT INTO themes (target, theme, created) VALUES (?, ?, ?)
             ON CONFLICT(target) DO UPDATE SET theme = excluded.theme, created = excluded.created`
          ).bind(id, theme, now)
    )
  );
  const who = resolved.ids.map((id) => targetLabel(id)).join(", ");
  return off ? `Тема снята: ${escape(who)}.` : `Тема «${escape(name)}» выдана: ${escape(who)}.`;
}

/**
 * Прислал расписание — получает зелёную тему волонтёра. Уже выданную тему
 * (ЦСКА, брутал…) не трогаем.
 */
async function grantVolunteer(env, from) {
  if (!env.STATS || !from?.id) return;
  await env.STATS.prepare(
    "INSERT INTO themes (target, theme, created) VALUES (?, 'volunteer', ?) ON CONFLICT(target) DO NOTHING"
  )
    .bind(`user:${from.id}`, new Date().toISOString())
    .run();
}

async function themesList(env) {
  const { results = [] } = await env.STATS.prepare(
    "SELECT target, theme FROM themes ORDER BY created DESC LIMIT 60"
  ).all();
  if (!results.length) return `${THEME_HELP}\n\nПока никому ничего не выдано.`;
  const lines = results.map((row) => `• ${escape(targetLabel(row.target))} — ${escape(row.theme)}`);
  return [THEME_HELP, "", ...lines].join("\n");
}

/* ---------- Кликер посвящения ---------- */

// Праздничная плашка в приложении — ещё и кликер: кто нажмёт больше всех
// до конца, получает приз. Приложение копит нажатия и шлёт пачкой раз в
// несколько секунд, здесь пачка проверяется на скорость и прибавляется.
// До конца посвящения — полночь с пятницы на субботу.
const CLICKER = { event: "posvyat-2026", ends: Date.parse("2026-10-03T00:00:00+03:00") };
// Пальцами быстрее 20 нажатий в секунду не выходит — лишнее не засчитываем.
const CLICKER_RATE = 20;
// Пачка приходит раз в 15 секунд – 2 минуты (см. CLICKER_FLUSH_MIN/MAX).
// Если связи не было дольше, засчитываем не больше чем за две с половиной.
const CLICKER_WINDOW = 150;
// Как часто приложения шлют пачки, решает сервер — сам, по нагрузке. У
// бесплатного Cloudflare 100 тысяч запросов и записей в базу на сутки на
// весь бот; кликеру отдаём до 6 тысяч пачек в час. Чем больше людей
// кликает прямо сейчас, тем реже каждый шлёт пачку: до 25 человек — раз
// в 15 секунд, 100 — раз в минуту, от 200 — раз в 2 минуты. Счётчик на телефоне
// растёт мгновенно при любом интервале, реже обновляется только таблица.
// Дольше 2 минут приложение не ждёт, а пачка за это время должна влезть
// в CLICKER_WINDOW.
const CLICKER_FLUSH_MIN = 15000;
const CLICKER_FLUSH_MAX = 120000;
const CLICKER_PER_HOUR = 6000;
// Таблица лидеров читает всех игроков разом, поэтому держим её в памяти:
// иначе каждый открывший таблицу тратил бы дневной лимит чтений базы.
let clickerCache = { at: 0, rows: [], flush: CLICKER_FLUSH_MIN };

/** Интервал пачек по числу кликающих сейчас — тех, кто прислал пачку недавно. */
function clickerFlush(rows) {
  const now = Math.floor(Date.now() / 1000);
  // Окно — два прошлых интервала: при редких пачках активный игрок иначе
  // выпадал бы из подсчёта, и интервал бы скакал туда-обратно.
  const span = Math.max(120, (2 * clickerCache.flush) / 1000);
  const active = rows.filter((row) => now - row.updated < span).length;
  const wanted = Math.ceil((active * 3600) / CLICKER_PER_HOUR) * 1000;
  return Math.min(CLICKER_FLUSH_MAX, Math.max(CLICKER_FLUSH_MIN, wanted));
}

function clickerName(user) {
  const first = String(user.first_name || "").trim();
  const last = String(user.last_name || "").trim();
  return (`${first}${last ? ` ${last[0]}.` : ""}`.trim() || "Без имени").slice(0, 40);
}

async function clickerRows(env) {
  const ttl = Date.now() >= CLICKER.ends ? 300000 : 15000;
  if (Date.now() - clickerCache.at < ttl) return clickerCache.rows;
  // Убранных из таблицы читаем тоже: пачки они шлют, нагрузку дают.
  const { results = [] } = await env.STATS.prepare(
    `SELECT user_id, name, grp, taps, updated, banned FROM clicker
     WHERE event = ? AND taps > 0
     ORDER BY taps DESC, updated ASC`
  )
    .bind(CLICKER.event)
    .all();
  const rows = results.filter((row) => !row.banned);
  clickerCache = { at: Date.now(), rows, flush: clickerFlush(results) };
  return rows;
}

function clickerBoard(rows, userId, mine, group) {
  // Своё место — по свежему своему счёту против чуть устаревших чужих.
  const others = rows.filter((row) => row.user_id !== userId);
  const place = mine > 0 ? others.filter((row) => row.taps > mine).length + 1 : null;
  const top = others.slice(0, 10).map((row) => ({ name: row.name, group: row.grp, taps: row.taps, me: false }));
  if (place && place <= 10) {
    const me = rows.find((row) => row.user_id === userId);
    top.splice(place - 1, 0, { name: me?.name || "", group: me?.grp || group, taps: mine, me: true });
    top.length = Math.min(top.length, 10);
  }

  const byGroup = new Map();
  for (const row of rows) {
    const item = byGroup.get(row.grp) || { group: row.grp, taps: 0, players: 0 };
    item.taps += row.user_id === userId ? mine : row.taps;
    item.players += 1;
    byGroup.set(row.grp, item);
  }
  const groups = [...byGroup.values()].sort((a, b) => b.taps - a.taps);
  const groupPlace = groups.findIndex((item) => item.group === group) + 1;
  return {
    top,
    place,
    players: rows.length,
    total: rows.reduce((sum, row) => sum + (row.user_id === userId ? mine : row.taps), 0),
    groups: groups.slice(0, 10).map((item) => ({ ...item, me: item.group === group })),
    myGroup: groupPlace ? { ...groups[groupPlace - 1], place: groupPlace } : null,
  };
}

async function clickerApi(env, body) {
  const user = await verifyInitData(body.initData || "", env.BOT_TOKEN);
  if (!user?.id) return { ok: false, error: "no user" };
  if (body.event !== CLICKER.event) return { ok: false, error: "no event" };
  const group = String(body.group || "").slice(0, 24);
  // Преподаватели не играют: у них «группа» — это они сами.
  if (!group || group.startsWith("преп:")) return { ok: false, error: "no group" };
  if (await appBan(env, user.id).catch(() => null)) return { ok: false, error: "banned" };

  const now = Math.floor(Date.now() / 1000);
  const ended = Date.now() >= CLICKER.ends;
  const taps = Math.max(0, Math.min(Math.floor(Number(body.taps) || 0), CLICKER_RATE * CLICKER_WINDOW));
  let mine = null;
  if (taps && !ended) {
    // Предел скорости считается в самом запросе: две пачки, присланные
    // разом, не обойдут его, прочитав одно и то же «последнее время».
    const row = await env.STATS.prepare(
      `INSERT INTO clicker (event, user_id, name, username, grp, taps, active, updated)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, MIN(?9, MAX(1, ?6 / ?8)), ?7)
       ON CONFLICT(event, user_id) DO UPDATE SET
         taps = taps + MIN(excluded.taps, ?8 * MAX(1, MIN(?9, ?7 - updated))),
         active = active + MAX(1, MIN(?9, ?7 - updated)),
         updated = ?7,
         name = excluded.name,
         username = excluded.username,
         grp = excluded.grp
       RETURNING taps`
    )
      .bind(CLICKER.event, user.id, clickerName(user), String(user.username || ""), group, taps, now, CLICKER_RATE, CLICKER_WINDOW)
      .first();
    mine = row?.taps ?? null;
  }
  if (!body.board) return { ok: true, mine, ends: CLICKER.ends, ended, flush: clickerCache.flush };

  if (mine === null) {
    const row = await env.STATS.prepare("SELECT taps FROM clicker WHERE event = ? AND user_id = ?")
      .bind(CLICKER.event, user.id)
      .first();
    mine = row?.taps || 0;
  }
  const rows = await clickerRows(env);
  return { ok: true, mine, ends: CLICKER.ends, ended, flush: clickerCache.flush, board: clickerBoard(rows, user.id, mine, group) };
}

const CLICKER_HELP = [
  "<b>Кликер посвящения</b> — нажатия на праздничную плашку в приложении.",
  "",
  "/clicker — таблица с id и скоростью",
  "/clicker ban 123456789 — убрать из таблицы (автокликер)",
  "/clicker unban 123456789 — вернуть",
  "/theme 123456789 чемпион — выдать приз победителю",
].join("\n");

async function clickerCommand(env, text) {
  const [action = "", id = ""] = String(text).replace(/^\/clicker(@\w+)?/, "").trim().split(/\s+/);
  if (action === "ban" || action === "unban") {
    if (!/^\d+$/.test(id)) return CLICKER_HELP;
    const result = await env.STATS.prepare("UPDATE clicker SET banned = ? WHERE event = ? AND user_id = ?")
      .bind(action === "ban" ? 1 : 0, CLICKER.event, Number(id))
      .run();
    clickerCache.at = 0;
    if (!result.meta?.changes) return `Игрока с id ${escape(id)} в кликере нет.`;
    return action === "ban" ? `Убран из таблицы: id ${escape(id)}.` : `Возвращён в таблицу: id ${escape(id)}.`;
  }

  const { results = [] } = await env.STATS.prepare(
    `SELECT user_id, name, username, grp, taps, active, banned FROM clicker
     WHERE event = ? AND taps > 0 ORDER BY banned ASC, taps DESC LIMIT 20`
  )
    .bind(CLICKER.event)
    .all();
  const totals = await env.STATS.prepare(
    "SELECT COUNT(*) AS players, COALESCE(SUM(taps), 0) AS taps FROM clicker WHERE event = ? AND banned = 0"
  )
    .bind(CLICKER.event)
    .first();
  const ended = Date.now() >= CLICKER.ends;
  const head = `${CLICKER_HELP}\n\n${ended ? "Окончен" : "Идёт до 3 октября, 00:00 МСК — ночь с пятницы на субботу"}. Игроков: ${totals?.players || 0}, нажатий: ${totals?.taps || 0}.`;
  if (!results.length) return `${head}\n\nПока никто не кликал.`;
  const lines = results.map((row, i) => {
    const minutes = Math.max(1, Math.round(row.active / 60));
    const rate = (row.taps / Math.max(1, row.active)).toFixed(1);
    const who = `${escape(row.name)}${row.username ? ` @${escape(row.username)}` : ""}`;
    const mark = row.banned ? "🚫 " : `${i + 1}. `;
    return `${mark}${who} · ${escape(row.grp)} — <b>${row.taps}</b>\n    id <code>${row.user_id}</code> · кликал ~${minutes} мин · ${rate}/с`;
  });
  return [head, "", ...lines].join("\n");
}

/* ---------- Очереди ---------- */

/**
 * Очереди на доклады и сдачи. Заводит староста или владелец, записываются
 * студенты сами. Порядок — по времени записи: номера не храним, иначе
 * после выхода одного пришлось бы перенумеровывать всех остальных.
 */
async function queuesApi(env, body) {
  const user = await verifyInitData(body.initData || "", env.BOT_TOKEN);
  if (!user?.id) return { ok: false, error: "no user" };
  const group = String(body.group || "");
  if (!group) return { ok: false, error: "no group" };

  // Забаненному очереди недоступны, как и расписание.
  if (await appBan(env, user.id).catch(() => null)) return { ok: false, error: "banned" };

  const manager =
    isOwner(env, user.id) ||
    Boolean(
      await env.STATS.prepare("SELECT 1 AS ok FROM starostas WHERE grp = ? AND tg_id = ?")
        .bind(group, user.id)
        .first()
    );
  const now = new Date().toISOString();
  const action = String(body.action || "list");

  if (action === "create") {
    const title = String(body.title || "").trim().slice(0, 80);
    if (!title) return { ok: false, error: "no title" };
    const day = /^\d{4}-\d{2}-\d{2}$/.test(String(body.day || "")) ? body.day : "";
    const subject = String(body.subject || "").slice(0, 120);
    const number = Math.min(99, Math.max(0, Number(body.number) || 0));
    const slots = 0;
    // Больше десяти открытых очередей на группу — это уже свалка.
    const { n } = await env.STATS.prepare(
      "SELECT COUNT(*) AS n FROM queues WHERE grp = ? AND closed = 0"
    )
      .bind(group)
      .first();
    if (n >= 10) return { ok: false, error: "too many" };
    await env.STATS.prepare(
      "INSERT INTO queues (grp, title, subject, day, number, slots, author, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    )
      .bind(group, title, subject, day, number, slots, user.id, now)
      .run();
  }

  if (["join", "leave", "close", "delete", "order", "hide"].includes(action)) {
    const queue = await env.STATS.prepare("SELECT * FROM queues WHERE id = ?")
      .bind(Number(body.queue) || 0)
      .first();
    // Чужая группа — не наше дело: очередь видна и меняется только своими.
    if (!queue || queue.grp !== group) return { ok: false, error: "no queue" };

    if (action === "join") {
      if (queue.closed) return { ok: false, error: "closed" };
      const position = Math.min(99, Math.max(0, Number(body.position) || 0));
      if (position) {
        // Номер именной: двое под пятым — это уже не очередь.
        const busy = await env.STATS.prepare(
          "SELECT 1 AS ok FROM queue_spots WHERE queue = ? AND position = ? AND tg_id <> ?"
        )
          .bind(queue.id, position, user.id)
          .first();
        if (busy) return { ok: false, error: "taken" };
      }
      await env.STATS.prepare(
        `INSERT INTO queue_spots (queue, tg_id, name, username, note, position, created) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(queue, tg_id) DO UPDATE SET note = excluded.note, position = excluded.position`
      )
        .bind(
          queue.id,
          user.id,
          [user.first_name, user.last_name].filter(Boolean).join(" ") || `id ${user.id}`,
          user.username || null,
          String(body.note || "").trim().slice(0, 80),
          position,
          now
        )
        .run();
    } else if (action === "leave") {
      await env.STATS.prepare("DELETE FROM queue_spots WHERE queue = ? AND tg_id = ?")
        .bind(queue.id, user.id)
        .run();
    } else if (action === "close") {
      // Закрыть запись — решение за владельцем: иначе автор очереди мог бы
      // захлопнуть её перед носом у тех, кто не успел.
      if (!isOwner(env, user.id)) return { ok: false, error: "forbidden" };
      await env.STATS.prepare("UPDATE queues SET closed = ? WHERE id = ?")
        .bind(queue.closed ? 0 : 1, queue.id)
        .run();
    } else if (action === "delete") {
      if (!manager && queue.author !== user.id) return { ok: false, error: "forbidden" };
      // Не стираем, а прячем: если очередь снесли из хулиганства, владелец
      // увидит и её саму, и всех, кто в ней стоял (/queues в боте).
      await env.STATS.prepare("UPDATE queues SET deleted = 1, closed = 1 WHERE id = ?")
        .bind(queue.id)
        .run();
    } else if (action === "hide") {
      // «Скрыть» — только с глаз владельца и навсегда; в /queues она остаётся.
      if (!isOwner(env, user.id)) return { ok: false, error: "forbidden" };
      await env.STATS.prepare("UPDATE queues SET hidden = 1 WHERE id = ?").bind(queue.id).run();
    } else if (action === "order") {
      // Ручной порядок — только владельцу: это способ разрешить спор.
      if (!isOwner(env, user.id)) return { ok: false, error: "forbidden" };
      const order = (body.order || []).map(Number).filter(Boolean).slice(0, 99);
      await env.STATS.batch(
        order.map((id, index) =>
          env.STATS.prepare("UPDATE queue_spots SET position = ? WHERE queue = ? AND tg_id = ?")
            .bind(index + 1, queue.id, id)
        )
      );
    }
  }

  // Отдаём всё разом: список коротких очередей дешевле одного запроса.
  // Студентам удалённых очередей не видно, владельцу — видно, пока он сам
  // их не уберёт: так видно, если очередь снесли из хулиганства.
  const owner = isOwner(env, user.id);
  const { results: queues = [] } = await env.STATS.prepare(
    owner
      ? `SELECT id, title, subject, day, number, author, closed, deleted FROM queues
         WHERE grp = ? AND hidden = 0 ORDER BY deleted, closed, id DESC LIMIT 30`
      : `SELECT id, title, subject, day, number, author, closed, deleted FROM queues
         WHERE grp = ? AND deleted = 0 ORDER BY closed, id DESC LIMIT 20`
  )
    .bind(group)
    .all();
  const { results: spots = [] } = await env.STATS.prepare(
    `SELECT s.queue, s.tg_id, s.name, s.username, s.note, s.position FROM queue_spots s
     JOIN queues q ON q.id = s.queue
     WHERE q.grp = ? ORDER BY s.position = 0, s.position, s.created LIMIT 400`
  )
    .bind(group)
    .all();
  return { ok: true, manager, owner, me: user.id, queues, spots };
}

/**
 * /queues — что происходит в очередях. Показывает и удалённые: очередь
 * может снести тот, кто её завёл, и владелец должен видеть, кого там стёрли.
 */
async function queuesCommand(env, text) {
  const target = glueCourse(String(text).replace(/^\/queues(@\w+)?/, "").trim());
  const where = target ? "WHERE q.grp = ?" : "";
  const { results = [] } = await env.STATS.prepare(
    `SELECT q.id, q.grp, q.title, q.subject, q.day, q.number, q.closed, q.deleted, q.hidden, q.created,
            (SELECT COUNT(*) FROM queue_spots s WHERE s.queue = q.id) AS people
     FROM queues q ${where} ORDER BY q.deleted, q.id DESC LIMIT 20`
  )
    .bind(...(target ? [target] : []))
    .all();
  if (!results.length) return target ? `У «${escape(target)}» очередей нет.` : "Очередей пока нет.";

  const lines = [];
  for (const queue of results) {
    const { results: spots = [] } = await env.STATS.prepare(
      `SELECT name, username, note, position FROM queue_spots WHERE queue = ?
       ORDER BY position = 0, position, created LIMIT 40`
    )
      .bind(queue.id)
      .all();
    const facts = [
      escape(queue.grp),
      queue.number ? `семинар ${queue.number}` : null,
      queue.day || null,
      queue.deleted ? "🗑 удалена" : queue.closed ? "запись закрыта" : null,
      queue.hidden ? "скрыта у владельца" : null,
    ].filter(Boolean);
    lines.push(`<b>№${queue.id} · ${escape(queue.title)}</b>\n${facts.join(" · ")}`);
    lines.push(
      spots.length
        ? spots
            .map(
              (s, i) =>
                `${s.position || i + 1}. ${escape(s.name)}${s.username ? ` @${escape(s.username)}` : ""}${
                  s.note ? ` — ${escape(s.note)}` : ""
                }`
            )
            .join("\n")
        : "пусто"
    );
    lines.push("");
  }
  return lines.join("\n");
}

/* ---------- Чат курса: PDF от куратора ---------- */

/**
 * Бот сидит в чате курса и ждёт только PDF. Ничего туда не пишет: ни
 * ответов, ни ошибок — чат чужой, и бот в нём гость. Найденный файл
 * уходит владельцу в личку кнопкой: публикует расписание по-прежнему
 * только он, автоматически ничего не заменяется.
 */
async function watchedChat(env, chatId) {
  if (!env.STATS || !chatId) return null;
  return env.STATS.prepare("SELECT chat_id, title FROM watched_chats WHERE chat_id = ?")
    .bind(chatId)
    .first();
}

async function watchCommand(env, message, on) {
  const chat = message.chat;
  if (on) {
    await env.STATS.prepare(
      `INSERT INTO watched_chats (chat_id, title, added) VALUES (?, ?, ?)
       ON CONFLICT(chat_id) DO UPDATE SET title = excluded.title`
    )
      .bind(chat.id, chat.title || "", new Date().toISOString())
      .run();
  } else {
    await env.STATS.prepare("DELETE FROM watched_chats WHERE chat_id = ?").bind(chat.id).run();
  }
  const name = escape(chat.title || `чат ${chat.id}`);
  // Отвечаем в личку, даже когда команда пришла из чата: в чате бот молчит.
  await callTelegram(env.BOT_TOKEN, "sendMessage", {
    chat_id: env.OWNER_ID,
    parse_mode: "HTML",
    text: on
      ? [
          `👀 Слежу за «${name}». Когда там появится PDF, пришлю сюда кнопку «Обновить расписание».`,
          "В сам чат бот не пишет ничего и никогда.",
          "Если файлы не приходят — у @BotFather нужно /setprivacy → Disable: иначе Telegram не отдаёт боту вложения из групп.",
          "Перестать следить: /unwatch в том чате.",
        ].join("\n")
      : `Больше не слежу за «${name}».`,
  });
}

/**
 * PDF в чате курса. Сам файл здесь не разобрать — парсер на Python живёт в
 * сборке на GitHub, поэтому файл уходит туда на проверку. Она ничего не
 * публикует: только решает, расписание это или методичка, и уже оттуда
 * владельцу приходит письмо — с кнопкой или без.
 */
async function offerUpdate(env, message, document) {
  const who = [message.from?.first_name, message.from?.last_name].filter(Boolean).join(" ");
  const username = message.from?.username ? ` @${message.from.username}` : "";
  const saved = await env.STATS.prepare(
    "INSERT INTO pending_pdfs (file_id, name, sender, created) VALUES (?, ?, ?, ?) RETURNING id"
  )
    .bind(document.file_id, document.file_name || "", who || "", new Date().toISOString())
    .first();
  if (!env.GITHUB_TOKEN) return;
  await fetch(`https://api.github.com/repos/${REPO}/dispatches`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "user-agent": "fgp-schedule-bot",
    },
    body: JSON.stringify({
      event_type: "probe-schedule",
      client_payload: {
        file_id: document.file_id,
        pending: String(saved.id),
        name: document.file_name || "",
        sender: `${who || "неизвестно"}${username}`,
        chat: message.chat.title || "чате",
      },
    }),
  });
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

  // Указатель общий на все факультеты: у каждого своя чётность недель, а у
  // расписаний по датам (код недели 3) — список дней от 1 января.
  const epoch = index.epoch ? Date.parse(`${index.epoch}T00:00:00Z`) : 0;
  const dayNumber = Math.round((date.getTime() - epoch) / 86400000);
  const parities = new Map();
  const parityFor = (tenant) => {
    if (!parities.has(tenant)) parities.set(tenant, parityOf(index.tenants?.[tenant]?.weeks || index.weeks, date));
    return parities.get(tenant);
  };
  const lessons = index.lessons.filter(([t, , day, slot, week, , , tenant = 0, days = []]) => {
    if (t !== teacher.i || day !== date.getUTCDay()) return false;
    if (slots.length && !slots.includes(slot)) return false;
    if (week === 3) return days.includes(dayNumber);
    const parity = parityFor(tenant);
    return week === 0 || parity === null || week === WEEK_CODES[parity];
  });
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
  if (grp.startsWith("uni:")) return `всего вуза «${grp.slice(4)}»`;
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

/* ---------- Сторож своего сервера ---------- */

/**
 * Работает в Cloudflare — то есть вне сервера, и скажет о беде, даже когда
 * сервер лежит целиком. О каждой беде пишет один раз, когда она началась,
 * и ещё раз — когда прошла; иначе сообщения шли бы каждую минуту.
 */
async function watchServer(env) {
  if (!env.STATS || !env.OWNER_ID) return;
  await env.STATS.prepare("CREATE TABLE IF NOT EXISTS watch (key TEXT PRIMARY KEY, since TEXT NOT NULL, fails INTEGER NOT NULL DEFAULT 1)").run();
  // Чистые проверки подряд после тревоги: «прошло» пишем, только когда их
  // набралось WATCH_CALM — иначе моргающая сеть давала бы тревогу и «прошло»
  // каждые четверть часа.
  await env.STATS.prepare("CREATE TABLE IF NOT EXISTS watch_calm (key TEXT PRIMARY KEY, oks INTEGER NOT NULL DEFAULT 0)").run();

  const problems = new Map();
  let health = null;
  try {
    const res = await fetch(`${MOVED_TO}/healthz`, { signal: AbortSignal.timeout(12000) });
    health = res.ok ? await res.json() : null;
    if (!health?.ok) problems.set("down", `Сервер отвечает с ошибкой (код ${res.status}).`);
  } catch {
    problems.set("down", "Сервер не отвечает: приложение не получает отмены, домашку и очереди, бот молчит.");
  }
  if (health?.ok) {
    if (health.tickAge !== null && health.tickAge > 240) problems.set("tick", "На сервере встала минутная задача: напоминания и рассылки не уходят.");
    if (health.telegramOk === false) problems.set("telegram-out", "Сервер не достаёт до Telegram: напоминания и ответы бота не уходят.");
    if (health.diskFree !== null && health.diskFree < 10) problems.set("disk", `На диске сервера осталось ${health.diskFree}% места.`);
    if (health.backupAge !== null && health.backupAge > 36) problems.set("backup", `Ночная копия базы не делалась ${health.backupAge} ч.`);
  }

  // Доходят ли до бота сообщения от Telegram — раз в пять минут.
  if (new Date().getUTCMinutes() % 5 === 0) {
    const info = await callTelegram(env.BOT_TOKEN, "getWebhookInfo", {}).catch(() => null);
    const result = info?.result;
    if (result) {
      const fresh = result.last_error_date && Date.now() / 1000 - result.last_error_date < 360;
      if (result.pending_update_count > 5 || (fresh && result.pending_update_count > 0)) {
        problems.set("telegram-in", `Сообщения от Telegram не доходят до бота: в очереди ${result.pending_update_count}. ${result.last_error_message || ""}`.trim());
      }
    }
  }

  const { results: known = [] } = await env.STATS.prepare("SELECT key, fails FROM watch").all();
  const before = new Map(known.map((row) => [row.key, row.fails]));
  const send = (text) => callTelegram(env.BOT_TOKEN, "sendMessage", { chat_id: env.OWNER_ID, text }).catch(() => {});

  // Сеть до сервера иногда моргает на минуту-две — это не авария. Пишем,
  // только если проблема держится WATCH_ALARM проверок подряд (пять минут).
  // Очередь Telegram проверяется раз в пять минут — по ней хватает двух.
  const threshold = (key) => (key === "telegram-in" ? 2 : WATCH_ALARM);
  for (const [key, text] of problems) {
    const fails = (before.get(key) || 0) + 1;
    await env.STATS.prepare(
      "INSERT INTO watch (key, since, fails) VALUES (?, ?, 1) ON CONFLICT(key) DO UPDATE SET fails = fails + 1"
    )
      .bind(key, new Date().toISOString())
      .run();
    await env.STATS.prepare("DELETE FROM watch_calm WHERE key = ?").bind(key).run();
    if (fails === threshold(key)) await send(`🚨 Сторож: ${text}`);
  }
  for (const [key, fails] of before) {
    if (problems.has(key) || (key === "telegram-in" && new Date().getUTCMinutes() % 5 !== 0)) continue;
    if (fails < threshold(key)) {
      // Тревоги не было — забываем молча.
      await env.STATS.prepare("DELETE FROM watch WHERE key = ?").bind(key).run();
      continue;
    }
    // Тревога была: ждём WATCH_CALM чистых проверок подряд, потом «прошло».
    await env.STATS.prepare("INSERT INTO watch_calm (key, oks) VALUES (?, 1) ON CONFLICT(key) DO UPDATE SET oks = oks + 1")
      .bind(key)
      .run();
    const calm = await env.STATS.prepare("SELECT oks FROM watch_calm WHERE key = ?").bind(key).first();
    if ((calm?.oks || 0) >= (key === "telegram-in" ? 1 : WATCH_CALM)) {
      await env.STATS.batch([
        env.STATS.prepare("DELETE FROM watch WHERE key = ?").bind(key),
        env.STATS.prepare("DELETE FROM watch_calm WHERE key = ?").bind(key),
      ]);
      await send(`✅ Сторож: прошло — ${WATCH_NAMES[key] || key}.`);
    }
  }
}

// Сторож: сколько проверок подряд (по минуте) должна держаться проблема (15 минут —
// короткие моргания сети владельца не тревожат),
// чтобы написать, и сколько чистых подряд — чтобы написать «прошло».
const WATCH_ALARM = 15;
const WATCH_CALM = 10;

const WATCH_NAMES = {
  down: "сервер снова отвечает",
  tick: "минутная задача снова работает",
  "telegram-out": "сервер снова достаёт до Telegram",
  "telegram-in": "сообщения от Telegram снова доходят",
  disk: "места на диске снова хватает",
  backup: "копия базы сделана",
};

// Бот переехал на свой сервер. Старый адрес в Cloudflare остаётся
// переходником: приложения, которые ещё держат в кэше прежнюю версию,
// стучатся сюда — и их запросы уходят на новый сервер, в ту же базу.
const MOVED_TO = "https://api.bodryash.ru";

// Для проверки на копии базы (без Telegram).
export { runAlerts, scanAlerts, watchSchedules, dueReminders };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!OWN_SERVER && MOVED_TO) {
      const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();
      return fetch(`${MOVED_TO}${url.pathname}${url.search}`, { method: request.method, headers: request.headers, body });
    }

    // Подписка на расписание в календаре телефона — см. ics.js.
    if (url.pathname.startsWith("/ics/")) {
      if (request.method === "GET" || request.method === "HEAD") {
        // Отмены и замены знает только бот — отдаём их календарю.
        const since = iso(addDays(today(), -14));
        const active = async (sql) => {
          const { results = [] } = await env.STATS.prepare(sql).bind(since).all();
          return results.map((r) => ({ ...r, slots: r.slots ? r.slots.split(",").map(Number) : [] }));
        };
        return handleIcs(url, request, {
          cancels: () => active("SELECT grp, day, slots, reason, subject, subgroup FROM cancels WHERE removed = 0 AND day >= ?"),
          changes: () => active("SELECT grp, day, slots, from_teacher, teacher, room, start, reason FROM changes WHERE removed = 0 AND day >= ?"),
          courseOf,
        });
      }
      // iPhone перед подпиской проверяет, не CalDAV ли это (PROPFIND). Ответ
      // «200 ok» сбивал его с толку: «не удалось выполнить проверку».
      return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
    }

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
      const theme = await themeFor(env, user?.id, group).catch(() => "");
      const important = await importantList(env).catch(() => []);
      const hello = await helloFor(env, user?.id, group).catch(() => "");
      const payload = { notices, cancels, changes, theme, hello, important, owner: Boolean(user && isOwner(env, user.id)), homework, canEdit, canComment: commenter, comments };
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

    if (url.pathname === "/invite" && request.method === "POST") {
      let result;
      try {
        result = await inviteSave(env, JSON.parse(await request.text()));
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

    if (url.pathname === "/share" && (request.method === "POST" || request.method === "GET")) {
      let result;
      try {
        result =
          request.method === "POST"
            ? await shareSave(env, JSON.parse(await request.text()))
            : await shareLoad(env, url.searchParams.get("code"));
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

    if (url.pathname === "/reminders" && request.method === "POST") {
      let result;
      try {
        result = await saveReminders(env, JSON.parse(await request.text()));
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

    if (url.pathname === "/clicker" && request.method === "POST") {
      let result;
      try {
        result = await clickerApi(env, JSON.parse(await request.text()));
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

    if (url.pathname === "/queues" && request.method === "POST") {
      let result;
      try {
        result = await queuesApi(env, JSON.parse(await request.text()));
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
    // Бота добавили в чат или выгнали. Отмечаем чат сами: команду писать
    // не надо. Чужие добавления игнорируем — Telegram сообщает, кто добавил.
    const membership = update.my_chat_member;
    if (membership) {
      const status = membership.new_chat_member?.status;
      const chat = membership.chat;
      const byOwner = isOwner(env, membership.from?.id);
      const gone = status === "left" || status === "kicked";
      if (chat?.type !== "private") {
        if (gone) {
          await env.STATS.prepare("DELETE FROM watched_chats WHERE chat_id = ?").bind(chat.id).run();
        } else if (byOwner) {
          await watchCommand(env, { chat }, true);
        }
      }
      return new Response("ok");
    }

    const pdf = update.callback_query?.data?.match(/^pdf:(\d+)$/);
    if (pdf || update.callback_query?.data === "pdfskip") {
      const query = update.callback_query;
      const owner = isOwner(env, query.from?.id);
      let notice = "Недоступно";
      if (owner) {
        if (pdf) {
          const row = await env.STATS.prepare("SELECT file_id, name FROM pending_pdfs WHERE id = ?")
            .bind(Number(pdf[1]))
            .first();
          notice = row
            ? await startUpdate(env, { file_id: row.file_id, file_name: row.name })
            : "Файл потерялся, перешлите его боту вручную.";
        } else {
          notice = "Пропустил.";
        }
      }
      await callTelegram(env.BOT_TOKEN, "answerCallbackQuery", {
        callback_query_id: query.id,
        text: notice.slice(0, 190),
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

    // «Назначить» / «Отклонить» под заявкой в старосты.
    const staff = update.callback_query?.data?.match(/^st(ok|no):(\d+)$/);
    if (staff) {
      const query = update.callback_query;
      const owner = isOwner(env, query.from?.id);
      const done = owner ? await decideStarosta(env, Number(staff[2]), staff[1] === "ok") : { note: "Недоступно", line: "" };
      await callTelegram(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: query.id, text: done.note });
      if (owner && query.message) {
        // Кнопки убираем, итог дописываем в то же сообщение: видно, что решено.
        await callTelegram(env.BOT_TOKEN, "editMessageReplyMarkup", {
          chat_id: query.message.chat.id,
          message_id: query.message.message_id,
          reply_markup: { inline_keyboard: [] },
        }).catch(() => null);
        if (done.line) {
          await callTelegram(env.BOT_TOKEN, "sendMessage", {
            chat_id: query.message.chat.id,
            text: done.line,
            parse_mode: "HTML",
            reply_to_message_id: query.message.message_id,
          }).catch(() => null);
        }
      }
      return new Response("ok");
    }

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
    // Стереть свои данные может каждый — и только свои.
    if (message && /^\/forget(?:@\w+)?(?:\s|$)/.test(text) && message.chat.type === "private") {
      const sure = /\s(да|yes)\s*$/i.test(text);
      let reply = FORGET_HELP;
      if (sure) {
        const removed = await forgetUser(env, message.from.id).catch(() => -1);
        reply = removed < 0 ? "Не получилось удалить — попробуйте позже." : "Готово: ваши данные стёрты.";
      }
      await callTelegram(env.BOT_TOKEN, "sendMessage", { chat_id: message.chat.id, text: reply, parse_mode: "HTML" });
    }

    // Пришли из настроек приложения добавить свой факультет — объясняем, что прислать.
    if (message && /^\/start(?:@\w+)?\s+faculty/.test(text)) {
      await callTelegram(env.BOT_TOKEN, "sendMessage", {
        chat_id: message.chat.id,
        text: [
          "Добавим расписание вашего факультета 🙌",
          "",
          "Пришлите сюда:",
          "• расписание — файлом (PDF, Excel) или ссылкой на страницу вуза;",
          "• название вуза и факультета;",
          "• если знаете — даты начала и конца семестра и какая неделя первая: чётная или нечётная.",
          "",
          "Как только добавим — напишем.",
        ].join("\n"),
      });
    }

    // Пришли по ссылке «поделиться расписанием»: открываем приложение сразу
    // с кодом — там предложат добавить чужое расписание отдельным профилем.
    // Рекламная метка: запоминаем, откуда человек пришёл в первый раз.
    const ad = message && text.match(/^\/start(?:@\w+)?\s+ad_([A-Za-z0-9_-]{1,40})$/);
    if (ad && message.from?.id) {
      await env.STATS.prepare("INSERT OR IGNORE INTO sources (tg_id, label, created) VALUES (?, ?, ?)")
        .bind(message.from.id, ad[1].toLowerCase(), new Date().toISOString())
        .run()
        .catch(() => {});
    }

    const shared = message && text.match(/^\/start(?:@\w+)?\s+p_([a-z0-9]{8})$/);
    if (shared) {
      const found = await shareLoad(env, shared[1]).catch(() => ({ ok: false }));
      await callTelegram(env.BOT_TOKEN, "sendMessage", {
        chat_id: message.chat.id,
        text: found.ok
          ? `С вами поделились расписанием${found.name ? ` «${escape(found.name)}»` : ""}.\n\nОткройте — и оно добавится отдельным профилем, ваше останется на месте.`
          : "Эта ссылка больше не работает — попросите прислать новую.",
        parse_mode: "HTML",
        reply_markup: found.ok
          ? { inline_keyboard: [[{ text: "📅 Добавить расписание", web_app: { url: `${WEB_APP_URL}?cfg=${shared[1]}` } }]] }
          : undefined,
      });
    }

    // Ссылка-приглашение группы: сразу кнопка, открывающая расписание этой группы.
    const invited = message && text.match(/^\/start(?:@\w+)?\s+g_([a-z0-9]{8})$/);
    if (invited) {
      const found = await shareLoad(env, invited[1]).catch(() => ({ ok: false }));
      if (message.from?.id) {
        await env.STATS.prepare("INSERT OR IGNORE INTO sources (tg_id, label, created) VALUES (?, ?, ?)")
          .bind(message.from.id, "invite", new Date().toISOString())
          .run()
          .catch(() => {});
      }
      await callTelegram(env.BOT_TOKEN, "sendMessage", {
        chat_id: message.chat.id,
        text: found.ok
          ? `Расписание группы${found.name ? ` «${escape(found.name)}»` : ""} 👇\n\nОткройте — приложение сразу настроится на эту группу.`
          : "Эта ссылка больше не работает — откройте расписание и выберите группу сами.",
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [[{ text: "📅 Открыть расписание", web_app: { url: found.ok ? `${WEB_APP_URL}?grp=${invited[1]}` : WEB_APP_URL } }]],
        },
      });
    }

    if (message && text.startsWith("/start") && !shared && !invited && !/^\/start(?:@\w+)?\s+starosta$/.test(text)) {
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
      // Главный способ расти — студенты сами присылают расписания. Говорим об
      // этом сразу, в первом же сообщении, а не только в глубине настроек.
      const invite = zh
        ? "没有你们院系的课表？把文件、照片或链接发到这里，并写上学校和院系——我们会接入并通知你。"
        : ko
          ? "학부 시간표가 없나요? 파일, 사진 또는 링크를 대학·학부 이름과 함께 여기로 보내 주세요. 연결한 뒤 알려 드립니다."
          : "Нет расписания твоего факультета? Скинь его сюда — файлом, фото или ссылкой, и напиши вуз и факультет. Подключим и напишем.";
      await callTelegram(env.BOT_TOKEN, "sendMessage", {
        chat_id: message.chat.id,
        text: `${greeting}

${invite}`,
        reply_markup: {
          inline_keyboard: [
            [{ text: zh ? "📅 打开课表" : ko ? "📅 시간표 열기" : "📅 Открыть расписание", web_app: { url: WEB_APP_URL } }],
          ],
        },
      });
    }

    // Присланный PDF обновляет расписание. Только от владельца: иначе кто
    // угодно опубликовал бы поддельное расписание для всего факультета.
    // Что студенты пишут боту словами и присылают фотографией — на своём
    // сервере складываем рядом с файлами: так приходят названия вуза и
    // группы и расписания-картинки. Команды и владельца не трогаем.
    if (
      message &&
      message.chat.type === "private" &&
      String(message.chat.id) !== String(env.OWNER_ID) &&
      globalThis.SCHEDULE_SAVE_NOTE
    ) {
      const photo = message.photo?.at(-1);
      if (photo) {
        await Promise.resolve(
          globalThis.SCHEDULE_SAVE_FILE?.({ ...photo, file_name: "photo.jpg" }, message.from, message.caption || "")
        ).catch(() => {});
        await grantVolunteer(env, message.from).catch(() => {});
      }
      const words = message.text && !message.text.startsWith("/") ? message.text : message.caption || "";
      if (words || photo) {
        await Promise.resolve(globalThis.SCHEDULE_SAVE_NOTE(message.from, words, Boolean(photo || message.document))).catch(() => {});
      }
      // Пишут «расписание», «пары на завтра» — ждут, что бот его покажет.
      // Молчание выглядело как поломка: отвечаем кнопкой, которая его открывает.
      const asksSchedule =
        /^\s*(?:расписани[ея]|пары|какие\s+пары|что\s+(?:завтра|сегодня))(?:\s+(?:на\s+)?(?:завтра|сегодня|недел[юя]))?[\s?!.]*$/i;
      if (!photo && !message.document && asksSchedule.test(words)) {
        await callTelegram(env.BOT_TOKEN, "sendMessage", {
          chat_id: message.chat.id,
          text: "Расписание открывается кнопкой ниже 👇\n\nЧтобы получать пары на день сообщением, включите в приложении «Утром в 7:30» — в настройках, раздел напоминаний.",
          reply_markup: { inline_keyboard: [[{ text: "📅 Открыть расписание", web_app: { url: WEB_APP_URL } }]] },
        }).catch(() => {});
      }
      if (photo) {
        await callTelegram(env.BOT_TOKEN, "sendMessage", {
          chat_id: message.chat.id,
          text: "Спасибо! Передал расписание — добавим и сообщим. Если не написали, допишите вуз, факультет и группу.",
        }).catch(() => {});
      }
    }

    // Владелец переслал боту чужое фото (расписание-картинку) — во входящие
    // от имени того, кто прислал. Без этого бот на такое молчал.
    if (
      message &&
      message.chat.type === "private" &&
      String(message.chat.id) === String(env.OWNER_ID) &&
      message.photo?.length &&
      (message.forward_origin || message.forward_from || message.forward_date) &&
      globalThis.SCHEDULE_SAVE_FILE
    ) {
      const origin = message.forward_origin;
      const from = origin?.sender_user || message.forward_from || { first_name: origin?.sender_user_name || message.forward_sender_name || "переслано" };
      let saved = true;
      await Promise.resolve(
        globalThis.SCHEDULE_SAVE_FILE({ ...message.photo.at(-1), file_name: "photo.jpg" }, from, message.caption || "")
      ).catch(() => {
        saved = false;
      });
      await callTelegram(env.BOT_TOKEN, "sendMessage", {
        chat_id: message.chat.id,
        text: saved ? "Сохранил фото во входящие." : "Не смог сохранить фото — подробности в журнале сервера.",
      }).catch(() => {});
    }

    // Владелец прислал видео, гифку, фото или файл с подписью «/broadcast …» —
    // это рассылка с вложением, а не расписание на обновление.
    const castMedia =
      message && isOwner(env, message.chat.id) && /^\/broadcast(?:\s|$)/.test(message.caption || "") ? mediaOf(message) : null;

    const document = castMedia ? null : message?.document;
    if (document) {
      const owner = String(message.chat.id) === String(env.OWNER_ID);
      const pdf =
        document.mime_type === "application/pdf" ||
        (document.file_name || "").toLowerCase().endsWith(".pdf");
      const watched = owner ? null : await watchedChat(env, message.chat.id).catch(() => null);

      // Владелец переслал боту чужой файл (расписание от студента) — это не
      // обновление ФГП: кладём во входящие от имени того, кто прислал.
      const origin = message.forward_origin;
      const forwardedFrom = owner
        ? origin?.sender_user ||
          message.forward_from ||
          (origin?.sender_user_name || message.forward_sender_name
            ? { first_name: origin?.sender_user_name || message.forward_sender_name }
            : origin || message.forward_date
              ? { first_name: "переслано" }
              : null)
        : null;
      if (forwardedFrom && globalThis.SCHEDULE_SAVE_FILE) {
        let saved = true;
        await Promise.resolve(globalThis.SCHEDULE_SAVE_FILE(document, forwardedFrom, message.caption || "")).catch(() => {
          saved = false;
        });
        await callTelegram(env.BOT_TOKEN, "sendMessage", {
          chat_id: message.chat.id,
          text: saved ? `Сохранил во входящие: ${document.file_name || "файл"}` : "Не смог сохранить файл — подробности в журнале сервера.",
        }).catch(() => {});
      } else if (watched) {
        // Чат курса: в сам чат не отвечаем ни при каких условиях.
        if (pdf) await offerUpdate(env, message, document);
      } else if (message.chat.type === "private") {
        await callTelegram(env.BOT_TOKEN, "sendMessage", {
          chat_id: message.chat.id,
          text: owner
            ? pdf
              ? await startUpdate(env, document)
              : "Это не PDF. Пришлите файл расписания."
            : "Спасибо! Передал расписание — добавим факультет и сообщим. Если не написали, допишите следующим сообщением вуз и факультет.",
        });
        // Расписание чужого факультета от студента — владельцу, вместе с
        // тем, кто прислал: добавляет факультеты он.
        if (!owner && env.OWNER_ID) {
          // На своём сервере файл ещё и сохраняется — чтобы подключить
          // факультет, не пересылая файл вручную.
          await Promise.resolve(globalThis.SCHEDULE_SAVE_FILE?.(document, message.from, message.caption || "")).catch(() => {});
          await grantVolunteer(env, message.from).catch(() => {});
          await callTelegram(env.BOT_TOKEN, "forwardMessage", {
            chat_id: env.OWNER_ID,
            from_chat_id: message.chat.id,
            message_id: message.message_id,
          }).catch(() => {});
          await callTelegram(env.BOT_TOKEN, "sendMessage", {
            chat_id: env.OWNER_ID,
            parse_mode: "HTML",
            text: `📥 Расписание для нового факультета от ${escape(clickerName(message.from || {}))}${message.from?.username ? ` @${escape(message.from.username)}` : ""} · id <code>${message.from?.id}</code>`,
          }).catch(() => {});
        }
      }
    }

    // Рассылка: сперва черновик с кнопками, отправка — только по нажатию.
    // Отозвать её нельзя, поэтому подтверждение обязательно.
    if (message && (text.startsWith("/broadcast") || castMedia)) {
      const owner = String(message.chat.id) === String(env.OWNER_ID);
      const body = (castMedia ? message.caption : text).slice("/broadcast".length).trim();
      if (!owner) {
        await callTelegram(env.BOT_TOKEN, "sendMessage", {
          chat_id: message.chat.id,
          text: "Команда недоступна.",
        });
      } else if (!body && !castMedia) {
        await callTelegram(env.BOT_TOKEN, "sendMessage", {
          chat_id: message.chat.id,
          text: [
            "Напишите текст следом: /broadcast Завтра занятий нет.",
            "",
            "Одному факультету — с решёткой впереди: /broadcast #фгп Завтра занятий нет.",
            "Всем, кроме факультета — с минусом: /broadcast #-фгп Новая функция для вас.",
            "Всему вузу: /broadcast #вуз:мгу Текст — всем факультетам МГУ.",
            "После решётки — короткое название или id факультета из /faculties.",
            "",
            "С видео, гифкой или фото — пришлите его боту, а команду и текст впишите в подпись.",
          ].join("\n"),
        });
      } else {
        // «#фгп Текст» — только одному факультету. С вложением текста после
        // решётки может и не быть: «#фгп» и видео.
        const tag = body.match(castMedia ? /^#(\S+)(?:\s+([\s\S]+))?$/ : /^#(\S+)\s+([\s\S]+)$/);
        // «#-фгп» — всем, кроме этого факультета.
        const except = Boolean(tag && tag[1].startsWith("-"));
        // «#вуз:мгу» — всем факультетам вуза сразу.
        const uniTag = tag && !except ? tag[1].match(/^вуз:(.+)$/i) : null;
        let found = null;
        if (uniTag) {
          const all = (await loadTenants().catch(() => [])).filter((t) => normalize(t.university) === normalize(uniTag[1]));
          if (all.length) found = { id: `in:${all.map((t) => t.id).join(",")}`, university: all[0].university, short: "все факультеты" };
        } else if (tag) {
          found = await findAudience(except ? tag[1].slice(1) : tag[1]);
        }
        const audience = found ? { ...found, except } : null;
        const words = audience ? (tag[2] || "").trim() : body;
        if (tag && !audience) {
          await callTelegram(env.BOT_TOKEN, "sendMessage", {
            chat_id: message.chat.id,
            text: `Не знаю факультета «${tag[1]}». Названия — в /faculties. Ничего не отправлено.`,
          });
        } else if (castMedia && words.length > CAPTION_MAX) {
          await callTelegram(env.BOT_TOKEN, "sendMessage", {
            chat_id: message.chat.id,
            text: `Подпись к вложению — не длиннее ${CAPTION_MAX} знаков, а в этой ${words.length}. Сократите текст. Ничего не отправлено.`,
          });
        } else {
          await draftBroadcast(env, message.chat.id, words, { audience, media: castMedia });
        }
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
        // Обновляется по версии деканата только ФГП — ему и пишем, остальных не будим.
        const extra = text.replace(/^\/updated(@\w+)?/, "").trim();
        const audience = await findAudience("msu-fgp");
        await draftBroadcast(env, message.chat.id, await updatedText(extra), { button: true, audience });
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
    // Студент просит права сам: командой, словами или по ссылке из приложения.
    const wantsStarosta =
      message &&
      message.chat.type === "private" &&
      !isOwner(env, message.chat.id) &&
      (/^\/starosta(?:@\w+)?\s*$/.test(text) || /^\/start(?:@\w+)?\s+starosta$/.test(text) || /^\s*я\s+староста[\s.!)]*$/i.test(text));
    if (wantsStarosta && message.from?.id) {
      const answer = await requestStarosta(env, message.from).catch(() => ({ text: "Не получилось отправить заявку. Попробуйте ещё раз чуть позже." }));
      await callTelegram(env.BOT_TOKEN, "sendMessage", { chat_id: message.chat.id, ...answer });
    } else if (message && (text.startsWith("/starosta") || text.startsWith("/unstarosta"))) {
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
    if (message && /^\/hellos?(?:@\w+)?(?:\s|$)/.test(text)) {
      let reply = "Команда недоступна.";
      if (isOwner(env, message.chat.id)) {
        reply = /^\/hellos/.test(text) ? await hellosList(env) : await helloCommand(env, text);
      }
      await callTelegram(env.BOT_TOKEN, "sendMessage", {
        chat_id: message.chat.id,
        text: reply,
        parse_mode: "HTML",
      });
    }

    if (message && /^\/themes?(?:@\w+)?(?:\s|$)/.test(text)) {
      let reply = "Команда недоступна.";
      if (isOwner(env, message.chat.id)) {
        reply = text.startsWith("/themes") ? await themesList(env) : await themeCommand(env, text);
      }
      await callTelegram(env.BOT_TOKEN, "sendMessage", {
        chat_id: message.chat.id,
        text: reply,
        parse_mode: "HTML",
      });
    }

    // Личное сообщение одному человеку от имени бота: /dm @ivanov текст.
    if (message && /^\/dm(?:@\w+)?(?:\s|$)/.test(text)) {
      const reply = isOwner(env, message.chat.id) ? await directMessage(env, text) : "Команда недоступна.";
      await callTelegram(env.BOT_TOKEN, "sendMessage", {
        chat_id: message.chat.id,
        text: reply,
        parse_mode: "HTML",
      });
    }

    if (message && /^\/clicker(?:@\w+)?(?:\s|$)/.test(text)) {
      const reply = isOwner(env, message.chat.id) ? await clickerCommand(env, text) : "Команда недоступна.";
      await callTelegram(env.BOT_TOKEN, "sendMessage", {
        chat_id: message.chat.id,
        text: reply,
        parse_mode: "HTML",
      });
    }

    if (message && /^\/(un)?important(?:@\w+)?(?:\s|$)/.test(text)) {
      const reply = isOwner(env, message.chat.id) ? await importantCommand(env, text) : "Команда недоступна.";
      await callTelegram(env.BOT_TOKEN, "sendMessage", {
        chat_id: message.chat.id,
        text: reply,
        parse_mode: "HTML",
      });
    }

    if (message && /^\/queues(?:@\w+)?(?:\s|$)/.test(text)) {
      const reply = isOwner(env, message.chat.id)
        ? await queuesCommand(env, text)
        : "Команда недоступна.";
      await callTelegram(env.BOT_TOKEN, "sendMessage", {
        chat_id: message.chat.id,
        text: reply.slice(0, 4000),
        parse_mode: "HTML",
      });
    }

    if (message && /^\/(un)?watch(?:@\w+)?(?:\s|$)/.test(text)) {
      // Право проверяем по автору, а не по чату: команду шлют из чата курса.
      if (isOwner(env, message.from?.id)) {
        await watchCommand(env, message, !text.startsWith("/unwatch"));
      }
    }

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

    // Метки рекламы и счётчик по факультетам — владельцу.
    if (message && /^\/(ads|faculties)(?:@\w+)?(?:\s|$)/.test(text)) {
      let reply = "Команда недоступна.";
      if (isOwner(env, message.chat.id)) {
        reply = text.startsWith("/ads") ? await adsReport(env) : await facultiesReport(env);
      }
      await callTelegram(env.BOT_TOKEN, "sendMessage", { chat_id: message.chat.id, text: reply.slice(0, 4000), parse_mode: "HTML" });
    }

    // Заходы одного человека — только владельцу.
    if (message && /^\/visits(?:@\w+)?(?:\s|$)/.test(text)) {
      const allowed = String(message.chat.id) === String(env.OWNER_ID);
      await callTelegram(env.BOT_TOKEN, "sendMessage", {
        chat_id: message.chat.id,
        text: allowed ? await visitsReport(env, text.split(/\s+/)[1] || "") : "Команда недоступна.",
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
    // Напоминания и рассылки теперь шлёт свой сервер. Здесь остался сторож:
    // раз в минуту смотрит на сервер со стороны и пишет владельцу, если
    // что-то сломалось.
    if (!OWN_SERVER && MOVED_TO) {
      ctx.waitUntil(watchServer(env).catch((error) => console.log("watch failed", String(error?.message || error))));
      return;
    }
    // Лимит обращений наружу — общий на весь запуск. Сначала напоминания:
    // они привязаны ко времени. Рассылке — что осталось, остальное она
    // доотправит в следующие минуты. Запас в 6 — на запросы к базе.
    ctx.waitUntil(
      (async () => {
        const used = await sendReminders(env).catch((error) => {
          console.log("reminders failed", String(error?.message || error));
          return REMIND_BATCH;
        });
        await drainOutbox(env, Math.min(BATCH, SEND_BUDGET - (used || 0)));
        // Уведомления об изменениях — только на своём сервере: в облаке не
        // хватило бы лимита обращений.
        if (OWN_SERVER) await runAlerts(env).catch((error) => console.log("alerts failed", String(error?.message || error)));
      })()
    );
  },
};
