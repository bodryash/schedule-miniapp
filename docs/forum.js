/* Подслушка — общий форум студентов всех вузов.
 *
 * Подключается после app.js и пользуется его общими именами (tg, el, t,
 * haptic, API_URL, els, openTab, tenant). Бот и правила модерации — в
 * worker/src/forum.js: здесь только экран. Анонимность — для других
 * студентов; владелец видит автора, и об этом сказано в правилах. */

const FORUM_URL = `${API_URL}/forum`;
const FORUM_ANON_KEY = "schedule.forumAnon";
const FORUM_TAG_KEY = "schedule.forumTag";
const FORUM_RULES_KEY = "schedule.forumRules";
const FORUM_POST_MAX = 600;
const FORUM_REPLY_MAX = 300;

const forum = {
  box: null,
  feed: null,
  moreButton: null,
  note: null,
  sort: "new",
  posts: [],
  more: false,
  owner: false,
  banned: null,
  loading: false,
  compose: null,
  thread: null,
  menu: null,
};

function forumStore(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Без памяти — настройка живёт до закрытия.
  }
  return null;
}

const forumAnon = () => forumStore(FORUM_ANON_KEY) !== "0";

/** Запрос к серверу. Ошибки несут код и понятную причину от сервера. */
async function forumRequest(action, payload = {}) {
  let res;
  try {
    res = await fetch(`${FORUM_URL}/${action}`, {
      method: "POST",
      body: JSON.stringify({ initData: tg?.initData || "", ...payload }),
    });
  } catch {
    throw Object.assign(new Error("network"), { code: "network" });
  }
  const body = await res.json().catch(() => ({}));
  if ("banned" in body) forum.banned = body.banned || null;
  if (!res.ok || !body.ok) {
    throw Object.assign(new Error(body.error || String(res.status)), { code: body.error || String(res.status), reason: body.reason || "" });
  }
  return body;
}

function forumErrorText(error) {
  switch (error.code) {
    case "blocked":
    case "limit":
    case "slow":
    case "duplicate":
      return error.reason || t("Так нельзя.");
    case "banned":
      return t("Вам закрыт доступ к записям в Подслушке.");
    case "off":
      return t("Подслушка временно закрыта.");
    case "too long":
      return t("Слишком длинно.");
    case "network":
      return t("Нет связи. Попробуйте ещё раз.");
    default:
      return t("Не получилось. Попробуйте ещё раз чуть позже.");
  }
}

function forumWhen(isoString) {
  const diff = Math.max(0, (Date.now() - new Date(isoString).getTime()) / 1000);
  if (diff < 60) return t("только что");
  if (diff < 3600) return t("{n} мин назад", { n: Math.floor(diff / 60) });
  if (diff < 86400) return t("{n} ч назад", { n: Math.floor(diff / 3600) });
  return new Intl.DateTimeFormat(LOCALE, { day: "numeric", month: "short" }).format(new Date(isoString));
}

/* ---------- Каркас экрана ---------- */

