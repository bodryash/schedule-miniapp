// Проверка Подслушки на настоящем сервере с пустой базой и заглушкой Telegram.
// Запуск: node server/forum.test.mjs
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const TOKEN = "123456:TESTTOKEN";
const OWNER = 1;
const dir = mkdtempSync(join(tmpdir(), "forum-"));
const sent = [];
const stub = createServer((req, res) => {
  let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
    const method = req.url.split("/").pop();
    try { sent.push({ method, ...JSON.parse(b || "{}") }); } catch {}
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, result: { message_id: 1 } }));
  });
});
await new Promise((r) => stub.listen(0, "127.0.0.1", r));
const stubPort = stub.address().port;
const PORT = 18800 + Math.floor(Math.random() * 100);
const srv = spawn("node", [fileURLToPath(new URL("./index.mjs", import.meta.url))], {
  env: { ...process.env, BOT_TOKEN: TOKEN, OWNER_ID: String(OWNER), STATS_SALT: "s", WEBHOOK_SECRET: "w", DB_PATH: join(dir, "t.sqlite"), PORT: String(PORT), NO_CRON: "1", TELEGRAM_API_BASE: `http://127.0.0.1:${stubPort}` },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = ""; srv.stdout.on("data", (d) => (log += d)); srv.stderr.on("data", (d) => (log += d));
for (let i = 0; i < 60; i++) { try { await fetch(`http://127.0.0.1:${PORT}/healthz`); break; } catch { await new Promise((r) => setTimeout(r, 250)); } }

const initData = (id, first = "Иван", username = null) => {
  const user = JSON.stringify({ id, first_name: first, username: username || undefined });
  const p = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), user });
  const check = [...p.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(TOKEN).digest();
  p.set("hash", createHmac("sha256", secret).update(check).digest("hex"));
  return p.toString();
};
const api = async (action, body, id = 100, first = "Иван", uname) => {
  const r = await fetch(`http://127.0.0.1:${PORT}/forum/${action}`, { method: "POST", body: JSON.stringify({ initData: initData(id, first, uname), ...body }) });
  return { status: r.status, ...(await r.json()) };
};
const tg = async (text, from = OWNER) => {
  const r = await fetch(`http://127.0.0.1:${PORT}/`, { method: "POST", headers: { "x-telegram-bot-api-secret-token": "w", "content-type": "application/json" }, body: JSON.stringify({ update_id: Math.floor(Math.random() * 1e9), message: { message_id: 1, from: { id: from, first_name: "O" }, chat: { id: from, type: "private" }, text } }) });
  return r.status;
};
const lastSent = (n = 1) => sent.slice(-n);
const settle = () => new Promise((r) => setTimeout(r, 200));
let fail = 0;
const ok = (cond, name, extra = "") => { console.log((cond ? "✓ " : "✗ ") + name + (cond ? "" : "  " + extra)); if (!cond) fail++; };

// 0. закрытое тестирование: по умолчанию пускаем только своих
let r = await api("list", {}, 100);
ok(r.status === 403 && r.error === "closed", "по умолчанию форум закрыт для посторонних", JSON.stringify(r));
r = await api("list", {}, OWNER);
ok(r.ok, "владельцу открыт всегда");
await tg("/ftester 100");
await settle();
ok(sent.some((m) => String(m.chat_id) === "100" && /тестовый доступ/.test(m.text || "") && m.reply_markup?.inline_keyboard?.[0]?.[0]?.web_app), "тестировщику ушло сообщение с кнопкой");
r = await api("list", {}, 100);
ok(r.ok, "тестировщик допущен");
r = await api("list", {}, 200);
ok(r.status === 403 && r.error === "closed", "остальные по-прежнему закрыты");
await tg("/fmod 201"); await settle();
r = await api("list", { sort: "review" }, 201);
ok(r.ok && r.owner === true && r.role === "moderator", "модератору видна очередь проверки", JSON.stringify(r).slice(0, 140));
ok(r.posts.every((p) => p.author === undefined), "модератор не видит настоящих авторов");
r = await api("mod", { kind: "p", id: 1, op: "purge" }, 201);
ok(r.status === 403, "модератор не может «удалить всё автора»", JSON.stringify(r));
r = await api("mod", { kind: "p", id: 99999, op: "del" }, 100);
ok(r.status === 403, "тестировщику модерация недоступна", JSON.stringify(r));
sent.length = 0; await tg("/froles"); await settle();
ok(sent.some((m) => /Допущены/.test(m.text || "") && /тестировщик/.test(m.text) && /модератор/.test(m.text)), "/froles показывает роли");
await tg("/funtester 100"); await settle();
r = await api("list", {}, 100);
ok(r.status === 403, "после /funtester доступ закрыт снова");
await tg("/ftester 100"); await tg("/forum all"); await settle();
r = await api("list", {}, 300);
ok(r.ok, "/forum all открывает форум всем");
await tg("/forum testers"); await settle();
r = await api("list", {}, 300);
ok(r.status === 403, "/forum testers закрывает снова");
await tg("/forum all"); await settle();
sent.length = 0;

