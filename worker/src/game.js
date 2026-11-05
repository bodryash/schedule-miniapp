/**
 * «Сессия 2048» — недельный турнир вузов внутри приложения.
 *
 * Попыток сколько угодно, потолка нет:
 *  - у игрока в зачёт идёт лучшая партия (игра идёт и после 2048);
 *  - у факультета — сумма рекордов всех его игроков: растёт с каждым новым
 *    игроком и каждым новым рекордом.
 * Счёт считает сервер: приложение присылает зерно партии и запись ходов,
 * сервер проигрывает её заново (тот же код, docs/game-core.mjs).
 *
 * Связь с Подслушкой: в начале бот публикует и закрепляет анонс, каждый вечер
 * в 21:00 — итоги дня, в конце — победителей; у призёров у имени в Подслушке
 * медаль (только под своим именем).
 */
import { level, replay } from "../../docs/game-core.mjs";

export const EVENT = {
  id: "s2048-2026-11",
  title: "Сессия 2048",
  starts: Date.parse("2026-11-05T00:00:00+03:00"),
  ends: Date.parse("2026-11-12T23:59:59+03:00"),
};

const MAX_MOVES = 400000;
const CHECKPOINT_GAP_MS = 1500;

const fail = (error, status = 400, extra = {}) => ({ status, json: { ok: false, error, ...extra } });
const now = () => Date.now();
const escape = (text) => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export const eventInfo = () => ({ id: EVENT.id, title: EVENT.title, starts: EVENT.starts, ends: EVENT.ends, live: now() >= EVENT.starts && now() <= EVENT.ends });

/** Имя в таблице: имя и первая буква фамилии — без @ника и полной фамилии. */
function shortName(user) {
  const first = String(user.first_name || "").trim();
  const last = String(user.last_name || "").trim();
  return (first ? `${first}${last ? ` ${last[0]}.` : ""}` : "Студент").slice(0, 32);
}

const cleanTenant = (value) => String(value || "").replace(/[^a-z0-9-]/gi, "").slice(0, 40) || "other";
const cleanLabel = (value) => String(value || "").replace(/[<>]/g, "").trim().slice(0, 60) || "Без факультета";

async function start(env, body, user) {
  if (now() > EVENT.ends) return fail("over", 410);
  const seed = crypto.getRandomValues(new Uint32Array(1))[0];
  const row = await env.STATS.prepare(
    "INSERT INTO game_runs (event, tg_id, seed, tenant, fac, started, moves, score, max_tile, over) VALUES (?, ?, ?, ?, ?, ?, '', 0, 2, 0) RETURNING id"
  )
    .bind(EVENT.id, user.id, seed, cleanTenant(body.tenant), cleanLabel(body.fac), new Date().toISOString())
    .first();
  return { status: 200, json: { ok: true, id: row.id, seed, event: eventInfo() } };
}

/**
 * Сохранить партию (и по ходу — «чекпоинт», и в конце). Запись ходов только
 * растёт: сервер проигрывает её целиком и берёт счёт из своей проверки.
 */
async function save(env, body, user, notify) {
  const id = Number(body.id);
  const moves = String(body.moves || "");
  if (!Number.isInteger(id) || id < 1 || moves.length > MAX_MOVES) return fail("bad request");
  const run = await env.STATS.prepare("SELECT * FROM game_runs WHERE id = ? AND tg_id = ?").bind(id, user.id).first();
  if (!run) return fail("not found", 404);
  if (run.over) return { status: 200, json: { ok: true, score: run.score, already: true } };
  // Партии, начатые до конца недели, можно доиграть ещё 15 минут.
  if (now() > EVENT.ends + 15 * 60000) return fail("over", 410);
  if (!moves.startsWith(run.moves)) return fail("bad moves", 422);
  // После конца недели принимаем только партии, начатые до него.
  const result = replay(run.seed, moves);
  if (!result.ok) return fail("bad moves", 422, { why: result.why });
  const over = result.over || Boolean(body.final);
  await env.STATS.prepare("UPDATE game_runs SET moves = ?, score = ?, max_tile = ?, over = ?, updated = ? WHERE id = ?")
    .bind(moves, result.score, result.max, over ? 1 : 0, new Date().toISOString(), id)
    .run();

  // Рекорд игрока: лучшая партия. Факультет — тот, с которого играл последним.
  const best = await env.STATS.prepare("SELECT best, max_tile FROM game_best WHERE event = ? AND tg_id = ?").bind(EVENT.id, user.id).first();
  const record = !best || result.score > best.best;
  await env.STATS.prepare(
    `INSERT INTO game_best (event, tg_id, name, tenant, fac, best, max_tile, games, updated)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(event, tg_id) DO UPDATE SET
       name = excluded.name, tenant = excluded.tenant, fac = excluded.fac,
       best = MAX(game_best.best, excluded.best), max_tile = MAX(game_best.max_tile, excluded.max_tile),
       games = game_best.games + ?, updated = excluded.updated`
  )
    .bind(EVENT.id, user.id, shortName(user), run.tenant, run.fac, result.score, result.max, over ? 1 : 0, new Date().toISOString(), over && !run.over ? 1 : 0)
    .run();
  const mine = await env.STATS.prepare("SELECT best FROM game_best WHERE event = ? AND tg_id = ?").bind(EVENT.id, user.id).first();
  const { n: above } = await env.STATS.prepare("SELECT COUNT(*) AS n FROM game_best WHERE event = ? AND best > ?").bind(EVENT.id, mine.best).first();
  // Новый лидер турнира — владельцу короткая весточка.
  if (record && above === 0 && result.score >= 1000 && over) {
    await notify?.(`🎮 ${EVENT.title}: новый лидер — ${escape(shortName(user))} (${escape(run.fac)}) · ${result.score.toLocaleString("ru-RU")}`).catch(() => {});
  }
  return { status: 200, json: { ok: true, score: result.score, max: result.max, over, record, best: mine.best, place: above + 1 } };
}

