/**
 * Бот на вебхуке: Telegram сам стучится сюда, поэтому ничего крутить на
 * компьютере не нужно. Отвечает на /start сообщением с кнопкой,
 * открывающей мини-приложение, и на /stats — сводкой по открытиям.
 *
 * Второй маршрут — POST /hit: мини-приложение сообщает, что его открыли.
 * Считает обезличенно, см. schema.sql.
 */

const WEB_APP_URL = "https://bodryash.github.io/schedule-miniapp/";

// Открытие засчитываем не чаще раза в час на человека, иначе тот, кто за
// пару десять раз посмотрел расписание, перевесит целую группу.
const HIT_COOLDOWN = 3600;

async function callTelegram(token, method, payload) {
  return fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
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

  await env.STATS.prepare(
    `INSERT INTO opens (day, grp, course, level, count) VALUES (?, ?, ?, ?, 1)
     ON CONFLICT(day, grp) DO UPDATE SET count = count + 1`
  )
    .bind(today, group.id || "—", group.course ?? null, group.level ?? null)
    .run();
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

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
      await callTelegram(env.BOT_TOKEN, "sendMessage", {
        chat_id: message.chat.id,
        text: "Открывай расписание 👇",
        reply_markup: {
          inline_keyboard: [
            [{ text: "📅 Открыть расписание", web_app: { url: WEB_APP_URL } }],
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
