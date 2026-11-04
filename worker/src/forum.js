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
// Постов в сутки без лимита: от спама защищают пауза между сообщениями,
// проверка повторов, проверка первого поста и защита от всплесков.
const REPLIES_PER_DAY = 200;
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

/* ---------- Роли ---------- */

/** «tester» — открыт тестовый доступ, «moderator» — ещё и проверяет записи. */
async function roleOf(env, id) {
  const row = await env.STATS.prepare("SELECT role FROM forum_roles WHERE tg_id = ?").bind(id).first();
  return row ? row.role : null;
}

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

// Для проверки «на проверку» (не мат): латиница читается как транслит —
// «kokain», «hero1n», «m3fedron» — и разнесённые буквы склеиваются.
const TRANSLIT = { a: "а", b: "б", c: "к", d: "д", e: "е", f: "ф", g: "г", h: "х", i: "и", j: "й", k: "к", l: "л", m: "м", n: "н", o: "о", p: "п", q: "к", r: "р", s: "с", t: "т", u: "у", v: "в", w: "в", x: "кс", y: "й", z: "з", "0": "о", "1": "и", "3": "е", "4": "а", "5": "с", "6": "б", "7": "т", "@": "а", $: "с" };

function variants(raw) {
  const low = String(raw).toLowerCase().replace(/ё/g, "е");
  const translit = low.replace(/[a-z0-9@$]/g, (c) => TRANSLIT[c] || c);
  const glue = (text) => text.replace(/(?:^|\s)((?:[а-я][\s.\-_*]+){3,}[а-я])(?=\s|$)/g, (m, run) => ` ${run.replace(/[^а-я]/g, "")}`);
  const mixed = normalize(raw);
  return [...new Set([mixed, translit, glue(mixed), glue(translit), low, glue(low)])];
}

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
  [new RegExp(`(убью|убить|убийств|убийц|убивать|убива|киллер|задушу|застрелю|пристрелю|расчлен|замочу|прирежу|зарежу|сожгу|взорву|прибью|изобью|расстрел|теракт|бомбу|минирова|взрывчат|${B}(murder|kill|killer|bomb)${E})`), "угроза или насилие"],
  [new RegExp(`(наркот|наркоман|наркош|наркодил|барыг|${B}(drugs?|weed|cocaine|heroin|meth|mdma|lsd|ecstasy)${E}|закладк|мефедрон|героин|хероин|кокаин|амфетамин|гашиш|марихуан|спайс|${B}(меф|соль|лсд|шишки)${E}|куплю\\s+(траву|шишки)|продам\\s+(траву|шишки)|${B}трав[ауы]\\s+(куп|прод)|(куп|прод|взять|достат|достан|возьм|закин|кину|есть)[а-я]*\\s+(мяу|миау|мяв)|${B}(кокс|мдма|экстази|кладмен|амф|альфа[\\s-]*пвп)${E})`), "наркотики"],
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
  for (const variant of variants(raw)) {
    const padded = ` ${variant} `;
    for (const [re, why] of HOLD_RULES) {
      const m = padded.match(re);
      if (m) return { hold: why, hit: m[0].trim().slice(0, 40) };
    }
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

function viewPost(env, row, user, perm, vote) {
  const mine = row.tg_id === user.id;
  const who = whoOf(env, row, row.id);
  return {
    id: row.id,
    name: who.name,
    emoji: who.emoji,
    hue: who.hue,
    anon: Boolean(row.anon),
    tag: row.tag || "",
    // Под своим именем человек сам выбрал быть узнаваемым: даём ссылку на его
    // профиль Telegram (если у него есть @ник). У анонимов её нет никогда.
    tg: !row.anon && row.username ? row.username : undefined,
    ava: !row.anon && row.tg_id ? 1 : undefined,
    text: row.text,
    created: row.created,
    // Рейтинг: голосов «за» минус голосов «против» (может быть отрицательным).
    score: row.likes,
    vote: Number(vote) || 0,
    likes: row.likes,
    replies: row.replies,
    liked: Number(vote) === 1,
    mine,
    pending: row.hidden === 3,
    canDelete: mine || perm.staff,
    // Настоящий автор — только владельцу (модератор видит содержимое, но не автора).
    author: perm.owner ? { name: row.name, username: row.username || null, id: row.tg_id } : undefined,
    hidden: perm.staff ? row.hidden : undefined,
    reports: perm.staff ? row.reports : undefined,
    held: perm.staff && row.held_for ? row.held_for : undefined,
  };
}

function viewReply(env, row, user, perm, postRow, byId, vote) {
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
    tg: !row.anon && row.username ? row.username : undefined,
    ava: !row.anon && row.tg_id ? 1 : undefined,
    text: row.text,
    created: row.created,
    score: row.likes || 0,
    vote: Number(vote) || 0,
    likes: row.likes || 0,
    liked: Number(vote) === 1,
    parent,
    mine,
    pending: row.hidden === 3,
    canDelete: mine || perm.staff,
    author: perm.owner ? { name: row.name, username: row.username || null, id: row.tg_id } : undefined,
    hidden: perm.staff ? row.hidden : undefined,
    held: perm.staff && row.held_for ? row.held_for : undefined,
  };
}

