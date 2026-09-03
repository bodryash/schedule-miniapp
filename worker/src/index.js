/**
 * Бот на вебхуке: Telegram сам стучится сюда, поэтому ничего крутить на
 * компьютере не нужно. Отвечает на /start сообщением с кнопкой,
 * открывающей мини-приложение.
 */

const WEB_APP_URL = "https://bodryash.github.io/schedule-miniapp/";

async function callTelegram(token, method, payload) {
  return fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export default {
  async fetch(request, env) {
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

    // Отвечаем только на /start; на всё остальное молчим, но подтверждаем
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

    return new Response("ok");
  },
};
