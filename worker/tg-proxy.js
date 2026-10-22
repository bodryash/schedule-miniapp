/**
 * Пересыльщик к api.telegram.org для сервера бота.
 *
 * С 22.10.2026 сервер в России не может подключиться к api.telegram.org
 * (соединение обрывается по таймауту), а до Cloudflare доходит. Поэтому
 * сервер шлёт запросы к Telegram сюда, а мы — дальше как есть.
 *
 * Пропускаем только запросы нашего бота: путь /bot<ID>:… или /file/bot<ID>:…,
 * где ID — номер бота (он не секрет, это часть его публичного id). Чужим
 * ботам пересыльщик не нужен — отвечаем 403.
 *
 * Деплой: npx wrangler deploy worker/tg-proxy.js --name tg-proxy \
 *   --compatibility-date 2026-09-11 --var BOT_ID:<номер бота>
 */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const id = String(env.BOT_ID || "");
    const allowed = id && (url.pathname.startsWith(`/bot${id}:`) || url.pathname.startsWith(`/file/bot${id}:`));
    if (!allowed) return new Response("forbidden", { status: 403 });
    const target = `https://api.telegram.org${url.pathname}${url.search}`;
    const init = {
      method: request.method,
      headers: { "content-type": request.headers.get("content-type") || "application/json" },
    };
    if (request.method !== "GET" && request.method !== "HEAD") init.body = await request.arrayBuffer();
    // Файлы сервер качает кусками (Range): длинное соединение до Cloudflare из
    // России душат после первых ~16 КБ. Отдаём нужный кусок файла.
    const range = request.headers.get("range");
    if (range && url.pathname.startsWith("/file/")) {
      const match = /^bytes=(\d+)-(\d+)$/.exec(range);
      const full = await fetch(target);
      if (!full.ok || !match) return new Response(full.body, { status: full.status });
      const bytes = new Uint8Array(await full.arrayBuffer());
      const from = Number(match[1]);
      const to = Math.min(Number(match[2]), bytes.length - 1);
      return new Response(bytes.slice(from, to + 1), {
        status: 206,
        headers: {
          "content-type": "application/octet-stream",
          "content-range": `bytes ${from}-${to}/${bytes.length}`,
        },
      });
    }
    const response = await fetch(target, init);
    return new Response(response.body, {
      status: response.status,
      headers: { "content-type": response.headers.get("content-type") || "application/octet-stream" },
    });
  },
};
