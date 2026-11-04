/**
 * «Подслушка» — общий форум студентов всех вузов.
 *
 * Пост можно написать анонимно или под своим именем из Telegram. Анонимность
 * только внешняя: автора мы всегда знаем (tg_id в базе), без этого нельзя ни
 * банить, ни отвечать на жалобы. Наружу tg_id не уходит; владелец видит
 * настоящего автора любого поста.
 *
 * Модерация жёсткая и в несколько слоёв:
 *  1. Фильтр до публикации: ссылки, @-упоминания, телефоны, почта, мат и
 *     оскорбления, повторы и флуд — не публикуются вовсе.
 *  2. Проверка владельцем до публикации: первый пост нового человека,
 *     угрозы, продажа запрещённого, «слив» личных данных, признаки беды —
 *     пост ждёт, владельцу приходит сообщение с кнопками.
 *  3. Жалобы: три — и пост скрыт сам; владелец получает сообщение.
 *  4. Баны (общие с комментариями: /ban, /unban, /bans), лимиты в сутки и
 *     «медленный режим», аварийный выключатель /forum off.
 *
 * Владелец узнаёт обо всём: о постах на проверке, о жалобах, о скрытом, о
 * всплесках флуда и об ошибках форума.
 */

import { activeBan } from "./comments.js";

export const POST_MAX = 600;
export const REPLY_MAX = 300;
const PAGE = 20;
const REPLIES_PAGE = 100;
const REPORTS_TO_HIDE = 3;
const POSTS_PER_DAY = 3;
const REPLIES_PER_DAY = 40;
const POST_GAP_SEC = 90;
const REPLY_GAP_SEC = 8;
// Больше стольких постов в час на весь форум — это всплеск: всё новое
// уходит на проверку, владелец получает предупреждение.
const FLOOD_POSTS_PER_HOUR = 25;
const TAG_MAX = 40;

const isOwner = (env, id) => String(id) === String(env.OWNER_ID);
const nowIso = () => new Date(Date.now()).toISOString();
const dayStartUtc = () => {
  // Сутки по Москве.
  const msk = new Date(Date.now() + 3 * 3600 * 1000);
  msk.setUTCHours(0, 0, 0, 0);
  return new Date(msk.getTime() - 3 * 3600 * 1000).toISOString();
};
const escape = (text) => String(text).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c]);
const fail = (error, status = 400, extra = {}) => ({ status, json: { ok: false, error, ...extra } });

/* ---------- Настройки ---------- */

async function setting(env, key, fallback) {
  const row = await env.STATS.prepare("SELECT value FROM forum_settings WHERE key = ?").bind(key).first();
  return row ? row.value : fallback;
}

async function putSetting(env, key, value) {
  await env.STATS.prepare(
    "INSERT INTO forum_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  )
    .bind(key, String(value))
    .run();
}

/* ---------- Фильтр текста ---------- */

// Похожие латинские буквы → русские: «xуй», «пиzда» не обходят фильтр.
const LOOKALIKE = { a: "а", b: "в", c: "с", e: "е", h: "н", k: "к", m: "м", o: "о", p: "р", t: "т", x: "х", y: "у", z: "з", "0": "о", "3": "з", "4": "ч", "6": "б" };

function normalize(text) {
  return String(text)
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[a-z0-9]/g, (c) => LOOKALIKE[c] || c);
}

// Мат и оскорбления — не публикуем. Проверяем слова по отдельности (и буквы,
// разнесённые пробелами и знаками: «х у й», «х.у.й»), а не весь текст
// слитно: иначе «не батарейка» читалось бы как «небатарейка» → «ебат».
const ROOTS = [
  /х[уюy]й/, /х[уюy]е[вблтмнк]/, /х[уюy][яю]/, /пизд/, /пезд/, /[еи]б[аоуы]н/, /ебат/, /ебал/, /ебла/, /ебну/, /заеб/, /доеб/, /наеб/, /приеб/, /уеб/,
  /бля[дт]/, /мудак/, /мудил/, /залуп/, /пидор/, /пидар/, /пидр/, /шлюх/, /манд[ао]в/, /гандон/, /долбоеб/, /дебил/,
];
const SWEARS = [
  /^сук[аиуоеы]?$/, /^сучк/, /^сучар/, /^хер(а|у|ом|ня)?$/, /^[нп]?ахер$/, /^похер/, /^жоп/, /^срат/, /^срак/, /^говн/, /^гавн/, /^дерьм/,
  /^твар(ь|и|ей)$/, /^мраз/, /^урод(ы|ина|ов)?$/, /^идиот(ы|ка|ов)?$/, /^кретин/, /^придурок$/, /^придурк/, /^гнид/, /^ублюд/, /^падла$/, /^чмо$/, /^лох(и|ов|а)?$/, /^шалав/, /^сволоч/,
];
// Оскорбления по национальности и тому подобное.
const SLURS = [
  /^черножоп/, /^хач(и|ей|ам)?$/, /^чурк/, /^жид(ы|ов|ам)?$/, /^жидо/, /^даун(ы|ов)?$/, /^нигер/, /^кацап/, /^хохол/, /^хохл/,
];