function forumBuild() {
  if (forum.box) return;
  const box = el("section", "forum");
  box.id = "forum";
  box.hidden = true;

  const bar = el("header", "bar");
  const title = el("div");
  title.append(el("h1", "", t("Подслушка")), el("div", "group-name", t("Общий форум студентов всех вузов")));
  const close = el("button", "icon", "×");
  close.type = "button";
  close.setAttribute("aria-label", t("Закрыть"));
  close.addEventListener("click", forumClose);
  bar.append(title, close);

  const rules = el("div", "fm-rules");
  rules.hidden = forumStore(FORUM_RULES_KEY) === "1";
  rules.append(
    el("b", "", t("Правила")),
    el("p", "", t("Без мата, оскорблений, ссылок, телефонов и чужих контактов. Первый пост проверяется перед публикацией.")),
    el("p", "", t("Анонимно — для других студентов. Администратор видит автора, чтобы блокировать травлю и спам."))
  );
  const ok = el("button", "ghost fm-rules-ok", t("Понятно"));
  ok.type = "button";
  ok.addEventListener("click", () => {
    forumStore(FORUM_RULES_KEY, "1");
    rules.hidden = true;
  });
  rules.append(ok);

  const sort = el("nav", "chips fm-sort");
  for (const [id, name] of [["new", "Новое"], ["top", "Горячее"]]) {
    const chip = el("button", id === forum.sort ? "chip chip--on" : "chip", t(name));
    chip.type = "button";
    chip.dataset.sort = id;
    chip.addEventListener("click", () => {
      if (forum.sort === id) return;
      haptic("select");
      forum.sort = id;
      for (const c of sort.children) c.classList.toggle("chip--on", c === chip);
      forumLoad(true);
    });
    sort.append(chip);
  }
  const refresh = el("button", "chip fm-refresh", "↻");
  refresh.type = "button";
  refresh.setAttribute("aria-label", t("Обновить"));
  refresh.addEventListener("click", () => {
    haptic("light");
    forumLoad(true);
  });
  sort.append(refresh);

  forum.note = el("p", "fm-note");
  forum.note.hidden = true;
  forum.feed = el("div", "fm-feed");
  forum.moreButton = el("button", "ghost fm-more", t("Показать ещё"));
  forum.moreButton.type = "button";
  forum.moreButton.hidden = true;
  forum.moreButton.addEventListener("click", () => forumLoad(false));

  const fab = el("button", "fm-fab", `＋ ${t("Написать")}`);
  fab.type = "button";
  fab.addEventListener("click", forumOpenCompose);
  forum.fab = fab;

  box.append(bar, rules, sort, forum.note, forum.feed, forum.moreButton, fab);
  document.body.append(box);
  forum.box = box;
}

function forumNote(text) {
  forum.note.textContent = text || "";
  forum.note.hidden = !text;
}

function showForum() {
  if (!tg?.initData) return;
  forumBuild();
  for (const node of [els.schedule, els.search, els.picker, els.free, els.week, els.queues, document.getElementById("deadlines")]) {
    if (node) node.hidden = true;
  }
  forum.box.hidden = false;
  forumNote("");
  window.scrollTo(0, 0);
  forumLoad(true);
}

function forumClose() {
  haptic("light");
  forum.box.hidden = true;
  openTab("schedule");
}

/* ---------- Лента ---------- */

async function forumLoad(reset) {
  if (forum.loading) return;
  forum.loading = true;
  if (reset) {
    forum.posts = [];
    forum.feed.replaceChildren(el("div", "fm-empty", t("Загружаем…")));
    forum.moreButton.hidden = true;
  }
  try {
    const before = !reset && forum.sort === "new" ? forum.posts.filter((p) => !p.pending).at(-1)?.id : 0;
    const body = await forumRequest("list", { sort: forum.sort, before });
    forum.owner = Boolean(body.owner);
    forum.more = Boolean(body.more);
    forum.posts = reset ? body.posts : [...forum.posts, ...body.posts];
    forumRender();
  } catch (error) {
    if (reset) forum.feed.replaceChildren(el("div", "fm-empty", forumErrorText(error)));
    else forumNote(forumErrorText(error));
  } finally {
    forum.loading = false;
  }
}

function forumRender() {
  forum.feed.replaceChildren(
    ...(forum.posts.length
      ? forum.posts.map(forumPostNode)
      : [el("div", "fm-empty", t("Пока тихо. Напишите первым — например, спросите про сессию или общежитие."))])
  );
  forum.moreButton.hidden = !forum.more;
  forum.fab.hidden = Boolean(forum.banned);
  forumNote(forum.banned ? t("Вам закрыт доступ к записям в Подслушке: читать можно.") : "");
}

function forumAuthorNode(item) {
  const line = el("div", "fm-owner");
  const a = item.author;
  line.textContent = `🔎 ${a.name}${a.username ? ` @${a.username}` : ""} · id ${a.id}${item.hidden ? ` · ${["", "скрыт жалобами", "удалён", "ждёт проверки"][item.hidden] || ""}` : ""}`;
  return line;
}