/* ---------- API ---------- */

/** Закрыта ли Подслушка на ремонт и что написать людям. */
async function forumStatus(env, user) {
  const off = (await setting(env, "forum_on", "1")) !== "1";
  return {
    status: 200,
    json: { ok: true, off, message: off ? await setting(env, "forum_off_msg", "") : "", owner: Boolean(user?.id && isOwner(env, user.id)) },
  };
}

/** Закрыть (off) или открыть Подслушку для всех, кроме владельца. */
export async function forumSwitch(env, off, message = "") {
  await putSetting(env, "forum_on", off ? "0" : "1");
  await putSetting(env, "forum_off_msg", off ? String(message || "").trim().slice(0, 200) : "");
  await putSetting(env, "forum_close_pending", "");
}

export async function forumApi(env, action, body, user, notify, tell) {
  // Статус отдаём и без входа: по нему приложение решает, открывать ли форум.
  if (action === "status") return forumStatus(env, user);
  if (!user?.id) return fail("unauthorized", 401);
  const owner = isOwner(env, user.id);
  if (action === "switch") {
    if (!owner) return fail("forbidden", 403);
    await forumSwitch(env, Boolean(body.off), body.message);
    return forumStatus(env, user);
  }
  const role = owner ? "owner" : await roleOf(env, user.id);
  // staff — владелец и модераторы: видят очередь проверки и решают судьбу записей.
  const who = { owner, staff: owner || role === "moderator", role };
  if (!owner && (await setting(env, "forum_on", "1")) !== "1") return fail("off", 503, { message: await setting(env, "forum_off_msg", "") });
  // Закрытое тестирование: пока форум не открыт для всех, пускаем только своих.
  if (!owner && !role && (await setting(env, "forum_access", "testers")) !== "all") return fail("closed", 403);

  // Забаненный (общий бан /ban) читает, но не пишет, не жалуется и не лайкает.
  const ban = owner ? null : await activeBan(env, user.id);
  const writing = ["post", "reply", "like", "vote", "report"].includes(action);
  if (ban && writing) return fail("banned", 403, { banned: ban });

  if (action === "list") return list(env, body, user, who, ban);
  if (action === "poll") return poll(env, body, user, who);
  if (action === "replies") return replies(env, body, user, who, ban);
  if (action === "post") return createPost(env, body, user, who, notify);
  if (action === "reply") return createReply(env, body, user, who, notify, tell);
  if (action === "like" || action === "vote") return vote(env, body, user, action === "like");
  if (action === "delete") return remove(env, body, user, who);
  if (action === "report") return report(env, body, user, who, notify);
  if (action === "mod") return mod(env, body, who);
  if (action === "prefs") return prefs(env, body, user);
  return fail("bad request");
}

async function list(env, body, user, who, ban) {
  const before = Number(body.before) || 0;
  const sort = who.staff && body.sort === "review" ? "review" : body.sort === "top" ? "top" : "new";
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
  const votes = new Map();
  if (ids.length) {
    const { results: rows2 = [] } = await env.STATS.prepare(
      `SELECT post, v FROM forum_likes WHERE tg_id = ? AND post IN (${ids.map(() => "?").join(",")})`
    )
      .bind(user.id, ...ids)
      .all();
    for (const l of rows2) votes.set(l.post, l.v);
  }
  const top = await env.STATS.prepare("SELECT MAX(id) AS id FROM forum_posts WHERE hidden = 0").first();
  let review;
  if (who.staff) {
    const row = await env.STATS.prepare(
      "SELECT (SELECT COUNT(*) FROM forum_posts WHERE hidden IN (1, 3)) + (SELECT COUNT(*) FROM forum_replies WHERE hidden IN (1, 3)) AS n"
    ).first();
    review = row?.n || 0;
  }
  return {
    status: 200,
    json: {
      ok: true,
      // Для приложения «owner» значит «есть права проверять»: так показываются вкладка «Проверка» и кнопки.
      owner: who.staff,
      role: who.role || null,
      banned: ban,
      top: top?.id || 0,
      review,
      more: sort === "new" && rows.length === PAGE,
      posts: all.map((p) => viewPost(env, p, user, who, votes.get(p.id) || 0)),
    },
  };
}

