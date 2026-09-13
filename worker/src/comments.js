/**
 * Комментарии к парам: «начнём на 10 минут позже», «взять ноутбук».
 *
 * Пишет и читает любой, кто открыл приложение в Telegram, в любой группе;
 * сдерживают лимиты, жалобы и баны (/ban). Подпись Telegram проверяет
 * index.js; сюда приходит уже проверенный пользователь.
 *
 * Новые комментарии не прилетают сами: окно обновляется при открытии и по
 * кнопке. Живой опрос сервера каждые несколько секунд съел бы дневной лимит
 * обращений за пару часов.
 */

import { addDays, iso, loadGroups, normalize, today } from "./inline.js";

export const COMMENT_MAX = 300;
const PER_USER_DAY = 10;
const PER_GROUP_DAY = 300;
const REPORTS_TO_HIDE = 3;
const PAGE = 50;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
// Комментировать можно неделю назад и две вперёд — как далеко листается
// расписание. Иначе кто-нибудь писал бы в пары годичной давности.
const PAST_DAYS = 7;
const FUTURE_DAYS = 14;

function escape(text) {
  return String(text).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c]);
}

/** Начало сегодняшнего дня по Москве в UTC — для дневных лимитов. */
function dayStartUtc() {
  return new Date(today().getTime() - 3 * 3600 * 1000).toISOString();
}

const isOwner = (env, id) => String(id) === String(env.OWNER_ID);

async function isStarosta(env, userId, groupId) {
  const row = await env.STATS.prepare("SELECT 1 AS ok FROM starostas WHERE grp = ? AND tg_id = ?")
    .bind(groupId, userId)
    .first();
  return Boolean(row);
}

/**
 * Писать и читать может любой, кто открыл приложение в Telegram, в любой
 * группе — так решил владелец. Сдерживают лимиты, жалобы и то, что
 * владелец видит всех авторов командой /comments.
 */
export async function canComment(env, user, groupId) {
  return Boolean(user?.id && groupId);
}

/** Группа должна быть в расписании — иначе через API писали бы в выдуманные. */
async function groupExists(groupId) {
  try {
    return (await loadGroups()).some((g) => g.id === groupId);
  } catch {
    // Список не загрузился — не мешаем писать в группу из самого приложения.
    return true;
  }
}

/** Счётчики «💬 N» на диапазон дат: строка на пару, где что-то написано. */
export async function commentCounts(env, groupId, range) {
  if (!env.STATS || !groupId) return [];
  const { results = [] } = await env.STATS.prepare(
    `SELECT day, subject, count FROM comment_counts
     WHERE grp = ? AND day >= ? AND day <= ? AND count > 0 LIMIT 200`
  )
    .bind(groupId, range.from, range.to)
    .all();
  return results;
}

function displayName(user) {
  const name = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
  return (name || (user.username ? `@${user.username}` : "Студент")).slice(0, 64);
}

async function listFor(env, user, groupId, day, subject) {
  const [{ results = [] }, starosta] = await Promise.all([
    env.STATS.prepare(
      `SELECT id, tg_id, name, text, created FROM comments
       WHERE grp = ? AND day = ? AND subject = ? AND hidden = 0
       ORDER BY id DESC LIMIT ?`
    )
      .bind(groupId, day, subject, PAGE)
      .all(),
    isStarosta(env, user.id, groupId),
  ]);
  const moderator = starosta || isOwner(env, user.id);
  // Идентификаторы Telegram наружу не отдаём — только «моё» и права.
  return results.reverse().map((c) => ({
    id: c.id,
    name: c.name,
    text: c.text,
    created: c.created,
    mine: c.tg_id === user.id,
    canDelete: c.tg_id === user.id || moderator,
  }));
}

function lessonParams(body) {
  const group = String(body.group || "");
  const day = String(body.day || "");
  const subject = String(body.subject || "").trim();
  if (!group || !subject || subject.length > 200 || !ISO_DAY.test(day)) return null;
  const now = today();
  if (day < iso(addDays(now, -PAST_DAYS)) || day > iso(addDays(now, FUTURE_DAYS))) return null;
  return { group, day, subject };
}

const fail = (error, status = 400, extra = {}) => ({ status, json: { ok: false, error, ...extra } });

/* ---------- Баны ---------- */

/** Действующий бан: без срока или срок ещё не вышел. */
async function activeBan(env, tgId) {
  const row = await env.STATS.prepare("SELECT reason, until FROM comment_bans WHERE tg_id = ?")
    .bind(tgId)
    .first();
  if (!row) return null;
  if (row.until && row.until <= new Date(Date.now()).toISOString()) return null;
  return { until: row.until || null, reason: row.reason || "" };
}

