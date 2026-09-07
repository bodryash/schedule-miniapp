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

  await env.STATS.prepare(
    `INSERT INTO people (uid, first, last, grp) VALUES (?, ?, ?, ?)
     ON CONFLICT(uid) DO UPDATE SET last = excluded.last, grp = excluded.grp`
  )
    .bind(uid, new Date().toISOString(), new Date().toISOString(), group.id || null)
    .run();

  if (now - lastSeen < HIT_COOLDOWN) return;

  await env.STATS.prepare(
    `INSERT INTO opens (day, grp, course, level, count) VALUES (?, ?, ?, ?, 1)
     ON CONFLICT(day, grp) DO UPDATE SET count = count + 1`
  )
    .bind(today, group.id || "—", group.course ?? null, group.level ?? null)
    .run();
}

function daysAgo(count) {
  return new Date(Date.now() - count * 86400000).toISOString().slice(0, 10);
}

async function buildStats(env) {
  if (!env.STATS) return "Статистика не подключена.";

  const today = new Date().toISOString().slice(0, 10);
  const week = daysAgo(7);

  const [todayRow, weekRow, people, top] = await Promise.all([
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
  ]);

  const lines = [
    `<b>Открытия</b>`,
    `Сегодня: ${todayRow.n}`,
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

    const message = update.message;
    const text = message?.text ?? "";

    // Запоминаем, кому потом можно написать. Telegram список пользователей
    // не отдаёт, так что кроме этой записи взять его неоткуда.
    if (message?.chat?.id && env.USERS) {
      await env.USERS.put(
        String(message.chat.id),
        JSON.stringify({
          id: message.chat.id,
          name: message.chat.first_name ?? "",
          seen: new Date().toISOString().slice(0, 10),
        })
      );
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

    // Сводка только владельцу: цифры чужие, показывать их всем незачем.
    if (message && text.startsWith("/stats")) {
      const allowed = String(message.chat.id) === String(env.OWNER_ID);
      await callTelegram(env.BOT_TOKEN, "sendMessage", {
        chat_id: message.chat.id,
        text: allowed ? await buildStats(env) : "Команда недоступна.",
        parse_mode: "HTML",
      });
    }

    return new Response("ok");
  },
};
