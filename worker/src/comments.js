/**
 * Комментарии к парам: «начнём на 10 минут позже», «взять ноутбук».
 *
 * Пишет и читает своя группа — по последнему открытию приложения, плюс
 * староста группы и владелец. Подпись Telegram проверяет index.js; сюда
 * приходит уже проверенный пользователь.
 *
 * Новые комментарии не прилетают сами: окно обновляется при открытии и по
 * кнопке. Живой опрос сервера каждые несколько секунд съел бы дневной лимит
 * обращений за пару часов.
 */

import { addDays, iso, today } from "./inline.js";

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
 * Член группы — по последнему открытию приложения: другого знания о группе
 * человека у нас нет. Староста и владелец — всегда.
 */
export async function canComment(env, user, groupId) {
  if (!user?.id || !groupId) return false;
  if (isOwner(env, user.id)) return true;
  const row = await env.STATS.prepare(
    "SELECT grp FROM people WHERE tg_id = ? ORDER BY last DESC LIMIT 1"
  )
    .bind(user.id)
    .first();
  if (row?.grp === groupId) return true;
  return isStarosta(env, user.id, groupId);
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

const fail = (error, status = 400) => ({ status, json: { ok: false, error } });

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

  if (action === "list" || action === "add") {
    const lesson = lessonParams(body);
    if (!lesson) return fail("bad request");
    if (!(await canComment(env, user, lesson.group))) return fail("forbidden", 403);

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
          `INSERT INTO comments (grp, day, subject, tg_id, name, text, created)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).bind(lesson.group, lesson.day, lesson.subject, user.id, displayName(user), text, new Date(Date.now()).toISOString()),
        await addCount(env, lesson, 1),
      ]);
    }

    return {
      status: 200,
      json: { ok: true, comments: await listFor(env, user, lesson.group, lesson.day, lesson.subject) },
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
      json: { ok: true, comments: await listFor(env, user, lesson.group, lesson.day, lesson.subject) },
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

/** /delcomment 12 — владелец удаляет комментарий по номеру. */
export async function deleteCommentCommand(env, text) {
  const id = Number(String(text).split(/\s+/)[1]);
  if (!id) return "Укажите номер: /delcomment 12. Номер приходит в уведомлении о жалобах.";
  const result = await moderateComment(env, "cmd", id);
  return result === "Удалил" ? `Комментарий №${id} удалён.` : `№${id}: ${result.toLowerCase()}.`;
}
