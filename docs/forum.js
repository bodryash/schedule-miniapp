/* Подслушка — общий форум студентов всех вузов.
 *
 * Загружается только когда форум открывают (см. openForum в app.js), вместе
 * с forum.css. Пользуется общими именами приложения: tg, el, t, haptic,
 * API_URL, LOCALE, tenant. Серверная часть и правила модерации —
 * worker/src/forum.js.
 *
 * Как устроено движение (чтобы ничего не рвалось):
 *  - только transform и opacity; перестановки в ленте — FLIP;
 *  - страницы (лента → обсуждение) двигаются как в нативных приложениях, их
 *    можно отпустить свайпом от левого края;
 *  - всё, что пользователь трогает, отвечает сразу (лайк, ответ), а сервер
 *    подтверждает потом; ошибка откатывает и объясняет.
 */
(() => {
  "use strict";

  const FORUM_URL = `${API_URL}/forum`;
  const KEY = {
    anon: "schedule.forumAnon",
    tag: "schedule.forumTag",
    rules: "schedule.forumRules",
    draft: "schedule.forumDraft",
  };
  const POST_MAX = 600;
  const REPLY_MAX = 300;
  const EASE = "cubic-bezier(0.32, 0.72, 0, 1)";
  const REDUCED = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const POLL_MS = 25000;

  /* ---------- Иконки ---------- */

  const ICON = {
    back: '<path d="M15 5l-7 7 7 7"/>',
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
    heart: '<path d="M12 20.4s-7.4-4.5-7.4-10.1A4.3 4.3 0 0 1 12 7.5a4.3 4.3 0 0 1 7.4 2.8c0 5.6-7.4 10.1-7.4 10.1z"/>',
    share: '<path d="M12 15V4M7.5 8.3L12 3.8l4.5 4.5M5 12.5v5.3A1.7 1.7 0 0 0 6.7 19.5h10.6a1.7 1.7 0 0 0 1.7-1.7v-5.3"/>',
    arrowUp: '<path d="M12 19.5V5M5.8 11.2L12 5l6.2 6.2"/>',
    arrowDown: '<path d="M12 4.5V19M5.8 12.8L12 19l6.2-6.2"/>',
    comment: '<path d="M5.5 5h13a2 2 0 0 1 2 2v8.2a2 2 0 0 1-2 2H13l-4.2 3.3v-3.3H5.5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z"/>',
    reply: '<path d="M9.5 6.5L4 12l5.5 5.5M4.5 12H14a5.5 5.5 0 0 1 5.5 5.5V19"/>',
    more: '<circle cx="5.5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="18.5" cy="12" r="1.5"/>',
    flag: '<path d="M6 21V4.2M6 5h11.2l-2.4 4 2.4 4H6"/>',
    trash: '<path d="M4.5 7h15M9.5 7V4.8h5V7M6.7 7l.9 12.2h8.8L17.3 7M10 11v5.2M14 11v5.2"/>',
    send: '<path d="M12 19V5.5M6.2 11.3L12 5.5l5.8 5.8"/>',
    mask: '<path d="M3.5 11h17M6.2 11l1.4-5.4a1 1 0 0 1 1-.8h6.8a1 1 0 0 1 1 .8l1.4 5.4"/><circle cx="8.2" cy="16" r="2.7"/><circle cx="15.8" cy="16" r="2.7"/><path d="M10.9 15.6h2.2"/>',
    person: '<circle cx="12" cy="8.3" r="3.6"/><path d="M5 20c.9-3.9 3.7-6 7-6s6.1 2.1 7 6"/>',
    pen: '<path d="M4 20l.9-4L16.3 4.6a2 2 0 0 1 2.8 2.8L7.7 18.8z"/><path d="M14.3 6.6l3 3"/>',
    refresh: '<path d="M19.5 11.5a7.5 7.5 0 1 0-2.2 5.7M19.5 5.5v6h-6"/>',
    verified: '<path d="M22.65 12.00 L22.50 12.69 L22.09 13.33 L21.51 13.89 L20.91 14.39 L20.41 14.85 L20.08 15.35 L19.96 15.93 L19.99 16.61 L20.07 17.39 L20.07 18.19 L19.91 18.94 L19.53 19.53 L18.94 19.91 L18.19 20.07 L17.39 20.07 L16.61 19.99 L15.93 19.96 L15.35 20.08 L14.85 20.41 L14.39 20.91 L13.89 21.51 L13.33 22.09 L12.69 22.50 L12.00 22.65 L11.31 22.50 L10.67 22.09 L10.11 21.51 L9.61 20.91 L9.15 20.41 L8.65 20.08 L8.07 19.96 L7.39 19.99 L6.61 20.07 L5.81 20.07 L5.06 19.91 L4.47 19.53 L4.09 18.94 L3.93 18.19 L3.93 17.39 L4.01 16.61 L4.04 15.93 L3.92 15.35 L3.59 14.85 L3.09 14.39 L2.49 13.89 L1.91 13.33 L1.50 12.69 L1.35 12.00 L1.50 11.31 L1.91 10.67 L2.49 10.11 L3.09 9.61 L3.59 9.15 L3.92 8.65 L4.04 8.07 L4.01 7.39 L3.93 6.61 L3.93 5.81 L4.09 5.06 L4.47 4.47 L5.06 4.09 L5.81 3.93 L6.61 3.93 L7.39 4.01 L8.07 4.04 L8.65 3.92 L9.15 3.59 L9.61 3.09 L10.11 2.49 L10.67 1.91 L11.31 1.50 L12.00 1.35 L12.69 1.50 L13.33 1.91 L13.89 2.49 L14.39 3.09 L14.85 3.59 L15.35 3.92 L15.93 4.04 L16.61 4.01 L17.39 3.93 L18.19 3.93 L18.94 4.09 L19.53 4.47 L19.91 5.06 L20.07 5.81 L20.07 6.61 L19.99 7.39 L19.96 8.07 L20.08 8.65 L20.41 9.15 L20.91 9.61 L21.51 10.11 L22.09 10.67 L22.50 11.31Z" fill="currentColor" stroke="currentColor" stroke-width="0.6" stroke-linejoin="round"/><path d="M8 12.3l2.8 2.8 5.3-5.6" stroke="#fff" stroke-width="2.1" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
    pin: '<path d="M9 3.5h6l-1 5.5 3.5 3.5v1.5h-11V12.5L10 9z"/><path d="M12 14v6.5"/>',
    power: '<path d="M12 3.5v8"/><path d="M7.2 6.6a7.2 7.2 0 1 0 9.6 0"/>',
    shield: '<path d="M12 3.2l7 2.8v5.6c0 4.2-2.9 7.7-7 9.4-4.1-1.7-7-5.2-7-9.4V6z"/><path d="M9 12l2.2 2.2L15.2 10"/>',
    at: '<circle cx="12" cy="12" r="3.6"/><path d="M15.6 12v1.4a2.4 2.4 0 0 0 4.8 0V12a8.4 8.4 0 1 0-3.3 6.7"/>',
    clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
    lock: '<rect x="5" y="10.5" width="14" height="9.5" rx="2.5"/><path d="M8.2 10.5V8a3.8 3.8 0 0 1 7.6 0v2.5"/>',
    up: '<path d="M12 19V5.5M6.2 11.3L12 5.5l5.8 5.8"/>',
    bell: '<path d="M6.2 16.8V11a5.8 5.8 0 0 1 11.6 0v5.8l1.6 2H4.6zM10 21h4"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    alert: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.8v5M12 16.2v.1"/>',
    eye: '<path d="M2.8 12S6 6 12 6s9.2 6 9.2 6-3.2 6-9.2 6S2.8 12 2.8 12z"/><circle cx="12" cy="12" r="2.6"/>',
    building: '<path d="M5 20.5V6.5L12 3.5l7 3v14M3.5 20.5h17M9 10h1.5M13.5 10H15M9 14h1.5M13.5 14H15"/>',
    ban: '<circle cx="12" cy="12" r="8.5"/><path d="M6 6l12 12"/>',
    broom: '<path d="M14.5 4.5l5 5M17 7l-6.5 6.5M10.5 13.5c-3.5 0-5.6 2.2-6.3 6 3.8.4 6.2-1.6 6.3-6zM8.2 16.2l1.6 1.6"/>',
  };

  function icon(name, size) {
    const span = document.createElement("span");
    span.className = "fm-i";
    span.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"${size ? ` width="${size}" height="${size}"` : ""}>${ICON[name] || ""}</svg>`;
    return span;
  }

  /* ---------- Мелочи ---------- */

  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const store = (key, value) => {
    try {
      if (value === undefined) return localStorage.getItem(key);
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch {
      // Без памяти — настройка живёт до закрытия.
    }
    return null;
  };

  function hueOf(text) {
    let h = 7;
    for (const ch of String(text)) h = (h * 31 + ch.codePointAt(0)) % 360;
    return h;
  }

  function ago(iso) {
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 45) return t("сейчас");
    if (s < 3600) return t("{n} мин", { n: Math.max(1, Math.round(s / 60)) });
    if (s < 86400) return t("{n} ч", { n: Math.floor(s / 3600) });
    if (s < 7 * 86400) return t("{n} д", { n: Math.floor(s / 86400) });
    return new Intl.DateTimeFormat(LOCALE, { day: "numeric", month: "short" }).format(new Date(iso));
  }

  function fullTime(iso) {
    return new Intl.DateTimeFormat(LOCALE, { hour: "2-digit", minute: "2-digit", day: "numeric", month: "long" }).format(new Date(iso));
  }

  /** Фото из Telegram: только у постов под своим именем; нет фото — остаётся буква. */
  function addPhoto(a, src, fallback) {
    const img = new Image();
    if (fallback) img.onerror = () => addPhoto(a, fallback);
    img.alt = "";
    img.decoding = "async";
    img.className = "fm-ava-img";
    img.onload = () => {
      a.append(img);
      requestAnimationFrame(() => img.classList.add("is-in"));
    };
    img.src = src;
  }

  function avatar(p, size, kind) {
    const a = document.createElement("span");
    a.className = `fm-ava${size ? ` fm-ava--${size}` : ""}`;
    a.style.setProperty("--h", Number.isFinite(p.hue) ? p.hue : hueOf(p.name || "?"));
    // Системные итоги турнира публикуются от имени владельца, но аватар им нужен фирменный.
    if (p.name === "Подслушка" && p.tag === "🎮 Сессия 2048") {
      a.classList.add("fm-ava--brand");
      a.textContent = ":P";
      return a;
    }
    if (p.emoji) {
      a.classList.add("fm-ava--emoji");
      a.textContent = p.emoji;
    } else {
      a.textContent = ([...String(p.name || "?").trim()][0] || "?").toUpperCase();
      // Свой пост под своим именем — фото сразу из Telegram, без запроса к серверу.
      const own = p.mine && p.ava ? tg?.initDataUnsafe?.user?.photo_url || S.meAva || "" : "";
      const server = p.ava && Number.isInteger(p.id) && p.id > 0 ? `${FORUM_URL}/ava/${kind || "p"}/${p.id}` : "";
      if (p.photo) addPhoto(a, p.photo);
      else if (own) addPhoto(a, own, server);
      else if (server) addPhoto(a, server);
    }
    return a;
  }

  /** Открыть профиль человека в Telegram (только у тех, кто пишет под своим именем). */
  function openProfile(nick) {
    haptic("light");
    const url = `https://t.me/${encodeURIComponent(nick)}`;
    if (tg?.openTelegramLink) tg.openTelegramLink(url);
    else window.open(url, "_blank", "noopener");
  }

  /** Имя и аватар ведут в Telegram, если человек пишет под своим именем и у него есть @ник. */
  function linkify(item, ...nodes) {
    if (!item.tg) return;
    for (const node of nodes) {
      node.dataset.tg = item.tg;
      node.classList.add("fm-tg");
    }
  }

  function animate(node, frames, options) {
    if (REDUCED || !node.animate) return null;
    return node.animate(frames, { easing: EASE, ...options });
  }

  const fmtScore = (n) => (n < 0 ? `\u2212${Math.abs(n)}` : String(n));
  const parseScore = (text) => Number(String(text).replace("\u2212", "-")) || 0;

  /**
   * Число с «прокруткой»: старое уезжает, новое въезжает. С `signed` показывает
   * и ноль, и минус (рейтинг), без него ноль — пусто (счётчик ответов).
   */
  function setNum(node, n, animated, signed = false) {
    const text = signed ? fmtScore(n) : n > 0 ? String(n) : "";
    const cur = node.firstElementChild;
    if (!cur) {
      const first = document.createElement("span");
      first.textContent = text;
      node.append(first);
      return;
    }
    if (cur.textContent === text) return;
    const prev = parseScore(cur.textContent);
    if (!animated || REDUCED || !node.animate) {
      cur.textContent = text;
      return;
    }
    const up = n >= prev;
    const next = document.createElement("span");
    next.textContent = text;
    if (up) node.append(next);
    else node.prepend(next);
    const from = up ? "translateY(0)" : "translateY(-18px)";
    const to = up ? "translateY(-18px)" : "translateY(0)";
    let done = 0;
    for (const child of [cur, next]) {
      const a = child.animate([{ transform: from }, { transform: to }], { duration: 260, easing: EASE, fill: "forwards" });
      a.onfinish = () => {
        if (++done < 2) return;
        cur.remove();
        for (const c of node.children) c.getAnimations().forEach((x) => x.cancel());
      };
    }
  }

  /**
   * Своя плавная прокрутка: у встроенной `behavior: "smooth"` в разных
   * WebView разная длительность (а в старых её нет вовсе), а нам нужно одно
   * и то же движение везде. Касание пальцем сразу отдаёт прокрутку человеку.
   */
  const scrolling = new WeakMap();
  function smoothScroll(el, to, ms = 420) {
    const target = clamp(to, 0, Math.max(0, el.scrollHeight - el.clientHeight));
    const from = el.scrollTop;
    const dist = target - from;
    scrolling.get(el)?.stop();
    if (REDUCED || Math.abs(dist) < 2) {
      el.scrollTop = target;
      return;
    }
    const dur = clamp(ms + Math.abs(dist) * 0.12, ms, 800);
    const t0 = performance.now();
    let raf = 0;
    const stop = () => {
      cancelAnimationFrame(raf);
      el.removeEventListener("touchstart", stop);
      el.removeEventListener("wheel", stop);
      scrolling.delete(el);
    };
    const step = (now) => {
      const p = clamp((now - t0) / dur, 0, 1);
      el.scrollTop = from + dist * (1 - Math.pow(1 - p, 3));
      if (p < 1) raf = requestAnimationFrame(step);
      else stop();
    };
    el.addEventListener("touchstart", stop, { passive: true });
    el.addEventListener("wheel", stop, { passive: true });
    scrolling.set(el, { stop });
    raf = requestAnimationFrame(step);
  }

  /**
   * FLIP: запоминаем, где стояли строки, меняем список, а потом плавно
   * «доезжаем» каждой строкой с прежнего места. Только transform — никакой
   * анимации высоты.
   */
  function flip(container, mutate, { limit = 40 } = {}) {
    const kids = [...container.children].slice(0, limit);
    const first = new Map(kids.map((k) => [k, k.getBoundingClientRect().top]));
    mutate();
    if (REDUCED) return;
    for (const k of container.children) {
      if (!first.has(k)) continue;
      const dy = first.get(k) - k.getBoundingClientRect().top;
      if (Math.abs(dy) < 1) continue;
      k.animate([{ transform: `translate3d(0, ${dy}px, 0)` }, { transform: "none" }], { duration: 340, easing: EASE });
    }
  }

  /* ---------- Состояние ---------- */

  const S = {
    root: null,
    open: false,
    sort: "new",
    posts: new Map(),
    order: [],
    more: false,
    loading: false,
    token: 0,
    top: 0,
    fresh: 0,
    owner: false,
    review: 0,
    banned: null,
    notify: true,
    poll: 0,
    toastTimer: 0,
    user: tg?.initDataUnsafe?.user || {},
    sheets: {},
    backHandler: null,
  };

  const T = {
    id: 0,
    post: null,
    replies: [],
    me: null,
    replyTo: null,
    open: false,
    token: 0,
    tmp: 0,
    queue: Promise.resolve(),
  };

  /* ---------- Сервер ---------- */

  async function request(action, payload = {}, { retry = false } = {}) {
    let lastError;
    for (let attempt = 0; attempt < (retry ? 2 : 1); attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      try {
        const res = await fetch(`${FORUM_URL}/${action}`, {
          method: "POST",
          body: JSON.stringify({ initData: tg?.initData || "", ...payload }),
          signal: controller.signal,
        });
        const body = await res.json().catch(() => ({}));
        if ("banned" in body) setBanned(body.banned || null);
        if (!res.ok || !body.ok) {
          throw Object.assign(new Error(body.error || String(res.status)), { code: body.error || String(res.status), reason: body.reason || "", status: res.status, note: body.message || "" });
        }
        return body;
      } catch (error) {
        lastError = error.code ? error : Object.assign(new Error("network"), { code: "network" });
        if (lastError.code !== "network") break;
        if (attempt + 1 < (retry ? 2 : 1)) await sleep(600);
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError;
  }

  function errorText(error) {
    switch (error.code) {
      case "blocked":
      case "limit":
      case "slow":
      case "duplicate":
        return error.reason || t("Так нельзя.");
      case "banned":
        return t("Вам закрыт доступ к записям.");
      case "off":
        return error.note ? `🛠 ${error.note}` : t("Подслушка временно закрыта.");
      case "closed":
        return t("Подслушка пока в закрытом тестировании.");
      case "too long":
        return t("Слишком длинно.");
      case "parent gone":
        return t("Этот ответ уже удалили.");
      case "network":
        return t("Нет связи. Попробуйте ещё раз.");
      default:
        return t("Не получилось. Попробуйте чуть позже.");
    }
  }

  // Ошибки, из-за которых ответ не повторяют, а возвращают человеку на правку.
  const isRejected = (error) => ["blocked", "limit", "slow", "duplicate", "banned", "too long", "parent gone", "off", "closed"].includes(error.code);

  // Те же простые проверки, что на сервере: ссылку, @ и телефон видно сразу,
  // не дожидаясь ответа.
  const LINK = /(https?:\/\/|www\.|t\.me|tg:\/\/|telegram\.me|vk\.com|\.(ru|com|org|net|рф|io|me|su|xyz|info|ly)(\/|\s|$))/i;
  const MENTION = /(^|[\s(])@[a-z0-9_]{3,}/i;
  const EMAIL = /[a-z0-9._%+-]+\s*@\s*[a-z0-9.-]+\s*\.\s*[a-z]{2,}/i;
  function precheck(text) {
    if (EMAIL.test(text) || MENTION.test(text)) return t("@-упоминания и почту нельзя: чужие контакты не публикуем.");
    if (LINK.test(text)) return t("Ссылки нельзя.");
    if ((text.match(/\+?\d[\d\s().-]{8,}\d/g) || []).some((run) => run.replace(/\D/g, "").length >= 10)) return t("Телефоны нельзя.");
    return "";
  }

  function setBanned(ban) {
    S.banned = ban;
    if (!S.root) return;
    S.root.classList.toggle("is-banned", Boolean(ban));
    renderLock();
  }

  /* ---------- Подсказки и мелкие окна ---------- */

  function toast(text, { tone = "ok", icon: name = "check", ms = 2800 } = {}) {
    if (!S.root) return;
    let box = S.root.querySelector(".fm-toast");
    if (!box) {
      box = document.createElement("div");
      box.className = "fm-toast";
      box.setAttribute("role", "status");
      S.root.append(box);
    }
    box.className = `fm-toast fm-toast--${tone}`;
    box.replaceChildren(icon(name), Object.assign(document.createElement("span"), { textContent: text }));
    void box.offsetWidth;
    box.classList.add("is-on");
    clearTimeout(S.toastTimer);
    S.toastTimer = setTimeout(() => box.classList.remove("is-on"), ms);
  }

  function makeSheet(cls, { input = false } = {}) {
    const backdrop = document.createElement("div");
    backdrop.className = `sheet-backdrop${input ? " sheet-backdrop--input" : ""}`;
    backdrop.hidden = true;
    const sh = document.createElement("div");
    sh.className = `sheet sheet--fm ${cls}`;
    sh.setAttribute("role", "dialog");
    sh.setAttribute("aria-modal", "true");
    backdrop.append(sh);
    const close = () => {
      backdrop.hidden = true;
    };
    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop) close();
    });
    document.body.append(backdrop);
    return { backdrop, sh, open: () => (backdrop.hidden = false), close, get isOpen() { return !backdrop.hidden; } };
  }

  /** Содержимое окна: ручку для свайпа, которую поставило приложение, оставляем. */
  function fill(sh, ...nodes) {
    const grab = sh.querySelector(":scope > .sheet-grab");
    sh.replaceChildren(...(grab ? [grab] : []), ...nodes);
  }

  /** Подмена содержимого окна с плавным изменением высоты и появлением. */
  function swap(sheet, build) {
    const sh = sheet.sh;
    const from = sh.offsetHeight;
    build();
    const to = sh.offsetHeight;
    if (REDUCED || !sh.animate) return;
    if (from && from !== to) sh.animate([{ height: `${from}px` }, { height: `${to}px` }], { duration: 280, easing: EASE });
    for (const child of sh.children) {
      if (child.classList.contains("sheet-grab")) continue;
      child.animate([{ opacity: 0, transform: "translate3d(0, 10px, 0)" }, { opacity: 1, transform: "none" }], { duration: 260, easing: EASE });
    }
  }

  /* ---------- Каркас ---------- */

  function build() {
    if (S.root) return;
    // Не <section>: у него в общих стилях своя анимация появления, и она
    // перебивала бы наш слайд (страница выскакивала бы без движения).
    const root = document.createElement("div");
    root.className = "fm";
    root.id = "forum";
    root.hidden = true;
    root.setAttribute("role", "region");
    root.setAttribute("aria-label", t("Подслушка"));

    // Жесты внутри форума не должны листать дни расписания под ним.
    for (const type of ["pointerdown", "touchstart"]) root.addEventListener(type, (e) => e.stopPropagation());

    /* лента */
    const feedPage = document.createElement("div");
    feedPage.className = "fm-page fm-page--feed";
    const nav = document.createElement("header");
    nav.className = "fm-nav";
    const back = navButton("back", t("Назад"), closeForum);
    const title = document.createElement("h1");
    title.className = "fm-nav-title";
    title.append(document.createTextNode(t("Подслушка")));
    const sub = document.createElement("small");
    sub.textContent = t("студенты всех вузов");
    title.append(sub);
    const info = navButton("shield", t("Правила"), () => openRules(false));
    // Своё звание — чипом в шапке, а не блоком над лентой: лента начинается сразу.
    const meChip = document.createElement("button");
    meChip.type = "button";
    meChip.className = "fm-me-chip";
    meChip.hidden = true;
    meChip.addEventListener("click", () => openMe());
    S.meChip = meChip;
    nav.append(back, title, meChip, info);

    const scroll = document.createElement("div");
    scroll.className = "fm-scroll";
    const wrap = document.createElement("div");
    wrap.className = "fm-wrap";

    const ptr = document.createElement("div");
    ptr.className = "fm-ptr";
    ptr.append(icon("refresh"));

    const segwrap = document.createElement("div");
    segwrap.className = "fm-segwrap";
    const seg = document.createElement("div");
    seg.className = "fm-seg";
    seg.setAttribute("role", "tablist");
    segwrap.append(seg);

    const lock = document.createElement("div");
    lock.className = "fm-lock";
    lock.hidden = true;

    const prompt = document.createElement("button");
    prompt.type = "button";
    prompt.className = "fm-prompt";
    prompt.addEventListener("click", () => openComposer());

    const feed = document.createElement("div");
    feed.className = "fm-feed";

    const tail = document.createElement("div");
    tail.className = "fm-tail";

    const gameBanner = document.createElement("button");
    gameBanner.type = "button";
    gameBanner.className = "fm-game";
    gameBanner.hidden = true;
    gameBanner.addEventListener("click", async () => {
      haptic("medium");
      // Сначала игра выезжает поверх Подслушки, потом Подслушка тихо уходит
      // под ней — расписание между ними не мелькает.
      await Promise.resolve(window.openGame?.()).catch(() => {});
      closeForum({ instant: true, under: true });
    });
    // «Задание дня» и свой уровень — карточкой над лентой.
    const chal = document.createElement("section");
    chal.className = "fm-chal";
    chal.hidden = true;
    wrap.append(segwrap, lock, gameBanner, chal, prompt, feed, tail);
    // Компьютер — как соцсеть: слева навигация и «Написать», справа колонка
    // с заданием дня и правилами. На телефоне этих блоков нет (скрыты стилями).
    const write = document.createElement("button");
    write.type = "button";
    write.className = "fm-side-write";
    write.append(icon("pen"), document.createTextNode(t("Написать пост")));
    write.addEventListener("click", () => openComposer());
    const brand = document.createElement("div");
    brand.className = "fm-side-brand";
    brand.innerHTML = `<b>${t("Подслушка")}</b><span>${t("студенты всех вузов")}</span>`;
    segwrap.prepend(brand);
    segwrap.append(write);
    const side = document.createElement("aside");
    side.className = "fm-side";
    const rules = document.createElement("section");
    rules.className = "fm-side-card";
    rules.innerHTML = `<h3>${t("Правила")}</h3><ul><li>${t("Без мата и травли")}</li><li>${t("Без ссылок и чужих контактов")}</li><li>${t("Анонимно — значит анонимно: автора не видят студенты")}</li></ul>`;
    side.append(chal, rules);
    wrap.insertBefore(side, prompt);
    scroll.append(ptr, wrap);

    const fab = document.createElement("button");
    fab.type = "button";
    fab.className = "fm-fab";
    fab.setAttribute("aria-label", t("Написать"));
    fab.append(icon("pen"));
    fab.addEventListener("click", () => openComposer());

    const fresh = document.createElement("button");
    fresh.type = "button";
    fresh.className = "fm-new";
    fresh.addEventListener("click", () => refresh({ toTop: true }));

    feedPage.append(nav, scroll, fab, fresh);

    /* обсуждение */
    const dim = document.createElement("div");
    dim.className = "fm-dim";
    const threadPage = document.createElement("div");
    threadPage.className = "fm-page fm-page--thread";
    threadPage.innerHTML = "";
    const tnav = document.createElement("header");
    tnav.className = "fm-nav";
    const tback = navButton("back", t("Назад"), closeThread);
    const ttitle = document.createElement("h1");
    ttitle.className = "fm-nav-title";
    ttitle.textContent = t("Обсуждение");
    tnav.append(tback, ttitle);
    const tscroll = document.createElement("div");
    tscroll.className = "fm-scroll";
    const twrap = document.createElement("div");
    twrap.className = "fm-wrap fm-thread";
    tscroll.append(twrap);

    const bar = document.createElement("div");
    bar.className = "fm-bar";
    const replying = document.createElement("div");
    replying.className = "fm-replying";
    const barIn = document.createElement("div");
    barIn.className = "fm-bar-in";
    const mask = document.createElement("button");
    mask.type = "button";
    mask.className = "fm-mask";
    mask.append(Object.assign(icon("mask"), { className: "fm-i fm-i--a" }), Object.assign(icon("person"), { className: "fm-i fm-i--b" }));
    const field = document.createElement("div");
    field.className = "fm-field";
    const area = document.createElement("textarea");
    area.rows = 1;
    area.maxLength = REPLY_MAX + 40;
    area.setAttribute("enterkeyhint", "send");
    field.append(area);
    const send = document.createElement("button");
    send.type = "button";
    send.className = "fm-send";
    send.setAttribute("aria-label", t("Отправить"));
    send.append(icon("send"));
    barIn.append(mask, field, send);
    const hint = document.createElement("div");
    hint.className = "fm-bar-hint";
    bar.append(replying, barIn, hint);

    threadPage.append(tnav, tscroll, bar);

    root.append(feedPage, dim, threadPage);
    document.body.append(root);

    Object.assign(S, { feedPage, nav, scroll, wrap, ptr, seg, segwrap, lock, prompt, feed, tail, fab, pill: fresh, gameBanner, chal });
    Object.assign(T, { page: threadPage, dim, nav: tnav, scroll: tscroll, wrap: twrap, bar, replying, mask, area, send, hint });
    S.root = root;

    buildSeg();
    renderPrompt();
    wireFeed();
    wireThread();
    wireScroll();
    wirePullToRefresh();
    wireEdgeSwipe(feedPage, { onPop: closeForum, under: null, isOpen: () => S.open && !T.open });
    wireEdgeSwipe(threadPage, { onPop: closeThread, under: feedPage, dim, isOpen: () => T.open, thread: true });
    trackKeyboard();
    document.addEventListener("visibilitychange", () => {
      if (S.open && !document.hidden) pollNow();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && S.open && !document.querySelector(".sheet-backdrop:not([hidden])")) back();
    });
  }

  function navButton(name, label, onClick) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "fm-nav-btn";
    b.setAttribute("aria-label", label);
    b.append(icon(name));
    b.addEventListener("click", () => {
      haptic("light");
      onClick();
    });
    return b;
  }

  /* ---------- Открытие и закрытие ---------- */

  async function showForum(opts = {}) {
    if (!tg?.initData) return;
    build();
    if (S.open) {
      if (opts.thread) openThread({ id: opts.thread }, { mark: opts.reply || "post" });
      return;
    }
    S.open = true;
    document.body.classList.add("fm-open");
    S.root.hidden = false;
    S.origin = opts.origin || originOf(document.getElementById("forum-btn"));
    // instant — появиться сразу, без анимации: так Подслушка встаёт под
    // уезжающей игрой, и расписание между ними не мелькает.
    // Закрываться Подслушка должна одинаково красиво, как бы её ни открыли:
    // iris остаётся, при instant пропускаем только анимацию открытия.
    S.iris = !REDUCED && Boolean(S.root.animate);
    S.root.classList.toggle("is-iris", S.iris || Boolean(opts.instant));
    if (opts.instant) S.root.style.transition = "none";
    void S.root.offsetWidth;
    S.root.classList.add("is-open");
    if (opts.instant) requestAnimationFrame(() => (S.root.style.transition = ""));
    if (S.iris && !opts.instant) {
      const { x, y } = S.origin;
      S.irisAnim?.cancel();
      S.irisAnim = S.root.animate(
        [{ clipPath: `circle(0px at ${x}px ${y}px)` }, { clipPath: `circle(${Math.hypot(innerWidth, innerHeight) + 40}px at ${x}px ${y}px)` }],
        { duration: 620, easing: "cubic-bezier(0.55, 0, 0.1, 1)" }
      );
      S.irisAnim.onfinish = () => S.irisAnim?.cancel();
    }
    if (!opts.instant) choreograph();
    else reveal();
    tg?.disableVerticalSwipes?.();
    attachBackButton();
    startPolling();
    if (!S.order.length) {
      showSkeleton();
      load(true, { first: true });
    } else {
      load(true, { silent: true });
    }
    if (store(KEY.rules) !== "1") setTimeout(() => openRules(true), 700);
    if (opts.thread) setTimeout(() => openThread({ id: opts.thread }, { mark: opts.reply || "post" }), 450);
  }

  /** Центр кнопки, из которой «раскрывается» режим; без неё — правый верхний угол. */
  function originOf(node) {
    const r = node?.getBoundingClientRect?.();
    if (r && r.width) return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    return { x: innerWidth - 40, y: 44 };
  }

  /**
   * Подслушка под уезжающей игрой: содержимое мягко поднимается по очереди
   * (шапка, переключатель, плашка, строка поста, первые посты), пока игра
   * уходит вниз.
   */
  function reveal() {
    if (REDUCED) return;
    const parts = [
      S.root.querySelector(".fm-nav"),
      S.segwrap,
      S.gameBanner && !S.gameBanner.hidden ? S.gameBanner : null,
      S.chal && !S.chal.hidden ? S.chal : null,
      S.prompt,
      ...[...S.feed.children].slice(0, 6),
    ].filter(Boolean);
    parts.forEach((node, i) => {
      animate(node, [{ opacity: 0, transform: "translate3d(0, 22px, 0) scale(0.985)" }, { opacity: 1, transform: "none" }], { duration: 480, delay: 90 + i * 45, fill: "backwards" });
    });
  }

  /** Открытие по очереди: заголовок, переключатель, лента (она сама), кнопка «+». */
  function choreograph() {
    if (REDUCED) return;
    const step = (node, from, delay, ms = 460) =>
      node && animate(node, [{ opacity: 0, transform: from }, { opacity: 1, transform: "none" }], { duration: ms, delay, easing: EASE, fill: "backwards" });
    step(S.root.querySelector(".fm-nav-title"), "translate3d(0, 10px, 0)", 260);
    step(S.root.querySelector(".fm-segwrap"), "translate3d(0, 12px, 0)", 340);
    const fab = S.root.querySelector(".fm-fab");
    if (fab) animate(fab, [{ opacity: 0, transform: "scale(0.4) rotate(-40deg)" }, { opacity: 1, transform: "scale(1) rotate(0)" }], { duration: 560, delay: 700, easing: "cubic-bezier(0.34, 1.5, 0.5, 1)", fill: "backwards" });
  }

  /** under — уходим в другой полноэкранный режим (игру): кнопку «назад» и
   *  запрет системного свайпа не трогаем, они нужны уже ему. */
  function closeForum({ instant = false, under = false } = {}) {
    if (!S.open) return;
    S.open = false;
    document.body.classList.remove("fm-open");
    if (T.open) closeThread({ instant: true });
    stopPolling();
    if (S.iris && !instant && S.root.animate) {
      // Режим «схлопывается» обратно в кнопку.
      const { x, y } = S.origin;
      S.irisAnim?.cancel();
      detachBackButton();
      tg?.enableVerticalSwipes?.();
      const a = S.root.animate(
        [{ clipPath: `circle(${Math.hypot(innerWidth, innerHeight) + 40}px at ${x}px ${y}px)` }, { clipPath: `circle(0px at ${x}px ${y}px)` }],
        { duration: 460, easing: "cubic-bezier(0.55, 0, 0.1, 1)", fill: "forwards" }
      );
      const end = () => {
        if (S.open) return;
        S.root.classList.remove("is-open");
        S.root.hidden = true;
        a.cancel();
      };
      a.onfinish = end;
      setTimeout(end, 700);
      return;
    }
    if (instant) {
      S.root.style.transition = "none";
      requestAnimationFrame(() => (S.root.style.transition = ""));
    }
    S.root.classList.remove("is-open");
    if (under) {
      if (tg?.BackButton && S.backHandler) tg.BackButton.offClick(S.backHandler);
      S.backHandler = null;
    } else {
      detachBackButton();
      tg?.enableVerticalSwipes?.();
    }
    const done = () => {
      if (!S.open) S.root.hidden = true;
    };
    if (REDUCED || instant) done();
    else S.root.addEventListener("transitionend", function once(e) {
      if (e.target !== S.root) return;
      S.root.removeEventListener("transitionend", once);
      done();
    });
    setTimeout(done, 520);
  }

  function back() {
    if (T.open) closeThread();
    else closeForum();
  }

  function attachBackButton() {
    if (!tg?.BackButton) return;
    S.backHandler = () => back();
    tg.BackButton.onClick(S.backHandler);
    tg.BackButton.show();
  }

  function detachBackButton() {
    if (!tg?.BackButton || !S.backHandler) return;
    tg.BackButton.offClick(S.backHandler);
    tg.BackButton.hide();
    S.backHandler = null;
  }

  /* ---------- Переключатель ---------- */

  function buildSeg() {
    const items = [["new", t("Новое")], ["top", t("Горячее")]];
    if (S.owner) items.push(["review", t("Проверка")]);
    S.seg.style.setProperty("--n", items.length);
    S.seg.replaceChildren(
      Object.assign(document.createElement("span"), { className: "fm-seg-thumb" }),
      ...items.map(([id, name]) => {
        const b = document.createElement("button");
        b.type = "button";
        b.dataset.sort = id;
        b.setAttribute("role", "tab");
        b.append(document.createTextNode(name));
        if (id === "review") {
          const badge = document.createElement("i");
          badge.hidden = !S.review;
          badge.textContent = String(S.review);
          b.append(badge);
        }
        b.addEventListener("click", () => setSort(id));
        return b;
      })
    );
    syncSeg();
  }

  function syncSeg() {
    const buttons = [...S.seg.querySelectorAll("button")];
    const index = Math.max(0, buttons.findIndex((b) => b.dataset.sort === S.sort));
    S.seg.style.setProperty("--i", index);
    buttons.forEach((b) => b.setAttribute("aria-selected", String(b.dataset.sort === S.sort)));
    const badge = S.seg.querySelector('[data-sort="review"] i');
    if (badge) {
      badge.hidden = !S.review;
      badge.textContent = String(S.review);
    }
  }

  function setSort(id) {
    if (S.sort === id) return;
    haptic("select");
    S.sort = id;
    syncSeg();
    S.scroll.scrollTo({ top: Math.min(S.scroll.scrollTop, segTop()), behavior: "auto" });
    showSkeleton();
    load(true);
  }

  const segTop = () => S.segwrap.offsetTop;

  /** Плашка турнира «Сессия 2048» над лентой — пока он идёт. */
  function renderGameBanner() {
    const box = S.gameBanner;
    if (!box) return;
    const g = S.gameInfo;
    box.hidden = !(g && (g.on || g.preview));
    clearInterval(S.gameTimer);
    if (box.hidden) return;
    box.replaceChildren(
      Object.assign(document.createElement("span"), { className: "fm-game-ico", textContent: "🎮" }),
      Object.assign(document.createElement("span"), { className: "fm-game-text" }),
      Object.assign(document.createElement("span"), { className: "fm-game-go", textContent: t("Играть") })
    );
    const text = box.querySelector(".fm-game-text");
    const clock = document.createElement("span");
    clock.className = "fm-game-clock";
    text.append(
      Object.assign(document.createElement("b"), { textContent: t("Сессия 2048 — турнир вузов") }),
      clock,
      Object.assign(document.createElement("small"), {
        textContent: g.on ? t("Без потолка · рекорд — в счёт факультета") : t("Видно только вам · запуск: /g2048 start"),
      })
    );
    // Живой отсчёт до конца турнира: дни, часы, минуты, секунды.
    const two = (n) => String(n).padStart(2, "0");
    const tick = () => {
      const left = Math.max(0, g.ends - Date.now());
      if (!left) {
        clock.textContent = t("Турнир закончился");
        clearInterval(S.gameTimer);
        return;
      }
      const d = Math.floor(left / 86400000);
      const h = Math.floor((left % 86400000) / 3600000);
      const m = Math.floor((left % 3600000) / 60000);
      const sec = Math.floor((left % 60000) / 1000);
      clock.replaceChildren(
        document.createTextNode(t("До конца") + " "),
        Object.assign(document.createElement("b"), { textContent: d ? `${d} ${t("д")} ${two(h)}:${two(m)}:${two(sec)}` : `${two(h)}:${two(m)}:${two(sec)}` })
      );
    };
    tick();
    S.gameTimer = setInterval(() => {
      if (S.open && !document.hidden) tick();
    }, 1000);
  }

  /** «Задание дня» и свой уровень: что написать сегодня и сколько до следующего уровня. */
  function renderChallenge() {
    const box = S.chal;
    if (!box) return;
    const c = S.challenge;
    const me = S.me;
    if (S.meChip) {
      S.meChip.hidden = !me;
      if (me) {
        S.meChip.replaceChildren(
          Object.assign(document.createElement("span"), { className: "fm-me-ico", textContent: me.icon }),
          Object.assign(document.createElement("b"), { textContent: String(me.karma) })
        );
        S.meChip.setAttribute("aria-label", t("Вы — {name} · {k} кармы", { name: me.name, k: me.karma }));
      }
    }
    box.hidden = !c;
    if (!c) return;
    // Одна строка: вопрос слева, «Ответить» справа. Подробности — в окне звания.
    const copy = document.createElement("div");
    copy.className = "fm-chal-copy";
    copy.append(
      Object.assign(document.createElement("span"), { className: "fm-chal-kicker", textContent: `${t("Задание дня")} · ${c.answers ? t("ответов: {n}", { n: c.answers }) : t("будь первым")}` }),
      Object.assign(document.createElement("p"), { className: "fm-chal-text", textContent: c.text })
    );
    const go = Object.assign(document.createElement("button"), { type: "button", className: "fm-chal-go", textContent: t("Ответить") });
    go.addEventListener("click", () => openComposer({ challenge: c }));
    box.replaceChildren(copy, go);
  }

  /** Окно «моё звание»: карма, полоса до следующего звания и пороги. */
  function openMe() {
    const me = S.me;
    if (!me) return;
    haptic("light");
    const sheet = (S.sheets.me ||= makeSheet("sheet--fm-me"));
    const wrapper = document.createElement("div");
    wrapper.className = "fm-sheet-in fm-me";
    const bar = document.createElement("span");
    bar.className = "fm-lvl-bar";
    const fillBar = document.createElement("i");
    const span = me.next ? me.next.need + me.karma : 1;
    fillBar.style.width = `${me.next ? Math.max(4, Math.round((me.karma / span) * 100)) : 100}%`;
    bar.append(fillBar);
    wrapper.append(
      Object.assign(document.createElement("div"), { className: "fm-me-big", textContent: me.icon }),
      Object.assign(document.createElement("h2"), { textContent: me.name }),
      Object.assign(document.createElement("p"), { className: "fm-sheet-sub", textContent: me.next ? t("{k} кармы · ещё {need} — и вы {icon} {next}", { k: me.karma, icon: me.next.icon, next: me.next.name, need: me.next.need }) : t("{k} кармы", { k: me.karma }) }),
      bar
    );
    const list = document.createElement("ul");
    list.className = "fm-me-ranks";
    for (const [icon, name, need] of [
      ["🌱", "Новичок", 0],
      ["💬", "Голос", 20],
      ["🔥", "Звезда", 80],
      ["💎", "Знаток", 200],
      ["👑", "Легенда", 500],
    ]) {
      const item = document.createElement("li");
      if (t(name) === me.name || name === me.name) item.className = "is-me";
      item.append(
        Object.assign(document.createElement("span"), { textContent: `${icon} ${t(name)}` }),
        Object.assign(document.createElement("b"), { textContent: need ? t("{n} кармы", { n: need }) : t("старт") })
      );
      list.append(item);
    }
    wrapper.append(
      list,
      Object.assign(document.createElement("p"), { className: "fm-me-note", textContent: t("Карма начисляется за посты, ответы и лайки. Лучший ответ на задание дня в 21:00 получает «🔥 Ответ дня» и +25 кармы.") })
    );
    const ok = Object.assign(document.createElement("button"), { type: "button", className: "primary", textContent: t("Понятно") });
    ok.addEventListener("click", () => sheet.close());
    wrapper.append(ok);
    fill(sheet.sh, wrapper);
    sheet.open();
  }

  /** Значок уровня у имени (только под своим именем — это решает сервер). */
  function levelNode(item) {
    if (!item.level) return null;
    return Object.assign(document.createElement("span"), { className: "fm-level", title: item.level.name, textContent: item.level.icon });
  }

  /** Текст черновика, если он есть: его показываем прямо в строке «Что у вас на уме?». */
  function draftText() {
    try {
      return String(JSON.parse(store(KEY.draft) || "{}").text || "").trim();
    } catch {
      return "";
    }
  }

  function renderPrompt() {
    const name = S.user.first_name || "";
    const me = avatar({ name: name || "?", hue: hueOf(String(S.user.id || name)), photo: tg?.initDataUnsafe?.user?.photo_url || S.meAva });
    const field = document.createElement("span");
    field.className = "fm-prompt-field";
    const draft = draftText();
    S.prompt.classList.toggle("has-draft", Boolean(draft));
    if (draft) {
      const label = Object.assign(document.createElement("b"), { className: "fm-draft-label", textContent: t("У вас есть неопубликованный черновик") });
      const quote = Object.assign(document.createElement("span"), { className: "fm-draft-text", textContent: draft.replace(/\s+/g, " ") });
      field.append(label, quote);
    } else field.textContent = t("Что у вас на уме?");
    const pen = document.createElement("span");
    pen.className = "fm-prompt-pen";
    pen.append(icon("pen"));
    S.prompt.replaceChildren(me, field, pen);
  }

  function renderLock() {
    if (!S.lock) return;
    const ban = S.banned;
    S.lock.hidden = !ban;
    S.prompt.hidden = Boolean(ban);
    if (!ban) return;
    const until = ban.until
      ? t("Запись закрыта до {date}. Читать можно.", { date: new Intl.DateTimeFormat(LOCALE, { day: "numeric", month: "long" }).format(new Date(ban.until)) })
      : t("Запись закрыта. Читать можно.");
    S.lock.replaceChildren(icon("lock"), Object.assign(document.createElement("span"), { textContent: until }));
  }

  /* ---------- Загрузка ленты ---------- */

  function showSkeleton() {
    const rows = [];
    for (let i = 0; i < 5; i++) {
      const s = document.createElement("div");
      s.className = "fm-skel";
      s.innerHTML = "<i></i><div><b></b><u></u><u></u><u></u></div>";
      rows.push(s);
    }
    S.feed.replaceChildren(...rows);
    S.tail.replaceChildren();
  }

  async function load(reset, { first = false, silent = false } = {}) {
    if (S.loading && !reset) return;
    const token = ++S.token;
    S.loading = true;
    const before = !reset && S.sort === "new" ? [...S.order].reverse().find((id) => !S.posts.get(id).pending) || 0 : 0;
    if (!reset) S.tail.replaceChildren(loaderNode());
    try {
      const body = await request("list", { sort: S.sort, before }, { retry: true });
      if (token !== S.token) return;
      S.owner = Boolean(body.owner);
      S.role = body.role || null;
      S.gameInfo = body.game || null;
      renderGameBanner();
      S.challenge = body.challenge || null;
      S.me = body.me || null;
      renderChallenge();
      if (body.meAva && !S.meAva) {
        S.meAva = `${API_URL}${body.meAva}`;
        renderPrompt();
      }
      S.review = body.review || 0;
      S.top = Math.max(S.top, body.top || 0);
      S.more = Boolean(body.more);
      if (S.owner && !S.seg.querySelector('[data-sort="review"]')) buildSeg();
      if (S.owner && !S.root.querySelector(".fm-nav-btn--admin")) {
        const admin = navButton("power", t("Управление"), openAdmin);
        admin.classList.add("fm-nav-btn--admin");
        S.root.querySelector(".fm-nav").append(admin);
      }
      syncSeg();
      setBanned(body.banned || null);
      const known = new Set(S.order);
      if (reset) {
        S.posts.clear();
        S.order = [];
      }
      const fresh = [];
      for (const post of body.posts) {
        if (S.posts.has(post.id)) continue;
        S.posts.set(post.id, post);
        S.order.push(post.id);
        fresh.push(post);
      }
      if (reset) {
        showFresh(0);
        renderFeed({ stagger: !silent, only: silent ? known : null });
      } else {
        S.feed.append(...fresh.map(rowNode));
        measureClamps();
      }
      renderTail();
      if (first && !body.posts.length) renderFeed({ stagger: false });
    } catch (error) {
      if (token !== S.token) return;
      if (reset) renderError(error);
      else {
        S.tail.replaceChildren();
        toast(errorText(error), { tone: "bad", icon: "alert" });
      }
    } finally {
      if (token === S.token) S.loading = false;
    }
  }

  async function refresh({ toTop = false } = {}) {
    haptic("light");
    showFresh(0);
    if (toTop) smoothScroll(S.scroll, 0);
    await load(true, { silent: true });
  }

  function renderFeed({ stagger = true, only = null } = {}) {
    const posts = S.order.map((id) => S.posts.get(id));
    if (!posts.length) {
      S.feed.replaceChildren(emptyState());
      return;
    }
    const rows = posts.map(rowNode);
    S.feed.replaceChildren(...rows);
    if (stagger) {
      rows.slice(0, 7).forEach((row, i) => {
        animate(row, [{ opacity: 0, transform: "translate3d(0, 16px, 0)" }, { opacity: 1, transform: "none" }], { duration: 440, delay: i * 45, fill: "backwards" });
      });
    } else if (only) {
      // Обновили на месте: въезжают только по-настоящему новые.
      rows.filter((row) => !only.has(Number(row.dataset.id))).slice(0, 5).forEach((row, i) => {
        animate(row, [{ opacity: 0, transform: "translate3d(0, -12px, 0)" }, { opacity: 1, transform: "none" }], { duration: 420, delay: i * 50, fill: "backwards" });
      });
    }
    measureClamps();
  }

  function renderTail() {
    if (S.sort !== "new" || !S.order.length) {
      S.tail.replaceChildren();
      return;
    }
    if (S.more) {
      const sentinel = document.createElement("div");
      sentinel.className = "fm-sentinel";
      sentinel.style.height = "1px";
      S.tail.replaceChildren(sentinel);
      observeSentinel(sentinel);
    } else {
      const end = document.createElement("div");
      end.className = "fm-end";
      end.textContent = t("Это всё. Напишите что-нибудь — станет живее.");
      S.tail.replaceChildren(end);
    }
  }

  let observer = null;
  function observeSentinel(node) {
    observer?.disconnect();
    if (!("IntersectionObserver" in window)) return;
    observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting) && S.more && !S.loading) load(false);
      },
      { root: S.scroll, rootMargin: "0px 0px 700px 0px" }
    );
    observer.observe(node);
  }

  function loaderNode() {
    const box = document.createElement("div");
    box.className = "fm-loader";
    box.innerHTML = "<i></i><i></i><i></i>";
    return box;
  }

  /* ---------- Пустые и ошибочные состояния ---------- */

  const ART = {
    quiet: '<svg class="fm-art" viewBox="0 0 132 108" aria-hidden="true"><defs><linearGradient id="fa1" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="var(--accent)" stop-opacity=".95"/><stop offset="1" stop-color="var(--accent)" stop-opacity=".55"/></linearGradient></defs><rect x="14" y="14" width="74" height="52" rx="18" fill="url(#fa1)"/><path d="M34 66l-6 16 20-16z" fill="var(--accent)" fill-opacity=".8"/><rect x="50" y="42" width="68" height="46" rx="16" fill="var(--text)" fill-opacity=".1"/><path d="M104 88l8 14-20-14z" fill="var(--text)" fill-opacity=".1"/><circle cx="36" cy="40" r="4" fill="#fff"/><circle cx="52" cy="40" r="4" fill="#fff" fill-opacity=".8"/><circle cx="68" cy="40" r="4" fill="#fff" fill-opacity=".6"/></svg>',
    done: '<svg class="fm-art fm-art--done" viewBox="0 0 132 108" aria-hidden="true"><defs><linearGradient id="fmDoneG" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#5ee08a"/><stop offset="1" stop-color="#1fa653"/></linearGradient><radialGradient id="fmDoneH" cx=".35" cy=".25" r=".7"><stop offset="0" stop-color="#fff" stop-opacity=".55"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient></defs><ellipse cx="66" cy="97" rx="26" ry="4.5" fill="#1fa653" fill-opacity=".18"/><g class="fm-done-badge"><circle cx="66" cy="52" r="36" fill="url(#fmDoneG)"/><circle cx="66" cy="52" r="36" fill="url(#fmDoneH)"/><circle cx="66" cy="52" r="35" fill="none" stroke="#fff" stroke-opacity=".25" stroke-width="2"/><path class="fm-done-tick" d="M49.5 53.5l11.5 11.5 21.5-24" fill="none" stroke="#fff" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/></g></svg>',
    off: '<svg class="fm-art" viewBox="0 0 132 108" aria-hidden="true"><circle cx="66" cy="54" r="40" fill="var(--text)" fill-opacity=".07"/><rect x="48" y="50" width="36" height="28" rx="8" fill="var(--text)" fill-opacity=".25"/><path d="M54 50v-8a12 12 0 0 1 24 0v8" fill="none" stroke="var(--text)" stroke-opacity=".25" stroke-width="6" stroke-linecap="round"/></svg>',
    lost: '<svg class="fm-art" viewBox="0 0 132 108" aria-hidden="true"><circle cx="66" cy="54" r="40" fill="var(--fm-danger)" fill-opacity=".1"/><path d="M66 34v26M66 74v.1" stroke="var(--fm-danger)" stroke-width="7" stroke-linecap="round"/></svg>',
  };

  function state({ art, title, text, action }) {
    const box = document.createElement("div");
    box.className = "fm-state";
    box.innerHTML = ART[art] || "";
    box.append(Object.assign(document.createElement("h3"), { textContent: title }), Object.assign(document.createElement("p"), { textContent: text }));
    if (action) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "fm-btn";
      b.textContent = action.label;
      b.addEventListener("click", action.run);
      box.append(b);
    }
    return box;
  }

  function emptyState() {
    if (S.sort === "review") {
      return state({ art: "done", title: t("Очередь пуста"), text: t("Всё проверено. Новые посты на проверке появятся здесь.") });
    }
    return state({
      art: "quiet",
      title: t("Здесь пока тихо"),
      text: t("Начните разговор: вопрос про преподавателя, поиск конспектов или история из общаги."),
      action: S.banned ? null : { label: t("Написать"), run: () => openComposer() },
    });
  }

  function renderError(error) {
    if (error.code === "closed") {
      S.feed.replaceChildren(state({ art: "off", title: t("Закрытое тестирование"), text: t("Подслушку пока проверяют свои. Скоро откроем для всех.") }));
      S.prompt.hidden = true;
      return;
    }
    if (error.code === "off") {
      S.feed.replaceChildren(state({ art: "off", title: t("Подслушка на паузе"), text: t("Администратор ненадолго закрыл форум. Загляните позже.") }));
      S.prompt.hidden = true;
      return;
    }
    S.feed.replaceChildren(
      state({ art: "lost", title: t("Не получилось загрузить"), text: errorText(error), action: { label: t("Повторить"), run: () => { showSkeleton(); load(true); } } })
    );
  }

  /* ---------- Строки ленты ---------- */

  /** Стрелки вверх/вниз с рейтингом посередине. */
  function voteControl(item, label) {
    const box = document.createElement("span");
    box.className = "fm-vote";
    box.setAttribute("role", "group");
    box.setAttribute("aria-label", label || t("Голосование"));
    const make = (dir, name, aria) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = `fm-v fm-v--${dir > 0 ? "up" : "down"}`;
      b.setAttribute("aria-label", aria);
      const holder = document.createElement("span");
      holder.className = "fm-i-wrap";
      holder.style.cssText = "position:relative;display:inline-flex";
      holder.append(icon(name));
      b.append(holder);
      return b;
    };
    const num = document.createElement("span");
    num.className = "fm-num";
    setNum(num, item.score || 0, false, true);
    box.append(make(1, "arrowUp", t("За")), num, make(-1, "arrowDown", t("Против")));
    paintVote(box, item, false);
    return box;
  }

  function paintVote(box, item, animated) {
    box.classList.toggle("is-up", item.vote === 1);
    box.classList.toggle("is-down", item.vote === -1);
    box.querySelector(".fm-v--up").setAttribute("aria-pressed", String(item.vote === 1));
    box.querySelector(".fm-v--down").setAttribute("aria-pressed", String(item.vote === -1));
    setNum(box.querySelector(".fm-num"), item.score || 0, animated, true);
  }

  function numButton(kind, count, label) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `fm-act fm-act--${kind}`;
    b.setAttribute("aria-label", label);
    const holder = document.createElement("span");
    holder.className = "fm-i-wrap";
    holder.style.cssText = "position:relative;display:inline-flex";
    holder.append(icon(kind === "like" ? "heart" : "comment"));
    const num = document.createElement("span");
    num.className = "fm-num";
    setNum(num, count, false);
    b.append(holder, num);
    return b;
  }

  /** Галочка владельца рядом с именем. */
  function badgeOf(item) {
    if (!item.verified) return null;
    const b = document.createElement("span");
    b.className = "fm-verified";
    b.title = t("Администратор Подслушки");
    b.setAttribute("aria-label", t("Администратор"));
    b.append(icon("verified"));
    return b;
  }

  function rowNode(post) {
    const row = document.createElement("article");
    row.className = `fm-row${post.pending ? " is-pending" : ""}`;
    row.dataset.id = post.id;

    const main = document.createElement("div");
    main.className = "fm-main";
    const meta = document.createElement("header");
    meta.className = "fm-meta";
    const name = document.createElement("span");
    name.className = "fm-name";
    name.textContent = post.name;
    meta.append(name);
    if (post.tg) meta.append(Object.assign(document.createElement("span"), { className: "fm-nick fm-nick--row fm-tg", textContent: `@${post.tg}` }));
    // Галочка — справа от @ника (если его нет — от имени).
    const check = badgeOf(post);
    if (check) meta.append(check);
    if (post.medal) meta.append(Object.assign(document.createElement("span"), { className: "fm-medal", title: t("Призёр «Сессии 2048»"), textContent: post.medal }));
    const lvl = levelNode(post);
    if (lvl) meta.append(lvl);
    if (post.best || post.challenge) {
      const chip = Object.assign(document.createElement("span"), { className: `fm-chal-chip${post.best ? " is-best" : ""}`, textContent: post.best ? t("🔥 Ответ дня") : t("🎯 Задание дня") });
      main.prepend(chip);
    }
    if (post.pinned) {
      row.classList.add("is-pinned");
      const badge = document.createElement("span");
      badge.className = "fm-pin";
      badge.append(icon("pin"), document.createTextNode(t("Закреплено")));
      // Отдельной строкой над именем: в строке с именем ему не хватало места.
      main.prepend(badge);
    }
    if (post.tag) meta.append(Object.assign(document.createElement("span"), { className: "fm-tag", textContent: post.tag }));
    const time = document.createElement("time");
    time.className = "fm-time";
    time.dateTime = post.created;
    time.textContent = ago(post.created);
    meta.append(time);
    if (post.edited) meta.append(Object.assign(document.createElement("span"), { className: "fm-edited", textContent: t("изменено") }));
    const dots = document.createElement("button");
    dots.type = "button";
    dots.className = "fm-dots";
    dots.setAttribute("aria-label", t("Ещё"));
    dots.append(icon("more"));
    meta.append(dots);
    main.append(meta);

    if (post.pending) main.append(badge("clock", t("На проверке — появится после одобрения")));
    if (post.hidden === 1) main.append(badge("alert", t("Скрыт жалобами"), true));
    if (post.author) main.append(ownerLine(post));

    const text = document.createElement("p");
    text.className = "fm-text is-clamped";
    // В ленте — без пустых строк: иначе «…» от обрезки повисает отдельной строкой.
    text.textContent = post.text.replace(/\n{2,}/g, "\n");
    main.append(text);

    const acts = document.createElement("footer");
    acts.className = "fm-acts";
    const votes = voteControl(post);
    votes.querySelectorAll("button").forEach((b) => (b.disabled = Boolean(post.pending)));
    const talk = numButton("reply", post.replies, t("Ответы"));
    talk.disabled = Boolean(post.pending);
    acts.append(votes, talk);
    main.append(acts);

    if (S.owner && (post.hidden === 3 || post.hidden === 1)) main.append(modBar("p", post));

    const ava = avatar(post);
    linkify(post, name, ava, meta.querySelector(".fm-nick") || ava);
    row.append(ava, main);
    return row;
  }

  function badge(name, text, bad) {
    const b = document.createElement("div");
    b.className = `fm-badge${bad ? " fm-badge--bad" : ""}`;
    b.append(icon(name), Object.assign(document.createElement("span"), { textContent: text }));
    return b;
  }

  function ownerLine(item) {
    const a = item.author;
    const line = document.createElement("div");
    line.className = "fm-owner";
    const bold = Object.assign(document.createElement("b"), { textContent: a.name });
    line.append(bold, document.createTextNode(`${a.username ? ` @${a.username}` : ""} · id ${a.id}${item.held ? ` · ${item.held}` : ""}`));
    return line;
  }

  function modBar(kind, item) {
    const bar = document.createElement("div");
    bar.className = "fm-modbar";
    const make = (label, op, cls) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = `fm-pill ${cls || ""}`;
      b.textContent = label;
      b.addEventListener("click", async (event) => {
        event.stopPropagation();
        bar.querySelectorAll("button").forEach((x) => (x.disabled = true));
        try {
          const res = await request("mod", { kind, id: item.id, op });
          haptic("success");
          toast(res.text, { icon: "check" });
          // В очереди проверки решённое уходит из списка; в общей ленте опубликованное остаётся.
          if (op === "ok" && S.sort !== "review") {
            item.hidden = 0;
            item.pending = false;
            replaceRow(item);
          } else {
            removeRow(item.id);
          }
          S.review = Math.max(0, S.review - 1);
          syncSeg();
        } catch (error) {
          bar.querySelectorAll("button").forEach((x) => (x.disabled = false));
          toast(errorText(error), { tone: "bad", icon: "alert" });
        }
      });
      return b;
    };
    bar.append(make(t("Опубликовать"), "ok", "fm-pill--ok"), make(t("Удалить"), "del"), make(t("Бан 7 дней"), "ban", "fm-pill--bad"));
    return bar;
  }

  function measureClamps() {
    requestAnimationFrame(() => {
      for (const text of S.feed.querySelectorAll(".fm-text.is-clamped")) {
        const row = text.closest(".fm-row");
        if (!row || row.querySelector(".fm-readmore")) continue;
        if (text.scrollHeight > text.clientHeight + 2) {
          const more = document.createElement("button");
          more.type = "button";
          more.className = "fm-readmore";
          more.textContent = t("Читать дальше");
          text.after(more);
        } else {
          text.classList.remove("is-clamped");
        }
      }
    });
  }

  function replaceRow(post) {
    const old = S.feed.querySelector(`.fm-row[data-id="${post.id}"]`);
    if (!old) return;
    const next = rowNode(post);
    old.replaceWith(next);
    measureClamps();
  }

  function removeRow(id) {
    const row = S.feed.querySelector(`.fm-row[data-id="${id}"]`);
    S.posts.delete(id);
    S.order = S.order.filter((x) => x !== id);
    if (!row) return;
    const finish = () => {
      flip(S.feed, () => row.remove());
      if (!S.order.length) S.feed.replaceChildren(emptyState());
    };
    const a = animate(row, [{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translate3d(-24px, 0, 0)" }], { duration: 200, fill: "forwards" });
    if (a) a.onfinish = finish;
    else finish();
  }

  function insertRow(post) {
    S.posts.set(post.id, post);
    S.order.unshift(post.id);
    const empty = S.feed.querySelector(".fm-state");
    const row = rowNode(post);
    if (empty) {
      S.feed.replaceChildren(row);
    } else {
      flip(S.feed, () => S.feed.prepend(row));
    }
    animate(row, [{ opacity: 0, transform: "translate3d(0, -14px, 0) scale(0.98)" }, { opacity: 1, transform: "none" }], { duration: 420, fill: "backwards" });
    measureClamps();
  }

  /** Обновляет лайк и счётчики поста везде, где он показан. */
  function refreshPost(post, animated) {
    const row = S.feed?.querySelector(`.fm-row[data-id="${post.id}"]`);
    if (row) {
      paintVote(row.querySelector(".fm-vote"), post, animated);
      setNum(row.querySelector(".fm-act--reply .fm-num"), post.replies || 0, animated);
    }
    if (T.open && T.post?.id === post.id) paintThreadPost(animated);
  }

  /* ---------- События ленты ---------- */

  function wireFeed() {
    const feed = S.feed;
    let pressed = null;
    const release = () => {
      pressed?.classList.remove("is-pressed");
      pressed = null;
    };
    feed.addEventListener("pointerdown", (e) => {
      const row = e.target.closest(".fm-row");
      if (!row || e.target.closest("button")) return;
      pressed = row;
      row.classList.add("is-pressed");
    });
    for (const type of ["pointerup", "pointercancel", "pointerleave", "pointermove"]) {
      feed.addEventListener(type, (e) => {
        if (type === "pointermove" && Math.abs(e.movementY) + Math.abs(e.movementX) < 3) return;
        release();
      });
    }
    S.scroll.addEventListener("scroll", release, { passive: true });

    feed.addEventListener("click", (event) => {
      const row = event.target.closest(".fm-row");
      if (!row) return;
      const post = S.posts.get(Number(row.dataset.id));
      if (!post) return;
      const profile = event.target.closest("[data-tg]");
      if (profile) return openProfile(profile.dataset.tg);
      const arrow = event.target.closest(".fm-v");
      if (arrow) return castVote(post, "p", arrow.classList.contains("fm-v--up") ? 1 : -1, arrow.closest(".fm-vote"));
      if (event.target.closest(".fm-dots")) return openActions("p", post);
      if (event.target.closest(".fm-modbar")) return;
      if (event.target.closest(".fm-act--reply")) return openThread(post, { focus: true });
      if (post.pending) return;
      openThread(post);
    });
  }

  /* ---------- Лайки ---------- */

  /** Стрелка «подпрыгивает» в свою сторону и бросает искры. */
  function pop(btn, dir) {
    const ic = btn.querySelector(".fm-i");
    if (!ic) return;
    const away = dir > 0 ? -1 : 1;
    animate(ic, [
      { transform: "translateY(0) scale(1)" },
      { transform: `translateY(${away * 7}px) scale(1.3)`, offset: 0.34 },
      { transform: `translateY(${-away * 1.5}px) scale(0.94)`, offset: 0.68 },
      { transform: "translateY(0) scale(1)" },
    ], { duration: 460, easing: "ease-out" });
    if (REDUCED) return;
    const holder = btn.querySelector(".fm-i-wrap");
    const color = dir > 0 ? "var(--accent)" : "#5b7cfa";
    for (let i = 0; i < 6; i++) {
      const dot = document.createElement("i");
      dot.className = "fm-burst";
      dot.style.background = color;
      holder.append(dot);
      const spread = ((i - 2.5) / 2.5) * 1.1;
      const a = dot.animate(
        [
          { transform: "translate3d(0,0,0) scale(1)", opacity: 1 },
          { transform: `translate3d(${Math.sin(spread) * 18}px, ${away * (14 + (i % 2) * 6)}px, 0) scale(0.2)`, opacity: 0 },
        ],
        { duration: 460, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)", delay: 50 }
      );
      a.onfinish = () => dot.remove();
    }
  }

  /** Голос за (1) или против (−1); повторное нажатие снимает голос. */
  async function castVote(item, kind, dir, box) {
    if (S.banned) return toast(t("Вам закрыт доступ к записям."), { tone: "warn", icon: "lock" });
    const was = item._was || { score: item.score || 0, vote: item.vote || 0 };
    const cur = item.vote || 0;
    const next = cur === dir ? 0 : dir;
    haptic(next ? "medium" : "light");
    item.vote = next;
    item.score = (item.score || 0) + (next - cur);
    if (next && box) pop(box.querySelector(next === 1 ? ".fm-v--up" : ".fm-v--down"), next);
    paintAll(item, kind, true);
    if (item._syncing) return;
    item._syncing = true;
    item._was = was;
    try {
      for (let i = 0; i < 3; i++) {
        const res = await request("vote", kind === "r" ? { kind: "r", id: item.id, v: item.vote } : { kind: "p", post: item.id, v: item.vote });
        item.score = res.score;
        if (res.v === item.vote) break;
      }
    } catch (error) {
      item.vote = was.vote;
      item.score = was.score;
      toast(errorText(error), { tone: "bad", icon: "alert" });
    } finally {
      item._syncing = false;
      item._was = null;
      paintAll(item, kind, false);
    }
  }

  function paintAll(item, kind, animated) {
    if (kind === "p") refreshPost(item, animated);
    else {
      const node = T.wrap?.querySelector(`.fm-reply[data-id="${item.id}"] .fm-vote`);
      if (node) paintVote(node, item, animated);
    }
  }

  /* ---------- Прокрутка, обновление жестом, опрос ---------- */

  function wireScroll() {
    let frame = 0;
    S.scroll.addEventListener(
      "scroll",
      () => {
        if (frame) return;
        frame = requestAnimationFrame(() => {
          frame = 0;
          const y = S.scroll.scrollTop;
          S.nav.classList.toggle("is-scrolled", y > 4);
          S.fab.classList.toggle("is-on", y > 280 && !S.banned);
        });
      },
      { passive: true }
    );
    T.scroll.addEventListener(
      "scroll",
      () => T.nav.classList.toggle("is-scrolled", T.scroll.scrollTop > 4),
      { passive: true }
    );
  }

  function showFresh(count) {
    S.freshCount = count;
    if (count) S.pill.replaceChildren(icon("up"), document.createTextNode(count === 1 ? t("Новый пост") : t("{n} новых", { n: count })));
    S.pill.classList.toggle("is-on", count > 0);
  }

  async function pollNow() {
    if (!S.open || document.hidden) return;
    // Аварийный выключатель: закрыли на ремонт — выходим из режима.
    const flag = await window.forumKill?.();
    if (flag?.off && S.open) {
      closeForum();
      window.forumKillNotice?.(flag);
      return;
    }
    if (T.open) return;
    try {
      const body = await request("poll", { after: S.top });
      if (!S.open) return;
      if (S.sort === "new" && body.count) showFresh(body.count);
      if (typeof body.review === "number" && body.review !== S.review) {
        S.review = body.review;
        syncSeg();
      }
    } catch {
      // Тихо: опрос — удобство, а не обязанность.
    }
  }

  function startPolling() {
    stopPolling();
    S.poll = setInterval(pollNow, POLL_MS);
    S.tick = setInterval(() => {
      for (const time of S.root.querySelectorAll("time.fm-time")) time.textContent = ago(time.dateTime);
    }, 30000);
  }

  function stopPolling() {
    clearInterval(S.poll);
    clearInterval(S.tick);
  }

  /** Потянули вниз у самого верха — обновить, как в нативных приложениях. */
  function wirePullToRefresh() {
    const scroll = S.scroll;
    let y0 = 0;
    let pull = 0;
    let active = false;
    let busy = false;
    const THRESHOLD = 68;
    const paint = (px, spin) => {
      S.wrap.style.transform = px ? `translate3d(0, ${px}px, 0)` : "";
      const p = clamp(px / THRESHOLD, 0, 1);
      S.ptr.style.opacity = String(p);
      S.ptr.style.transform = `translate3d(0, ${px * 0.9}px, 0) rotate(${spin ? 0 : p * 270}deg) scale(${0.6 + p * 0.4})`;
      S.ptr.classList.toggle("is-spin", Boolean(spin));
    };
    scroll.addEventListener("touchstart", (e) => {
      if (busy || scroll.scrollTop > 0 || e.touches.length !== 1) return;
      y0 = e.touches[0].clientY;
      active = true;
      pull = 0;
    }, { passive: true });
    scroll.addEventListener("touchmove", (e) => {
      if (!active) return;
      const dy = e.touches[0].clientY - y0;
      if (dy <= 0 || scroll.scrollTop > 0) {
        if (pull) paint(0);
        pull = 0;
        return;
      }
      if (e.cancelable) e.preventDefault();
      // Чем дальше тянут, тем тяжелее: резинка.
      pull = Math.min(130, dy * 0.5 * (1 - Math.min(dy, 400) / 1200));
      S.wrap.style.transition = "none";
      S.ptr.style.transition = "none";
      paint(pull);
    }, { passive: false });
    const end = async () => {
      if (!active) return;
      active = false;
      S.wrap.style.transition = `transform 380ms ${EASE}`;
      S.ptr.style.transition = `transform 380ms ${EASE}, opacity 200ms`;
      if (pull >= THRESHOLD * 0.9 && !busy) {
        busy = true;
        haptic("medium");
        paint(52, true);
        const started = Date.now();
        await load(true, { silent: true });
        await sleep(Math.max(0, 600 - (Date.now() - started)));
        busy = false;
      }
      paint(0);
      pull = 0;
      setTimeout(() => {
        S.wrap.style.transition = "";
        S.ptr.style.transition = "";
      }, 400);
    };
    scroll.addEventListener("touchend", end);
    scroll.addEventListener("touchcancel", end);
  }

  /* ---------- Свайп от края: назад ---------- */

  function wireEdgeSwipe(page, { onPop, under, dim, isOpen, thread }) {
    let id = null;
    let x0 = 0;
    let y0 = 0;
    let dx = 0;
    let locked = false;
    let t0 = 0;
    const host = thread ? page : S.root;
    const target = thread ? page : page;
    const mover = thread ? page : S.root;
    host.addEventListener("pointerdown", (e) => {
      if (!isOpen() || (e.pointerType === "mouse" && e.button !== 0)) return;
      if (e.clientX > 26) return;
      id = e.pointerId;
      x0 = e.clientX;
      y0 = e.clientY;
      dx = 0;
      locked = false;
      t0 = performance.now();
    });
    host.addEventListener("pointermove", (e) => {
      if (e.pointerId !== id) return;
      dx = e.clientX - x0;
      const dy = e.clientY - y0;
      if (!locked) {
        if (Math.abs(dy) > 12 && Math.abs(dy) > Math.abs(dx)) {
          id = null;
          return;
        }
        if (dx < 8) return;
        locked = true;
        try { host.setPointerCapture(id); } catch { /* уже отпущен */ }
        mover.style.transition = "none";
        if (under) under.style.transition = "none";
        if (dim) dim.style.transition = "none";
        mover.style.willChange = "transform";
      }
      const w = mover.offsetWidth || 1;
      const p = clamp(dx / w, 0, 1);
      mover.style.transform = `translate3d(${Math.max(0, dx)}px, 0, 0)`;
      if (under) under.style.transform = `translate3d(${-22 * (1 - p)}%, 0, 0)`;
      if (dim) dim.style.opacity = String(0.14 * (1 - p));
    });
    const finish = (e) => {
      if (e.pointerId !== id) return;
      id = null;
      if (!locked) return;
      locked = false;
      const w = mover.offsetWidth || 1;
      const velocity = dx / Math.max(1, performance.now() - t0);
      const pop = dx > w * 0.38 || velocity > 0.55;
      const set = `transform 340ms ${EASE}`;
      mover.style.transition = set;
      if (under) under.style.transition = set;
      if (dim) dim.style.transition = `opacity 340ms ${EASE}`;
      if (pop) {
        haptic("light");
        mover.style.transform = "translate3d(100%, 0, 0)";
        // Цель нижней страницы — «на месте» (0), а не её состояние «под обсуждением»:
        // иначе она бы на конце жеста поехала обратно под обсуждение и скакнула.
        if (under) under.style.transform = "translate3d(0, 0, 0)";
        if (dim) dim.style.opacity = "0";
        setTimeout(() => {
          // Сначала состояние (страница закрыта), и только потом снимаем
          // временные стили: иначе страница на кадр прыгнула бы обратно.
          onPop({ instant: true });
          requestAnimationFrame(() => {
            mover.style.transition = "";
            mover.style.transform = "";
            mover.style.willChange = "";
            if (under) {
              under.style.transition = "";
              under.style.transform = "";
            }
            if (dim) {
              dim.style.transition = "";
              dim.style.opacity = "";
            }
          });
        }, 340);
      } else {
        mover.style.transform = thread ? "translate3d(0, 0, 0)" : "translate3d(0, 0, 0)";
        if (under) under.style.transform = "translate3d(-22%, 0, 0)";
        if (dim) dim.style.opacity = "0.14";
        setTimeout(() => {
          mover.style.transition = "";
          mover.style.transform = "";
          mover.style.willChange = "";
          if (under) {
            under.style.transition = "";
            under.style.transform = "";
          }
          if (dim) {
            dim.style.transition = "";
            dim.style.opacity = "";
          }
        }, 360);
      }
    };
    host.addEventListener("pointerup", finish);
    host.addEventListener("pointercancel", finish);
  }

  /* ---------- Клавиатура ---------- */

  function trackKeyboard() {
    const vv = window.visualViewport;
    if (!vv) return;
    let frame = 0;
    let last = -1;
    const apply = () => {
      frame = 0;
      // iOS при фокусе ещё и сдвигает всю страницу вверх — поле тогда
      // «прыгало» дважды: со страницей и от нашего отступа. Страницу держим
      // на месте, поле над клавиатурой ставим сами.
      if (S.open && (window.scrollY || vv.offsetTop)) window.scrollTo(0, 0);
      const raw = Math.max(0, Math.round(window.innerHeight - vv.height - Math.max(0, vv.offsetTop)));
      const kb = raw > 80 ? raw : 0;
      if (kb === last) return;
      last = kb;
      S.root.style.setProperty("--fm-kb", `${kb}px`);
      S.root.classList.toggle("is-kb", kb > 0);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(apply);
    };
    vv.addEventListener("resize", schedule);
    vv.addEventListener("scroll", schedule);
  }

  /* ---------- Обсуждение ---------- */

  async function openThread(seed, { focus = false, mark = null } = {}) {
    if (T.open && T.id === seed.id) {
      if (mark) highlight(mark);
      return;
    }
    haptic("light");
    const token = ++T.token;
    T.id = seed.id;
    T.post = seed.text ? seed : null;
    T.replies = [];
    T.me = null;
    T.replyTo = null;
    T.open = true;
    T.area.value = "";
    autosize();
    syncReplyBar();
    setReplyTarget(null);
    renderThread({ skeleton: true });
    T.scroll.scrollTop = 0;
    T.dim.classList.add("is-on");
    S.feedPage.classList.add("is-under");
    T.page.classList.add("is-open");
    // «Ответить» из ленты: поле в фокусе сразу, в том же касании — клавиатура
    // выезжает вместе со страницей, а не через две секунды после загрузки.
    if (focus) T.area.focus({ preventScroll: true });
    const slide = sleep(REDUCED ? 0 : 390);
    try {
      const body = await request("replies", { post: seed.id }, { retry: true });
      if (token !== T.token) return;
      const known = S.posts.get(seed.id);
      if (known) Object.assign(known, body.post);
      T.post = known || body.post;
      T.replies = body.replies;
      T.me = body.me;
      S.notify = body.notify;
      await slide;
      if (token !== T.token) return;
      renderThread({ fade: true });
      if (mark) setTimeout(() => highlight(mark), REDUCED ? 0 : 420);
      if (focus && document.activeElement !== T.area) T.area.focus({ preventScroll: true });
    } catch (error) {
      if (token !== T.token) return;
      await slide;
      T.wrap.replaceChildren(
        state({
          art: "lost",
          title: error.code === "404" ? t("Этого поста уже нет") : t("Не получилось открыть"),
          text: error.code === "404" ? t("Его удалил автор или модератор.") : errorText(error),
          action: { label: t("Назад"), run: () => closeThread() },
        })
      );
    }
  }

  function closeThread({ instant = false } = {}) {
    if (!T.open) return;
    T.open = false;
    T.token++;
    T.area.blur();
    T.dim.classList.remove("is-on");
    S.feedPage.classList.remove("is-under");
    T.page.classList.remove("is-open");
    if (instant) {
      T.page.style.transition = "none";
      S.feedPage.style.transition = "none";
      T.dim.style.transition = "none";
      requestAnimationFrame(() => {
        T.page.style.transition = "";
        S.feedPage.style.transition = "";
        T.dim.style.transition = "";
      });
    }
    setTimeout(() => {
      if (!T.open) T.wrap.replaceChildren();
    }, 420);
  }

  /** Подсветка сообщения, на которое ведёт ссылка: прокрутить к нему и мигнуть. */
  function highlight(mark) {
    const node = mark === "post" ? T.wrap.querySelector(".fm-th-post") : T.wrap.querySelector(`.fm-reply[data-id="${mark}"]`);
    if (!node) return;
    if (mark !== "post") {
      const top = node.getBoundingClientRect().top - T.scroll.getBoundingClientRect().top + T.scroll.scrollTop - 90;
      smoothScroll(T.scroll, Math.max(0, top));
    }
    node.classList.remove("is-marked");
    void node.offsetWidth;
    node.classList.add("is-marked");
    haptic("light");
    setTimeout(() => node.classList.remove("is-marked"), 2600);
  }

  function renderThread({ skeleton = false, fade = false } = {}) {
    const wrap = T.wrap;
    if (skeleton) {
      wrap.replaceChildren();
      if (T.post) wrap.append(threadPostNode());
      const rows = [];
      for (let i = 0; i < 3; i++) {
        const s = document.createElement("div");
        s.className = "fm-skel";
        s.innerHTML = "<i></i><div><b></b><u></u><u></u></div>";
        rows.push(s);
      }
      const list = document.createElement("div");
      list.className = "fm-replies fm-replies--skel";
      list.append(...rows);
      wrap.append(list);
      return;
    }
    const keep = wrap.querySelector(".fm-th-post");
    const head = keep && T.post && keep.dataset.id === String(T.post.id) ? keep : threadPostNode();
    wrap.replaceChildren(head, repliesNode(), Object.assign(document.createElement("div"), { className: "fm-spacer" }));
    if (keep === head) paintThreadPost(false);
    if (fade) {
      animate(wrap.querySelector(".fm-replies"), [{ opacity: 0, transform: "translate3d(0, 12px, 0)" }, { opacity: 1, transform: "none" }], { duration: 380, fill: "backwards" });
    }
    syncReplyBar();
  }

  function threadPostNode() {
    const post = T.post;
    const box = document.createElement("article");
    box.className = "fm-th-post";
    box.dataset.id = post.id;

    const head = document.createElement("div");
    head.className = "fm-th-head";
    const who = document.createElement("div");
    who.className = "fm-th-who";
    const nameLine = Object.assign(document.createElement("span"), { className: "fm-name", textContent: post.name });
    const bigCheck = badgeOf(post);
    if (bigCheck && !post.tg) nameLine.append(bigCheck);
    who.append(nameLine);
    const sub = document.createElement("small");
    sub.textContent = fullTime(post.created) + (post.edited ? ` · ${t("изменено")}` : "");
    if (post.tag) sub.append(Object.assign(document.createElement("span"), { className: "fm-tag", textContent: post.tag }));
    who.append(sub);
    const dots = document.createElement("button");
    dots.type = "button";
    dots.className = "fm-dots";
    dots.setAttribute("aria-label", t("Ещё"));
    dots.append(icon("more"));
    dots.addEventListener("click", () => openActions("p", post));
    const bigAva = avatar(post, "l");
    linkify(post, bigAva, who.querySelector(".fm-name"));
    if (post.tg) {
      const nick = Object.assign(document.createElement("span"), { className: "fm-nick fm-tg", textContent: `@${post.tg}` });
      nick.dataset.tg = post.tg;
      if (bigCheck) sub.prepend(nick, bigCheck, document.createTextNode(" · "));
      else sub.prepend(nick, document.createTextNode(" · "));
    }
    head.append(bigAva, who, dots);
    box.append(head);

    if (post.pending) box.append(badge("clock", t("На проверке — появится после одобрения")));
    if (post.author) box.append(ownerLine(post));

    const text = document.createElement("p");
    text.className = "fm-th-text";
    text.textContent = post.text;
    box.append(text);
    wireDoubleTap(text, post);

    const stats = document.createElement("div");
    stats.className = "fm-th-stats";
    stats.innerHTML = '<span><b class="n-likes"></b> <em class="l-likes" style="font-style:normal"></em></span><span><b class="n-replies"></b> <em class="l-replies" style="font-style:normal"></em></span>';
    box.append(stats);

    const acts = document.createElement("div");
    acts.className = "fm-th-acts";
    const votes = voteControl(post);
    votes.querySelectorAll("button").forEach((b) => {
      b.disabled = Boolean(post.pending);
      b.addEventListener("click", () => castVote(post, "p", b.classList.contains("fm-v--up") ? 1 : -1, votes));
    });
    const talk = numButton("reply", post.replies, t("Ответить"));
    talk.disabled = Boolean(post.pending);
    talk.addEventListener("click", () => {
      setReplyTarget(null);
      T.area.focus({ preventScroll: true });
    });
    acts.append(votes, talk);
    box.append(acts);
    queueMicrotask(() => paintThreadPost(false));
    return box;
  }

  function paintThreadPost(animated) {
    const post = T.post;
    const box = T.wrap.querySelector(".fm-th-post");
    if (!box || !post) return;
    paintVote(box.querySelector(".fm-vote"), post, animated);
    setNum(box.querySelector(".fm-act--reply .fm-num"), post.replies || 0, animated);
    box.querySelector(".n-likes").textContent = fmtScore(post.score || 0);
    box.querySelector(".l-likes").textContent = t("рейтинг");
    box.querySelector(".n-replies").textContent = String(post.replies || 0);
    box.querySelector(".l-replies").textContent = plural(post.replies || 0, t("ответ"), t("ответа"), t("ответов"));
  }

  function plural(n, one, few, many) {
    if (LANG !== "ru") return one;
    const m10 = n % 10;
    const m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
    return many;
  }

  /** Два быстрых касания по тексту поста — лайк, с большим сердцем. */
  function wireDoubleTap(node, post) {
    let last = 0;
    node.addEventListener("click", (e) => {
      const now = performance.now();
      if (now - last < 320) {
        last = 0;
        if (post.vote !== 1 && !post.pending) castVote(post, "p", 1, T.wrap.querySelector(".fm-th-acts .fm-vote"));
        bigArrow(e.clientX, e.clientY);
      } else last = now;
    });
  }

  function bigArrow(x, y) {
    const rect = T.page.getBoundingClientRect();
    const heart = document.createElement("div");
    heart.className = "fm-bigheart";
    heart.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 3.2l8.4 9.3h-5.2V20.8H8.8V12.5H3.6z"/></svg>';
    heart.style.left = `${x - rect.left}px`;
    heart.style.top = `${y - rect.top}px`;
    T.page.append(heart);
    const a = animate(heart, [
      { opacity: 0, transform: "scale(0.3)" },
      { opacity: 1, transform: "scale(1.15)", offset: 0.3 },
      { opacity: 1, transform: "scale(1)", offset: 0.55 },
      { opacity: 0, transform: "scale(1.05) translate3d(0,-16px,0)" },
    ], { duration: 760, easing: "ease-out" });
    if (a) a.onfinish = () => heart.remove();
    else heart.remove();
  }

  function repliesNode() {
    const list = document.createElement("div");
    list.className = "fm-replies";
    if (!T.replies.length) {
      list.append(state({ art: "quiet", title: t("Ответов пока нет"), text: t("Скажите первым — анонимно или под своим именем.") }));
      return list;
    }
    list.append(Object.assign(document.createElement("div"), { className: "fm-th-title", textContent: t("Ответы") }));
    // Ответ на чей-то ответ стоит сразу под ним, со сдвигом: видно, кому отвечают.
    for (const reply of threaded(T.replies)) list.append(replyNode(reply));
    return list;
  }

  /** Ответы ветками: сначала ответ на пост, под ним — всё, что написали в ответ ему. */
  function threaded(replies) {
    const byId = new Map(replies.map((r) => [r.id, r]));
    const rootOf = (r) => {
      let cur = r;
      for (let i = 0; i < 20 && cur.parent && byId.has(cur.parent.id); i++) cur = byId.get(cur.parent.id);
      return cur;
    };
    const groups = new Map();
    for (const r of replies) {
      const root = rootOf(r);
      if (!groups.has(root.id)) groups.set(root.id, []);
      if (r !== root) groups.get(root.id).push(r);
    }
    const out = [];
    for (const r of replies) {
      if (rootOf(r) !== r) continue;
      out.push(r, ...groups.get(r.id));
    }
    return out;
  }

  function replyNode(reply) {
    const row = document.createElement("article");
    row.className = `fm-reply${reply.pending || reply.tmp ? " is-pending" : ""}${reply.parent ? " is-child" : ""}`;
    row.dataset.id = reply.id;
    const main = document.createElement("div");
    main.className = "fm-main";
    const meta = document.createElement("header");
    meta.className = "fm-meta";
    meta.append(Object.assign(document.createElement("span"), { className: "fm-name", textContent: reply.name }));
    const replyCheck = badgeOf(reply);
    if (replyCheck) meta.append(replyCheck);
    if (reply.medal) meta.append(Object.assign(document.createElement("span"), { className: "fm-medal", title: t("Призёр «Сессии 2048»"), textContent: reply.medal }));
    const replyLvl = levelNode(reply);
    if (replyLvl) meta.append(replyLvl);
    if (reply.op) meta.append(Object.assign(document.createElement("span"), { className: "fm-op", textContent: t("автор") }));
    const time = document.createElement("time");
    time.className = "fm-time";
    time.dateTime = reply.created;
    time.textContent = ago(reply.created);
    meta.append(time);
    if (reply.edited) meta.append(Object.assign(document.createElement("span"), { className: "fm-edited", textContent: t("изменено") }));
    if (!reply.tmp) meta.append(replyDots(reply));
    main.append(meta);
    if (reply.pending) main.append(badge("clock", t("На проверке")));
    if (reply.hidden === 1 || reply.hidden === 3) {
      if (reply.hidden === 1) main.append(badge("alert", t("Скрыт жалобами"), true));
    }
    if (reply.author) main.append(ownerLine(reply));
    if (reply.parent) {
      const q = document.createElement("button");
      q.type = "button";
      q.className = "fm-quote";
      q.append(icon("reply", 14));
      if (reply.parent.gone) {
        q.append(Object.assign(document.createElement("span"), { textContent: t("Ответ удалён") }));
        q.disabled = true;
      } else {
        q.append(Object.assign(document.createElement("b"), { textContent: reply.parent.name }), Object.assign(document.createElement("span"), { textContent: reply.parent.text }));
        q.addEventListener("click", () => jumpToReply(reply.parent.id));
      }
      main.append(q);
    }
    const text = document.createElement("p");
    text.className = "fm-text";
    text.textContent = reply.text;
    main.append(text);
    main.append(replyActs(reply));
        const smallAva = avatar(reply, "s", "r");
    linkify(reply, smallAva, meta.querySelector(".fm-name"));
    row.append(smallAva, main);
    row.reply = reply;
    return row;
  }

  function replyDots(reply) {
    const dots = document.createElement("button");
    dots.type = "button";
    dots.className = "fm-dots";
    dots.setAttribute("aria-label", t("Ещё"));
    dots.append(icon("more"));
    dots.addEventListener("click", () => openActions("r", reply));
    return dots;
  }

  function replyActs(reply) {
    const acts = document.createElement("footer");
    acts.className = "fm-acts";
    if (reply.tmp || reply.pending) return acts;
    const like = voteControl(reply);
    like.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => castVote(reply, "r", b.classList.contains("fm-v--up") ? 1 : -1, like)));
    const answer = document.createElement("button");
    answer.type = "button";
    answer.className = "fm-act fm-reply-btn";
    answer.textContent = t("Ответить");
    answer.addEventListener("click", () => {
      setReplyTarget(reply);
      T.area.focus({ preventScroll: true });
    });
    acts.append(like, answer);
    return acts;
  }

  /** Ответ подтвердился сервером: тот же узел, без перерисовки, только оживает. */
  function finalizeReply(node, reply) {
    node.dataset.id = reply.id;
    node.classList.remove("is-pending");
    node.querySelector(".fm-acts")?.replaceWith(replyActs(reply));
    const meta = node.querySelector(".fm-meta");
    if (meta && !meta.querySelector(".fm-dots")) meta.append(replyDots(reply));
    if (reply.pending) {
      node.classList.add("is-pending");
      node.querySelector(".fm-main").insertBefore(badge("clock", t("На проверке")), node.querySelector(".fm-text"));
    }
  }

  function jumpToReply(id) {
    const node = T.wrap.querySelector(`.fm-reply[data-id="${id}"]`);
    if (!node) return;
    haptic("select");
    const top = node.getBoundingClientRect().top - T.scroll.getBoundingClientRect().top + T.scroll.scrollTop - 90;
    smoothScroll(T.scroll, Math.max(0, top), 420);
    setTimeout(() => {
      node.classList.add("is-flash");
      requestAnimationFrame(() => requestAnimationFrame(() => node.classList.remove("is-flash")));
    }, 280);
  }

  /* ---------- Поле ответа ---------- */

  function wireThread() {
    const { area, send, mask } = T;
    T.wrap.addEventListener("click", (e) => {
      const profile = e.target.closest("[data-tg]");
      if (profile) openProfile(profile.dataset.tg);
    });
    area.addEventListener("input", () => {
      autosize();
      syncReplyBar();
      T.hint.classList.remove("is-bad");
      T.hint.textContent = area.value.length > REPLY_MAX - 60 ? `${REPLY_MAX - area.value.length}` : "";
    });
    area.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        sendReply();
      }
    });
    send.addEventListener("click", sendReply);
    mask.addEventListener("click", () => {
      const anon = !anonOn();
      store(KEY.anon, anon ? "1" : "0");
      haptic("select");
      syncReplyBar();
      toast(anon ? t("Ответ будет анонимным") : t("Ответ под вашим именем"), { tone: "ok", icon: anon ? "mask" : "person", ms: 1800 });
    });
    T.replying.addEventListener("click", (e) => {
      if (e.target.closest("button")) setReplyTarget(null);
    });
  }

  const anonOn = () => store(KEY.anon) !== "0";

  function autosize() {
    const a = T.area;
    a.style.height = "42px";
    a.style.height = `${clamp(a.scrollHeight, 42, 124)}px`;
    requestAnimationFrame(() => {
      T.page.style.setProperty("--fm-bar", `${T.bar.offsetHeight}px`);
    });
  }

  function syncReplyBar() {
    const text = T.area.value.trim();
    const ok = text.length > 0 && text.length <= REPLY_MAX && !S.banned;
    T.send.classList.toggle("is-ready", ok);
    T.mask.classList.toggle("is-anon", anonOn());
    T.mask.setAttribute("aria-label", anonOn() ? t("Анонимно") : t("Под своим именем"));
    T.area.placeholder = S.banned ? t("Запись закрыта") : T.replyTo ? t("Ваш ответ…") : t("Написать ответ…");
    T.area.disabled = Boolean(S.banned);
    T.mask.hidden = Boolean(S.banned);
    T.send.hidden = Boolean(S.banned);
  }

  function setReplyTarget(reply) {
    T.replyTo = reply && !reply.tmp ? reply : null;
    const box = T.replying;
    if (!T.replyTo) {
      box.classList.remove("is-on");
      box.replaceChildren();
    } else {
      const label = document.createElement("span");
      label.append(document.createTextNode(`${t("Ответ")} `), Object.assign(document.createElement("b"), { textContent: T.replyTo.name }));
      const x = document.createElement("button");
      x.type = "button";
      x.setAttribute("aria-label", t("Отменить"));
      x.append(icon("close"));
      box.replaceChildren(icon("reply", 16), label, x);
      box.classList.add("is-on");
      animate(box, [{ opacity: 0, transform: "translate3d(0, 8px, 0)" }, { opacity: 1, transform: "none" }], { duration: 240 });
    }
    syncReplyBar();
    autosize();
  }

  function sendReply() {
    const text = T.area.value.trim();
    if (!text || text.length > REPLY_MAX || !T.post || S.banned) return;
    const bad = precheck(text);
    if (bad) return replyError(bad);
    const post = T.post;
    const to = T.replyTo;
    const anon = anonOn();
    const me = T.me;
    const tmp = {
      id: `tmp${++T.tmp}`,
      tmp: true,
      name: anon ? me?.alias?.name || t("Вы") : me?.name || S.user.first_name || t("Вы"),
      emoji: anon ? me?.alias?.emoji || "" : "",
      hue: anon ? me?.alias?.hue : me?.hue,
      anon,
      op: Boolean(post.mine) && !anon,
      text,
      created: new Date().toISOString(),
      likes: 0,
      liked: false,
      parent: to ? { id: to.id, name: to.name, text: to.text.length > 90 ? `${to.text.slice(0, 90)}…` : to.text } : null,
      mine: true,
    };
    haptic("light");
    T.area.value = "";
    T.hint.textContent = "";
    setReplyTarget(null);
    autosize();
    syncReplyBar();
    appendReply(tmp);
    // Серверу — по очереди: ответы одного человека уходят строго друг за другом.
    T.queue = T.queue.then(() => deliver(tmp, { text, anon, to: to?.id || 0, post }));
  }

  function appendReply(reply) {
    const list = T.wrap.querySelector(".fm-replies");
    if (!list) return;
    const hadState = list.querySelector(".fm-state");
    if (hadState || !list.querySelector(".fm-th-title")) {
      list.replaceChildren(Object.assign(document.createElement("div"), { className: "fm-th-title", textContent: t("Ответы") }));
    }
    const node = replyNode(reply);
    // Ответ на ответ встаёт в конец своей ветки, а не в конец всего списка.
    let after = reply.parent && !reply.parent.gone ? list.querySelector(`.fm-reply[data-id="${reply.parent.id}"]`) : null;
    while (after?.nextElementSibling?.classList.contains("is-child")) after = after.nextElementSibling;
    if (after) after.after(node);
    else list.append(node);
    T.replies.push(reply);
    animate(node, [{ opacity: 0, transform: "translate3d(0, 14px, 0)" }, { opacity: 1, transform: "none" }], { duration: 380, fill: "backwards" });
    requestAnimationFrame(() => {
      const bottom = node.getBoundingClientRect().bottom;
      const limit = T.bar.getBoundingClientRect().top - 12;
      if (bottom > limit) smoothScroll(T.scroll, T.scroll.scrollTop + bottom - limit, 360);
    });
    post_count(+1);
  }

  function post_count(delta) {
    if (!T.post) return;
    T.post.replies = Math.max(0, (T.post.replies || 0) + delta);
    refreshPost(T.post, true);
  }

  async function deliver(tmp, { text, anon, to, post }) {
    // Номер узла запоминаем заранее: после ответа сервера у ответа уже настоящий id.
    const key = tmp.id;
    const node = () => T.wrap.querySelector(`.fm-reply[data-id="${key}"]`);
    try {
      const res = await request("reply", { post: post.id, text, anon, to });
      const real = res.reply;
      Object.assign(tmp, real, { tmp: false });
      const old = node();
      if (old && T.id === post.id) finalizeReply(old, tmp);
      if (res.pending) {
        post_count(-1);
        toast(t("Ответ на проверке — появится после одобрения."), { tone: "warn", icon: "clock", ms: 3600 });
      }
    } catch (error) {
      const old = node();
      if (error.code === "network" && old) {
        old.classList.add("is-failed");
        const failed = document.createElement("div");
        failed.className = "fm-failed";
        const retry = document.createElement("button");
        retry.type = "button";
        retry.textContent = t("Повторить");
        retry.addEventListener("click", () => {
          failed.remove();
          T.queue = T.queue.then(() => deliver(tmp, { text, anon, to, post }));
        });
        failed.append(icon("alert", 16), Object.assign(document.createElement("span"), { textContent: t("Не отправилось") }), retry);
        old.querySelector(".fm-main").append(failed);
        haptic("error");
        return;
      }
      // Отклонено сервером: возвращаем текст человеку, чтобы поправил.
      if (old) flip(T.wrap.querySelector(".fm-replies"), () => old.remove());
      T.replies = T.replies.filter((r) => r !== tmp);
      post_count(-1);
      if (!T.area.value) {
        T.area.value = text;
        autosize();
        syncReplyBar();
      }
      replyError(errorText(error));
    }
  }

  function replyError(message) {
    haptic("error");
    T.hint.textContent = message;
    T.hint.classList.add("is-bad");
    animate(T.bar.querySelector(".fm-field"), [
      { transform: "translate3d(0,0,0)" },
      { transform: "translate3d(-7px,0,0)" },
      { transform: "translate3d(7px,0,0)" },
      { transform: "translate3d(-5px,0,0)" },
      { transform: "translate3d(4px,0,0)" },
      { transform: "translate3d(0,0,0)" },
    ], { duration: 360, easing: "ease-out" });
  }

  /* ---------- Меню «⋯» ---------- */

  function actionRow(name, label, run, { bad = false, sub = "" } = {}) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `fm-action${bad ? " fm-action--bad" : ""}`;
    const text = document.createElement("span");
    text.textContent = label;
    if (sub) text.append(Object.assign(document.createElement("small"), { textContent: sub }));
    b.append(icon(name), text);
    b.addEventListener("click", () => {
      haptic("light");
      run();
    });
    return b;
  }

  function openActions(kind, item) {
    const sheet = (S.sheets.actions ||= makeSheet("sheet--fm-actions"));
    const noun = kind === "p" ? t("пост") : t("ответ");

    const home = () => {
      const list = document.createElement("div");
      list.className = "fm-actions";
      if (kind === "r" && !item.pending && T.open) {
        list.append(actionRow("reply", t("Ответить"), () => {
          sheet.close();
          setReplyTarget(item);
          setTimeout(() => T.area.focus(), 260);
        }));
      }
      if (kind === "p" && !item.pending && item.id > 0 && S.role === "owner") {
        list.append(actionRow("pin", item.pinned ? t("Открепить") : t("Закрепить наверху"), async () => {
          sheet.close();
          try {
            const res = await request("pin", { post: item.id, on: !item.pinned });
            Object.assign(item, res.post);
            haptic("success");
            toast(item.pinned ? t("Пост закреплён наверху") : t("Пост откреплён"), { icon: "pin" });
            if (T.open && T.id === item.id) closeThread();
            if (S.sort !== "review") load(true, { silent: true });
            smoothScroll(S.scroll, 0);
          } catch (error) {
            toast(errorText(error), { tone: "bad", icon: "alert" });
          }
        }, { sub: item.pinned ? t("Вернуть на своё место в ленте") : t("Первым в ленте у всех") }));
      }
      if (kind === "p" && !item.pending && item.id > 0) {
        list.append(actionRow("share", t("Поделиться"), () => {
          sheet.close();
          const link = `https://t.me/FGPshedulebot?start=f_${item.id}`;
          const share = `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(item.text.replace(/\s+/g, " ").slice(0, 120))}`;
          if (tg?.openTelegramLink) tg.openTelegramLink(share);
          else window.open(share, "_blank", "noopener");
        }, { sub: t("Отправить в чат") }));
      }
      if (kind === "r" && !item.pending && item.id > 0 && T.open) {
        list.append(actionRow("share", t("Поделиться"), () => {
          sheet.close();
          const link = `https://t.me/FGPshedulebot?start=f_${T.id}_${item.id}`;
          const share = `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(item.text.replace(/\s+/g, " ").slice(0, 120))}`;
          if (tg?.openTelegramLink) tg.openTelegramLink(share);
          else window.open(share, "_blank", "noopener");
        }, { sub: t("Отправить в чат") }));
      }
      if (item.mine && item.id > 0 && !item.tmp) {
        list.append(actionRow("pen", t("Изменить"), () => {
          sheet.close();
          setTimeout(() => openEditor(kind, item), 200);
        }));
      }
      if (!item.mine) list.append(actionRow("flag", t("Пожаловаться"), () => swap(sheet, reasons), { sub: t("Модератор посмотрит") }));
      if (item.canDelete) list.append(actionRow("trash", t("Удалить"), () => swap(sheet, () => confirm({ title: t("Удалить {what}?", { what: noun }), text: t("Это нельзя отменить."), cta: t("Удалить"), run: () => doDelete() })), { bad: true }));
      if (S.owner && item.author && !item.mine) {
        list.append(Object.assign(document.createElement("div"), { className: "fm-sep" }));
        list.append(actionRow("ban", t("Удалить и забанить на 7 дней"), () => swap(sheet, () => confirm({ title: t("Забанить автора?"), text: `${item.author.name}${item.author.username ? ` @${item.author.username}` : ""} · id ${item.author.id}`, cta: t("Удалить и забанить"), run: () => doMod("ban") })), { bad: true }));
        list.append(actionRow("broom", t("Удалить всё, что писал автор"), () => swap(sheet, () => confirm({ title: t("Удалить всё автора?"), text: t("Все его посты и ответы исчезнут."), cta: t("Удалить всё"), run: () => doMod("purge") })), { bad: true }));
        const info = document.createElement("div");
        info.className = "fm-action fm-action--info";
        info.textContent = `${t("Автор")}: ${item.author.name}${item.author.username ? ` @${item.author.username}` : ""} · id ${item.author.id}`;
        list.append(info);
      }
      fill(sheet.sh, list);
    };

    const reasons = () => {
      const wrapper = document.createElement("div");
      wrapper.className = "fm-sheet-in";
      wrapper.append(Object.assign(document.createElement("h2"), { textContent: t("Что не так?") }), Object.assign(document.createElement("p"), { className: "fm-sheet-sub", textContent: t("Жалоба анонимна: автор её не увидит.") }));
      const list = document.createElement("div");
      list.className = "fm-actions";
      for (const [code, name, ic] of [
        ["spam", t("Спам или реклама"), "alert"],
        ["abuse", t("Оскорбления или травля"), "ban"],
        ["private", t("Личные данные"), "eye"],
        ["danger", t("Угрозы или опасное"), "shield"],
        ["other", t("Другое"), "flag"],
      ]) list.append(actionRow(ic, name, () => doReport(code)));
      const cancel = Object.assign(document.createElement("div"), { className: "fm-sheet-actions" });
      const b = Object.assign(document.createElement("button"), { type: "button", className: "fm-btn fm-btn--soft", textContent: t("Назад") });
      b.addEventListener("click", () => swap(sheet, home));
      cancel.append(b);
      fill(sheet.sh, wrapper, list, cancel);
    };

    const confirm = ({ title, text, cta, run }) => {
      const wrapper = document.createElement("div");
      wrapper.className = "fm-sheet-in";
      wrapper.append(Object.assign(document.createElement("h2"), { textContent: title }), Object.assign(document.createElement("p"), { className: "fm-sheet-sub", textContent: text }));
      const actions = Object.assign(document.createElement("div"), { className: "fm-sheet-actions" });
      const yes = Object.assign(document.createElement("button"), { type: "button", className: "fm-btn", textContent: cta });
      yes.style.background = "var(--fm-danger)";
      yes.addEventListener("click", async () => {
        yes.disabled = true;
        await run();
      });
      const no = Object.assign(document.createElement("button"), { type: "button", className: "fm-btn fm-btn--soft", textContent: t("Отмена") });
      no.addEventListener("click", () => sheet.close());
      actions.append(yes, no);
      fill(sheet.sh, wrapper, actions);
    };

    const thanks = (text) => {
      const box = document.createElement("div");
      box.className = "fm-check";
      box.innerHTML = '<svg viewBox="0 0 64 64"><circle cx="32" cy="32" r="26"/><path d="M21 33l8 8 15-17"/></svg>';
      box.append(Object.assign(document.createElement("h2"), { textContent: text }));
      swap(sheet, () => fill(sheet.sh, box));
      setTimeout(() => sheet.close(), 1300);
    };

    const doReport = async (reason) => {
      try {
        await request("report", { kind, id: item.id, reason });
        haptic("success");
        thanks(t("Спасибо, отправили"));
      } catch (error) {
        sheet.close();
        toast(errorText(error), { tone: "bad", icon: "alert" });
      }
    };

    const doDelete = async () => {
      try {
        await request("delete", { kind, id: item.id });
        haptic("success");
        sheet.close();
        if (kind === "p") {
          if (T.open && T.id === item.id) closeThread();
          setTimeout(() => removeRow(item.id), T.open ? 300 : 0);
        } else {
          const node = T.wrap.querySelector(`.fm-reply[data-id="${item.id}"]`);
          if (node) flip(T.wrap.querySelector(".fm-replies"), () => node.remove());
          T.replies = T.replies.filter((r) => r.id !== item.id);
          post_count(-1);
        }
        toast(t("Удалено"), { icon: "trash" });
      } catch (error) {
        sheet.close();
        toast(errorText(error), { tone: "bad", icon: "alert" });
      }
    };

    const doMod = async (op) => {
      try {
        const res = await request("mod", { kind, id: item.id, op });
        haptic("success");
        sheet.close();
        toast(res.text, { icon: "check" });
        if (kind === "p") {
          if (T.open && T.id === item.id) closeThread();
          setTimeout(() => removeRow(item.id), T.open ? 300 : 0);
        } else {
          const node = T.wrap.querySelector(`.fm-reply[data-id="${item.id}"]`);
          if (node) flip(T.wrap.querySelector(".fm-replies"), () => node.remove());
          T.replies = T.replies.filter((r) => r.id !== item.id);
        }
        if (op === "purge") load(true, { silent: true });
      } catch (error) {
        sheet.close();
        toast(errorText(error), { tone: "bad", icon: "alert" });
      }
    };

    home();
    sheet.open();
  }

  /* ---------- Правила и настройки ---------- */

  function openRules(first) {
    const sheet = (S.sheets.rules ||= makeSheet("sheet--fm-rules"));
    const wrapper = document.createElement("div");
    wrapper.className = "fm-sheet-in";
    const hero = document.createElement("div");
    hero.className = "fm-hero";
    for (const [emoji, hue] of [["🦊", 28], ["🐧", 210], ["🦉", 285]]) hero.append(avatar({ emoji, hue, name: "?" }));
    wrapper.append(hero);
    wrapper.append(Object.assign(document.createElement("h2"), { textContent: t("Подслушка") }));
    wrapper.append(Object.assign(document.createElement("p"), { className: "fm-sheet-sub", textContent: t("Общий форум студентов всех вузов. Пишите свободно, но по-человечески.") }));
    const rules = document.createElement("div");
    rules.className = "fm-rules";
    for (const [name, title, text] of [
      ["shield", t("Без мата и травли"), t("Оскорбления не публикуются. Три жалобы — и пост скрыт.")],
      ["at", t("Без ссылок и чужих контактов"), t("Ни телефонов, ни @ников, ни ссылок: личное остаётся личным.")],
      ["mask", t("Анонимно — для студентов"), t("Другие не узнают, кто вы. Администратор видит автора, чтобы блокировать травлю и спам. Под своим именем — видно имя и ссылку на ваш Telegram.")],
    ]) {
      const row = document.createElement("div");
      row.className = "fm-rule";
      const box = document.createElement("span");
      box.className = "fm-rule-i";
      box.append(icon(name));
      const copy = document.createElement("div");
      copy.append(Object.assign(document.createElement("b"), { textContent: title }), Object.assign(document.createElement("span"), { textContent: text }));
      row.append(box, copy);
      rules.append(row);
    }
    wrapper.append(rules);

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "fm-toggle";
    toggle.setAttribute("role", "switch");
    toggle.setAttribute("aria-checked", String(S.notify));
    toggle.innerHTML = `<span>${t("Ответы — в бота")}<small>${t("Тихое сообщение, когда вам отвечают")}</small></span><i class="fm-sw"></i>`;
    toggle.addEventListener("click", async () => {
      haptic("select");
      const next = toggle.getAttribute("aria-checked") !== "true";
      toggle.setAttribute("aria-checked", String(next));
      try {
        const res = await request("prefs", { notify: next });
        S.notify = res.notify;
      } catch (error) {
        toggle.setAttribute("aria-checked", String(!next));
        toast(errorText(error), { tone: "bad", icon: "alert" });
      }
    });
    wrapper.append(toggle);
    const fine = document.createElement("div");
    fine.className = "fm-fine";
    for (const line of [
      t("Когда кто-то отвечает на ваш пост или на ваш ответ, бот пришлёт тихое сообщение, без звука: кусочек ответа и кнопку «Открыть обсуждение». Она ведёт сразу в эту тему."),
      t("Не чаще раза в 20 минут по одной теме, чтобы бурное обсуждение не засыпало чат. Лайки и ваши собственные ответы сообщений не вызывают."),
      t("Аноним остаётся анонимом: вы увидите «Аноним Лиса», а не имя. Бот может написать только тем, кто уже запускал его."),
    ]) fine.append(Object.assign(document.createElement("p"), { textContent: line }));
    wrapper.append(fine);

    const actions = document.createElement("div");
    actions.className = "fm-sheet-actions";
    const ok = Object.assign(document.createElement("button"), { type: "button", className: "fm-btn", textContent: first ? t("Понятно, поехали") : t("Готово") });
    ok.addEventListener("click", () => {
      store(KEY.rules, "1");
      sheet.close();
    });
    actions.append(ok);
    fill(sheet.sh, wrapper, actions);
    sheet.backdrop.addEventListener("click", () => store(KEY.rules, "1"), { once: true });
    sheet.open();
    request("prefs", {}).then((res) => {
      S.notify = res.notify;
      toggle.setAttribute("aria-checked", String(res.notify));
    }).catch(() => {});
  }

  /* ---------- Правка своего поста или ответа ---------- */

  function openEditor(kind, item) {
    const sheet = (S.sheets.editor ||= makeSheet("sheet--fm-composer sheet--fm-editor", { input: true }));
    const max = kind === "p" ? POST_MAX : REPLY_MAX;
    const box = document.createElement("div");
    box.className = "fm-composer";
    const top = document.createElement("div");
    top.className = "fm-comp-top";
    const cancel = Object.assign(document.createElement("button"), { type: "button", className: "fm-link", textContent: t("Отмена") });
    const title = Object.assign(document.createElement("h2"), { textContent: kind === "p" ? t("Изменить пост") : t("Изменить ответ") });
    const save = Object.assign(document.createElement("button"), { type: "button", className: "fm-publish is-ready", textContent: t("Сохранить") });
    top.append(cancel, title, save);
    const body = document.createElement("div");
    body.className = "fm-comp-body";
    const area = document.createElement("textarea");
    area.maxLength = max + 60;
    area.value = item.text;
    body.append(area);
    const err = document.createElement("div");
    err.className = "fm-comp-err";
    const hint = Object.assign(document.createElement("div"), { className: "fm-comp-as", textContent: t("Рядом с текстом появится пометка «изменено».") });
    box.append(top, body, hint, err);
    fill(sheet.sh, box);
    const sync = () => {
      const len = area.value.trim().length;
      save.classList.toggle("is-ready", len >= 3 && len <= max && area.value.trim() !== item.text);
    };
    const showErr = (message) => {
      err.replaceChildren(icon("alert"), Object.assign(document.createElement("span"), { textContent: message }));
      err.classList.add("is-on");
      haptic("error");
    };
    area.addEventListener("input", () => {
      err.classList.remove("is-on");
      sync();
    });
    cancel.addEventListener("click", () => sheet.close());
    let busy = false;
    save.addEventListener("click", async () => {
      const text = area.value.trim();
      if (busy || text === item.text) return sheet.close();
      if (text.length < 3) return showErr(t("Напишите хотя бы пару фраз :P"));
      if (text.length > max) return showErr(t("Слишком длинно."));
      busy = true;
      save.classList.add("is-busy");
      try {
        const res = await request("edit", { kind, id: item.id, text });
        item.text = res.text || text;
        item.edited = true;
        if (res.pending) item.pending = true;
        haptic("success");
        sheet.close();
        if (kind === "p") {
          replaceRow(item);
          if (T.open && T.id === item.id) {
            T.wrap.querySelector(".fm-th-post")?.remove();
            renderThread({});
          }
        } else if (T.open) renderThread({});
        toast(res.pending ? t("Изменено — уйдёт на проверку перед публикацией.") : t("Изменено"), res.pending ? { tone: "warn", icon: "clock", ms: 3600 } : { icon: "check" });
      } catch (error) {
        showErr(errorText(error));
      } finally {
        busy = false;
        save.classList.remove("is-busy");
      }
    });
    sync();
    sheet.open();
    setTimeout(() => {
      area.focus();
      area.setSelectionRange(area.value.length, area.value.length);
    }, 320);
  }

  /* ---------- Управление (только владелец): закрыть на ремонт ---------- */

  const GITHUB_SWITCH = "https://github.com/bodryash/schedule-miniapp/actions/workflows/forum-switch.yml";

  async function openAdmin() {
    const sheet = (S.sheets.admin ||= makeSheet("sheet--fm-admin"));
    let status = { off: false, message: "" };
    try {
      status = await request("status", {});
    } catch {
      // Не ответил — показываем обычную кнопку: закрыть всё равно можно.
    }
    const head = (title, sub) => {
      const w = document.createElement("div");
      w.className = "fm-sheet-in";
      w.append(Object.assign(document.createElement("h2"), { textContent: title }), Object.assign(document.createElement("p"), { className: "fm-sheet-sub", textContent: sub }));
      return w;
    };
    const home = () => {
      const list = document.createElement("div");
      list.className = "fm-actions";
      if (status.off) {
        list.append(actionRow("check", t("Открыть для всех"), async () => {
          try {
            await request("switch", { off: false });
            status = { off: false, message: "" };
            haptic("success");
            sheet.close();
            toast(t("Подслушка открыта для всех"));
          } catch (error) {
            toast(errorText(error), { tone: "bad", icon: "alert" });
          }
        }, { sub: t("Сейчас закрыта на ремонт") }));
      } else {
        list.append(actionRow("power", t("Закрыть на ремонт"), () => swap(sheet, ask), { bad: true, sub: t("Мгновенно, для всех, кроме вас") }));
      }
      list.append(actionRow("shield", t("Выключатель на GitHub"), () => {
        sheet.close();
        if (tg?.openLink) tg.openLink(GITHUB_SWITCH);
        else window.open(GITHUB_SWITCH, "_blank", "noopener");
      }, { sub: t("Если бот не отвечает: работает без него") }));
      fill(sheet.sh, head(t("Управление Подслушкой"), status.off ? t("Сейчас закрыта на ремонт.") : t("Только для вас.")), list);
    };
    const ask = () => {
      const w = head(t("Закрыть на ремонт?"), t("Подслушка закроется у всех, кроме вас. Откроете обратно в любой момент."));
      const field = document.createElement("input");
      field.type = "text";
      field.maxLength = 120;
      field.placeholder = t("Что написать людям (необязательно)");
      field.className = "fm-admin-field";
      w.append(field);
      const actions = Object.assign(document.createElement("div"), { className: "fm-sheet-actions" });
      const yes = Object.assign(document.createElement("button"), { type: "button", className: "fm-btn", textContent: t("Да, закрыть") });
      yes.style.background = "var(--fm-danger)";
      yes.addEventListener("click", async () => {
        yes.disabled = true;
        try {
          await request("switch", { off: true, message: field.value.trim() });
          haptic("success");
          sheet.close();
          toast(t("Подслушка закрыта на ремонт"), { tone: "warn", icon: "lock" });
        } catch (error) {
          yes.disabled = false;
          toast(errorText(error), { tone: "bad", icon: "alert" });
        }
      });
      const no = Object.assign(document.createElement("button"), { type: "button", className: "fm-btn fm-btn--soft", textContent: t("Отмена") });
      no.addEventListener("click", () => sheet.close());
      actions.append(yes, no);
      fill(sheet.sh, w, actions);
    };
    home();
    sheet.open();
  }

  /* ---------- Новый пост ---------- */

  function openComposer(opts = {}) {
    if (S.banned) return toast(t("Вам закрыт доступ к записям."), { tone: "warn", icon: "lock" });
    haptic("light");
    const sheet = (S.sheets.composer ||= makeSheet("sheet--fm-composer", { input: true }));
    let draft = {};
    try {
      draft = JSON.parse(store(KEY.draft) || "{}");
    } catch {
      draft = {};
    }
    let anon = draft.anon ?? store(KEY.anon) !== "0";
    let withTag = store(KEY.tag) === "1";
    const tagLabel = [tenant()?.university, tenant()?.short].filter(Boolean).join(" · ");

    const box = document.createElement("div");
    box.className = "fm-composer";
    const top = document.createElement("div");
    top.className = "fm-comp-top";
    const cancel = Object.assign(document.createElement("button"), { type: "button", className: "fm-link", textContent: t("Отмена") });
    const title = Object.assign(document.createElement("h2"), { textContent: t("Новый пост") });
    const publish = Object.assign(document.createElement("button"), { type: "button", className: "fm-publish", textContent: t("Опубликовать") });
    top.append(cancel, title, publish);
    // Ответ на «Задание дня» — тема видна прямо над полем.
    const chalNote = opts.challenge ? Object.assign(document.createElement("div"), { className: "fm-comp-chal", textContent: `🎯 ${opts.challenge.text}` }) : null;

    const body = document.createElement("div");
    body.className = "fm-comp-body";
    const ava = document.createElement("span");
    const area = document.createElement("textarea");
    area.maxLength = POST_MAX + 60;
    area.placeholder = pick([
      t("Кто сдавал физику у Петрова? Как лучше готовиться?"),
      t("Где в корпусе можно нормально поесть между парами?"),
      t("Ищу конспекты по микроэкономике, поделитесь?"),
      t("Что у вас на уме? Вопрос, история, совет…"),
    ]);
    area.value = draft.text || "";
    body.append(ava, area);

    const as = document.createElement("div");
    as.className = "fm-comp-as";
    const err = document.createElement("div");
    err.className = "fm-comp-err";

    const tools = document.createElement("div");
    tools.className = "fm-comp-tools";
    const anonChip = document.createElement("button");
    anonChip.type = "button";
    anonChip.className = "fm-chip";
    const tagChip = document.createElement("button");
    tagChip.type = "button";
    tagChip.className = "fm-chip";
    // Счётчик знаков: пока места много — его нет, чтобы не мозолил глаза.
    const ring = document.createElement("div");
    ring.className = "fm-count";
    tools.append(anonChip);
    if (tagLabel) tools.append(tagChip);
    tools.append(ring);

    box.append(...[top, chalNote, body, as, err, tools].filter(Boolean));
    fill(sheet.sh, box);

    const me = { name: S.user.first_name || t("Вы"), hue: hueOf(String(S.user.id || "me")), photo: tg?.initDataUnsafe?.user?.photo_url || S.meAva };
    const faces = () => (anon ? avatar({ name: "?", emoji: "🕶", hue: 222 }) : avatar(me));
    let face = faces();
    ava.replaceWith(face);
    const redraw = (animated) => {
      anonChip.classList.toggle("is-on", anon);
      anonChip.replaceChildren(icon(anon ? "mask" : "person"), document.createTextNode(anon ? t("Анонимно") : t("От вашего имени")));
      tagChip.classList.toggle("is-on", withTag);
      tagChip.replaceChildren(icon("building"), document.createTextNode(tagLabel));
      const nick = S.user.username;
      as.replaceChildren(
        document.createTextNode(
          anon
            ? t("Другие увидят «Аноним …». ")
            : nick
              ? t("Другие увидят ваше имя и смогут перейти в ваш Telegram (@{nick}). ", { nick })
              : t("Другие увидят ваше имя. ")
        ),
        Object.assign(document.createElement("b"), { textContent: anon ? t("Администратор видит автора.") : "" })
      );
      if (animated) {
        const next = faces();
        face.replaceWith(next);
        face = next;
        animate(next, [{ transform: "scale(0.6) rotate(-30deg)", opacity: 0 }, { transform: "none", opacity: 1 }], { duration: 320, easing: "cubic-bezier(0.34,1.56,0.64,1)" });
      }
    };
    const update = () => {
      const len = area.value.trim().length;
      const ready = len >= 3 && len <= POST_MAX;
      publish.classList.toggle("is-ready", ready);
      const left = POST_MAX - len;
      ring.textContent = left <= 100 ? String(left) : "";
      ring.classList.toggle("is-warn", left <= 40 && left >= 0);
      ring.classList.toggle("is-over", left < 0);
    };
    let saveTimer = 0;
    const saveDraft = () => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        const text = area.value;
        store(KEY.draft, text.trim() ? JSON.stringify({ text, anon }) : null);
      }, 300);
    };
    const clearErr = () => err.classList.remove("is-on");
    const showErr = (message) => {
      err.replaceChildren(icon("alert"), Object.assign(document.createElement("span"), { textContent: message }));
      err.classList.add("is-on");
      haptic("error");
      animate(err, [{ transform: "translate3d(0,0,0)" }, { transform: "translate3d(-7px,0,0)" }, { transform: "translate3d(7px,0,0)" }, { transform: "translate3d(-4px,0,0)" }, { transform: "translate3d(0,0,0)" }], { duration: 340, easing: "ease-out" });
    };

    area.addEventListener("input", () => {
      update();
      clearErr();
      saveDraft();
    });
    area.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        submit();
      }
    });
    anonChip.addEventListener("click", () => {
      anon = !anon;
      store(KEY.anon, anon ? "1" : "0");
      haptic("select");
      redraw(true);
      saveDraft();
    });
    tagChip.addEventListener("click", () => {
      withTag = !withTag;
      store(KEY.tag, withTag ? "1" : "0");
      haptic("select");
      redraw(false);
    });
    cancel.addEventListener("click", () => {
      sheet.close();
      if (area.value.trim()) toast(t("Черновик сохранён"), { icon: "pen", ms: 1800 });
    });
    let busy = false;
    const submit = async () => {
      if (busy) return;
      const text = area.value.trim();
      if (text.length < 3) return showErr(t("Напишите хотя бы пару фраз :P"));
      const bad = precheck(text);
      if (bad) return showErr(bad);
      busy = true;
      publish.classList.add("is-busy");
      clearErr();
      try {
        const res = await request("post", { text, anon, tag: withTag ? tagLabel : "", challenge: opts.challenge?.day || undefined });
        haptic("success");
        store(KEY.draft, null);
        area.value = "";
        update();
        sheet.close();
        // Сначала окно уходит, потом пост въезжает: так глаз успевает увидеть, куда он делся.
        setTimeout(() => {
          if (S.sort !== "new") {
            S.sort = "new";
            syncSeg();
            S.posts.set(res.post.id, res.post);
            load(true, { silent: true });
          } else insertRow(res.post);
          smoothScroll(S.scroll, 0);
          if (res.pending) toast(t("Пост на проверке — появится после одобрения."), { tone: "warn", icon: "clock", ms: 3800 });
          else toast(t("Опубликовано"), { icon: "check" });
        }, 260);
      } catch (error) {
        showErr(errorText(error));
      } finally {
        busy = false;
        publish.classList.remove("is-busy");
      }
    };
    publish.addEventListener("click", submit);
    // Окно закрыли любым способом (кнопкой, свайпом, тапом мимо) — черновик
    // сохраняем сразу и показываем его в строке «Что у вас на уме?».
    sheet.onHide = () => {
      clearTimeout(saveTimer);
      const text = area.value;
      store(KEY.draft, text.trim() ? JSON.stringify({ text, anon }) : null);
      renderPrompt();
    };
    if (!sheet.watching) {
      sheet.watching = new MutationObserver(() => {
        if (sheet.backdrop.hidden) sheet.onHide?.();
      });
      sheet.watching.observe(sheet.backdrop, { attributes: true, attributeFilter: ["hidden"] });
    }
    redraw(false);
    update();
    sheet.open();
    // Фокус — в том же нажатии: iOS и Telegram поднимают клавиатуру, только
    // если поле получило фокус прямо из касания, а не через таймер.
    area.focus({ preventScroll: true });
    setTimeout(() => {
      if (document.activeElement !== area) area.focus({ preventScroll: true });
    }, 320);
  }

  const pick = (list) => list[Math.floor(Math.random() * list.length)];

  window.showForum = showForum;
})();