async function addCount(env, { group, day, subject }, delta) {
  return env.STATS.prepare(
    `INSERT INTO comment_counts (grp, day, subject, count) VALUES (?, ?, ?, MAX(?, 0))
     ON CONFLICT(grp, day, subject) DO UPDATE SET count = MAX(count + ?, 0)`
  ).bind(group, day, subject, delta, delta);
}

/**
 * /comments/list, /comments/add, /comments/delete, /comments/report.
 * `notify(text, buttons)` — сообщение владельцу, для жалоб.
 */
export async function commentsApi(env, action, body, user, notify) {
  if (!user?.id) return fail("unauthorized", 401);

  // Забаненный читает, но не пишет и не жалуется: жалобы — тоже способ
  // вредить ленте.
  const ban = isOwner(env, user.id) ? null : await activeBan(env, user.id);
  if (ban && (action === "add" || action === "report")) return fail("banned", 403, { banned: ban });

  if (action === "list" || action === "add") {
    const lesson = lessonParams(body);
    if (!lesson) return fail("bad request");
    if (!(await canComment(env, user, lesson.group))) return fail("forbidden", 403);
    if (!(await groupExists(lesson.group))) return fail("bad request");

    if (action === "add") {
      const text = String(body.text || "").trim();
      if (!text) return fail("empty");
      if (text.length > COMMENT_MAX) return fail("too long");

      const since = dayStartUtc();
      const [mine, group] = await Promise.all([
        env.STATS.prepare("SELECT COUNT(*) AS n FROM comments WHERE tg_id = ? AND created >= ?")
          .bind(user.id, since)
          .first(),
        env.STATS.prepare("SELECT COUNT(*) AS n FROM comments WHERE grp = ? AND created >= ?")
          .bind(lesson.group, since)
          .first(),
      ]);
      if (!isOwner(env, user.id) && mine.n >= PER_USER_DAY) return fail("user limit", 429);
      if (!isOwner(env, user.id) && group.n >= PER_GROUP_DAY) return fail("group limit", 429);

      await env.STATS.batch([
        env.STATS.prepare(
          `INSERT INTO comments (grp, day, subject, tg_id, name, username, text, created)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          lesson.group,
          lesson.day,
          lesson.subject,
          user.id,
          displayName(user),
          user.username || null,
          text,
          new Date(Date.now()).toISOString()
        ),
        await addCount(env, lesson, 1),
      ]);
    }

    return {
      status: 200,
      json: { ok: true, banned: ban, comments: await listFor(env, user, lesson.group, lesson.day, lesson.subject) },
    };
  }

  if (action === "delete" || action === "report") {
    const id = Number(body.id);
    if (!Number.isInteger(id) || id < 1) return fail("bad request");
    const comment = await env.STATS.prepare(
      "SELECT id, grp, day, subject, tg_id, name, text, hidden, reports FROM comments WHERE id = ?"
    )
      .bind(id)
      .first();
    if (!comment || comment.hidden) return fail("not found", 404);
    const lesson = { group: comment.grp, day: comment.day, subject: comment.subject };

    if (action === "delete") {
      const allowed =
        comment.tg_id === user.id || isOwner(env, user.id) || (await isStarosta(env, user.id, comment.grp));
      if (!allowed) return fail("forbidden", 403);
      await env.STATS.batch([
        env.STATS.prepare("UPDATE comments SET hidden = 2 WHERE id = ? AND hidden = 0").bind(id),
        await addCount(env, lesson, -1),
      ]);
    } else {
      if (comment.tg_id === user.id) return fail("own comment");
      if (!(await canComment(env, user, comment.grp))) return fail("forbidden", 403);
      const added = await env.STATS.prepare(
        "INSERT OR IGNORE INTO comment_reports (comment, tg_id) VALUES (?, ?)"
      )
        .bind(id, user.id)
        .run();
      if (added.meta?.changes) {
        const reports = comment.reports + 1;
        const hide = reports >= REPORTS_TO_HIDE;
        await env.STATS.batch([
          env.STATS.prepare("UPDATE comments SET reports = ?, hidden = ? WHERE id = ?").bind(reports, hide ? 1 : 0, id),
          ...(hide ? [await addCount(env, lesson, -1)] : []),
        ]);
        if (hide) {
          await notify(
            [
              `⚠️ Комментарий №${id} скрыт после ${reports} жалоб.`,
              `${escape(comment.grp)} · ${escape(comment.subject)} · ${comment.day}`,
              `${escape(comment.name)}: ${escape(comment.text)}`,
            ].join("\n"),
            [[{ text: "Вернуть", callback_data: `cmr:${id}` }, { text: "Удалить", callback_data: `cmd:${id}` }]]
          );
        }
      }
    }

    return {
      status: 200,
      json: { ok: true, banned: ban, comments: await listFor(env, user, lesson.group, lesson.day, lesson.subject) },
    };
  }

  return fail("bad request");
}

/** Кнопки владельца под уведомлением о скрытом комментарии. */
export async function moderateComment(env, action, id) {
  const comment = await env.STATS.prepare("SELECT grp, day, subject, hidden FROM comments WHERE id = ?")
    .bind(id)
    .first();
  if (!comment) return "Комментария нет";
  const lesson = { group: comment.grp, day: comment.day, subject: comment.subject };
  if (action === "cmr") {
    if (comment.hidden !== 1) return "Уже решено";
    // Жалобы обнуляем: иначе следующая сразу скрыла бы его снова.
    await env.STATS.batch([
      env.STATS.prepare("UPDATE comments SET hidden = 0, reports = 0 WHERE id = ?").bind(id),
      env.STATS.prepare("DELETE FROM comment_reports WHERE comment = ?").bind(id),
      await addCount(env, lesson, 1),
    ]);
    return "Вернул";
  }
  if (comment.hidden === 2) return "Уже удалён";
  // Скрытый жалобами уже вычтен из счётчика — второй раз не вычитаем.
  await env.STATS.batch([
    env.STATS.prepare("UPDATE comments SET hidden = 2 WHERE id = ?").bind(id),
    ...(comment.hidden === 0 ? [await addCount(env, lesson, -1)] : []),
  ]);
  return "Удалил";
}

const LIST_LIMIT = 40;
const STATUS = { 0: "", 1: " · 🚫 скрыт жалобами", 2: " · 🗑 удалён" };
const TIME = new Intl.DateTimeFormat("ru-RU", {
  day: "2-digit",
  month: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Europe/Moscow",
});

export const COMMENTS_HELP = [
  "<b>Комментарии</b> — последние сверху, со всеми авторами.",
  "/comments — все группы",
  "/comments 311гэу — по группе",
  "/comments @ivanov или /comments 123456 — по человеку",
  "/delcomment 12 — удалить",
  "/ban @ivanov [дни] [причина] — запретить писать, /unban, /bans",
].join("\n");

const BAN_HELP = [
  "<b>Бан в комментариях</b> — читать можно, писать и жаловаться нельзя.",
  "",
  "/ban @ivanov — навсегда",
  "/ban @ivanov 7 спам — на 7 дней, с причиной",
  "/ban №12 — автора комментария №12 (видно в /comments)",
  "/ban 123456 — по id Telegram",
  "/unban @ivanov — снять",
  "/bans — список",
].join("\n");

const DAY_MS = 86400000;
const shortDate = (isoString) =>
  new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", timeZone: "Europe/Moscow" }).format(
    new Date(isoString)
  );

/**
 * Кого банить: «№12» — автор комментария; иначе @username или id через
 * findPerson из index.js, а если человек только комментировал — из самих
 * комментариев.
 */
async function resolveAuthor(env, token, findPerson) {
  const number = String(token).match(/^[№#](\d+)$/);
  if (number) {
    return env.STATS.prepare("SELECT tg_id, name, username FROM comments WHERE id = ?")
      .bind(Number(number[1]))
      .first();
  }
  const person = await findPerson(env, token);
  if (person?.name || person?.username) return person;
  const username = String(token).replace(/^@/, "");
  const fromComments = /^\d+$/.test(username)
    ? await env.STATS.prepare("SELECT tg_id, name, username FROM comments WHERE tg_id = ? ORDER BY id DESC LIMIT 1")
        .bind(Number(username))
        .first()
    : await env.STATS.prepare(
        "SELECT tg_id, name, username FROM comments WHERE lower(username) = lower(?) ORDER BY id DESC LIMIT 1"
      )
        .bind(username)
        .first();
  return fromComments || person;
}

const authorLabel = (p) =>
  [p.name, p.username ? `@${p.username}` : null, `id ${p.tg_id}`].filter(Boolean).join(" · ");

/** /ban — возвращает { text, keyboard } для ответа владельцу. */
export async function banCommand(env, text, findPerson) {
  const [, who, ...rest] = String(text).trim().split(/\s+/);
  if (!who) return { text: BAN_HELP };

  const person = await resolveAuthor(env, who, findPerson);
  if (!person?.tg_id) {
    return { text: `Не нашёл ${escape(who)}. Проще всего банить по номеру комментария: /ban №12.` };
  }
  if (isOwner(env, person.tg_id)) return { text: "Себя забанить нельзя." };

  let days = null;
  if (rest[0] && /^\d{1,4}$/.test(rest[0])) days = Number(rest.shift());
  if (days === 0) return { text: "Срок — от 1 дня. Без срока — навсегда: /ban @ivanov" };
  const reason = rest.join(" ").slice(0, 200);
  const now = new Date(Date.now());
  const until = days ? new Date(now.getTime() + days * DAY_MS).toISOString() : null;

  await env.STATS.prepare(
    `INSERT INTO comment_bans (tg_id, name, username, reason, created, until) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(tg_id) DO UPDATE SET name = excluded.name, username = excluded.username,
       reason = excluded.reason, created = excluded.created, until = excluded.until`
  )
    .bind(person.tg_id, person.name || null, person.username || null, reason, now.toISOString(), until)
    .run();

  const { n } = await env.STATS.prepare("SELECT COUNT(*) AS n FROM comments WHERE tg_id = ? AND hidden = 0")
    .bind(person.tg_id)
    .first();
  const term = until ? `до ${shortDate(until)}` : "навсегда";
  return {
    text: [
      `⛔ ${escape(authorLabel(person))} — запрет писать комментарии ${term}.`,
      reason ? `Причина: ${escape(reason)}` : null,
      n ? `Комментариев автора на виду: ${n}.` : "Видимых комментариев у автора нет.",
      `Снять: /unban ${person.username ? `@${escape(person.username)}` : person.tg_id}`,
    ]
      .filter(Boolean)
      .join("\n"),
    keyboard: n ? [[{ text: `Удалить все комментарии автора (${n})`, callback_data: `cmpurge:${person.tg_id}` }]] : null,
  };
}

export async function unbanCommand(env, text, findPerson) {
  const who = String(text).trim().split(/\s+/)[1];
  if (!who) return "Укажите кого: /unban @ivanov. Список — /bans";
  const person = await resolveAuthor(env, who, findPerson);
  if (!person?.tg_id) return `Не нашёл ${escape(who)}.`;
  const result = await env.STATS.prepare("DELETE FROM comment_bans WHERE tg_id = ?").bind(person.tg_id).run();
  return result.meta?.changes
    ? `${escape(authorLabel(person))} снова может писать комментарии.`
    : `${escape(authorLabel(person))} не был забанен.`;
}

export async function bansList(env) {
  const { results = [] } = await env.STATS.prepare(
    `SELECT tg_id, name, username, reason, created, until FROM comment_bans
     WHERE until IS NULL OR until > ? ORDER BY created DESC LIMIT 60`
  )
    .bind(new Date(Date.now()).toISOString())
    .all();
  if (!results.length) return `Забаненных нет.\n\n${BAN_HELP}`;
  return [
    `<b>Забанены в комментариях</b> (${results.length})`,
    "",
    ...results.map(
      (b) =>
        `⛔ <a href="tg://user?id=${b.tg_id}">${escape(b.name || `id ${b.tg_id}`)}</a>${b.username ? ` @${escape(b.username)}` : ""} · id ${b.tg_id} · ${b.until ? `до ${shortDate(b.until)}` : "навсегда"}${b.reason ? ` · ${escape(b.reason)}` : ""}`
    ),
  ].join("\n");
}

/** «Удалить все его комментарии» — прячет видимые и поправляет счётчики. */
export async function purgeAuthor(env, tgId) {
  const { results = [] } = await env.STATS.prepare(
    "SELECT id, grp, day, subject FROM comments WHERE tg_id = ? AND hidden = 0"
  )
    .bind(tgId)
    .all();
  if (!results.length) return 0;
  const perLesson = new Map();
  for (const c of results) {
    const key = `${c.grp}|${c.day}|${c.subject}`;
    if (!perLesson.has(key)) perLesson.set(key, { group: c.grp, day: c.day, subject: c.subject, n: 0 });
    perLesson.get(key).n += 1;
  }
  await env.STATS.batch([
    env.STATS.prepare("UPDATE comments SET hidden = 2 WHERE tg_id = ? AND hidden = 0").bind(tgId),
    ...(await Promise.all([...perLesson.values()].map((l) => addCount(env, l, -l.n)))),
  ]);
  return results.length;
}

/**
 * /comments [группа | @username | id] — кто, куда и что писал. Владельцу
 * видно всё, включая удалённое и скрытое: отвечать за ленту ему.
 * Возвращает несколько сообщений: у Telegram предел 4096 знаков.
 */
export async function listCommentsCommand(env, text) {
  const arg = String(text).replace(/^\/comments(@\w+)?/, "").trim().split(/\s+/)[0] || "";

  let where = "1 = 1";
  let bind = [];
  let title = "все группы";
  if (/^@?\w+$/.test(arg) && (arg.startsWith("@") || /[a-z]/i.test(arg)) && !/[а-яё]/i.test(arg)) {
    where = "lower(username) = lower(?)";
    bind = [arg.replace(/^@/, "")];
    title = `@${bind[0]}`;
  } else if (/^\d{5,}$/.test(arg)) {
    where = "tg_id = ?";
    bind = [Number(arg)];
    title = `id ${arg}`;
  } else if (arg) {
    let groups = [];
    try {
      groups = await loadGroups();
    } catch {
      // без списка групп сравним как написано
    }
    const group = groups.find((g) => normalize(g.id) === normalize(arg));
    where = "grp = ?";
    bind = [group ? group.id : arg];
    title = bind[0];
  }

  const [{ results = [] }, total] = await Promise.all([
    env.STATS.prepare(
      `SELECT id, grp, day, subject, tg_id, name, username, text, created, hidden, reports
       FROM comments WHERE ${where} ORDER BY id DESC LIMIT ?`
    )
      .bind(...bind, LIST_LIMIT)
      .all(),
    env.STATS.prepare(`SELECT COUNT(*) AS n, COUNT(DISTINCT tg_id) AS people FROM comments WHERE ${where}`)
      .bind(...bind)
      .first(),
  ]);

  const head = `<b>Комментарии: ${escape(title)}</b> — всего ${total.n}, авторов ${total.people}${
    total.n > LIST_LIMIT ? `, показаны последние ${LIST_LIMIT}` : ""
  }`;
  if (!results.length) return [`${head}\n\nПусто.\n\n${COMMENTS_HELP}`];

  // Кто из авторов сейчас забанен — одной выборкой на весь список.
  const authors = [...new Set(results.map((c) => c.tg_id))];
  const { results: banned = [] } = await env.STATS.prepare(
    `SELECT tg_id FROM comment_bans WHERE tg_id IN (${authors.map(() => "?").join(",")})
     AND (until IS NULL OR until > ?)`
  )
    .bind(...authors, new Date(Date.now()).toISOString())
    .all();
  const bannedIds = new Set(banned.map((b) => b.tg_id));

  const blocks = results.map((c) => {
    // Ссылка на профиль работает и без @username.
    const mark = bannedIds.has(c.tg_id) ? " ⛔" : "";
    const who = `<a href="tg://user?id=${c.tg_id}">${escape(c.name)}</a>${c.username ? ` @${escape(c.username)}` : ""} · id ${c.tg_id}${mark}`;
    const lesson = `${escape(c.grp)} · ${escape(c.subject)} · пара ${c.day.slice(8, 10)}.${c.day.slice(5, 7)}`;
    const reports = c.reports && c.hidden !== 1 ? ` · жалоб ${c.reports}` : "";
    const body = c.text.length > 300 ? `${c.text.slice(0, 300)}…` : c.text;
    return [
      `№${c.id} · ${TIME.format(new Date(c.created))}${STATUS[c.hidden] || ""}${reports}`,
      who,
      lesson,
      escape(body),
    ].join("\n");
  });

  const messages = [];
  let current = head;
  for (const block of blocks) {
    if (current.length + block.length + 2 > 3900) {
      messages.push(current);
      current = block;
    } else {
      current += `\n\n${block}`;
    }
  }
  messages.push(current);
  return messages;
}

/** /delcomment 12 — владелец удаляет комментарий по номеру. */
export async function deleteCommentCommand(env, text) {
  const id = Number(String(text).split(/\s+/)[1]);
  if (!id) return "Укажите номер: /delcomment 12. Номер приходит в уведомлении о жалобах.";
  const result = await moderateComment(env, "cmd", id);
  return result === "Удалил" ? `Комментарий №${id} удалён.` : `№${id}: ${result.toLowerCase()}.`;
}