function forumPostNode(post) {
  const card = el("article", `fm-post${post.pending ? " fm-post--pending" : ""}`);
  const head = el("div", "fm-head");
  head.append(el("span", "fm-ava", post.emoji), el("b", "fm-name", post.name));
  if (post.tag) head.append(el("span", "fm-tag", post.tag));
  head.append(el("span", "fm-when", forumWhen(post.created)));
  if (post.pending) head.append(el("span", "fm-pending", t("⏳ на проверке")));
  card.append(head);
  if (post.author) card.append(forumAuthorNode(post));
  card.append(el("p", "fm-text", post.text));

  const foot = el("div", "fm-foot");
  const like = el("button", `fm-btn${post.liked ? " fm-btn--on" : ""}`, `${post.liked ? "♥" : "♡"} ${post.likes || ""}`.trim());
  like.type = "button";
  like.setAttribute("aria-label", t("Нравится"));
  like.disabled = post.pending;
  like.addEventListener("click", async (event) => {
    event.stopPropagation();
    haptic("light");
    // Сразу меняем вид, сервер подтвердит.
    post.liked = !post.liked;
    post.likes = Math.max(0, post.likes + (post.liked ? 1 : -1));
    like.className = `fm-btn${post.liked ? " fm-btn--on" : ""}`;
    like.textContent = `${post.liked ? "♥" : "♡"} ${post.likes || ""}`.trim();
    try {
      const body = await forumRequest("like", { post: post.id });
      post.liked = body.liked;
      post.likes = body.likes;
    } catch (error) {
      post.liked = !post.liked;
      post.likes = Math.max(0, post.likes + (post.liked ? 1 : -1));
      forumNote(forumErrorText(error));
    }
    like.className = `fm-btn${post.liked ? " fm-btn--on" : ""}`;
    like.textContent = `${post.liked ? "♥" : "♡"} ${post.likes || ""}`.trim();
  });
  const talk = el("button", "fm-btn", `💬 ${post.replies || ""}`.trim());
  talk.type = "button";
  talk.disabled = post.pending;
  talk.addEventListener("click", () => forumOpenThread(post));
  const more = el("button", "fm-btn fm-btn--more", "⋯");
  more.type = "button";
  more.setAttribute("aria-label", t("Ещё"));
  more.addEventListener("click", (event) => {
    event.stopPropagation();
    forumOpenMenu("p", post);
  });
  foot.append(like, talk, more);
  card.append(foot);
  card.addEventListener("click", (event) => {
    if (event.target.closest("button") || post.pending || card.classList.contains("fm-post--open")) return;
    forumOpenThread(post);
  });
  return card;
}

/* ---------- Окна снизу ---------- */

/** Окно снизу с общей механикой (свайп вниз, замок страницы) — как у остальных. */
function forumSheet(className, input = true) {
  const backdrop = el("div", input ? "sheet-backdrop sheet-backdrop--input" : "sheet-backdrop");
  backdrop.hidden = true;
  const sheet = el("div", `sheet ${className}`);
  sheet.setAttribute("role", "dialog");
  sheet.setAttribute("aria-modal", "true");
  backdrop.append(sheet);
  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop) backdrop.hidden = true;
  });
  document.body.append(backdrop);
  return { backdrop, sheet };
}

function forumSwitch(label, on, onChange) {
  const row = el("div", "fm-switch");
  row.append(el("span", "", label));
  const sw = el("button", "mode-switch");
  sw.type = "button";
  sw.setAttribute("role", "switch");
  sw.setAttribute("aria-checked", String(on));
  sw.append(el("i"));
  const flip = () => {
    haptic("select");
    const next = sw.getAttribute("aria-checked") !== "true";
    sw.setAttribute("aria-checked", String(next));
    onChange(next);
  };
  row.addEventListener("click", (event) => {
    event.preventDefault();
    flip();
  });
  row.append(sw);
  return row;
}

