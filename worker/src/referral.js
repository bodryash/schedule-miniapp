/**
 * «Неделя магната» — конкурс приглашений. У каждого своя ссылка
 * t.me/FGPshedulebot?start=r_КОД. Друг засчитывается, только если он у нас
 * впервые (раньше не открывал расписание) и сам открыл приложение с выбранной
 * группой. Кто привёл больше всех за неделю — тому NFT «Money Pot» №8875,
 * тема «Магнат» и 💰 у имени в Подслушке.
 */
const EVENT = { id: "pot1", title: "Неделя магната", days: 7, prize: "NFT «Money Pot» №8875" };
const BOT = "FGPshedulebot";
const MEDALS = ["💰", "🥈", "🥉"];
const now = () => Date.now();
const iso = () => new Date().toISOString();

async function setting(env, key) {
  const row = await env.STATS.prepare("SELECT value FROM forum_settings WHERE key = ?").bind(key).first();
  return row ? row.value : null;
}
async function putSetting(env, key, value) {
  await env.STATS.prepare("INSERT INTO forum_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(key, value).run();
}

/** Окно конкурса: { starts, ends } в мс или null, пока не запущен. */
async function window_(env) {
  const starts = Number(await setting(env, `${EVENT.id}:starts`));
  if (!starts) return null;
  return { starts, ends: starts + EVENT.days * 86400000 };
}

const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
function randomCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join("");
}

const displayName = (u) => [u.first_name, u.last_name].filter(Boolean).join(" ") || u.username || "Студент";
/** В общей таблице — имя и первая буква фамилии: ники не светим. */
const shortName = (name) => {
  const [first, last] = String(name || "Студент").split(/\s+/);
  return last ? `${first} ${last[0]}.` : first;
};

export async function refCode(env, user) {
  const row = await env.STATS.prepare("SELECT code FROM ref_codes WHERE tg_id = ?").bind(user.id).first();
  if (row) {
    await env.STATS.prepare("UPDATE ref_codes SET name = ?, username = ? WHERE tg_id = ?").bind(displayName(user), user.username || null, user.id).run();
    return row.code;
  }
  for (let i = 0; i < 5; i++) {
    const code = randomCode();
    const ok = await env.STATS.prepare("INSERT OR IGNORE INTO ref_codes (tg_id, code, name, username, created) VALUES (?, ?, ?, ?, ?)")
      .bind(user.id, code, displayName(user), user.username || null, iso())
      .run();
    if (ok.meta?.changes) return code;
  }
  throw new Error("no code");
}

/** /start r_КОД — запоминаем, кто пригласил. Только для тех, кто у нас впервые. */
export async function refStart(env, from, code) {
  if (!from?.id) return { ok: false };
  const owner = await env.STATS.prepare("SELECT tg_id, name FROM ref_codes WHERE code = ?").bind(code).first();
  if (!owner) return { ok: false, reason: "code" };
  if (owner.tg_id === from.id) return { ok: false, reason: "self", owner };
  const seen = await env.STATS.prepare("SELECT 1 AS yes FROM people WHERE tg_id = ? LIMIT 1").bind(from.id).first();
  if (seen) return { ok: false, reason: "old", owner };
  await env.STATS.prepare("INSERT OR IGNORE INTO ref_hits (invitee, referrer, at, active) VALUES (?, ?, ?, 0)").bind(from.id, owner.tg_id, iso()).run();
  return { ok: true, owner };
}

/** Друг открыл приложение и выбрал группу — засчитываем и радуем пригласившего. */
export async function refActivate(env, user, group, notify) {
  if (!user?.id || !group?.id) return;
  const hit = await env.STATS.prepare("SELECT referrer FROM ref_hits WHERE invitee = ? AND active = 0").bind(user.id).first();
  if (!hit) return;
  await env.STATS.prepare("UPDATE ref_hits SET active = 1, active_at = ? WHERE invitee = ?").bind(iso(), user.id).run();
  const w = await window_(env);
  if (!w || now() < w.starts || now() > w.ends) return;
  const count = await countFor(env, hit.referrer, w);
  await notify?.(hit.referrer, `🎉 По вашей ссылке пришёл ${shortName(displayName(user))}! У вас уже ${count} — «${EVENT.title}» продолжается.`).catch(() => {});
}

async function countFor(env, tgId, w) {
  const row = await env.STATS.prepare(
    "SELECT COUNT(*) AS n FROM ref_hits WHERE referrer = ? AND active = 1 AND active_at >= ? AND active_at <= ?"
  )
    .bind(tgId, new Date(w.starts).toISOString(), new Date(w.ends).toISOString())
    .first();
  return row?.n || 0;
}