async function board(env, body, user) {
  const { results: players = [] } = await env.STATS.prepare(
    "SELECT tg_id, name, fac, best, max_tile FROM game_best WHERE event = ? ORDER BY best DESC, updated LIMIT 50"
  )
    .bind(EVENT.id)
    .all();
  const { results: facs = [] } = await env.STATS.prepare(
    "SELECT tenant, MAX(fac) AS fac, SUM(best) AS total, COUNT(*) AS players, MAX(best) AS top FROM game_best WHERE event = ? GROUP BY tenant ORDER BY total DESC LIMIT 50"
  )
    .bind(EVENT.id)
    .all();
  const me = await env.STATS.prepare("SELECT best, max_tile, games, tenant FROM game_best WHERE event = ? AND tg_id = ?").bind(EVENT.id, user.id).first();
  let place = null;
  let facPlace = null;
  if (me) {
    place = (await env.STATS.prepare("SELECT COUNT(*) AS n FROM game_best WHERE event = ? AND best > ?").bind(EVENT.id, me.best).first()).n + 1;
    const idx = facs.findIndex((f) => f.tenant === me.tenant);
    facPlace = idx >= 0 ? idx + 1 : null;
  }
  const totals = await env.STATS.prepare("SELECT COUNT(*) AS players, COALESCE(SUM(games), 0) AS games FROM game_best WHERE event = ?").bind(EVENT.id).first();
  return {
    status: 200,
    json: {
      ok: true,
      event: eventInfo(),
      players: players.map((p, i) => ({ place: i + 1, name: p.name, fac: p.fac, best: p.best, max: p.max_tile, me: p.tg_id === user.id })),
      facs: facs.map((f, i) => ({ place: i + 1, tenant: f.tenant, fac: f.fac, total: f.total, players: f.players, top: f.top })),
      me: me ? { best: me.best, max: me.max_tile, games: me.games, place, facPlace, tenant: me.tenant } : null,
      totals,
    },
  };
}

/** Турнир запускает владелец командой /g2048 start — после выкладки приложения. */
export async function gameLaunched(env) {
  return (await setting(env, `${EVENT.id}:launch`)) === "1";
}

export async function gameApi(env, action, body, user, notify) {
  if (!user?.id) return fail("unauthorized", 401);
  // Владелец может играть и до запуска — чтобы проверить.
  const owner = String(user.id) === String(env.OWNER_ID);
  if (!owner && (now() < EVENT.starts || !(await gameLaunched(env)))) return fail("soon", 403, { event: eventInfo() });
  if (action === "start") return start(env, body, user);
  if (action === "save") return save(env, body, user, notify);
  if (action === "board") return board(env, body, user);
  return fail("bad request");
}

/* ---------- Подслушка: анонс, итоги дня, победители ---------- */

async function setting(env, key) {
  const row = await env.STATS.prepare("SELECT value FROM forum_settings WHERE key = ?").bind(key).first();
  return row ? row.value : null;
}