const B = "(?:^|[^а-я])";
const E = "(?:$|[^а-я])";
const HOLD_RULES = [
  [new RegExp(`(убью|убить|прирежу|зарежу|сожгу|взорву|прибью|изобью|расстрел|теракт|бомбу|минирова|взрывчат)`), "угроза или насилие"],
  [new RegExp(`(закладк|мефедрон|героин|кокаин|амфетамин|гашиш|марихуан|спайс|${B}(меф|соль|лсд|шишки)${E}|куплю\\s+(траву|шишки)|продам\\s+(траву|шишки)|${B}трав[ауы]\\s+(куп|прод))`), "наркотики"],
  [new RegExp(`(суицид|самоубий|не\\s+хочу\\s+жить|хочу\\s+умереть|покончить\\s+с\\s+собой|вскрыть\\s+вены|повеситься|надоело\\s+жить|лучше\\s+бы\\s+я\\s+умер|хочу\\s+исчезнуть)`), "признаки беды — человеку, возможно, нужна помощь"],
  [new RegExp(`(паспорт|снилс|номер\\s+карты|адрес\\s+проживания|живёт\\s+по\\s+адресу|живет\\s+по\\s+адресу|домашний\\s+адрес|вот\\s+его\\s+номер|вот\\s+ее\\s+номер|${B}слив(ы|аю|ай|ать|ал[аи]?)?${E}|скинь\\s+фото|голые|голая|обнаж|интим|18\\+|порн)`), "личные данные или интим"],
  [new RegExp(`(взятк|сдам\\s+за\\s+деньги|за\\s+деньги\\s+сдам|купить\\s+диплом|диплом\\s+на\\s+заказ|курсов(ую|ые)\\s+на\\s+заказ|реферат\\s+на\\s+заказ|пишу\\s+работы|помогу\\s+с\\s+сессией|сдам\\s+сессию\\s+за)`), "реклама или платные услуги"],
  [new RegExp(`(путин|навальн|мобилизац|митинг|госдум|террорист|экстремист|нацист|фашист|мигрант)`), "политика"],
  [new RegExp(`(ищу\\s+работу|подработк|${B}вакансия${E}|набираем|казино|букмекер|быстры[ейх]+\\s+деньги|инвестици|крипт[оау]|${B}займ${E})`), "реклама или заработок"],
];