/** Сколько новых постов появилось после `after` — для плашки «↑ 3 новых». */
async function poll(env, body, user, who) {
  const after = Number(body.after) || 0;
  const row = await env.STATS.prepare(
    "SELECT COUNT(*) AS n, MAX(id) AS top FROM forum_posts WHERE hidden = 0 AND id > ? AND tg_id != ?"
  )
    .bind(after, user.id)
    .first();
  let review;
  if (who.staff) {
    const r = await env.STATS.prepare(
      "SELECT (SELECT COUNT(*) FROM forum_posts WHERE hidden IN (1, 3)) + (SELECT COUNT(*) FROM forum_replies WHERE hidden IN (1, 3)) AS n"
    ).first();
    review = r?.n || 0;
  }
  return { status: 200, json: { ok: true, count: row?.n || 0, review } };
}

async function replies(env, body, user, who, ban) {
  const id = Number(body.post);
  if (!Number.isInteger(id) || id < 1) return fail("bad request");
  const post = await env.STATS.prepare("SELECT * FROM forum_posts WHERE id = ?").bind(id).first();
  if (!post || (post.hidden !== 0 && !(post.hidden === 3 && post.tg_id === user.id) && !who.staff)) return fail("not found", 404);
  const { results = [] } = await env.STATS.prepare(
    `SELECT * FROM forum_replies WHERE post = ? AND (hidden = 0 OR (hidden = 3 AND tg_id = ?)${who.staff ? " OR hidden IN (1, 3)" : ""}) ORDER BY id LIMIT ?`
  )
    .bind(id, user.id, REPLIES_PAGE)
    .all();
  const myVote = await env.STATS.prepare("SELECT v FROM forum_likes WHERE post = ? AND tg_id = ?").bind(id, user.id).first();
  const replyVotes = new Map();
  if (results.length) {
    const { results: rl = [] } = await env.STATS.prepare(
      `SELECT reply, v FROM forum_reply_likes WHERE tg_id = ? AND reply IN (${results.map(() => "?").join(",")})`
    )
      .bind(user.id, ...results.map((r) => r.id))
      .all();
    for (const l of rl) replyVotes.set(l.reply, l.v);
  }
  const byId = new Map(results.map((r) => [r.id, r]));
  const prefsRow = await env.STATS.prepare("SELECT notify FROM forum_prefs WHERE tg_id = ?").bind(user.id).first();
  return {
    status: 200,
    json: {
      ok: true,
      banned: ban,
      notify: prefsRow ? Boolean(prefsRow.notify) : true,
      // Как зрителя будут звать в этой теме — чтобы свой ответ сразу показать
      // с настоящим именем, не дожидаясь сервера.
      me: { alias: alias(env, id, user.id), name: displayName(user), hue: personHue(env, user.id) },
      post: viewPost(env, post, user, who, myVote?.v || 0),
      replies: results.map((r) => viewReply(env, r, user, who, post, byId, replyVotes.get(r.id) || 0)),
    },
  };
}

/** Общая проверка перед записью поста/ответа. Возвращает { fail } или { hold, flood }. */
async function gate(env, user, who, kind, text, notify) {
  const screen = screenText(text);
  if (who.owner) return { hold: "" };
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
  if (kind === "r" && today >= REPLIES_PER_DAY) return { fail: fail("limit", 429, { reason: `Не больше ${REPLIES_PER_DAY} ответов в сутки.` }) };
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
  return { hold, hit: screen.hold && hold === screen.hold ? screen.hit : "" };
}

