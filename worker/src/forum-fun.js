/**
 * Подслушка: уровни авторов и «Задание дня».
 *
 * Карма — за то, что людям нравится: плюсы к постам и ответам, сами посты и
 * ответы, победы в «Задании дня». Уровень виден у имени, только если человек
 * пишет под своим именем: у анонимов значок раскрыл бы, кто это. Свой уровень
 * человек видит всегда — в шапке ленты.
 *
 * Задания — безопасные темы о студенческой жизни: про опыт, советы и смешные
 * ситуации, без оценок конкретных людей (преподавателей, однокурсников).
 */
const LEVELS = [
  { min: 0, icon: "🌱", name: "Новичок" },
  { min: 20, icon: "💬", name: "Голос" },
  { min: 80, icon: "🔥", name: "Звезда" },
  { min: 200, icon: "💎", name: "Знаток" },
  { min: 500, icon: "👑", name: "Легенда" },
];
const WIN_BONUS = 25;

export function levelOf(karma) {
  let i = 0;
  while (i + 1 < LEVELS.length && karma >= LEVELS[i + 1].min) i++;
  const next = LEVELS[i + 1];
  return { icon: LEVELS[i].icon, name: LEVELS[i].name, karma, next: next ? { icon: next.icon, name: next.name, need: next.min - karma } : null };
}

let karmaCache = { at: 0, map: new Map() };
/** Карма всех авторов разом (кэш на минуту — лента запрашивается часто). */
export async function karmaMap(env) {
  if (Date.now() - karmaCache.at < 60000) return karmaCache.map;
  const map = new Map();
  const add = (id, n) => map.set(id, (map.get(id) || 0) + n);
  const { results: posts = [] } = await env.STATS.prepare(
    "SELECT tg_id, COUNT(*) AS n, COALESCE(SUM(likes), 0) AS s, COALESCE(SUM(best), 0) AS w FROM forum_posts WHERE hidden = 0 GROUP BY tg_id"
  ).all();
  for (const r of posts) add(r.tg_id, r.n * 2 + Math.max(0, r.s) * 3 + r.w * WIN_BONUS);
  const { results: reps = [] } = await env.STATS.prepare("SELECT tg_id, COUNT(*) AS n FROM forum_replies WHERE hidden = 0 GROUP BY tg_id").all();
  for (const r of reps) add(r.tg_id, r.n);
  const { results: rl = [] } = await env.STATS.prepare(
    "SELECT r.tg_id AS tg_id, COALESCE(SUM(l.v), 0) AS s FROM forum_reply_likes l JOIN forum_replies r ON r.id = l.reply WHERE r.hidden = 0 GROUP BY r.tg_id"
  ).all();
  for (const r of rl) add(r.tg_id, Math.max(0, r.s) * 2);
  // Выданное владельцем вручную (/karma). Таблицы может не быть в старой базе.
  const bonus = await env.STATS.prepare("SELECT tg_id, COALESCE(SUM(amount), 0) AS s FROM forum_karma_bonus GROUP BY tg_id")
    .all()
    .catch(() => ({ results: [] }));
  for (const r of bonus.results || []) add(r.tg_id, r.s);
  karmaCache = { at: Date.now(), map };
  return map;
}
/** /karma @ник 25 — выдать (или с минусом снять) карму вручную. Только владелец. */
export async function karmaCommand(env, text, findPerson) {
  const m = String(text).replace(/^\/karma(@\w+)?/, "").trim().match(/^(\S+)\s+(-?\d{1,4})$/);
  if (!m) return "Кому и сколько: <code>/karma @ник 25</code> (с минусом — снять).";
  const person = await findPerson(env, m[1]);
  if (!person?.tg_id) return `Не нашёл ${m[1]} — человек должен хоть раз открыть приложение или бота.`;
  const amount = Number(m[2]);
  await env.STATS.prepare("CREATE TABLE IF NOT EXISTS forum_karma_bonus (id INTEGER PRIMARY KEY AUTOINCREMENT, tg_id INTEGER NOT NULL, amount INTEGER NOT NULL, at TEXT NOT NULL)").run();
  await env.STATS.prepare("INSERT INTO forum_karma_bonus (tg_id, amount, at) VALUES (?, ?, ?)").bind(person.tg_id, amount, new Date().toISOString()).run();
  dropKarmaCache();
  const total = (await karmaMap(env)).get(person.tg_id) || 0;
  const level = levelOf(total);
  const who = person.username ? `@${person.username}` : person.name || `id ${person.tg_id}`;
  return `${amount >= 0 ? "Выдал" : "Снял"} ${Math.abs(amount)} кармы: ${who}. Теперь ${total} — ${level.icon} ${level.name}.`;
}