const LINKS = /(https?:\/\/|www\.|t\.me|tg:\/\/|telegram\.me|vk\.com|\.(ru|com|org|net|рф|io|me|su|xyz|info|ly)(\/|\s|$))/i;
const MENTION = /(^|[\s(])@[a-z0-9_]{3,}/i;
const EMAIL = /[a-z0-9._%+-]+\s*@\s*[a-z0-9.-]+\s*\.\s*[a-z]{2,}/i;
// Телефон: подряд цифры с пробелами и знаками, всего 10 и больше.
const hasPhone = (text) =>
  (String(text).match(/\+?\d[\d\s().-]{8,}\d/g) || []).some((run) => run.replace(/\D/g, "").length >= 10);

/** Слова текста и «склеенные» из разнесённых коротких кусочков: «х у й» → «хуй». */
function candidates(norm) {
  const tokens = norm.split(/[^а-я]+/).filter(Boolean);
  const out = [...tokens];
  let run = "";
  for (const t of tokens) {
    if (t.length <= 2) run += t;
    else {
      if (run.length >= 3) out.push(run);
      run = "";
    }
  }
  if (run.length >= 3) out.push(run);
  // Растянутые буквы («хууууй») сводим к одной.
  return out.map((w) => w.replace(/(.)\1+/g, "$1"));
}

const isProfane = (norm) =>
  candidates(norm).some((w) => ROOTS.some((re) => re.test(w)) || SWEARS.some((re) => re.test(w)) || SLURS.some((re) => re.test(w)));

function similarity(a, b) {
  const clean = (text) => normalize(text).replace(/[^а-яa-z0-9]/g, "");
  const pairs = (text) => {
    const map = new Map();
    for (let i = 0; i < text.length - 1; i++) {
      const pair = text.slice(i, i + 2);
      map.set(pair, (map.get(pair) || 0) + 1);
    }
    return map;
  };
  const x = clean(a);
  const y = clean(b);
  if (!x && !y) return 1;
  if (x.length < 2 || y.length < 2) return x === y ? 1 : 0;
  const px = pairs(x);
  const py = pairs(y);
  let common = 0;
  for (const [pair, n] of px) common += Math.min(n, py.get(pair) || 0);
  return (2 * common) / (x.length - 1 + y.length - 1);
}

/**
 * Что делать с текстом: { block: «почему нельзя» } — не публикуем;
 * { hold: «причина» } — на проверку владельцу; {} — можно.
 */
export function screenText(text, { allowEmpty = false } = {}) {
  const raw = String(text || "").trim();
  if (!raw && !allowEmpty) return { block: "Пустое сообщение." };
  if (EMAIL.test(raw) || MENTION.test(raw)) return { block: "@-упоминания и почту нельзя: чужие контакты не публикуем." };
  if (LINKS.test(raw)) return { block: "Ссылки нельзя." };
  if (hasPhone(raw)) return { block: "Телефоны нельзя." };
  const letters = raw.replace(/[^а-яА-Яa-zA-Z]/g, "");
  if (letters.length >= 12 && letters.replace(/[^А-ЯA-Z]/g, "").length / letters.length > 0.7) {
    return { block: "Не кричите заглавными." };
  }
  if (/(.)\1{7,}/.test(raw)) return { block: "Слишком много одинаковых знаков." };
  const norm = normalize(raw);
  if (isProfane(norm)) return { block: "Без мата и оскорблений." };
  const padded = ` ${norm} `;
  for (const [re, why] of HOLD_RULES) {
    if (re.test(padded)) return { hold: why };
  }
  return {};
}

/* ---------- Имена ---------- */

const ALIASES = ["Лиса", "Енот", "Барсук", "Сова", "Выдра", "Бобр", "Ёж", "Заяц", "Кот", "Пингвин", "Панда", "Тигр", "Олень", "Орёл", "Попугай", "Лама", "Утка", "Медведь", "Хомяк", "Тюлень", "Слон", "Жираф", "Белка", "Волк"];
const EMOJI = ["🦊", "🦝", "🦡", "🦉", "🦦", "🦫", "🦔", "🐇", "🐈", "🐧", "🐼", "🐯", "🦌", "🦅", "🦜", "🦙", "🦆", "🐻", "🐹", "🦭", "🐘", "🦒", "🐿️", "🐺"];

function hash(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Анонимный псевдоним: одному человеку в одной теме — одно и то же имя. */
function alias(env, post, tgId) {
  const h = hash(`${env.STATS_SALT || "salt"}:${post}:${tgId}`);
  const i = h % ALIASES.length;
  return { name: `Аноним ${ALIASES[i]}`, emoji: EMOJI[i], hue: (h >>> 5) % 360 };
}

/** Цвет аватара человека под именем: один и тот же везде, id не раскрывает. */
function personHue(env, tgId) {
  return hash(`${env.STATS_SALT || "salt"}:hue:${tgId}`) % 360;
}

function displayName(user) {
  const name = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
  return (name || (user.username ? `@${user.username}` : "Студент")).slice(0, 48);
}

/* ---------- Сообщения владельцу ---------- */

const AUTHOR_LINK = (row) =>
  `<a href="tg://user?id=${row.tg_id}">${escape(row.name)}</a>${row.username ? ` @${escape(row.username)}` : ""} · id ${row.tg_id}`;

function snippet(text, n = 500) {
  const t = String(text || "");
  return escape(t.length > n ? `${t.slice(0, n)}…` : t);
}

function buttons(kind, id, { review = false } = {}) {
  const k = kind === "p" ? "p" : "r";
  return [
    review
      ? [
          { text: "✅ Опубликовать", callback_data: `fok:${k}:${id}` },
          { text: "🗑 Удалить", callback_data: `fdl:${k}:${id}` },
        ]
      : [
          { text: "↩️ Вернуть", callback_data: `fok:${k}:${id}` },
          { text: "🗑 Удалить", callback_data: `fdl:${k}:${id}` },
        ],
    [
      { text: "⛔ Удалить + бан 7 дней", callback_data: `fbn:${k}:${id}` },
      { text: "🧹 Всё автора", callback_data: `fpg:${k}:${id}` },
    ],
  ];
}

const throttle = new Map();
/** Не чаще раза в `ms` на ключ: чтобы всплеск не завалил владельца сообщениями. */
function quiet(key, ms) {
  const last = throttle.get(key) || 0;
  if (Date.now() - last < ms) return true;
  throttle.set(key, Date.now());
  return false;
}

/* ---------- Выборки ---------- */

async function authorOf(env, kind, id) {
  const table = kind === "p" ? "forum_posts" : "forum_replies";
  return env.STATS.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(id).first();
}

const REPORT_REASONS = {
  spam: "спам или реклама",
  abuse: "оскорбления или травля",
  private: "личные данные",
  danger: "угрозы или опасное",
  other: "другое",
};

function whoOf(env, row, postId) {
  return row.anon
    ? alias(env, postId, row.tg_id)
    : { name: row.name, emoji: "", hue: personHue(env, row.tg_id) };
}

function viewPost(env, row, user, owner, liked) {
  const mine = row.tg_id === user.id;
  const who = whoOf(env, row, row.id);
  return {
    id: row.id,
    name: who.name,
    emoji: who.emoji,
    hue: who.hue,
    anon: Boolean(row.anon),
    tag: row.tag || "",
    text: row.text,
    created: row.created,
    likes: row.likes,
    replies: row.replies,
    liked: Boolean(liked),
    mine,
    pending: row.hidden === 3,
    canDelete: mine || owner,
    // Настоящий автор — только владельцу.
    author: owner ? { name: row.name, username: row.username || null, id: row.tg_id } : undefined,
    hidden: owner ? row.hidden : undefined,
    reports: owner ? row.reports : undefined,
    held: owner && row.held_for ? row.held_for : undefined,
  };
}

function viewReply(env, row, user, owner, postRow, byId, liked) {
  const mine = row.tg_id === user.id;
  const who = whoOf(env, row, row.post);
  let parent = null;
  if (row.parent) {
    const p = byId.get(row.parent);
    parent = p && p.hidden === 0
      ? { id: p.id, name: whoOf(env, p, row.post).name, text: p.text.length > 90 ? `${p.text.slice(0, 90)}…` : p.text }
      : { id: row.parent, gone: true };
  }
  return {
    id: row.id,
    name: who.name,
    emoji: who.emoji,
    hue: who.hue,
    anon: Boolean(row.anon),
    op: row.tg_id === postRow.tg_id,
    text: row.text,
    created: row.created,
    likes: row.likes || 0,
    liked: Boolean(liked),
    parent,
    mine,
    pending: row.hidden === 3,
    canDelete: mine || owner,
    author: owner ? { name: row.name, username: row.username || null, id: row.tg_id } : undefined,
    hidden: owner ? row.hidden : undefined,
    held: owner && row.held_for ? row.held_for : undefined,
  };
}

/* ---------- API ---------- */

export async function forumApi(env, action, body, user, notify, tell) {
  if (!user?.id) return fail("unauthorized", 401);
  const owner = isOwner(env, user.id);
  if (!owner && (await setting(env, "forum_on", "1")) !== "1") return fail("off", 503);

  // Забаненный (общий бан /ban) читает, но не пишет, не жалуется и не лайкает.
  const ban = owner ? null : await activeBan(env, user.id);
  const writing = ["post", "reply", "like", "report"].includes(action);
  if (ban && writing) return fail("banned", 403, { banned: ban });

  if (action === "list") return list(env, body, user, owner, ban);
  if (action === "poll") return poll(env, body, user, owner);
  if (action === "replies") return replies(env, body, user, owner, ban);
  if (action === "post") return createPost(env, body, user, owner, notify);
  if (action === "reply") return createReply(env, body, user, owner, notify, tell);
  if (action === "like") return like(env, body, user);
  if (action === "delete") return remove(env, body, user, owner);
  if (action === "report") return report(env, body, user, owner, notify);
  if (action === "mod") return mod(env, body, owner);
  if (action === "prefs") return prefs(env, body, user);
  return fail("bad request");
}

async function list(env, body, user, owner, ban) {
  const before = Number(body.before) || 0;
  const sort = owner && body.sort === "review" ? "review" : body.sort === "top" ? "top" : "new";
  const since = new Date(Date.now() - 3 * 86400000).toISOString();
  let rows;
  if (sort === "review") {
    ({ results: rows = [] } = await env.STATS.prepare(
      "SELECT * FROM forum_posts WHERE hidden IN (1, 3) ORDER BY id DESC LIMIT ?"
    )
      .bind(PAGE)
      .all());
  } else if (sort === "top") {
    ({ results: rows = [] } = await env.STATS.prepare(
      "SELECT * FROM forum_posts WHERE hidden = 0 AND created > ? ORDER BY likes * 3 + replies DESC, id DESC LIMIT ?"
    )
      .bind(since, PAGE)
      .all());
  } else {
    ({ results: rows = [] } = await env.STATS.prepare(
      `SELECT * FROM forum_posts WHERE hidden = 0 ${before ? "AND id < ?" : ""} ORDER BY id DESC LIMIT ?`
    )
      .bind(...(before ? [before] : []), PAGE)
      .all());
  }

  // Свои посты, ждущие проверки, — сверху первой страницы: человек видит, что пост принят.
  let mine = [];
  if (!before && sort === "new") {
    ({ results: mine = [] } = await env.STATS.prepare(
      "SELECT * FROM forum_posts WHERE tg_id = ? AND hidden = 3 ORDER BY id DESC LIMIT 5"
    )
      .bind(user.id)
      .all());
  }
  const all = [...mine, ...rows];
  const ids = all.map((p) => p.id);
  const liked = new Set();
  if (ids.length) {
    const { results: likes = [] } = await env.STATS.prepare(
      `SELECT post FROM forum_likes WHERE tg_id = ? AND post IN (${ids.map(() => "?").join(",")})`
    )
      .bind(user.id, ...ids)
      .all();
    for (const l of likes) liked.add(l.post);
  }
  const top = await env.STATS.prepare("SELECT MAX(id) AS id FROM forum_posts WHERE hidden = 0").first();
  let review;
  if (owner) {
    const row = await env.STATS.prepare(
      "SELECT (SELECT COUNT(*) FROM forum_posts WHERE hidden IN (1, 3)) + (SELECT COUNT(*) FROM forum_replies WHERE hidden IN (1, 3)) AS n"
    ).first();
    review = row?.n || 0;
  }
  return {
    status: 200,
    json: {
      ok: true,
      owner,
      banned: ban,
      top: top?.id || 0,
      review,
      more: sort === "new" && rows.length === PAGE,
      posts: all.map((p) => viewPost(env, p, user, owner, liked.has(p.id))),
    },
  };
}

/** Сколько новых постов появилось после `after` — для плашки «↑ 3 новых». */
async function poll(env, body, user, owner) {
  const after = Number(body.after) || 0;
  const row = await env.STATS.prepare(
    "SELECT COUNT(*) AS n, MAX(id) AS top FROM forum_posts WHERE hidden = 0 AND id > ? AND tg_id != ?"
  )
    .bind(after, user.id)
    .first();
  let review;
  if (owner) {
    const r = await env.STATS.prepare(
      "SELECT (SELECT COUNT(*) FROM forum_posts WHERE hidden IN (1, 3)) + (SELECT COUNT(*) FROM forum_replies WHERE hidden IN (1, 3)) AS n"
    ).first();
    review = r?.n || 0;
  }
  return { status: 200, json: { ok: true, count: row?.n || 0, review } };
}

async function replies(env, body, user, owner, ban) {
  const id = Number(body.post);
  if (!Number.isInteger(id) || id < 1) return fail("bad request");
  const post = await env.STATS.prepare("SELECT * FROM forum_posts WHERE id = ?").bind(id).first();
  if (!post || (post.hidden !== 0 && !(post.hidden === 3 && post.tg_id === user.id) && !owner)) return fail("not found", 404);
  const { results = [] } = await env.STATS.prepare(
    `SELECT * FROM forum_replies WHERE post = ? AND (hidden = 0 OR (hidden = 3 AND tg_id = ?)${owner ? " OR hidden IN (1, 3)" : ""}) ORDER BY id LIMIT ?`
  )
    .bind(id, user.id, REPLIES_PAGE)
    .all();
  const liked = await env.STATS.prepare("SELECT 1 AS ok FROM forum_likes WHERE post = ? AND tg_id = ?").bind(id, user.id).first();
  const likedReplies = new Set();
  if (results.length) {
    const { results: rl = [] } = await env.STATS.prepare(
      `SELECT reply FROM forum_reply_likes WHERE tg_id = ? AND reply IN (${results.map(() => "?").join(",")})`
    )
      .bind(user.id, ...results.map((r) => r.id))
      .all();
    for (const l of rl) likedReplies.add(l.reply);
  }
  const byId = new Map(results.map((r) => [r.id, r]));
  const prefsRow = await env.STATS.prepare("SELECT notify FROM forum_prefs WHERE tg_id = ?").bind(user.id).first();
  return {
    status: 200,
    json: {
      ok: true,
      banned: ban,
      notify: prefsRow ? Boolean(prefsRow.notify) : true,
      post: viewPost(env, post, user, owner, liked),
      replies: results.map((r) => viewReply(env, r, user, owner, post, byId, likedReplies.has(r.id))),
    },
  };
}

/** Общая проверка перед записью поста/ответа. Возвращает { fail } или { hold, flood }. */
async function gate(env, user, owner, kind, text, notify) {
  const screen = screenText(text);
  if (owner) return { hold: "" };
  if (screen.block) return { fail: fail("blocked", 422, { reason: screen.block }) };

  const table = kind === "p" ? "forum_posts" : "forum_replies";
  const since = dayStartUtc();
  const [{ n: today }, last, recent] = await Promise.all([
    env.STATS.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE tg_id = ? AND created >= ?`).bind(user.id, since).first(),
    env.STATS.prepare(`SELECT created FROM ${table} WHERE tg_id = ? ORDER BY id DESC LIMIT 1`).bind(user.id).first(),
    env.STATS.prepare(`SELECT text FROM ${table} WHERE created > ? ORDER BY id DESC LIMIT 40`)
      .bind(new Date(Date.now() - 3600 * 1000).toISOString())
      .all(),
  ]);
  const cap = kind === "p" ? POSTS_PER_DAY : REPLIES_PER_DAY;
  if (today >= cap) return { fail: fail("limit", 429, { reason: kind === "p" ? `Не больше ${POSTS_PER_DAY} постов в сутки.` : `Не больше ${REPLIES_PER_DAY} ответов в сутки.` }) };
  const gap = kind === "p" ? POST_GAP_SEC : REPLY_GAP_SEC;
  if (last && Date.now() - new Date(last.created).getTime() < gap * 1000) {
    return { fail: fail("slow", 429, { reason: `Подождите ${gap} секунд между сообщениями.` }) };
  }
  // Повтор (свой или чужой) за последний час — нет: так не копируют рассылку.
  if ((recent.results || []).some((r) => similarity(r.text, text) >= 0.9)) {
    return { fail: fail("duplicate", 422, { reason: "Такое уже писали." }) };
  }

  let hold = screen.hold || "";
  // Новичок: первый пост ждёт одобрения владельца.
  if (!hold && kind === "p" && (await setting(env, "forum_newbie_hold", "1")) === "1") {
    const trusted = await env.STATS.prepare("SELECT 1 AS ok FROM forum_trusted WHERE tg_id = ?").bind(user.id).first();
    if (!trusted) hold = "первый пост нового автора";
  }
  // Всплеск: пока не уляжется, всё новое — на проверку.
  const { n: hour } = await env.STATS.prepare("SELECT COUNT(*) AS n FROM forum_posts WHERE created > ?")
    .bind(new Date(Date.now() - 3600 * 1000).toISOString())
    .first();
  if (hour >= FLOOD_POSTS_PER_HOUR) {
    if (!hold) hold = "всплеск публикаций";
    if (!quiet("forum-flood", 30 * 60 * 1000)) {
      await notify(`🚨 Подслушка: ${hour} постов за час — всплеск (флуд или атака). Всё новое временно уходит на проверку. Выключить форум: /forum off`, null).catch(() => {});
    }
  }
  return { hold };
}

async function createPost(env, body, user, owner, notify) {
  const text = String(body.text || "").trim();
  if (text.length > POST_MAX) return fail("too long");
  const tag = String(body.tag || "").trim().slice(0, TAG_MAX);
  const verdict = await gate(env, user, owner, "p", text, notify);
  if (verdict.fail) return verdict.fail;
  if (tag && screenText(tag, { allowEmpty: true }).block) return fail("blocked", 422, { reason: "Подпись вуза не подходит." });
  const anon = body.anon === false ? 0 : 1;
  const hidden = verdict.hold ? 3 : 0;
  const result = await env.STATS.prepare(
    `INSERT INTO forum_posts (tg_id, name, username, anon, text, created, hidden, held_for, tag)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
  )
    .bind(user.id, displayName(user), user.username || null, anon, text, nowIso(), hidden, verdict.hold || "", tag)
    .first();
  if (hidden) {
    await notify(
      [
        `📝 <b>Подслушка: пост №${result.id} ждёт проверки</b> — ${escape(verdict.hold)}`,
        `Автор: ${AUTHOR_LINK({ tg_id: user.id, name: displayName(user), username: user.username })}`,
        `Показан как: ${anon ? "аноним" : "под именем"}`,
        "",
        snippet(text),
      ].join("\n"),
      buttons("p", result.id, { review: true })
    ).catch(() => {});
  }
  const row = await env.STATS.prepare("SELECT * FROM forum_posts WHERE id = ?").bind(result.id).first();
  return {
    status: 200,
    json: { ok: true, pending: Boolean(hidden), reason: hidden ? verdict.hold : "", post: viewPost(env, row, user, owner, false) },
  };
}

async function createReply(env, body, user, owner, notify, tell) {
  const postId = Number(body.post);
  if (!Number.isInteger(postId) || postId < 1) return fail("bad request");
  const post = await env.STATS.prepare("SELECT * FROM forum_posts WHERE id = ? AND hidden = 0").bind(postId).first();
  if (!post) return fail("not found", 404);
  const text = String(body.text || "").trim();
  if (text.length > REPLY_MAX) return fail("too long");
  // Ответ на чей-то ответ: родитель должен быть виден и из этой же темы.
  let parent = null;
  const to = Number(body.to) || 0;
  if (to) {
    parent = await env.STATS.prepare("SELECT * FROM forum_replies WHERE id = ? AND post = ? AND hidden = 0").bind(to, postId).first();
    if (!parent) return fail("parent gone", 404);
  }
  const verdict = await gate(env, user, owner, "r", text, notify);
  if (verdict.fail) return verdict.fail;
  const anon = body.anon === false ? 0 : 1;
  // Ответы новичков не ждут проверки (иначе тема мертва) — только стоп-слова и всплеск.
  const hidden = verdict.hold ? 3 : 0;
  const result = await env.STATS.prepare(
    `INSERT INTO forum_replies (post, tg_id, name, username, anon, text, created, hidden, held_for, parent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
  )
    .bind(postId, user.id, displayName(user), user.username || null, anon, text, nowIso(), hidden, verdict.hold || "", parent ? parent.id : 0)
    .first();
  const row = await env.STATS.prepare("SELECT * FROM forum_replies WHERE id = ?").bind(result.id).first();
  if (!hidden) {
    await env.STATS.prepare("UPDATE forum_posts SET replies = replies + 1 WHERE id = ?").bind(postId).run();
    // Автору поста и автору ответа, на который отвечают, — тихое уведомление в боте.
    if (tell) {
      const mine = whoOf(env, row, postId);
      const targets = new Map();
      if (post.tg_id !== user.id) targets.set(post.tg_id, { what: "пост", quote: post.text });
      if (parent && parent.tg_id !== user.id) targets.set(parent.tg_id, { what: "ответ", quote: parent.text });
      for (const [tgId, info] of targets) {
        if (quiet(`fr:${tgId}:${postId}`, 20 * 60 * 1000)) continue;
        const pref = await env.STATS.prepare("SELECT notify FROM forum_prefs WHERE tg_id = ?").bind(tgId).first();
        if (pref && !pref.notify) continue;
        const q = info.quote.length > 70 ? `${info.quote.slice(0, 70)}…` : info.quote;
        tell(
          tgId,
          [`💬 Ответили на ваш ${info.what} в Подслушке`, `«${escape(q)}»`, "", `<b>${escape(mine.name)}:</b> ${escape(text.length > 160 ? `${text.slice(0, 160)}…` : text)}`].join("\n"),
          postId
        ).catch(() => {});
      }
    }
  } else {
    await notify(
      [
        `💬 <b>Подслушка: ответ №${result.id} (к посту №${postId}) ждёт проверки</b> — ${escape(verdict.hold)}`,
        `Автор: ${AUTHOR_LINK({ tg_id: user.id, name: displayName(user), username: user.username })}`,
        "",
        snippet(text),
      ].join("\n"),
      buttons("r", result.id, { review: true })
    ).catch(() => {});
  }
  const byId = new Map(parent ? [[parent.id, parent]] : []);
  return {
    status: 200,
    json: { ok: true, pending: Boolean(hidden), reason: hidden ? verdict.hold : "", reply: viewReply(env, row, user, owner, post, byId, false) },
  };
}

async function like(env, body, user) {
  const kind = body.kind === "r" ? "r" : "p";
  const id = Number(kind === "r" ? body.id : body.post || body.id);
  if (!Number.isInteger(id) || id < 1) return fail("bad request");
  const table = kind === "r" ? "forum_replies" : "forum_posts";
  const likes = kind === "r" ? "forum_reply_likes" : "forum_likes";
  const col = kind === "r" ? "reply" : "post";
  const item = await env.STATS.prepare(`SELECT id FROM ${table} WHERE id = ? AND hidden = 0`).bind(id).first();
  if (!item) return fail("not found", 404);
  const had = await env.STATS.prepare(`SELECT 1 AS ok FROM ${likes} WHERE ${col} = ? AND tg_id = ?`).bind(id, user.id).first();
  if (had) {
    await env.STATS.batch([
      env.STATS.prepare(`DELETE FROM ${likes} WHERE ${col} = ? AND tg_id = ?`).bind(id, user.id),
      env.STATS.prepare(`UPDATE ${table} SET likes = MAX(likes - 1, 0) WHERE id = ?`).bind(id),
    ]);
  } else {
    await env.STATS.batch([
      env.STATS.prepare(`INSERT OR IGNORE INTO ${likes} (${col}, tg_id) VALUES (?, ?)`).bind(id, user.id),
      env.STATS.prepare(`UPDATE ${table} SET likes = likes + 1 WHERE id = ?`).bind(id),
    ]);
  }
  const row = await env.STATS.prepare(`SELECT likes FROM ${table} WHERE id = ?`).bind(id).first();
  return { status: 200, json: { ok: true, liked: !had, likes: row?.likes || 0 } };
}

async function remove(env, body, user, owner) {
  const kind = body.kind === "r" ? "r" : "p";
  const id = Number(body.id);
  if (!Number.isInteger(id) || id < 1) return fail("bad request");
  const row = await authorOf(env, kind, id);
  if (!row || row.hidden === 2) return fail("not found", 404);
  if (row.tg_id !== user.id && !owner) return fail("forbidden", 403);
  await applyAction(env, "del", kind, row);
  return { status: 200, json: { ok: true } };
}

async function report(env, body, user, owner, notify) {
  const kind = body.kind === "r" ? "r" : "p";
  const id = Number(body.id);
  if (!Number.isInteger(id) || id < 1) return fail("bad request");
  const reason = Object.hasOwn(REPORT_REASONS, body.reason) ? body.reason : "other";
  const row = await authorOf(env, kind, id);
  if (!row || row.hidden !== 0) return fail("not found", 404);
  if (row.tg_id === user.id) return fail("own");
  const added = await env.STATS.prepare("INSERT OR IGNORE INTO forum_reports (kind, item, tg_id, reason) VALUES (?, ?, ?, ?)")
    .bind(kind, id, user.id, reason)
    .run();
  if (!added.meta?.changes) return { status: 200, json: { ok: true, already: true } };
  const reports = row.reports + 1;
  const hide = reports >= REPORTS_TO_HIDE;
  const table = kind === "p" ? "forum_posts" : "forum_replies";
  await env.STATS.prepare(`UPDATE ${table} SET reports = ?, hidden = ? WHERE id = ?`).bind(reports, hide ? 1 : 0, id).run();
  if (hide && kind === "r") await env.STATS.prepare("UPDATE forum_posts SET replies = MAX(replies - 1, 0) WHERE id = ?").bind(row.post).run();
  const label = kind === "p" ? "пост" : "ответ";
  // Какие причины назвали — владельцу, чтобы решить быстрее.
  const { results: why = [] } = await env.STATS.prepare(
    "SELECT reason, COUNT(*) AS n FROM forum_reports WHERE kind = ? AND item = ? GROUP BY reason ORDER BY n DESC"
  )
    .bind(kind, id)
    .all();
  const reasons = why.map((w) => `${REPORT_REASONS[w.reason] || w.reason}${w.n > 1 ? ` ×${w.n}` : ""}`).join(", ");
  // Каждая жалоба — владельцу: первая тихо (без звука), скрытие — со звуком.
  await notify(
    [
      hide ? `⚠️ <b>Подслушка: ${label} №${id} скрыт после ${reports} жалоб</b>` : `🚩 Подслушка: жалоба на ${label} №${id} (${reports} из ${REPORTS_TO_HIDE})`,
      `Причина: ${escape(reasons)}`,
      `Автор: ${AUTHOR_LINK(row)} · показан как ${row.anon ? "аноним" : "под именем"}`,
      "",
      snippet(row.text),
    ].join("\n"),
    buttons(kind, id)
  ).catch(() => {});
  return { status: 200, json: { ok: true } };
}

/** Решения владельца прямо в приложении: те же, что кнопки под уведомлениями. */
async function mod(env, body, owner) {
  if (!owner) return fail("forbidden", 403);
  const kind = body.kind === "r" ? "r" : "p";
  const id = Number(body.id);
  const op = { ok: "fok", del: "fdl", ban: "fbn", purge: "fpg" }[body.op];
  if (!Number.isInteger(id) || id < 1 || !op) return fail("bad request");
  const text = await forumModerate(env, op, kind, id);
  return { status: 200, json: { ok: true, text } };
}

/** Личные настройки форума: пока одна — присылать ли ответы в бота. */
async function prefs(env, body, user) {
  if (typeof body.notify === "boolean") {
    await env.STATS.prepare(
      "INSERT INTO forum_prefs (tg_id, notify) VALUES (?, ?) ON CONFLICT(tg_id) DO UPDATE SET notify = excluded.notify"
    )
      .bind(user.id, body.notify ? 1 : 0)
      .run();
  }
  const row = await env.STATS.prepare("SELECT notify FROM forum_prefs WHERE tg_id = ?").bind(user.id).first();
  return { status: 200, json: { ok: true, notify: row ? Boolean(row.notify) : true } };
}

/* ---------- Решения владельца ---------- */

async function applyAction(env, action, kind, row) {
  const table = kind === "p" ? "forum_posts" : "forum_replies";
  const visibleNow = row.hidden === 0;
  if (action === "del") {
    await env.STATS.prepare(`UPDATE ${table} SET hidden = 2 WHERE id = ?`).bind(row.id).run();
    if (kind === "r" && visibleNow) await env.STATS.prepare("UPDATE forum_posts SET replies = MAX(replies - 1, 0) WHERE id = ?").bind(row.post).run();
  } else if (action === "ok") {
    await env.STATS.prepare(`UPDATE ${table} SET hidden = 0, reports = 0 WHERE id = ?`).bind(row.id).run();
    await env.STATS.prepare("DELETE FROM forum_reports WHERE kind = ? AND item = ?").bind(kind, row.id).run();
    if (kind === "r" && !visibleNow) await env.STATS.prepare("UPDATE forum_posts SET replies = replies + 1 WHERE id = ?").bind(row.post).run();
    // Одобренному автору следующие посты проверки не ждут.
    await env.STATS.prepare("INSERT OR IGNORE INTO forum_trusted (tg_id, created) VALUES (?, ?)").bind(row.tg_id, nowIso()).run();
  }
}

/** Бан автора — тот же, что /ban в комментариях: действует и там, и в форуме. */
export async function banForumAuthor(env, row, days, reason) {
  const until = days ? new Date(Date.now() + days * 86400000).toISOString() : null;
  await env.STATS.prepare(
    `INSERT INTO comment_bans (tg_id, name, username, reason, created, until) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(tg_id) DO UPDATE SET name = excluded.name, username = excluded.username,
       reason = excluded.reason, created = excluded.created, until = excluded.until`
  )
    .bind(row.tg_id, row.name || null, row.username || null, reason || "форум", nowIso(), until)
    .run();
}

async function purgeForumAuthor(env, tgId) {
  const posts = await env.STATS.prepare("UPDATE forum_posts SET hidden = 2 WHERE tg_id = ? AND hidden != 2").bind(tgId).run();
  const replies = await env.STATS.prepare("UPDATE forum_replies SET hidden = 2 WHERE tg_id = ? AND hidden != 2").bind(tgId).run();
  // Счётчики ответов под постами пересчитываем разом.
  await env.STATS.prepare(
    "UPDATE forum_posts SET replies = (SELECT COUNT(*) FROM forum_replies r WHERE r.post = forum_posts.id AND r.hidden = 0)"
  ).run();
  return (posts.meta?.changes || 0) + (replies.meta?.changes || 0);
}

/** Кнопки владельца: fok / fdl / fbn / fpg. Возвращает текст ответа на нажатие. */
export async function forumModerate(env, action, kind, id) {
  const row = await authorOf(env, kind === "r" ? "r" : "p", id);
  if (!row) return "Уже нет";
  const k = kind === "r" ? "r" : "p";
  if (action === "fok") {
    if (row.hidden === 0) return "Уже виден";
    if (row.hidden === 2) return "Уже удалён";
    await applyAction(env, "ok", k, row);
    return "Опубликовано";
  }
  if (action === "fdl") {
    if (row.hidden === 2) return "Уже удалён";
    await applyAction(env, "del", k, row);
    return "Удалено";
  }
  if (action === "fbn") {
    if (isOwner(env, row.tg_id)) return "Себя нельзя";
    if (row.hidden !== 2) await applyAction(env, "del", k, row);
    await banForumAuthor(env, row, 7, "форум");
    return "Удалено, автор забанен на 7 дней";
  }
  if (action === "fpg") {
    if (isOwner(env, row.tg_id)) return "Себя нельзя";
    const n = await purgeForumAuthor(env, row.tg_id);
    return `Удалено у автора: ${n}`;
  }
  return "Неизвестно";
}

/* ---------- Команды владельца ---------- */

export const FORUM_HELP = [
  "<b>Подслушка</b> — общий форум вузов.",
  "/forum — сводка и посты на проверке",
  "/forum off · /forum on — аварийный выключатель",
  "/forum newbie on|off — проверять первый пост нового автора",
  "/fwho 12 — кто на самом деле автор поста №12 (ответ: /fwho r5)",
  "/fdel 12 — удалить пост (ответ: /fdel r5)",
  "/fban 12 [дни] [причина] — удалить и забанить автора поста №12",
  "Баны общие с комментариями: /bans, /unban @ник.",
].join("\n");

function parseRef(token) {
  const m = String(token || "").match(/^(r|р)?[№#]?(\d+)$/i);
  return m ? { kind: m[1] ? "r" : "p", id: Number(m[2]) } : null;
}

export async function forumCommand(env, text) {
  const [cmdRaw, ...args] = String(text).trim().split(/\s+/);
  const cmd = cmdRaw.replace(/^\//, "").replace(/@\w+$/, "").toLowerCase();

  if (cmd === "forum") {
    const sub = (args[0] || "").toLowerCase();
    if (sub === "off" || sub === "on") {
      await putSetting(env, "forum_on", sub === "on" ? "1" : "0");
      return { text: sub === "on" ? "✅ Подслушка включена." : "⛔ Подслушка выключена: у всех, кроме вас, форум не открывается. Включить: /forum on" };
    }
    if (sub === "newbie" && (args[1] === "on" || args[1] === "off")) {
      await putSetting(env, "forum_newbie_hold", args[1] === "on" ? "1" : "0");
      return { text: args[1] === "on" ? "✅ Первый пост нового автора проверяете вы." : "⚠️ Первые посты новых авторов публикуются сразу (стоп-слова и жалобы работают по-прежнему)." };
    }
    const since = dayStartUtc();
    const [on, newbie, today, pending, hidden, posts, authors, bans] = await Promise.all([
      setting(env, "forum_on", "1"),
      setting(env, "forum_newbie_hold", "1"),
      env.STATS.prepare("SELECT COUNT(*) AS n FROM forum_posts WHERE created >= ?").bind(since).first(),
      env.STATS.prepare("SELECT (SELECT COUNT(*) FROM forum_posts WHERE hidden = 3) + (SELECT COUNT(*) FROM forum_replies WHERE hidden = 3) AS n").first(),
      env.STATS.prepare("SELECT (SELECT COUNT(*) FROM forum_posts WHERE hidden = 1) + (SELECT COUNT(*) FROM forum_replies WHERE hidden = 1) AS n").first(),
      env.STATS.prepare("SELECT COUNT(*) AS n FROM forum_posts WHERE hidden = 0").first(),
      env.STATS.prepare("SELECT COUNT(DISTINCT tg_id) AS n FROM forum_posts").first(),
      env.STATS.prepare("SELECT COUNT(*) AS n FROM comment_bans WHERE until IS NULL OR until > ?").bind(nowIso()).first(),
    ]);
    const { results: queue = [] } = await env.STATS.prepare(
      `SELECT 'p' AS kind, id, tg_id, name, username, text, held_for FROM forum_posts WHERE hidden = 3
       UNION ALL SELECT 'r', id, tg_id, name, username, text, held_for FROM forum_replies WHERE hidden = 3
       ORDER BY id LIMIT 8`
    ).all();
    return {
      text: [
        `<b>Подслушка</b> — ${on === "1" ? "✅ включена" : "⛔ выключена"}`,
        `Постов на виду: ${posts.n}, авторов: ${authors.n}, сегодня новых: ${today.n}`,
        `На проверке: ${pending.n} · скрыто жалобами: ${hidden.n} · в бане: ${bans.n}`,
        `Первый пост новичка проверяете: ${newbie === "1" ? "да" : "нет"}`,
        "",
        FORUM_HELP,
      ].join("\n"),
      queue: queue.map((q) => ({
        text: [`📝 ${q.kind === "p" ? "Пост" : "Ответ"} №${q.id} ждёт — ${escape(q.held_for)}`, `Автор: ${AUTHOR_LINK(q)}`, "", snippet(q.text)].join("\n"),
        keyboard: buttons(q.kind, q.id, { review: true }),
      })),
    };
  }

  const ref = parseRef(args[0]);
  if (!ref) return { text: `Укажите номер: /${cmd} 12 (ответ — /${cmd} r5).\n\n${FORUM_HELP}` };
  const row = await authorOf(env, ref.kind, ref.id);
  if (!row) return { text: `Нет ${ref.kind === "p" ? "поста" : "ответа"} №${ref.id}.` };

  if (cmd === "fwho") {
    const state = { 0: "виден", 1: "скрыт жалобами", 2: "удалён", 3: "ждёт проверки" }[row.hidden];
    return {
      text: [
        `${ref.kind === "p" ? "Пост" : "Ответ"} №${row.id} · ${state}`,
        `Автор: ${AUTHOR_LINK(row)}`,
        `Показан как: ${row.anon ? "аноним" : "под именем"}`,
        row.reports ? `Жалоб: ${row.reports}` : null,
        "",
        snippet(row.text),
      ].filter((x) => x !== null).join("\n"),
      keyboard: buttons(ref.kind, ref.id, { review: row.hidden === 3 }),
    };
  }
  if (cmd === "fdel") {
    return { text: `${ref.kind === "p" ? "Пост" : "Ответ"} №${ref.id}: ${(await forumModerate(env, "fdl", ref.kind, ref.id)).toLowerCase()}.` };
  }
  if (cmd === "fban") {
    if (isOwner(env, row.tg_id)) return { text: "Себя забанить нельзя." };
    let days = null;
    const rest = args.slice(1);
    if (rest[0] && /^\d{1,4}$/.test(rest[0])) days = Number(rest.shift());
    if (days === 0) return { text: "Срок — от 1 дня. Без срока — навсегда: /fban 12" };
    if (row.hidden !== 2) await applyAction(env, "del", ref.kind, row);
    await banForumAuthor(env, row, days, rest.join(" ").slice(0, 200) || "форум");
    return {
      text: `⛔ ${escape(row.name)}${row.username ? ` @${escape(row.username)}` : ""} · id ${row.tg_id} — ${days ? `бан на ${days} дн.` : "бан навсегда"}, ${ref.kind === "p" ? "пост" : "ответ"} №${ref.id} удалён.\nСнять: /unban ${row.username ? `@${escape(row.username)}` : row.tg_id}`,
    };
  }
  return { text: FORUM_HELP };
}