async function createPost(env, body, user, who, notify) {
  const text = String(body.text || "").trim();
  if (text.length > POST_MAX) return fail("too long");
  const tag = String(body.tag || "").trim().slice(0, TAG_MAX);
  const verdict = await gate(env, user, who, "p", text, notify);
  if (verdict.fail) return verdict.fail;
  if (tag && screenText(tag, { allowEmpty: true }).block) return fail("blocked", 422, { reason: "Подпись вуза не подходит." });
  const anon = body.anon === false ? 0 : 1;
  const hidden = verdict.hold ? 3 : 0;
  const result = await env.STATS.prepare(
    `INSERT INTO forum_posts (tg_id, name, username, anon, text, created, hidden, held_for, tag)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
  )
    .bind(user.id, displayName(user), user.username || null, anon, text, nowIso(), hidden, verdict.hold ? verdict.hold + (verdict.hit ? ` («${verdict.hit}»)` : "") : "", tag)
    .first();
  if (hidden) {
    await notify(
      [
        `📝 <b>Подслушка: пост №${result.id} ждёт проверки</b>`,
        `Причина: <b>${escape(verdict.hold)}</b>${verdict.hit ? ` — сработало на «${escape(verdict.hit)}»` : ""}`,
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
    json: { ok: true, pending: Boolean(hidden), reason: hidden ? verdict.hold : "", post: viewPost(env, row, user, who, false) },
  };
}

async function createReply(env, body, user, who, notify, tell) {
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
  const verdict = await gate(env, user, who, "r", text, notify);
  if (verdict.fail) return verdict.fail;
  const anon = body.anon === false ? 0 : 1;
  // Ответы новичков не ждут проверки (иначе тема мертва) — только стоп-слова и всплеск.
  const hidden = verdict.hold ? 3 : 0;
  const result = await env.STATS.prepare(
    `INSERT INTO forum_replies (post, tg_id, name, username, anon, text, created, hidden, held_for, parent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
  )
    .bind(postId, user.id, displayName(user), user.username || null, anon, text, nowIso(), hidden, verdict.hold ? verdict.hold + (verdict.hit ? ` («${verdict.hit}»)` : "") : "", parent ? parent.id : 0)
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
        `💬 <b>Подслушка: ответ №${result.id} (к посту №${postId}) ждёт проверки</b>`,
        `Причина: <b>${escape(verdict.hold)}</b>${verdict.hit ? ` — сработало на «${escape(verdict.hit)}»` : ""}`,
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
    json: { ok: true, pending: Boolean(hidden), reason: hidden ? verdict.hold : "", reply: viewReply(env, row, user, who, post, byId, false) },
  };
}

/**
 * Голос за (+1) или против (−1) поста или ответа; 0 — снять голос.
 * `like` (старый способ) — то же самое: голос «за» включается и выключается.
 */
async function vote(env, body, user, legacyToggle) {
  const kind = body.kind === "r" ? "r" : "p";
  const id = Number(kind === "r" ? body.id : body.post || body.id);
  if (!Number.isInteger(id) || id < 1) return fail("bad request");
  const table = kind === "r" ? "forum_replies" : "forum_posts";
  const votes = kind === "r" ? "forum_reply_likes" : "forum_likes";
  const col = kind === "r" ? "reply" : "post";
  const item = await env.STATS.prepare(`SELECT id, tg_id FROM ${table} WHERE id = ? AND hidden = 0`).bind(id).first();
  if (!item) return fail("not found", 404);
  const had = await env.STATS.prepare(`SELECT v FROM ${votes} WHERE ${col} = ? AND tg_id = ?`).bind(id, user.id).first();
  const old = had ? had.v : 0;
  const next = legacyToggle ? (old === 1 ? 0 : 1) : clampVote(body.v);
  if (next === null) return fail("bad request");
  if (next !== old) {
    await env.STATS.batch([
      next === 0
        ? env.STATS.prepare(`DELETE FROM ${votes} WHERE ${col} = ? AND tg_id = ?`).bind(id, user.id)
        : env.STATS.prepare(
            `INSERT INTO ${votes} (${col}, tg_id, v) VALUES (?, ?, ?) ON CONFLICT(${col}, tg_id) DO UPDATE SET v = excluded.v`
          ).bind(id, user.id, next),
      env.STATS.prepare(`UPDATE ${table} SET likes = likes + ? WHERE id = ?`).bind(next - old, id),
    ]);
  }
  const row = await env.STATS.prepare(`SELECT likes FROM ${table} WHERE id = ?`).bind(id).first();
  return { status: 200, json: { ok: true, v: next, vote: next, liked: next === 1, score: row?.likes || 0, likes: row?.likes || 0 } };
}