export function dropKarmaCache() {
  karmaCache.at = 0;
}

const CHALLENGES = [
  "Лучший совет первокурснику, который ты бы дал себе год назад",
  "Самая смешная ситуация, которая случилась с тобой на паре",
  "Где в твоём вузе лучше всего готовиться к сессии?",
  "Какой предмет оказался интереснее, чем ты думал?",
  "Твой лайфхак, как не опаздывать на первую пару",
  "Самая вкусная еда рядом с твоим корпусом",
  "Как ты отдыхаешь после тяжёлой недели?",
  "Что бы ты изменил в студенческой жизни, если бы был ректором на день?",
  "Самая неожиданная находка в твоём вузе: место, кружок, традиция",
  "Как ты готовишься к экзамену за ночь (или не готовишься)?",
  "Лучший студенческий мем этой недели — опиши словами",
  "Какую привычку ты завёл в универе и не жалеешь?",
  "Что тебя мотивирует ходить на пары?",
  "Самое красивое место в твоём вузе",
  "Твоя самая удачная шпаргалка… по жизни: правило, которое всегда работает",
  "Как ты нашёл друзей в универе?",
  "Какой навык из вуза уже пригодился в жизни?",
  "Самый абсурдный слух, который ходил по твоему вузу",
  "Чем ты занимаешься на большом перерыве?",
  "Что бы ты посоветовал тому, кто выбирает твой факультет?",
  "Опиши свою неделю тремя словами",
];

/** День по Москве: «2026-11-06». */
export const mskDay = (t = Date.now()) => new Date(t + 3 * 3600000).toISOString().slice(0, 10);

export function challengeOf(day = mskDay()) {
  const n = Math.floor(Date.parse(`${day}T00:00:00Z`) / 86400000);
  return { day, text: CHALLENGES[((n % CHALLENGES.length) + CHALLENGES.length) % CHALLENGES.length] };
}

export async function challengeInfo(env) {
  const c = challengeOf();
  const row = await env.STATS.prepare("SELECT COUNT(*) AS n FROM forum_posts WHERE challenge = ? AND hidden = 0").bind(c.day).first();
  return { ...c, answers: row?.n || 0 };
}

/** Раз в минуту: в 21:00 МСК — лучший ответ на задание дня, автору — сообщение. */
export async function forumFunTick(env, dm, getSetting, putSetting) {
  const now = Date.now();
  const msk = new Date(now + 3 * 3600000);
  if (msk.getUTCHours() < 21) return;
  const day = mskDay(now);
  if (await getSetting(env, `chal:${day}`, "")) return;
  await putSetting(env, `chal:${day}`, "1");
  const best = await env.STATS.prepare(
    "SELECT id, tg_id, likes FROM forum_posts WHERE challenge = ? AND hidden = 0 AND likes >= 2 ORDER BY likes DESC, replies DESC, id ASC LIMIT 1"
  )
    .bind(day)
    .first();
  if (!best) return;
  await env.STATS.prepare("UPDATE forum_posts SET best = 1 WHERE id = ?").bind(best.id).run();
  dropKarmaCache();
  await dm?.(best.tg_id, `🔥 Ваш ответ на «Задание дня» в Подслушке — лучший! +${WIN_BONUS} кармы и отметка «Ответ дня» у поста.`).catch(() => {});
}
