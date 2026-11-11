/**
 * Оплаченная реклама в Подслушке: пост от имени Подслушки, закреплённый на
 * время кампании. Публикуется сам в первую минуту кампании, по окончании
 * открепляется. Плашка в приложении — в docs/app.js (PROMO).
 */

const CAMPAIGN = {
  id: "campus8-2026-11",
  starts: Date.parse("2026-11-11T00:00:00+03:00"),
  ends: Date.parse("2026-11-18T23:59:59+03:00"),
  tag: "📣 Реклама",
  text: [
    "💘 Знакомства для студентов — @campus8bot",
    "",
    "Ищешь друзей в своём вузе, компанию на выходные или кого-то особенного? В @campus8bot анкеты только студентов: смотри, кто учится рядом, ставь лайки и пиши, когда симпатия взаимная.",
    "",
    "Заходи: t.me/campus8bot",
  ].join("\n"),
};

async function setting(env, key) {
  const row = await env.STATS.prepare("SELECT value FROM forum_settings WHERE key = ?").bind(key).first();
  return row ? row.value : null;
}

async function putSetting(env, key, value) {
  await env.STATS.prepare("INSERT INTO forum_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(key, value).run();
}

/** Раз в минуту: опубликовать и закрепить в начале, открепить в конце. */
export async function promoTick(env) {
  const owner = Number(env.OWNER_ID);
  if (!owner || !env.STATS) return;
  const t = Date.now();
  const key = `${CAMPAIGN.id}:post`;
  const posted = await setting(env, key);
  if (!posted && t >= CAMPAIGN.starts && t <= CAMPAIGN.ends) {
    // Сначала занимаем отметку: минутные задачи идут внахлёст.
    await putSetting(env, key, "pending");
    const row = await env.STATS.prepare(
      `INSERT INTO forum_posts (tg_id, name, username, anon, text, created, hidden, held_for, tag, pinned)
       VALUES (?, ?, NULL, 0, ?, ?, 0, '', ?, ?) RETURNING id`
    )
      .bind(owner, "Подслушка", CAMPAIGN.text, new Date().toISOString(), CAMPAIGN.tag, t)
      .first();
    await putSetting(env, key, String(row?.id || ""));
    return;
  }
  if (posted && posted !== "pending" && t > CAMPAIGN.ends && !(await setting(env, `${CAMPAIGN.id}:done`))) {
    await putSetting(env, `${CAMPAIGN.id}:done`, "1");
    await env.STATS.prepare("UPDATE forum_posts SET pinned = 0 WHERE id = ?").bind(Number(posted)).run();
  }
}