const clampVote = (v) => (v === 1 || v === -1 || v === 0 ? v : null);

async function remove(env, body, user, who) {
  const kind = body.kind === "r" ? "r" : "p";
  const id = Number(body.id);
  if (!Number.isInteger(id) || id < 1) return fail("bad request");
  const row = await authorOf(env, kind, id);
  if (!row || row.hidden === 2) return fail("not found", 404);
  if (row.tg_id !== user.id && !who.staff) return fail("forbidden", 403);
  await applyAction(env, "del", kind, row);
  return { status: 200, json: { ok: true } };
}

async function report(env, body, user, who, notify) {
  const kind = body.kind === "r" ? "r" : "p";
  const id = Number(body.id);
  if (!Number.isInteger(id) || id < 1) return fail("bad request");
  const reason = Object.hasOwn(REPORT_REASONS, body.reason) ? body.reason : "other";
  const row = await authorOf(env, kind, id);
  if (!row || row.hidden !== 0) return fail("not found", 404);
  if (row.tg_id === user.id) return fail("own");
  const added = await env.STATS.prepare("INSERT OR IGNORE INTO forum_reports (kind, item, tg_id, reason, name, username) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(kind, id, user.id, reason, displayName(user), user.username || null)
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
  // Кто жалуется — владельцу: анонимность жалобы только перед автором и остальными.
  const { results: who2 = [] } = await env.STATS.prepare(
    "SELECT tg_id, name, username, reason FROM forum_reports WHERE kind = ? AND item = ? ORDER BY rowid"
  )
    .bind(kind, id)
    .all();
  const reporters = who2.map((r) => `• ${AUTHOR_LINK(r)} — ${escape(REPORT_REASONS[r.reason] || r.reason)}`).join("\n");
  const reasons = why.map((w) => `${REPORT_REASONS[w.reason] || w.reason}${w.n > 1 ? ` ×${w.n}` : ""}`).join(", ");
  // Каждая жалоба — владельцу: первая тихо (без звука), скрытие — со звуком.
  await notify(
    [
      hide ? `⚠️ <b>Подслушка: ${label} №${id} скрыт после ${reports} жалоб</b>` : `🚩 Подслушка: жалоба на ${label} №${id} (${reports} из ${REPORTS_TO_HIDE})`,
      `Причина: ${escape(reasons)}`,
      `Жалуются:\n${reporters}`,
      `Автор: ${AUTHOR_LINK(row)} · показан как ${row.anon ? "аноним" : "под именем"}`,
      "",
      snippet(row.text),
    ].join("\n"),
    buttons(kind, id)
  ).catch(() => {});
  return { status: 200, json: { ok: true } };
}

/** Решения владельца прямо в приложении: те же, что кнопки под уведомлениями. */
async function mod(env, body, who) {
  if (!who.staff) return fail("forbidden", 403);
  const kind = body.kind === "r" ? "r" : "p";
  const id = Number(body.id);
  // «Удалить всё автора» — только владельцу: модератору автор не раскрывается.
  if (body.op === "purge" && !who.owner) return fail("forbidden", 403);
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
  "/fclose [текст людям] — закрыть Подслушку на ремонт (переспросит) · /fopen — открыть",
  "/forum off · /forum on — то же без переспроса",
  "/forum newbie on|off — проверять первый пост нового автора",
  "/forum testers · /forum all — доступ: только свои (тестировщики, модераторы) или все",
  "/ftester @ник — открыть доступ тестировщику · /funtester @ник — закрыть",
  "/fmod @ник — назначить модератором · /funmod @ник — снять",
  "/froles — кто допущен к форуму",
  "/fwho 12 — кто на самом деле автор поста №12 (ответ: /fwho r5)",
  "/fdel 12 — удалить пост (ответ: /fdel r5)",
  "/fban 12 [дни] [причина] — удалить и забанить автора поста №12",
  "Баны общие с комментариями: /bans, /unban @ник.",
].join("\n");

function parseRef(token) {
  const m = String(token || "").match(/^(r|р)?[№#]?(\d+)$/i);
  return m ? { kind: m[1] ? "r" : "p", id: Number(m[2]) } : null;
}

/** Ответ на кнопки «Да, закрыть» / «Отмена» под /fclose. */
export async function forumCloseConfirm(env, yes) {
  const pending = await setting(env, "forum_close_pending", "");
  if (!yes) {
    await putSetting(env, "forum_close_pending", "");
    return "Отменено, Подслушка работает.";
  }
  if (!pending) return "Запрос устарел: отправьте /fclose ещё раз.";
  await forumSwitch(env, true, pending === "-" ? "" : pending);
  return "Подслушка закрыта на ремонт. Открыть: /fopen";
}

export async function forumCommand(env, text, findPerson) {
  const [cmdRaw, ...args] = String(text).trim().split(/\s+/);
  const cmd = cmdRaw.replace(/^\//, "").replace(/@\w+$/, "").toLowerCase();

  if (cmd === "fclose") {
    // Закрыть на ремонт — с переспросом: сначала кнопки, закрывает только «Да».
    const message = args.join(" ").trim().slice(0, 200);
    await putSetting(env, "forum_close_pending", message || "-");
    return {
      text: `⛔ Закрыть Подслушку на ремонт для всех?${message ? `\nЛюдям покажем: «${escape(message)}»` : ""}\nОткрыть обратно: /fopen`,
      keyboard: [[{ text: "⛔ Да, закрыть", callback_data: "fcl:y" }, { text: "Отмена", callback_data: "fcl:n" }]],
    };
  }
  if (cmd === "fopen") {
    await forumSwitch(env, false);
    return { text: "✅ Подслушка открыта." };
  }

  if (cmd === "forum") {
    const sub = (args[0] || "").toLowerCase();
    if (sub === "off" || sub === "on") {
      await putSetting(env, "forum_on", sub === "on" ? "1" : "0");
      return { text: sub === "on" ? "✅ Подслушка включена." : "⛔ Подслушка выключена: у всех, кроме вас, форум не открывается. Включить: /forum on" };
    }
    if (sub === "all" || sub === "testers") {
      await putSetting(env, "forum_access", sub);
      return {
        text:
          sub === "all"
            ? "🌍 Подслушка открыта для всех, у кого есть приложение с ней."
            : "🔒 Подслушка в закрытом тестировании: пускаем только вас, тестировщиков и модераторов. Открыть всем: /forum all",
      };
    }
    if (sub === "newbie" && (args[1] === "on" || args[1] === "off")) {
      await putSetting(env, "forum_newbie_hold", args[1] === "on" ? "1" : "0");
      return { text: args[1] === "on" ? "✅ Первый пост нового автора проверяете вы." : "⚠️ Первые посты новых авторов публикуются сразу (стоп-слова и жалобы работают по-прежнему)." };
    }
    const access = await setting(env, "forum_access", "testers");
    const { results: roleRows = [] } = await env.STATS.prepare("SELECT role, COUNT(*) AS n FROM forum_roles GROUP BY role").all();
    const rolesLine = roleRows.length ? roleRows.map((r) => `${r.role === "moderator" ? "модераторов" : "тестировщиков"}: ${r.n}`).join(", ") : "никого не назначено";
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
        `Доступ: ${access === "all" ? "🌍 для всех" : "🔒 закрытое тестирование"} · ${rolesLine}`,
        "",
        FORUM_HELP,
      ].join("\n"),
      queue: queue.map((q) => ({
        text: [`📝 ${q.kind === "p" ? "Пост" : "Ответ"} №${q.id} ждёт\nПричина: <b>${escape(q.held_for)}</b>`, `Автор: ${AUTHOR_LINK(q)}`, "", snippet(q.text)].join("\n"),
        keyboard: buttons(q.kind, q.id, { review: true }),
      })),
    };
  }

  if (["ftester", "funtester", "fmod", "funmod", "froles"].includes(cmd)) return rolesCommand(env, cmd, args, findPerson);

  const ref = parseRef(args[0]);
  if (!ref) return { text: `Укажите номер: /${cmd} 12 (ответ — /${cmd} r5).\n\n${FORUM_HELP}` };
  const row = await authorOf(env, ref.kind, ref.id);
  if (!row) return { text: `Нет ${ref.kind === "p" ? "поста" : "ответа"} №${ref.id}.` };

  if (cmd === "fwho") {
    const { results: reps = [] } = await env.STATS.prepare(
      "SELECT tg_id, name, username, reason FROM forum_reports WHERE kind = ? AND item = ? ORDER BY rowid"
    ).bind(ref.kind, ref.id).all();
    const state = { 0: "виден", 1: "скрыт жалобами", 2: "удалён", 3: "ждёт проверки" }[row.hidden];
    return {
      text: [
        `${ref.kind === "p" ? "Пост" : "Ответ"} №${row.id} · ${state}`,
        `Автор: ${AUTHOR_LINK(row)}`,
        `Показан как: ${row.anon ? "аноним" : "под именем"}`,
        row.reports ? `Жалоб: ${row.reports}` : null,
        reps.length ? `Жалуются:\n${reps.map((r) => `• ${AUTHOR_LINK({ ...r, name: r.name || "—" })} — ${escape(REPORT_REASONS[r.reason] || r.reason)}`).join("\n")}` : null,
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

/* ---------- Тестировщики и модераторы ---------- */

const ROLE_NAME = { tester: "тестировщик", moderator: "модератор" };

async function rolesCommand(env, cmd, args, findPerson) {
  if (cmd === "froles") {
    const { results = [] } = await env.STATS.prepare(
      "SELECT tg_id, name, username, role, created FROM forum_roles ORDER BY role DESC, created"
    ).all();
    if (!results.length) return { text: "Никого не назначено.\n\n/ftester @ник — тестировщик\n/fmod @ник — модератор" };
    return {
      text: [
        `<b>Допущены к Подслушке</b> (${results.length})`,
        "",
        ...results.map((r) => `${r.role === "moderator" ? "🛡" : "🧪"} <a href="tg://user?id=${r.tg_id}">${escape(r.name || `id ${r.tg_id}`)}</a>${r.username ? ` @${escape(r.username)}` : ""} · id ${r.tg_id} · ${ROLE_NAME[r.role]}`),
        "",
        "Снять: /funtester @ник · /funmod @ник",
      ].join("\n"),
    };
  }
  const grant = cmd === "ftester" || cmd === "fmod";
  const role = cmd === "ftester" || cmd === "funtester" ? "tester" : "moderator";
  const token = args[0];
  if (!token) return { text: `Кого? /${cmd} @ник или /${cmd} 123456789` };
  const person = await findPerson(env, token);
  if (!person?.tg_id) {
    return { text: `Не нашёл ${escape(token)}. Человек должен хоть раз открыть бота или расписание; можно указать его числовой id.` };
  }
  if (isOwner(env, person.tg_id)) return { text: "Вы и так владелец: у вас все права." };
  const label = `${escape(person.name || "")}${person.username ? ` @${escape(person.username)}` : ""} · id ${person.tg_id}`.trim();

  if (grant) {
    await env.STATS.prepare(
      `INSERT INTO forum_roles (tg_id, name, username, role, created) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(tg_id) DO UPDATE SET role = excluded.role, name = excluded.name, username = excluded.username`
    )
      .bind(person.tg_id, person.name || null, person.username || null, role, nowIso())
      .run();
    // Модератору первые посты проверять незачем.
    if (role === "moderator") {
      await env.STATS.prepare("INSERT OR IGNORE INTO forum_trusted (tg_id, created) VALUES (?, ?)").bind(person.tg_id, nowIso()).run();
    }
    return {
      text: `${role === "moderator" ? "🛡" : "🧪"} ${label} — теперь ${ROLE_NAME[role]} Подслушки. Ему отправил сообщение с кнопкой.`,
      notify: {
        chat: person.tg_id,
        text:
          role === "moderator"
            ? "🛡 Вас назначили модератором Подслушки.\n\nВ форуме появилась вкладка «Проверка»: там посты и ответы, которые ждут решения или скрыты жалобами. Можно опубликовать, удалить или забанить автора на 7 дней. Кто автор, модератору не показывается."
            : "🧪 Вам открыт тестовый доступ к Подслушке — общему форуму студентов.\n\nПока он закрыт для остальных. Открывается из меню «⋯» → «Подслушка». Если что-то не так, просто напишите, что именно.",
        button: "Открыть",
      },
    };
  }
  const had = await env.STATS.prepare("SELECT role FROM forum_roles WHERE tg_id = ?").bind(person.tg_id).first();
  if (!had || had.role !== role) {
    return { text: `${label} не ${role === "moderator" ? "модератор" : "тестировщик"}${had ? ` (он ${ROLE_NAME[had.role]})` : ""}.` };
  }
  await env.STATS.prepare("DELETE FROM forum_roles WHERE tg_id = ?").bind(person.tg_id).run();
  return { text: `${label} больше не ${ROLE_NAME[role]} Подслушки.` };
}