async function standings(env, w, limit = 10) {
  const { results = [] } = await env.STATS.prepare(
    `SELECT h.referrer AS tg_id, COUNT(*) AS n, MAX(h.active_at) AS last, c.name, c.username
     FROM ref_hits h LEFT JOIN ref_codes c ON c.tg_id = h.referrer
     WHERE h.active = 1 AND h.active_at >= ? AND h.active_at <= ?
     GROUP BY h.referrer ORDER BY n DESC, last ASC LIMIT ?`
  )
    .bind(new Date(w.starts).toISOString(), new Date(w.ends).toISOString(), limit)
    .all();
  return results;
}

/** Мини-приложение: своя ссылка, счёт, место и таблица. */
export async function refApi(env, user) {
  if (!user?.id) return { status: 401, json: { ok: false, error: "unauthorized" } };
  const code = await refCode(env, user);
  const w = await window_(env);
  const base = { ok: true, title: EVENT.title, prize: EVENT.prize, link: `https://t.me/${BOT}?start=r_${code}` };
  if (!w) return { status: 200, json: { ...base, live: false, count: 0, top: [] } };
  const count = await countFor(env, user.id, w);
  const all = await standings(env, w, 500);
  const place = count ? all.findIndex((r) => r.tg_id === user.id) + 1 : 0;
  const top = all.slice(0, 10).map((r, i) => ({ place: i + 1, name: shortName(r.name), count: r.n, me: r.tg_id === user.id }));
  return { status: 200, json: { ...base, live: now() <= w.ends, starts: w.starts, ends: w.ends, count, place, players: all.length, top } };
}

/** 💰🥈🥉 у имени в Подслушке — после итогов. */
let medalCache = { at: 0, value: {} };
export async function refMedals(env) {
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

/** Раз в минуту: по окончании недели — итоги владельцу и медали. */
export async function refTick(env, notifyOwner) {
  const w = await window_(env);
  if (!w || now() <= w.ends || (await setting(env, `${EVENT.id}:final`))) return;
  await putSetting(env, `${EVENT.id}:final`, "1");
  const top = await standings(env, w, 10);
  const medals = {};
  top.slice(0, 3).forEach((r, i) => (medals[r.tg_id] = MEDALS[i]));
  await putSetting(env, `${EVENT.id}:medals`, JSON.stringify(medals));
  medalCache.at = 0;
  await notifyOwner?.(
    [
      `🏁 <b>${EVENT.title}</b> — итоги. Победителю: ${EVENT.prize}.`,
      "",
      ...top.map((r, i) => `${MEDALS[i] || `${i + 1}.`} ${r.name || "?"}${r.username ? ` @${r.username}` : ""} (id ${r.tg_id}) — ${r.n}`),
      "",
      top.length ? `Тема «Магнат» призёрам: ${top.slice(0, 3).map((r) => `<code>/theme ${r.username ? `@${r.username}` : r.tg_id} магнат</code>`).join(" ")}` : "Никто не привёл ни одного друга.",
    ].join("\n")
  ).catch(() => {});
}

/** /ref — сводка; /ref start — запустить неделю; /ref stop — остановить. */
export async function refCommand(env, text) {
  const arg = text.trim().split(/\s+/)[1] || "";
  if (arg === "start") {
    await putSetting(env, `${EVENT.id}:starts`, String(now()));
    await env.STATS.prepare("DELETE FROM forum_settings WHERE key IN (?, ?)").bind(`${EVENT.id}:final`, `${EVENT.id}:medals`).run();
    const ends = new Date(now() + EVENT.days * 86400000);
    return `💰 «${EVENT.title}» запущена до ${ends.toLocaleString("ru-RU", { timeZone: "Europe/Moscow", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" })} (МСК). Ссылки — в приложении, в баннере.`;
  }
  if (arg === "stop") {
    await env.STATS.prepare("DELETE FROM forum_settings WHERE key = ?").bind(`${EVENT.id}:starts`).run();
    return "Конкурс остановлен, баннер в приложении скрыт.";
  }
  const w = await window_(env);
  if (!w) return `«${EVENT.title}» не запущена. Запуск на 7 дней: <code>/ref start</code>`;
  const top = await standings(env, w, 15);
  const total = await env.STATS.prepare("SELECT COUNT(*) AS n FROM ref_hits WHERE active = 1 AND active_at >= ? AND active_at <= ?")
    .bind(new Date(w.starts).toISOString(), new Date(w.ends).toISOString())
    .first();
  const left = Math.max(0, Math.ceil((w.ends - now()) / 86400000));
  return [
    `💰 <b>${EVENT.title}</b> · ${now() > w.ends ? "завершена" : `осталось ${left} дн.`}`,
    `Всего приведено: ${total?.n || 0}`,
    "",
    ...(top.length ? top.map((r, i) => `${i + 1}. ${r.name || "?"}${r.username ? ` @${r.username}` : ""} — ${r.n}`) : ["Пока никто никого не привёл."]),
  ].join("\n");
}

export const REF_EVENT = EVENT;