function forumOpenCompose() {
  if (forum.banned) return;
  if (!forum.compose) {
    const { backdrop, sheet } = forumSheet("sheet--forum");
    const top = el("div", "sheet-top");
    top.append(el("h2", "", t("Новый пост")));
    const close = el("button", "icon", "×");
    close.type = "button";
    close.addEventListener("click", () => (backdrop.hidden = true));
    top.append(close);
    const area = el("textarea", "fm-area");
    area.maxLength = FORUM_POST_MAX;
    area.rows = 5;
    area.placeholder = t("Что у вас на уме? Вопрос, история, совет…");
    const counter = el("div", "fm-counter", String(FORUM_POST_MAX));
    area.addEventListener("input", () => (counter.textContent = String(FORUM_POST_MAX - area.value.length)));
    const tag = tenant()?.short || tenant()?.faculty || "";
    const tagLabel = [tenant()?.university, tenant()?.short].filter(Boolean).join(" · ") || tag;
    let anon = forumAnon();
    let withTag = forumStore(FORUM_TAG_KEY) === "1";
    const anonRow = forumSwitch(t("Анонимно"), anon, (v) => {
      anon = v;
      forumStore(FORUM_ANON_KEY, v ? "1" : "0");
      hint.textContent = v ? t("Подпишемся как «Аноним …». Администратор видит автора.") : t("Покажем ваше имя из Telegram.");
    });
    const tagRow = tagLabel ? forumSwitch(`${t("Подписать вуз")}: ${tagLabel}`, withTag, (v) => {
      withTag = v;
      forumStore(FORUM_TAG_KEY, v ? "1" : "0");
    }) : null;
    const hint = el("p", "fm-hint", anon ? t("Подпишемся как «Аноним …». Администратор видит автора.") : t("Покажем ваше имя из Telegram."));
    const error = el("p", "error");
    error.hidden = true;
    const send = el("button", "primary", t("Опубликовать"));
    send.type = "button";
    send.addEventListener("click", async () => {
      const text = area.value.trim();
      if (text.length < 3) {
        error.textContent = t("Напишите хотя бы пару слов.");
        error.hidden = false;
        return;
      }
      send.disabled = true;
      error.hidden = true;
      try {
        const body = await forumRequest("post", { text, anon, tag: withTag ? tagLabel : "" });
        haptic("success");
        area.value = "";
        counter.textContent = String(FORUM_POST_MAX);
        backdrop.hidden = true;
        forumLoad(true).then(() => {
          if (body.pending) forumNote(t("Пост отправлен на проверку и появится после одобрения."));
        });
      } catch (err) {
        haptic("error");
        error.textContent = forumErrorText(err);
        error.hidden = false;
      } finally {
        send.disabled = false;
      }
    });
    sheet.append(top, area, counter, anonRow, ...(tagRow ? [tagRow] : []), hint, error, send);
    forum.compose = { backdrop, area, error };
  }
  forum.compose.error.hidden = true;
  forum.compose.backdrop.hidden = false;
  setTimeout(() => forum.compose.area.focus(), 250);
}

/* ---------- Тема: пост и ответы ---------- */

async function forumOpenThread(post) {
  if (!forum.thread) {
    const { backdrop, sheet } = forumSheet("sheet--forum sheet--thread", false);
    forum.thread = { backdrop, sheet, id: 0 };
  }
  const { backdrop, sheet } = forum.thread;
  forum.thread.id = post.id;
  sheet.replaceChildren(el("div", "fm-empty", t("Загружаем…")));
  backdrop.hidden = false;
  await forumRenderThread(post.id);
}