async function putSetting(env, key, value) {
  await env.STATS.prepare("INSERT INTO forum_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(key, value).run();
}

async function forumPost(env, text, { pin = false } = {}) {
  const owner = Number(env.OWNER_ID);
  if (!owner) return null;
  const row = await env.STATS.prepare(
    `INSERT INTO forum_posts (tg_id, name, username, anon, text, created, hidden, held_for, tag, pinned)
     VALUES (?, ?, NULL, 0, ?, ?, 0, '', ?, ?) RETURNING id`
  )
    .bind(owner, "Подслушка", text, new Date().toISOString(), "🎮 Сессия 2048", pin ? now() : 0)
    .first();
  return row?.id || null;
}

async function standings(env, limit = 3) {
  const { results: facs = [] } = await env.STATS.prepare(
    "SELECT MAX(fac) AS fac, SUM(best) AS total, COUNT(*) AS players FROM game_best WHERE event = ? GROUP BY tenant ORDER BY total DESC LIMIT ?"
  )
    .bind(EVENT.id, limit)
    .all();
  const { results: players = [] } = await env.STATS.prepare(
    "SELECT tg_id, name, fac, best, max_tile FROM game_best WHERE event = ? ORDER BY best DESC, updated LIMIT ?"
  )
    .bind(EVENT.id, limit)
    .all();
  return { facs, players };
}

async function personalRecaps(env, dm, left) {
  const { results: all = [] } = await env.STATS.prepare(
    "SELECT tg_id, fac, tenant, best FROM game_best WHERE event = ? AND best > 0 ORDER BY best DESC, updated"
  )
    .bind(EVENT.id)
    .all();
  const { results: facs = [] } = await env.STATS.prepare(
    "SELECT tenant, SUM(best) AS total FROM game_best WHERE event = ? GROUP BY tenant ORDER BY total DESC"
  )
    .bind(EVENT.id)
    .all();
  const facRank = new Map(facs.map((f, i) => [f.tenant, i + 1]));
  const days = `${left} ${left === 1 ? "день" : left < 5 ? "дня" : "дней"}`;
  for (const [i, p] of all.entries()) {
    const place = i + 1;
    const fr = facRank.get(p.tenant) || facs.length;
    const ahead = i > 0 ? all[i - 1].best - p.best : 0;
    const text = [
      `🎮 <b>${EVENT.title}</b> — ваши итоги дня`,
      "",
      `${MEDALS[i] || "🏅"} Вы на <b>${place}</b> месте из ${all.length} · рекорд ${fmt(p.best)}`,
      `🏛 ${p.fac || "Ваш факультет"} — <b>${fr}</b> место из ${facs.length}`,
      place > 1 ? `До ${place - 1}-го места — ${fmt(ahead + 1)} очков.` : "Вы лидер турнира — держите позицию!",
      "",
      `До конца — ${days}. Позовите однокурсников: их рекорды добавляются к счёту факультета.`,
    ].join("\n");
    await dm(p.tg_id, text).catch(() => {});
    // Telegram разрешает ~30 сообщений в секунду — идём с запасом.
    await new Promise((r) => setTimeout(r, 60));
  }
}

const MEDALS = ["🥇", "🥈", "🥉"];
const fmt = (n) => Number(n || 0).toLocaleString("ru-RU");

/** Раз в минуту: анонс в начале, итоги дня в 21:00, победители в конце. */
export async function gameTick(env, notify, dm) {
  const t = now();
  if (t < EVENT.starts || !(await gameLaunched(env))) return;
  if (!(await setting(env, `${EVENT.id}:announced`))) {
    await putSetting(env, `${EVENT.id}:announced`, "1");
    const id = await forumPost(
      env,
      [
        "🎮 Началась «Сессия 2048» — турнир вузов прямо в приложении!",
        "",
        "Собирайте плитки: Пара → Семинар → Зачёт → … → Красный диплом → Аспирантура — и дальше без потолка.",
        "Попыток сколько угодно. В зачёт идёт ваш лучший результат, а счёт факультета — сумма рекордов всех его игроков: чем больше однокурсников играет, тем выше факультет.",
        "",
        "Призы: лучшему игроку — эксклюзивная тема и 🥇 у имени здесь, в Подслушке; лучшему факультету — тема на всех.",
        "Итоги дня — каждый вечер здесь. До 12 ноября включительно.",
      ].join("\n"),
      { pin: true }
    );
    if (id) await putSetting(env, `${EVENT.id}:announce_post`, String(id));
    return;
  }
  const msk = new Date(t + 3 * 3600000);
  const day = msk.toISOString().slice(0, 10);
  if (t <= EVENT.ends && msk.getUTCHours() >= 21 && !(await setting(env, `${EVENT.id}:recap:${day}`))) {
    await putSetting(env, `${EVENT.id}:recap:${day}`, "1");
    const { facs, players } = await standings(env, 3);
    if (!players.length) return;
    const left = Math.max(1, Math.ceil((EVENT.ends - t) / 86400000));
    await forumPost(
      env,
      [
        `📊 «Сессия 2048»: итоги дня. До конца турнира — ${left} ${left === 1 ? "день" : left < 5 ? "дня" : "дней"}.`,
        "",
        "Факультеты:",
        ...facs.map((f, i) => `${MEDALS[i]} ${f.fac} — ${fmt(f.total)} (игроков: ${f.players})`),
        "",
        "Игроки:",
        ...players.map((p, i) => `${MEDALS[i]} ${p.name}, ${p.fac} — ${fmt(p.best)} · ${level(p.max_tile).name}`),
        "",
        "Ваш факультет ниже? Зовите однокурсников — каждый рекорд добавляется к счёту факультета.",
      ].join("\n")
    );
    // Каждому игроку — личные итоги: его место и место факультета.
    if (dm) await personalRecaps(env, dm, left).catch((e) => console.log("2048 recaps failed", String(e?.message || e)));
    return;
  }
  if (t > EVENT.ends && !(await setting(env, `${EVENT.id}:final`))) {
    await putSetting(env, `${EVENT.id}:final`, "1");
    const { facs, players } = await standings(env, 3);
    const medals = {};
    players.forEach((p, i) => (medals[p.tg_id] = MEDALS[i]));
    await putSetting(env, `${EVENT.id}:medals`, JSON.stringify(medals));
    // Анонс больше не закреплён: турнир кончился.
    const announce = Number(await setting(env, `${EVENT.id}:announce_post`));
    if (announce) await env.STATS.prepare("UPDATE forum_posts SET pinned = 0 WHERE id = ?").bind(announce).run();
    if (!players.length) return;
    await forumPost(
      env,
      [
        "🏁 «Сессия 2048» закончилась! Победители:",
        "",
        ...players.map((p, i) => `${MEDALS[i]} ${p.name}, ${p.fac} — ${fmt(p.best)} · ${level(p.max_tile).name}`),
        "",
        facs[0] ? `🏆 Лучший факультет — ${facs[0].fac}: ${fmt(facs[0].total)} очков, игроков ${facs[0].players}.` : "",
        "",
        "Медали теперь стоят у имён победителей в Подслушке. Спасибо всем, кто играл!",
      ].join("\n"),
      { pin: true }
    );
    await notify?.(
      [
        `🏁 <b>${EVENT.title}</b> — итоги. Выдайте призы:`,
        ...players.map((p, i) => `${MEDALS[i]} ${escape(p.name)} · ${escape(p.fac)} · id <code>${p.tg_id}</code> — ${fmt(p.best)}`),
        facs[0] ? `🏆 Факультет: ${escape(facs[0].fac)}` : "",
        "Тема победителю: /theme",
      ].join("\n")
    ).catch(() => {});
  }
}

/** Медали призёров для Подслушки: { tg_id: "🥇" }, кэш на минуту. */
let medalCache = { at: 0, value: {} };
export async function gameMedals(env) {
  if (now() - medalCache.at < 60000) return medalCache.value;
  let value = {};
  try {
    value = JSON.parse((await setting(env, `${EVENT.id}:medals`)) || "{}");
  } catch {
    value = {};
  }
  medalCache = { at: now(), value };
  return value;
}

/** /g2048 — сводка для владельца; /g2048 start — запустить турнир, /g2048 stop — спрятать. */
export async function gameCommand(env, text = "") {
  const arg = String(text).trim().split(/\s+/)[1] || "";
  if (arg === "start") {
    await putSetting(env, `${EVENT.id}:launch`, "1");
    return `🎮 «${EVENT.title}» запущена: через минуту в Подслушке появится закреплённый анонс, игра откроется у всех. Сводка: /g2048`;
  }
  if (arg === "stop") {
    await putSetting(env, `${EVENT.id}:launch`, "0");
    return "⏸ Турнир спрятан: играть может только владелец. Вернуть: /g2048 start";
  }
  const totals = await env.STATS.prepare("SELECT COUNT(*) AS players, COALESCE(SUM(games), 0) AS games, COALESCE(MAX(best), 0) AS top FROM game_best WHERE event = ?").bind(EVENT.id).first();
  const runs = await env.STATS.prepare("SELECT COUNT(*) AS n FROM game_runs WHERE event = ?").bind(EVENT.id).first();
  const { facs, players } = await standings(env, 5);
  const left = EVENT.ends - now();
  const launched = await gameLaunched(env);
  return [
    `🎮 <b>${EVENT.title}</b> — ${!launched ? "ещё не запущена (запустить: /g2048 start)" : left > 0 ? `идёт, до конца ${Math.ceil(left / 3600000)} ч` : "закончилась"}`,
    `Игроков: ${totals.players} · партий начато: ${runs.n} · доиграно: ${totals.games} · рекорд: ${fmt(totals.top)}`,
    "",
    "<b>Факультеты:</b>",
    ...(facs.length ? facs.map((f, i) => `${i + 1}. ${escape(f.fac)} — ${fmt(f.total)} (игроков ${f.players})`) : ["пока пусто"]),
    "",
    "<b>Игроки:</b>",
    ...(players.length ? players.map((p, i) => `${i + 1}. ${escape(p.name)} · ${escape(p.fac)} — ${fmt(p.best)} · id <code>${p.tg_id}</code>`) : ["пока пусто"]),
  ].join("\n");
}