// 1. первый пост нового автора — на проверку
r = await api("post", { text: "Кто знает, когда пересдача по микроэкономике?", anon: true });
ok(r.ok && r.pending, "первый пост новичка ждёт проверки", JSON.stringify(r));
ok(sent.some((m) => m.method === "sendMessage" && /ждёт проверки/.test(m.text) && String(m.chat_id) === "1"), "владельцу пришло уведомление о проверке");
const note = sent.find((m) => /ждёт проверки/.test(m.text || ""));
ok(note?.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data?.startsWith("fok:p:"), "в уведомлении есть кнопка «Опубликовать»");
const postId = r.post.id;
// не виден чужим
r = await api("list", {}, 200);
ok(r.ok && r.posts.length === 0, "чужие пока не видят пост на проверке", JSON.stringify(r.posts));
r = await api("list", {}, 100);
ok(r.posts.length === 1 && r.posts[0].pending, "автор видит свой пост с пометкой «на проверке»");
// одобрение кнопкой
await fetch(`http://127.0.0.1:${PORT}/`, { method: "POST", headers: { "x-telegram-bot-api-secret-token": "w", "content-type": "application/json" }, body: JSON.stringify({ update_id: 1, callback_query: { id: "c1", from: { id: OWNER }, data: `fok:p:${postId}`, message: { chat: { id: OWNER }, message_id: 5 } } }) });
r = await api("list", {}, 200);
ok(r.posts.length === 1 && r.posts[0].name.startsWith("Аноним"), "после одобрения виден всем как аноним", JSON.stringify(r.posts));
ok(r.posts[0].author === undefined, "настоящий автор чужим не виден");
r = await api("list", {}, OWNER);
ok(r.posts[0].author?.id === 100, "владельцу виден настоящий автор");
// доверенный: второй пост публикуется сразу, но лимит интервала
r = await api("post", { text: "Второй вопрос про общагу", anon: false }, 100);
ok(r.status === 429 && r.error === "slow", "интервал между постами", JSON.stringify(r));
// фильтры
r = await api("post", { text: "пишите мне @ivanov_x", anon: true }, 101); ok(r.status === 422 && r.error === "blocked", "упоминание блокируется", JSON.stringify(r));
r = await api("post", { text: "ну ты и хуйло, поговорим", anon: true }, 101); ok(r.status === 422, "мат блокируется", JSON.stringify(r));
r = await api("post", { text: "я не хочу жить, всё надоело", anon: true }, 101); ok(r.ok && r.pending && /беды/.test(r.reason), "признаки беды — на проверку", JSON.stringify(r));
r = await api("post", { text: "куплю траву недорого", anon: true }, 102); ok(r.ok && r.pending, "наркотики — на проверку", JSON.stringify(r));
// ответы
sent.length = 0;
r = await api("reply", { post: postId, text: "Во вторник в 14:00, смотри в расписании", anon: true }, 200);
await settle();
ok(sent.some((m) => m.method === "sendMessage" && String(m.chat_id) === "100" && /Ответили на ваш пост/.test(m.text || "") && m.reply_markup?.inline_keyboard?.[0]?.[0]?.web_app?.url?.includes("?forum=" + postId)), "автору поста пришло уведомление со ссылкой на тему");
ok(r.ok && !r.pending, "ответ публикуется сразу", JSON.stringify(r));
const rep1 = r.reply;
r = await api("reply", { post: postId, text: "Спасибо большое!", anon: true }, 100);
r = await api("replies", { post: postId }, 100);
ok(r.replies.length === 2 && r.replies[1].op === false, "анонимный ответ автора поста без плашки «автор»", JSON.stringify(r.replies));
ok(r.replies[0].name !== r.replies[1].name, "у разных анонимов разные имена");
r = await api("list", {}, 200); ok(r.posts[0].replies === 2, "счётчик ответов растёт");
// лайк
r = await api("like", { post: postId }, 200); ok(r.ok && r.liked && r.likes === 1, "лайк", JSON.stringify(r));
r = await api("like", { post: postId }, 200); ok(r.ok && !r.liked && r.likes === 0, "повторный лайк снимает", JSON.stringify(r));
// голосование стрелками
r = await api("vote", { kind: "p", post: postId, v: -1 }, 301);
ok(r.ok && r.v === -1 && r.score === -1, "стрелка вниз: рейтинг 0 → −1", JSON.stringify(r));
r = await api("vote", { kind: "p", post: postId, v: -1 }, 302);
ok(r.score === -2, "второй голос против: рейтинг −2", JSON.stringify(r));
r = await api("vote", { kind: "p", post: postId, v: 1 }, 301);
ok(r.v === 1 && r.score === 0, "переключили вниз → вверх: меняет рейтинг сразу на 2 (−2 → 0)", JSON.stringify(r));
r = await api("list", {}, 302);
ok(r.posts.find((p) => p.id === postId)?.vote === -1, "свой голос виден в ленте", JSON.stringify(r.posts.find((p) => p.id === postId)));
r = await api("vote", { kind: "p", post: postId, v: 0 }, 302);
ok(r.v === 0 && r.score === 1, "снять голос против: −1 к минусу (0 → +1)", JSON.stringify(r));
r = await api("vote", { kind: "p", post: postId, v: 7 }, 302); ok(r.status === 400, "странный голос отклонён");
r = await api("vote", { kind: "p", post: postId, v: 1 }, 301);
r = await api("vote", { kind: "p", post: postId, v: 0 }, 301);
// ответ на ответ, лайк ответа, цитата родителя
r = await api("replies", { post: postId }, 100);
const parentId = r.replies[0].id;
sent.length = 0;
r = await api("reply", { post: postId, text: "Это ответ на ответ", anon: true, to: parentId }, 201);
await settle();
ok(r.ok && r.reply.parent?.id === parentId, "ответ на ответ хранит родителя", JSON.stringify(r));
r = await api("replies", { post: postId }, 100);
const child = r.replies.find((x) => x.parent);
ok(child && child.parent.text.length > 0 && child.parent.name.startsWith("Аноним"), "родитель приходит цитатой с именем", JSON.stringify(child));
ok(sent.some((m) => m.method === "sendMessage" && String(m.chat_id) === "200" && /Ответили на ваш ответ/.test(m.text || "")), "автору ответа пришло уведомление, что ответили именно ему");
r = await api("reply", { post: postId, text: "Ответ на несуществующий", anon: true, to: 99999 }, 202); ok(r.status === 404, "ответ на чужую/несуществующую ветку — отказ", JSON.stringify(r));
r = await api("like", { kind: "r", id: parentId }, 202); ok(r.ok && r.liked && r.likes === 1, "лайк ответа", JSON.stringify(r));
r = await api("replies", { post: postId }, 202); ok(r.replies.find((x) => x.id === parentId).liked === true, "лайк ответа виден лайкнувшему");
r = await api("prefs", { notify: false }, OWNER); ok(r.ok && r.notify === false, "уведомления можно выключить");
// другая тема — чтобы не упереться в «не чаще раза в 20 минут»
const other = await api("post", { text: "Вторая тема, чтобы проверить выключенные уведомления", anon: true }, OWNER);
await api("prefs", { notify: false }, OWNER);
sent.length = 0; await api("reply", { post: other.post.id, text: "Ответ, о котором автор не узнает", anon: true }, 203);
await settle();
ok(!sent.some((m) => String(m.chat_id) === String(OWNER) && /Ответили/.test(m.text || "")), "выключенные уведомления не приходят");
await api("prefs", { notify: true }, OWNER);
// опрос новых
const top0 = (await api("list", {}, 200)).top;
await api("post", { text: "Свежий пост про расписание на пятницу, кто в курсе?", anon: true }, OWNER);
r = await api("poll", { after: top0 }, 200); ok(r.ok && r.count === 1, "poll считает новые посты", JSON.stringify(r));
r = await api("poll", { after: top0 }, OWNER); ok(r.count === 0, "свои посты в «новых» не считаются", JSON.stringify(r));
// причина жалобы доходит до владельца
sent.length = 0;
const newPost = (await api("list", {}, 200)).posts[0];
await api("report", { kind: "p", id: newPost.id, reason: "spam" }, 300);
ok(sent.some((m) => /спам или реклама/.test(m.text || "")), "причина жалобы указана в сообщении владельцу");
ok(sent.some((m) => /Жалуются:/.test(m.text || "") && /tg:\/\/user\?id=300/.test(m.text || "")), "владелец видит, кто пожаловался (ссылка на профиль)");
// действия владельца из приложения
r = await api("mod", { kind: "p", id: newPost.id, op: "del" }, 200); ok(r.status === 403, "обычному человеку mod недоступен", JSON.stringify(r));
r = await api("mod", { kind: "p", id: newPost.id, op: "del" }, OWNER); ok(r.ok && /Удалено/.test(r.text), "владелец удаляет из приложения", JSON.stringify(r));
r = await api("list", { sort: "review" }, OWNER); ok(r.ok && typeof r.review === "number", "очередь проверки у владельца", JSON.stringify(r).slice(0, 120));
r = await api("list", { sort: "review" }, 200); ok(r.ok && r.review === undefined && r.posts.every((p) => !p.pending || p.mine), "очередь проверки обычному не раскрывается");