async function forumRenderThread(id) {
  const { sheet, backdrop } = forum.thread;
  let body;
  try {
    body = await forumRequest("replies", { post: id });
  } catch (error) {
    sheet.replaceChildren(el("div", "fm-empty", forumErrorText(error)));
    return;
  }
  if (forum.thread.id !== id) return;
  const post = body.post;

  const top = el("div", "sheet-top");
  top.append(el("h2", "", t("Обсуждение")));
  const close = el("button", "icon", "×");
  close.type = "button";
  close.addEventListener("click", () => (backdrop.hidden = true));
  top.append(close);

  const head = forumPostNode({ ...post, pending: false });
  head.classList.add("fm-post--open");
  const list = el("div", "fm-replies");
  if (!body.replies.length) list.append(el("div", "fm-empty", t("Ответов пока нет.")));
  for (const reply of body.replies) {
    const row = el("div", `fm-reply${reply.pending ? " fm-post--pending" : ""}`);
    const rh = el("div", "fm-head");
    rh.append(el("span", "fm-ava", reply.emoji), el("b", "fm-name", reply.name));
    if (reply.op) rh.append(el("span", "fm-op", t("автор")));
    rh.append(el("span", "fm-when", forumWhen(reply.created)));
    if (reply.pending) rh.append(el("span", "fm-pending", t("⏳ на проверке")));
    row.append(rh);
    if (reply.author) row.append(forumAuthorNode(reply));
    row.append(el("p", "fm-text", reply.text));
    const more = el("button", "fm-btn fm-btn--more", "⋯");
    more.type = "button";
    more.addEventListener("click", () => forumOpenMenu("r", reply, id));
    row.append(more);
    list.append(row);
  }

  let box = null;
  if (!forum.banned) {
    let anon = forumAnon();
    const area = el("textarea", "fm-area fm-area--reply");
    area.rows = 2;
    area.maxLength = FORUM_REPLY_MAX;
    area.placeholder = t("Ответить…");
    const row = el("div", "fm-compose");
    const mask = el("button", `fm-mask${anon ? " fm-mask--on" : ""}`, anon ? "🕶" : "🎓");
    mask.type = "button";
    mask.setAttribute("aria-label", t("Анонимно"));
    mask.addEventListener("click", () => {
      anon = !anon;
      forumStore(FORUM_ANON_KEY, anon ? "1" : "0");
      mask.textContent = anon ? "🕶" : "🎓";
      mask.classList.toggle("fm-mask--on", anon);
      status.textContent = anon ? t("Ответ будет анонимным") : t("Ответ под вашим именем");
      haptic("select");
    });
    const send = el("button", "primary fm-send", "➤");
    send.type = "button";
    const status = el("p", "fm-hint", anon ? t("Ответ будет анонимным") : t("Ответ под вашим именем"));
    send.addEventListener("click", async () => {
      const text = area.value.trim();
      if (!text) return;
      send.disabled = true;
      try {
        const res = await forumRequest("reply", { post: id, text, anon });
        haptic("success");
        area.value = "";
        await forumRenderThread(id);
        if (res.pending) status.textContent = t("Ответ отправлен на проверку.");
        const original = forum.posts.find((p) => p.id === id);
        if (original && !res.pending) original.replies += 1;
        forumRender();
      } catch (err) {
        haptic("error");
        status.textContent = forumErrorText(err);
      } finally {
        send.disabled = false;
      }
    });
    row.append(mask, area, send);
    box = el("div", "fm-reply-box");
    box.append(row, status);
  }

  // Поле ответа — сразу под постом, ответы ниже: так не нужно листать за ним.
  sheet.replaceChildren(top, head, ...(box ? [box] : []), list);
}

/* ---------- Меню «⋯»: пожаловаться, удалить ---------- */

function forumOpenMenu(kind, item, postId) {
  if (!forum.menu) {
    const { backdrop, sheet } = forumSheet("sheet--forum-menu", false);
    forum.menu = { backdrop, sheet };
  }
  const { backdrop, sheet } = forum.menu;
  const status = el("p", "fm-hint");
  const done = (text) => {
    forumNote(text);
    backdrop.hidden = true;
  };
  const buttons = [];
  if (!item.mine) {
    const report = el("button", "secondary", `🚩 ${t("Пожаловаться")}`);
    report.type = "button";
    report.addEventListener("click", async () => {
      try {
        await forumRequest("report", { kind, id: item.id });
        haptic("success");
        done(t("Спасибо, жалоба отправлена."));
      } catch (error) {
        status.textContent = forumErrorText(error);
      }
    });
    buttons.push(report);
  }
  if (item.canDelete) {
    const remove = el("button", "secondary fm-danger", `🗑 ${t("Удалить")}`);
    remove.type = "button";
    remove.addEventListener("click", async () => {
      try {
        await forumRequest("delete", { kind, id: item.id });
        haptic("success");
        backdrop.hidden = true;
        if (kind === "p" && forum.thread?.id === item.id) forum.thread.backdrop.hidden = true;
        if (kind === "r" && postId) await forumRenderThread(postId);
        await forumLoad(true);
      } catch (error) {
        status.textContent = forumErrorText(error);
      }
    });
    buttons.push(remove);
  }
  const cancel = el("button", "ghost", t("Отмена"));
  cancel.type = "button";
  cancel.addEventListener("click", () => (backdrop.hidden = true));
  sheet.replaceChildren(...buttons, status, cancel);
  backdrop.hidden = false;
}

// Вне Telegram (обычный браузер) подписать запрос нечем — раздел не показываем.
if (!tg?.initData) document.querySelector('[data-menu="forum"]')?.remove();