// жалобы: 3 → скрыт
sent.length = 0;
for (const id of [300, 301, 302]) r = await api("report", { kind: "p", id: postId }, id);
r = await api("list", {}, 200); ok(!r.posts.some((p) => p.id === postId), "после 3 жалоб пост скрыт", JSON.stringify(r.posts.map((p) => p.id)));
ok(sent.some((m) => /скрыт после 3 жалоб/.test(m.text || "")), "владелец получил уведомление о скрытии");
ok(sent.filter((m) => /жалоба на/.test(m.text || "")).length === 2, "и о первых двух жалобах");
// бан → не пишет
await tg(`/fban ${postId} 3 тест`);
r = await api("post", { text: "новый пост после бана", anon: true }, 100); ok(r.status === 403 && r.error === "banned", "забаненный не пишет", JSON.stringify(r));
r = await api("list", {}, 100); ok(r.ok, "забаненный может читать");
// ссылка на профиль — только у тех, кто пишет под именем и имеет @ник
const named = await api("post", { text: "Пост под своим именем, чтобы проверить ссылку на профиль", anon: false }, OWNER, "Админ", "boss_nick");
const anonPost = await api("post", { text: "Анонимный пост того же человека, ссылки быть не должно", anon: true }, OWNER, "Админ", "boss_nick");
r = await api("list", {}, 200);
const seenNamed = r.posts.find((p) => p.id === named.post.id);
const seenAnon = r.posts.find((p) => p.id === anonPost.post.id);
ok(seenNamed?.tg === "boss_nick", "под именем — ссылка на профиль доступна другим", JSON.stringify(seenNamed));
ok(seenAnon && seenAnon.tg === undefined && !JSON.stringify(seenAnon).includes("boss_nick"), "у анонима ника нет нигде в ответе", JSON.stringify(seenAnon));
// команды владельца
sent.length = 0; await tg("/forum");
ok(sent.some((m) => /Подслушка/.test(m.text || "") && /На проверке/.test(m.text)), "/forum показывает сводку");
ok(sent.filter((m) => /ждёт\nПричина:/.test(m.text || "")).length >= 2, "в сводке очередь проверки с кнопками");
sent.length = 0; await tg(`/fwho ${postId}`); ok(sent.some((m) => /Автор:/.test(m.text || "") && /id 100/.test(m.text)), "/fwho раскрывает автора");
// выключатель
await tg("/forum off");
r = await api("list", {}, 200); ok(r.status === 503 && r.error === "off", "/forum off выключает у всех", JSON.stringify(r));
r = await api("list", {}, OWNER); ok(r.ok, "владельцу форум доступен при выключенном");
await tg("/forum on");
r = await api("list", {}, 200); ok(r.ok, "/forum on включает");
// закрытие на ремонт: /fclose переспрашивает, закрывает только «Да»
const press = (data, from = OWNER) => fetch(`http://127.0.0.1:${PORT}/`, { method: "POST", headers: { "x-telegram-bot-api-secret-token": "w", "content-type": "application/json" }, body: JSON.stringify({ update_id: Math.floor(Math.random() * 1e9), callback_query: { id: "c", from: { id: from }, data, message: { chat: { id: from }, message_id: 9 } } }) });
sent.length = 0; await tg("/fclose Чиним фильтр"); await settle();
ok(sent.some((m) => /Закрыть Подслушку на ремонт/.test(m.text || "") && m.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data === "fcl:y"), "/fclose переспрашивает кнопками");
r = await api("list", {}, 200); ok(r.ok, "до подтверждения форум не закрыт");
await press("fcl:n"); await settle();
r = await api("list", {}, 200); ok(r.ok, "«Отмена» — форум работает");
await tg("/fclose Чиним фильтр"); await settle();
await press("fcl:y", 777); await settle();
r = await api("list", {}, 200); ok(r.ok, "чужая кнопка не закрывает");
await press("fcl:y"); await settle();
r = await api("list", {}, 200); ok(r.status === 503 && r.error === "off" && r.message === "Чиним фильтр", "«Да» закрывает и отдаёт текст людям", JSON.stringify(r));
r = await api("status", {}, 200); ok(r.ok && r.off === true && r.message === "Чиним фильтр" && r.owner === false, "status: закрыто, текст, не владелец", JSON.stringify(r));
r = await api("status", {}, OWNER); ok(r.owner === true, "status узнаёт владельца");
r = await fetch(`http://127.0.0.1:${PORT}/forum/status`, { method: "POST", body: "{}" }).then((x) => x.json()); ok(r.ok && r.off === true, "status без входа тоже отвечает", JSON.stringify(r));
r = await api("switch", { off: false }, 200); ok(r.status === 403, "кнопка в приложении — только владельцу");
r = await api("switch", { off: false }, OWNER); ok(r.ok && r.off === false, "владелец открывает из приложения", JSON.stringify(r));
r = await api("switch", { off: true, message: "Минутку" }, OWNER); ok(r.off === true && r.message === "Минутку", "и закрывает из приложения");
await tg("/fopen"); await settle();
r = await api("list", {}, 200); ok(r.ok, "/fopen открывает");
r = await api("status", {}, 200); ok(r.off === false && r.message === "", "status после открытия чистый");
// правка своего поста
r = await api("post", { text: "Пост для правки, исходный текст тут", anon: true }, 610, "Петя");
const eid = r.post.id;
if (r.pending) await api("mod", { kind: "p", id: eid, op: "ok" }, OWNER);
r = await api("edit", { kind: "p", id: eid, text: "Пост для правки — исправленный текст" }, 611); ok(r.status === 403, "чужой пост править нельзя");
r = await api("edit", { kind: "p", id: eid, text: "Пост для правки — исправленный текст" }, 610); ok(r.ok && r.edited, "свой пост правится", JSON.stringify(r));
r = await api("list", {}, 200); const ed = r.posts.find((p) => p.id === eid);
ok(ed?.text === "Пост для правки — исправленный текст" && ed.edited === true, "новый текст и пометка «изменено» видны всем", JSON.stringify(ed));
r = await api("edit", { kind: "p", id: eid, text: "пишите на t.me/spam" }, 610); ok(r.status === 422, "правка проходит фильтр (ссылки нельзя)");
sent.length = 0; r = await api("edit", { kind: "p", id: eid, text: "Куплю закладку срочно" }, 610); await settle();
ok(r.ok && r.pending, "опасная правка уходит на проверку", JSON.stringify(r));
ok(sent.some((m) => /изменён и ждёт проверки/.test(m.text || "")), "владельцу пришло уведомление о правке");
// галочка владельца: только под своим именем
r = await api("post", { text: "Официально: проверка галочки владельца в ленте", anon: false }, OWNER, "Владелец");
const vPost = r.post; ok(vPost?.verified === true, "у поста владельца под именем — галочка", JSON.stringify(r).slice(0, 200));
r = await api("post", { text: "Анонимный пост владельца, без галочки тут", anon: true }, OWNER, "Владелец");
ok(r.post && r.post.verified === undefined, "у анонимного поста владельца галочки нет");
r = await api("list", {}, 200); ok(r.posts.find((p) => p.id === vPost.id)?.verified === true, "другие тоже видят галочку");
// статистика форума
sent.length = 0; await tg("/fstats"); await settle();
ok(sent.some((m) => /Подслушка — статистика/.test(m.text || "") && /Посты:/.test(m.text) && /Голоса:/.test(m.text)), "/fstats присылает статистику", JSON.stringify(sent.slice(-1)).slice(0, 300));
// закрепление: только владелец, закреплённый пост первым в «Новом»
r = await api("list", {}, 200); const oldest = r.posts[r.posts.length - 1];
r = await api("pin", { post: oldest.id, on: true }, 200); ok(r.status === 403, "закреплять может только владелец");
r = await api("pin", { post: oldest.id, on: true }, OWNER); ok(r.ok && r.post.pinned === true, "владелец закрепил пост", JSON.stringify(r).slice(0, 200));
r = await api("list", {}, 200); ok(r.posts[0].id === oldest.id && r.posts[0].pinned, "закреплённый пост — первый в ленте", JSON.stringify(r.posts.map((p) => p.id)));
ok(r.posts.filter((p) => p.id === oldest.id).length === 1, "и не повторяется ниже");
r = await api("pin", { post: oldest.id, on: false }, OWNER); ok(r.ok && r.post.pinned === false, "открепил");
r = await api("list", {}, 200); ok(r.posts[0].id !== oldest.id, "после открепления — на своём месте");
// снять всех модераторов одной командой
await tg("/fmod 451"); await tg("/fmod 452"); await settle();
r = await api("list", {}, 451); ok(r.ok && r.role === "moderator", "модератор назначен (до /funmod all)");
sent.length = 0; await tg("/funmod all"); await settle();
ok(sent.some((m) => /Снял всех модераторов/.test(m.text || "")), "/funmod all снимает всех сразу", JSON.stringify(sent.slice(-2)));
sent.length = 0; await tg("/froles"); await settle();
ok(!sent.some((m) => /🛡/.test(m.text || "")), "после /funmod all модераторов в списке нет");
// очистка: только после «Да», посты и модераторы стираются, тестировщики остаются
await tg("/fmod 450"); await settle();
r = await api("list", {}, 200); const beforeWipe = r.posts.length; ok(beforeWipe > 0, "до очистки посты есть");
sent.length = 0; await tg("/fclear"); await settle();
ok(sent.some((m) => /Стереть ВСЕ/.test(m.text || "") && m.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data === "fwp:y"), "/fclear переспрашивает кнопками");
r = await api("list", {}, 200); ok(r.posts.length === beforeWipe, "до подтверждения ничего не стёрто");
await press("fwp:n"); await settle();
r = await api("list", {}, 200); ok(r.posts.length === beforeWipe, "«Отмена» ничего не стирает");
await press("fwp:y", 777); await settle();
r = await api("list", {}, 200); ok(r.posts.length === beforeWipe, "чужая кнопка не стирает");
await press("fwp:y"); await settle();
r = await api("list", {}, 200); ok(r.ok && r.posts.length === 0, "«Да» стирает все посты", JSON.stringify(r.posts?.length));
r = await api("list", {}, 450); ok(r.ok && r.owner === false, "бывший модератор зайти может, но уже без прав");
r = await api("list", { sort: "review" }, 450); ok(!r.review && !(r.posts || []).length, "модераторской очереди у него нет");
// чужой не владелец
sent.length = 0; await tg("/forum off", 777); ok(sent.some((m) => /недоступна/.test(m.text || "")), "чужому команда недоступна");
r = await api("list", {}, 200); ok(r.ok, "и форум не выключился");
// повтор
r = await api("post", { text: "Подскажите, где найти актовый зал в главном корпусе?", anon: true }, 400);
r = await api("post", { text: "Подскажите, где найти актовый зал в главном корпусе?", anon: true }, 401); ok(r.status === 422 && r.error === "duplicate", "копия чужого текста — отказ", JSON.stringify(r));
// подделанная подпись
const bad = await fetch(`http://127.0.0.1:${PORT}/forum/list`, { method: "POST", body: JSON.stringify({ initData: "user=%7B%22id%22%3A5%7D&hash=00" }) });
ok(bad.status === 401, "без верной подписи Telegram — 401");

console.log(fail ? `\nПРОВАЛОВ: ${fail}` : "\nВСЕ ПРОВЕРКИ ПРОШЛИ");
if (fail) console.log(log.slice(-1500));
srv.kill(); stub.close(); rmSync(dir, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
