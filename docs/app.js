const tg = window.Telegram?.WebApp;

/* ---------- Язык ---------- */

// Язык выбирает index.html до загрузки: словарь (i18n.js) подключается
// только для нерусского, русским он не стоит ни байта.
const LANG = window.__lang || "ru";
const DICT = window.I18N?.[LANG] || {};
const LOCALE = { ru: "ru-RU", en: "en-GB", zh: "zh-CN", ko: "ko-KR" }[LANG] || "ru-RU";
const LANG_KEY = "schedule.lang";

/** Перевод по русской строке-ключу; {n} подставляются. Нет перевода — русский. */
function t(text, vars) {
  const template = DICT[text] ?? text;
  return vars ? template.replace(/\{(\w+)\}/g, (_, key) => vars[key]) : template;
}

// Названия предметов: data/subjects.json, общий с ботом. Новый предмет без
// перевода показывается по-русски — ничего не ломается.
let SUBJECTS = {};

function tr(subject) {
  return (LANG !== "ru" && SUBJECTS[subject]?.[LANG]) || subject;
}

const MONTHS_GENITIVE = [
  "января", "февраля", "марта", "апреля", "мая", "июня",
  "июля", "августа", "сентября", "октября", "ноября", "декабря",
];

/** Пометки из PDF: «с 16.09.2026 года; на английском языке». */
function trNote(note) {
  if (LANG === "ru") return note;
  return note
    .split("; ")
    .map((part) => {
      let match = part.match(/^с (\d{1,2}\.\d{2})\.\d{4}(?: года)?$/);
      if (match) return t("с {date}", { date: match[1] });
      match = part.match(/^с (\d{1,2}) ([а-я]+) \d{4} года$/);
      if (match && MONTHS_GENITIVE.includes(match[2])) {
        const month = String(MONTHS_GENITIVE.indexOf(match[2]) + 1).padStart(2, "0");
        return t("с {date}", { date: `${match[1].padStart(2, "0")}.${month}` });
      }
      match = part.match(/^(\d{2}\.\d{2})\.\d{4} разово отмена$/);
      if (match) return t("{date} — разовая отмена", { date: match[1] });
      return t(part);
    })
    .join("; ");
}

/** Статичные тексты из index.html: помечены data-i18n, ключ — сам текст. */
function translatePage() {
  if (LANG === "ru") return;
  for (const node of document.querySelectorAll("[data-i18n]")) {
    node.textContent = t(node.textContent.replace(/\s+/g, " ").trim());
  }
  for (const node of document.querySelectorAll("[placeholder]")) {
    node.placeholder = t(node.placeholder);
  }
  for (const node of document.querySelectorAll("[aria-label]")) {
    node.setAttribute("aria-label", t(node.getAttribute("aria-label")));
  }
  for (const node of document.querySelectorAll("optgroup[data-i18n-label]")) {
    node.label = t(node.label);
  }
}
const STORAGE_KEY = "schedule.prefs";

// Шрифт цифр — дело вкуса и к расписанию не относится: хранится отдельно
// от настроек группы и не сбрасывается при смене факультета.
const DIGITS = { tall: "Вытянутый", pixel: "Пиксельный", plain: "Обычный" };
// Два независимых выбора: цифры (числа дней, время пар) и шапка (день и дата).
const FONT_PICKS = [
  { attr: "digits", key: "schedule.digits", title: "Шрифт цифр", sample: () => "09:00" },
  { attr: "head", key: "schedule.head", title: "Шрифт шапки", sample: () => t("Суббота") },
];
function fontStyle(pick) {
  try {
    const saved = localStorage.getItem(pick.key);
    return DIGITS[saved] ? saved : "tall";
  } catch {
    return "tall";
  }
}
for (const pick of FONT_PICKS) document.body.dataset[pick.attr] = fontStyle(pick);

// Светлая или тёмная тема. По умолчанию — как в Telegram; выбор человека
// сильнее и хранится на устройстве. Цвета заданы в index.html, чтобы
// заставка сразу была нужного цвета.
const SCHEME_KEY = "schedule.scheme";
const SCHEMES = { auto: "Как в Telegram", light: "Светлая", dark: "Тёмная" };
const SCHEME_BG = { light: "#ffffff", dark: "#16181d" };

function scheme() {
  try {
    const saved = localStorage.getItem(SCHEME_KEY);
    return saved === "light" || saved === "dark" ? saved : "auto";
  } catch {
    return "auto";
  }
}

function applyScheme(value = scheme()) {
  if (value === "auto") delete document.documentElement.dataset.scheme;
  else document.documentElement.dataset.scheme = value;
  // Шапка и фон самого окна Telegram — в тон, иначе вокруг останется рамка другого цвета.
  const telegram = window.Telegram?.WebApp;
  try {
    telegram?.setHeaderColor?.(value === "auto" ? "bg_color" : SCHEME_BG[value]);
    telegram?.setBackgroundColor?.(value === "auto" ? "bg_color" : SCHEME_BG[value]);
  } catch {
    // Старый клиент не умеет — останется рамка, расписанию это не мешает.
  }
}
applyScheme();
// Где живёт бот: свой сервер в России. Прежний адрес в Cloudflare остался
// переходником для версий приложения, которые ещё лежат в кэше.
const API_URL = "https://api.bodryash.ru";
const HIT_URL = `${API_URL}/hit`;

/**
 * Сообщает воркеру, что расписание открыли: обезличенный счётчик, чтобы
 * понимать, каким курсам приложение нужно, а до кого ссылка не дошла.
 * Отправляем подписанный Telegram initData — иначе счётчик накрутит кто
 * угодно одной командой. Вне Telegram не считаем.
 */
function countOpen(group) {
  if (!tg?.initData) return;
  try {
    const body = JSON.stringify({ initData: tg.initData, group });
    navigator.sendBeacon(HIT_URL, new Blob([body], { type: "text/plain" }));
  } catch {
    // Счётчик не должен мешать расписанию работать.
  }
}

/* ---------- Объявления ---------- */

// Объявления об изменениях публикует владелец командой /notice боту. Сайт
// статический, поэтому за ними ходим к воркеру.
const NOTICES_URL = `${API_URL}/notices`;
const DISMISSED_KEY = "schedule.dismissedNotices";

// cancels — отменённые пары (/cancel), приходят тем же запросом.
// homework — домашка группы, canEdit — открыл староста этой группы,
// weeks — недели, чья домашка уже загружена или грузится.
let notices = {
  group: null,
  list: [],
  cancels: [],
  changes: [],
  homework: [],
  canEdit: false,
  canComment: false,
  comments: new Map(),
  weeks: new Set(),
};

function readDismissed() {
  try {
    return JSON.parse(localStorage.getItem(DISMISSED_KEY) || "[]");
  } catch {
    return [];
  }
}

function dismissNotice(id) {
  try {
    const ids = [...readDismissed(), id].slice(-50);
    localStorage.setItem(DISMISSED_KEY, JSON.stringify(ids));
  } catch {
    // Не запомнили — плашка вернётся при следующем открытии, и только.
  }
}

/** Грузим один раз на группу: листание дней не должно дёргать сеть. */
async function loadNotices(group) {
  const groupId = group.id;
  if (notices.group === groupId) return;
  // Режим преподавателя: групп много, объявления и отмены — у каждой свои.
  // В первой версии их не грузим, показываем чистое расписание.
  if (group.teacher) {
    notices = { ...notices, group: groupId, list: [], cancels: [], changes: [], homework: [], owner: false,
      canEdit: false, canComment: false, comments: new Map(), weeks: new Set([0, 1]) };
    renderNotices(false);
    return;
  }
  // Домашку при открытии берём только на показанную неделю; вторую —
  // когда до неё долистают. Так запрос вдвое легче.
  notices = {
    group: groupId,
    list: [],
    cancels: [],
    changes: [],
    homework: [],
    canEdit: false,
    // Комментарии: право писать и счётчики «день|предмет» → число.
    canComment: false,
    comments: new Map(),
    weeks: new Set([selectedWeek]),
  };
  renderNotices(false);
  try {
    // Курс и ступень — для объявлений на весь курс («/notice 3курс»).
    // Подпись Telegram — чтобы воркер узнал старосту; в теле, не в адресе.
    // Тело без content-type уходит как text/plain — без лишнего
    // предварительного запроса, который браузер шлёт для JSON.
    const res = await fetch(NOTICES_URL, {
      method: "POST",
      body: JSON.stringify({
        group: groupId,
        course: group.course,
        level: group.level,
        initData: tg?.initData || "",
        ...weekRange(selectedWeek),
      }),
    });
    if (!res.ok) return;
    const body = await res.json();
    if (notices.group !== groupId) return;
    // Заблокированному расписание не показываем совсем.
    if (body.ban) return showBanned(body.ban);
    notices.list = body.notices || [];
    notices.cancels = body.cancels || [];
    notices.changes = body.changes || [];
    notices.owner = Boolean(body.owner);
    applyTheme(body.theme || "");
    notices.important = body.important || [];
    saveHello(body.hello || "");
    notices.homework = body.homework || [];
    notices.canEdit = Boolean(body.canEdit);
    notices.canComment = Boolean(body.canComment);
    notices.deadlines = body.deadlines || [];
    notices.polls = body.polls || [];
    renderPolls();
    if (tab === "deadlines") renderDeadlines();
    mergeCommentCounts(weekRange(selectedWeek), body.comments);
    renderNotices(true);
    if (tab === "week") showWeek();
    // Замены меняют саму карточку (время, преподавателя), поверх её не
    // наложить — перерисовываем день, только если он задет.
    if (notices.changes.some((c) => c.day === isoDate(dateOfDay(selectedDay)))) {
      renderLessons(group, weekParity(data.weeks));
    }
    applyCancels();
    applyHomework();
    // Точки под датами — без отменённых пар, как и заставка.
    if (!els.schedule.hidden && notices.cancels.length) renderDays();
    // Отмены приехали — план для напоминаний надо пересобрать с ними.
    sendReminderSettings();
  } catch {
    // Без объявлений расписание остаётся расписанием.
  }
}

function renderNotices(animate) {
  const dismissed = readDismissed();
  const nodes = notices.list
    .filter((n) => !dismissed.includes(n.id))
    .map((n) => {
      // Цвет задаёт владелец (/notice … #красный); неизвестный — обычный жёлтый.
      const color = ["yellow", "red", "green", "blue", "gray"].includes(n.color) ? n.color : "yellow";
      const node = el("div", `notice notice--${color}${animate ? " notice--enter" : ""}`);
      const close = el("button", "notice-close", "×");
      close.type = "button";
      close.setAttribute("aria-label", t("Скрыть объявление"));
      close.addEventListener("click", () => {
        haptic("light");
        dismissNotice(n.id);
        node.remove();
      });
      const body = el("div", "notice-text");
      // Личное — видит только этот человек; пусть это будет понятно.
      if (n.personal) body.append(el("span", "notice-personal", t("лично вам")));
      body.append(document.createTextNode(n.text));
      node.append(body, close);
      return node;
    });
  els.notices.replaceChildren(...nodes);
}

/**
 * Замена на показанный день (/change): другое время, преподаватель или
 * аудитория у одной пары. Возвращает изменённую копию занятия.
 */
function withChange(lesson, date = dateOfDay(selectedDay)) {
  const day = isoDate(date);
  const change = notices.changes.find(
    (c) =>
      c.day === day &&
      c.slots.includes(lesson.slot) &&
      (!c.subject || c.subject === lesson.subject) &&
      (!c.subgroup || c.subgroup === lesson.subgroup) &&
      (!c.from_teacher || lesson.teacher.includes(c.from_teacher))
  );
  if (!change) return lesson;
  const copy = { ...lesson };
  if (change.teacher) copy.teacher = change.teacher;
  if (change.room) copy.room = change.room;
  // Новое время — сдвиг всего блока: «3–4 пара с 12:00» сдвигает обе
  // пары на час, перемена между ними остаётся прежней.
  const bells = new Map(data.bells.map((b) => [b.n, b]));
  const first = bells.get(Math.min(...change.slots));
  const own = bells.get(lesson.slot);
  if (change.start && first && own) {
    const shift = minutes(change.start) - minutes(first.start);
    const at = (time) => {
      const m = minutes(time) + shift;
      return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
    };
    copy.start = at(own.start);
    copy.end = at(own.end);
  }
  copy.note = [lesson.note, change.reason || t("Изменение")].filter(Boolean).join(" · ");
  return copy;
}

/**
 * Отмены в показанный день, задевающие пару и предмет. Отмена по номеру
 * пары (без предмета) задевает всё; без номеров — весь день.
 */
function cancelsFor(slot, subject) {
  const day = isoDate(dateOfDay(selectedDay));
  return notices.cancels.filter(
    (c) =>
      c.day === day &&
      (!c.slots.length || c.slots.includes(slot)) &&
      (!c.subject || c.subject === subject)
  );
}

/** Отменено ли занятие в конкретный день — без опоры на выбранный день. */
function lessonCancelOn(lesson, day) {
  return (
    notices.cancels.find(
      (c) =>
        c.day === day &&
        (!c.slots.length || c.slots.includes(lesson.slot)) &&
        (!c.subject || c.subject === lesson.subject) &&
        (!c.subgroup || c.subgroup === lesson.subgroup)
    ) || null
  );
}

/**
 * Отменено ли конкретное занятие. Отмена по преподавателю несёт подгруппу:
 * заболел преподаватель одной языковой подгруппы — у остальных пара идёт.
 */
function lessonCancel(lesson) {
  return (
    cancelsFor(lesson.slot, lesson.subject).find(
      (c) => !c.subgroup || c.subgroup === lesson.subgroup
    ) || null
  );
}

/**
 * Зачёркивает отменённые пары поверх готовых карточек, как refreshNow:
 * отмены приходят позже расписания, и перерисовка заново проиграла бы
 * появление списка.
 */
function applyCancels() {
  for (const card of els.lessons.querySelectorAll(".card")) {
    const subgroups = cardSubgroups(card);
    const slotsOfCard = cardSlots(card);

    // Склеенная карточка «1–6 пара»: отменены все пары — гаснет целиком,
    // часть — подписываем, какие именно.
    if (slotsOfCard.length > 1) {
      const cancelled = slotsOfCard
        .map((slot) => ({ slot, cancel: cancelsFor(slot, card.dataset.subject).find((c) => !c.subgroup) }))
        .filter((x) => x.cancel);
      const all = cancelled.length === slotsOfCard.length;
      card.classList.toggle("card--cancelled", all);
      const off = new Set(cancelled.map((x) => x.slot));
      for (const row of card.querySelectorAll(".segment")) {
        row.classList.toggle("segment--cancelled", off.has(Number(row.dataset.slot)));
      }
      let note = card.querySelector(".cancel-note");
      if (!cancelled.length) {
        note?.remove();
        continue;
      }
      if (!note) {
        note = el("div", "cancel-note");
        (card.querySelector(".card-body") || card).append(note);
      }
      const label = all
        ? t("Отменена")
        : t("Отменена: {slots} пара", { slots: cancelled.map((x) => x.slot).join(", ") });
      const reason = cancelled[0].cancel.reason;
      note.textContent = reason ? `${label} · ${reason}` : label;
      continue;
    }

    const matches = cancelsFor(Number(card.dataset.slot), card.dataset.subject);
    // Целиком — если отмена без подгруппы или отменены все подгруппы карточки.
    const whole =
      matches.find((c) => !c.subgroup) ||
      (subgroups.length && subgroups.every((n) => matches.some((c) => c.subgroup === n))
        ? matches[0]
        : null);
    // Иначе — только у части подгрупп: карточка не гаснет, но это видно.
    const partial = whole ? [] : matches.filter((c) => c.subgroup && subgroups.includes(c.subgroup));

    card.classList.toggle("card--cancelled", Boolean(whole));
    let note = card.querySelector(".cancel-note");
    if (!whole && !partial.length) {
      note?.remove();
      continue;
    }
    if (!note) {
      note = el("div", "cancel-note");
      (card.querySelector(".card-body") || card).append(note);
    }
    const cancel = whole || partial[0];
    const label = whole
      ? t("Отменена")
      : t("Отменена у {groups}", {
          groups: [...new Set(partial.map((c) => c.subgroup))]
            .sort((a, b) => a - b)
            .map((n) => t("гр. {n}", { n }))
            .join(", "),
        });
    note.textContent = cancel.reason ? `${label} · ${cancel.reason}` : label;
  }
  refreshNow();
  refreshNext();
  renderRibbon();
  renderNowCard();
}

/* ---------- Домашка ---------- */

const HOMEWORK_URL = `${API_URL}/homework`;

/** Понедельник–суббота недели ленты (0 — текущая) для запроса домашки. */
function weekRange(week) {
  return { from: isoDate(dateOfDay(1, week)), to: isoDate(dateOfDay(DAYS.length, week)) };
}

/** Догружает домашку недели, когда её пролистали. Каждую — один раз. */
async function ensureHomeworkWeek(week) {
  const groupId = notices.group;
  if (!groupId || groupId.startsWith("teacher:") || notices.weeks.has(week)) return;
  notices.weeks.add(week);
  try {
    const res = await fetch(`${HOMEWORK_URL}/list`, {
      method: "POST",
      // Подпись — только ради счётчиков комментариев своей группы.
      body: JSON.stringify({ group: groupId, initData: tg?.initData || "", ...weekRange(week) }),
    });
    if (!res.ok) throw new Error(res.status);
    const body = await res.json();
    if (notices.group !== groupId) return;
    const { from, to } = weekRange(week);
    notices.homework = notices.homework
      .filter((h) => h.day < from || h.day > to)
      .concat(body.homework || []);
    mergeCommentCounts({ from, to }, body.comments);
    applyHomework();
  } catch {
    // Не вышло — попробуем при следующем заходе на эту неделю.
    if (notices.group === groupId) notices.weeks.delete(week);
  }
}

/** Подгруппы карточки: у языковых пар в одной карточке их несколько. */
function cardSubgroups(card) {
  return (card.dataset.subgroups || "").split(",").filter(Boolean).map(Number);
}

/** Домашка к карточке в показанный день: всей группе или своим подгруппам. */
function homeworkFor(card) {
  const day = isoDate(dateOfDay(selectedDay));
  const subgroups = cardSubgroups(card);
  return notices.homework.filter(
    (h) =>
      h.day === day &&
      h.subject === card.dataset.subject &&
      (!h.subgroup || !subgroups.length || subgroups.includes(h.subgroup))
  );
}

/**
 * Домашка под парой — поверх готовых карточек, как отмены. Предмет,
 * который идёт двумя парами подряд, получает её только у первой: иначе
 * одно задание стояло бы дважды.
 */
function applyHomework() {
  applyImportant();
  applyAbsenceButtons();
  applyMine();
  applyNotes();
  const seen = new Set();
  for (const card of els.lessons.querySelectorAll(".card")) {
    card.querySelector(".hw")?.remove();
    card.querySelector(".owner-actions")?.remove();
    const subject = card.dataset.subject;
    // Отмена пары — у владельца и у старосты своей группы.
    if (subject && (notices.owner || notices.canEdit)) addOwnerButtons(card);
    if (!subject || seen.has(subject)) continue;
    seen.add(subject);

    const items = homeworkFor(card);
    if (!items.length && !notices.canEdit && !notices.canComment) continue;

    const block = el("div", "hw");
    for (const item of items) {
      const line = el("div", "hw-item");
      line.append(el("span", "hw-label", t("ДЗ")));
      const prefix = item.subgroup ? `${t("гр. {n}", { n: item.subgroup })}: ` : "";
      line.append(el("span", "hw-text", prefix + item.text));
      block.append(line);
    }

    // Кнопки под парой в один ряд: домашка у старосты, комментарии у группы.
    const actions = el("div", "card-actions");
    if (notices.canEdit && els.hwSheet) {
      const button = el("button", "hw-edit", t(items.length ? "Изменить ДЗ" : "＋ ДЗ"));
      button.type = "button";
      button.addEventListener("click", () => openHomework(card));
      actions.append(button);
    }
    if (notices.canComment && els.cmSheet) {
      const count = notices.comments.get(commentKey(isoDate(dateOfDay(selectedDay)), subject)) || 0;
      const button = el("button", count ? "cm-open cm-open--has" : "cm-open", count ? `💬 ${count}` : "💬");
      button.type = "button";
      button.setAttribute("aria-label", t("Комментарии"));
      button.addEventListener("click", () => openComments(card));
      actions.append(button);
    }
    if (actions.children.length) block.append(actions);
    (card.querySelector(".card-body") || card).append(block);
  }
}

/**
 * Клавиатура выезжает не мгновенно, и если подтягивать поле сразу, экран
 * дёргается: страница прыгает, пока телефон меняет высоту окна. Поэтому
 * ждём, пока окно перестанет меняться, и только потом один раз подводим
 * поле к нужному месту.
 */
function keepFieldVisible() {
  let timer = null;
  const settle = (node) => {
    clearTimeout(timer);
    // В окне снизу поле уже на месте: окно само держится над клавиатурой.
    // Лишняя прокрутка здесь и давала «кашу» — окно ехало вверх, клавиатура
    // выезжала, а следом ещё и содержимое подпрыгивало к середине.
    if (node.closest?.(".sheet")) return;
    timer = setTimeout(() => {
      if (document.activeElement !== node) return;
      node.scrollIntoView({ block: "center", behavior: "smooth" });
    }, 350);
  };

  document.addEventListener("focusin", (event) => {
    const node = event.target;
    if (!node.matches?.("input, textarea")) return;
    // Телеграм умеет сам держать приложение развёрнутым — так экран не
    // складывается пополам, когда появляется клавиатура.
    tg?.expand?.();
    // Полоса разделов на время набора гаснет. С места она не сходит
    // никогда — см. pinTabs().
    document.body.classList.add("typing");
    settle(node);
    // Окно меняет высоту несколько раз подряд; подводим поле после последнего.
    const viewport = window.visualViewport;
    const onResize = () => settle(node);
    viewport?.addEventListener("resize", onResize);
    node.addEventListener(
      "blur",
      () => {
        clearTimeout(timer);
        document.body.classList.remove("typing");
        viewport?.removeEventListener("resize", onResize);
      },
      { once: true }
    );
  });
}

/** Пятый тап по дате — конфетти. Просто так. */
function initConfetti() {
  let taps = 0;
  let timer = null;
  els.dateLabel?.addEventListener("click", () => {
    taps += 1;
    clearTimeout(timer);
    timer = setTimeout(() => (taps = 0), 1500);
    if (taps < 5) return;
    taps = 0;
    showConfetti();
    haptic("success");
  });
}

function showConfetti() {
  const box = el("div", "confetti");
  // У чемпиона и салют золотой.
  const colors = document.body.classList.contains("champion")
    ? ["#ffd700", "#f5c542", "#e6b422", "#fff3b0", "#d4a017", "#ffcc4d"]
    : document.body.classList.contains("cska")
    ? ["#e4002b", "#0b3ea8", "#ff3b5c", "#2f6bff", "#ffffff", "#b80022"]
    : ["#ff2d87", "#ffd166", "#4c6ef5", "#2ea6ff", "#40c057", "#ff922b"];
  for (let i = 0; i < 40; i++) {
    const piece = el("i");
    piece.style.left = `${Math.random() * 100}%`;
    piece.style.background = colors[i % colors.length];
    piece.style.animationDelay = `${Math.random() * 0.4}s`;
    piece.style.transform = `rotate(${Math.random() * 180}deg)`;
    box.append(piece);
  }
  document.body.append(box);
  setTimeout(() => box.remove(), 2600);
}

/* ---------- События факультета ---------- */

// Праздники, которых нет в расписании. За несколько дней в шапке горит
// плашка с отсчётом. Тем, чей это праздник, — огонёк на плитке дня и
// конфетти при первом открытии в сам день.
//
// Сейчас событий нет — расписание в штатном режиме. Посвящение 2026 прошло
// так (образец для следующего праздника):
//   {
//     id: "posvyat-2026",
//     date: "2026-10-02",
//     title: "Посвящение первокурсников",
//     place: "Красновидово",
//     icon: "🔥",
//     // До этого момента плашка — кликер с таблицей лидеров.
//     clicker: "2026-10-03T00:00:00+03:00",
//     // До этого дня плашка висит с итогами кликера.
//     until: "2026-10-05",
//     // Свои — те, чей это праздник.
//     ours: (group) => !group.teacher && group.level === "бакалавриат" && group.course === 1,
//   },
// Кликеру нужен и сервер: событие и срок — в CLICKER в worker/src/index.js.
const EVENTS = [];
// За сколько дней до события появляется плашка.
const EVENT_AHEAD = 3;
const EVENT_CELEBRATED_KEY = "schedule.eventsCelebrated";

function daysUntil(iso, now = new Date()) {
  // Полдень, а не полночь: переход на летнее время не съест сутки.
  return Math.round((new Date(`${iso}T12:00:00`) - new Date(`${isoDate(now)}T12:00:00`)) / 86400000);
}

function upcomingEvent() {
  for (const event of EVENTS) {
    // days < 0 — праздник прошёл, но плашка ещё висит с итогами.
    const days = daysUntil(event.date);
    const last = event.until ? daysUntil(event.until) : days;
    if (days <= EVENT_AHEAD && last >= 0) return { ...event, days };
  }
  return null;
}

function eventOn(iso) {
  return EVENTS.find((event) => event.date === iso) || null;
}

function storedList(key) {
  try {
    return JSON.parse(localStorage.getItem(key) || "[]");
  } catch {
    return [];
  }
}

function storeInList(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify([...storedList(key), value].slice(-20)));
  } catch {
    // Без хранилища плашка просто покажется снова.
  }
}

/** Ёлки по нижнему краю плашки: дальний ряд светлее, ближний темнее. */
function forestSvg() {
  const row = (count, min, max, cls, shift) => {
    let d = "";
    for (let i = 0; i < count; i++) {
      const x = (i + 0.5) * (400 / count) + ((i * 37 + shift) % 11) - 5;
      const h = min + (((i * 53 + shift) % 17) / 16) * (max - min);
      const w = h * 0.34;
      const f = (n) => n.toFixed(1);
      d += `M${f(x - w)} 40L${f(x)} ${f(40 - h * 0.8)}L${f(x + w)} 40Z`;
      d += `M${f(x - w * 0.72)} ${f(40 - h * 0.42)}L${f(x)} ${f(40 - h)}L${f(x + w * 0.72)} ${f(40 - h * 0.42)}Z`;
    }
    return `<path class="${cls}" d="${d}"/>`;
  };
  return (
    `<svg class="event-forest" viewBox="0 0 400 40" preserveAspectRatio="xMidYMax slice">` +
    row(30, 12, 22, "event-trees-far", 3) +
    row(19, 16, 31, "event-trees", 0) +
    `</svg>`
  );
}

let eventBox = null;

function renderEvent() {
  const group = activeGroup();
  const event = group ? upcomingEvent() : null;
  const stamp = event ? `${event.id}:${event.days === 0 ? "day" : event.days > 0 ? "before" : "after"}` : "";
  // Итоги — это итоги кликера: преподавателям, которые не играли, они ни к чему.
  const relevant = Boolean(event) && (event.days >= 0 || (Boolean(event.clicker) && !group.teacher));
  // Плашка висит всегда: крестик закрывали случайно, пытаясь кликать, и
  // теряли кликер. Скрытые раньше плашки тоже возвращаются.
  const show = relevant;
  const ours = show && event.ours(group);
  if (!eventBox) {
    eventBox = el("div", "event-box");
    // Коробку вставляем сами: в старой закэшированной разметке её нет.
    (document.getElementById("remind-ask") || els.days).before(eventBox);
  }
  // Перерисовываем, только если что-то поменялось: showSchedule зовётся на
  // каждом листании дня, а искры и выезд не должны начинаться заново.
  const key = show ? `${stamp}:${event.days}:${ours}:${group.id}` : "";
  if (eventBox.dataset.key === key) return;
  eventBox.dataset.key = key;
  if (!show) return eventBox.replaceChildren();

  const card = el("div", `event${ours ? " event--ours" : ""}${event.days === 0 ? " event--today" : ""}`);
  const when =
    event.days < 0
      ? t("Итоги")
      : event.days === 0
      ? t("Сегодня")
      : event.days === 1
        ? t("Завтра")
        : event.days === 2
          ? t("Послезавтра")
          : t("Через {n} дн.", { n: event.days });
  const text = el("div", "event-text");
  text.append(el("span", "event-when", `${when} · ${t(event.place)}`), el("b", "event-title", t(event.title)));
  const sub =
    event.days < 0
      ? ours
        ? t("Добро пожаловать на ФГП! 🎓")
        : ""
      : ours
        ? event.days === 0
          ? t("Добро пожаловать на ФГП! Это твой день 🎉")
          : t("Это твой праздник — ждём тебя!")
        : group.teacher
          ? ""
          : t("Поздравь первокурсников 🙌");
  if (sub) text.append(el("span", "event-sub", sub));
  // Играют все студенты; преподавателям плашка — просто новость.
  const playing = Boolean(event.clicker) && !group.teacher;
  if (playing) text.append(clickerRow(event));

  const scene = el("div", "event-scene");
  scene.setAttribute("aria-hidden", "true");
  scene.innerHTML = forestSvg();
  const sparks = el("span", "event-sparks");
  for (let i = 0; i < 10; i++) {
    const spark = el("i");
    spark.style.setProperty("--dx", `${Math.round(Math.random() * 28 - 14)}px`);
    spark.style.setProperty("--delay", `${(i * 0.27 + Math.random() * 0.2).toFixed(2)}s`);
    sparks.append(spark);
  }
  const fire = el("span", "event-fire", event.icon);
  scene.append(sparks, fire);

  if (playing) {
    // Нажатие — по касанию, а не по «клику»: так засчитывается каждый палец
    // и нет задержки, которую браузер держит, ожидая двойного тапа.
    card.classList.add("event--clicker");
    card.addEventListener("pointerdown", (e) => {
      if (e.target.closest("button")) return;
      clickerTap(e, card, fire);
    });
  } else {
    // Тап по плашке — салют. Просто чтобы было приятно.
    card.addEventListener("click", () => {
      haptic("success");
      showConfetti();
      fire.animate(
        [{ transform: "scale(1)" }, { transform: "scale(1.45) translateY(-3px)", offset: 0.4 }, { transform: "scale(1)" }],
        { duration: 520, easing: "cubic-bezier(0.3, 1.5, 0.5, 1)" }
      );
      burstSparks(card);
    });
  }

  card.append(scene, text);
  eventBox.replaceChildren(card);

  // Заставка ещё на экране — конфетти запустит она, когда уйдёт.
  const splash = els.splash;
  if (!splash || !splash.isConnected || splash.classList.contains("splash--gone")) celebrateEvent();
}

function burstSparks(card) {
  card.classList.remove("event--burst");
  void card.offsetWidth;
  card.classList.add("event--burst");
}

/* ---------- Кликер посвящения ---------- */

// Плашка праздника — ещё и кликер: кто нажмёт больше всех до конца, тот
// получает приз. Нажатия копятся здесь и уходят пачкой раз в несколько
// секунд: запрос на каждое нажатие съел бы дневной лимит бота за час.
const CLICKER_URL = `${API_URL}/clicker`;
// Пачка раз в 15 секунд: у бота 100 тысяч запросов и записей в базу на
// сутки на всё сразу, и при частых пачках сотни кликающих выбрали бы их к
// вечеру — встали бы и кликер, и напоминания, и отмены пар. Сервер может
// прислать интервал побольше, если запас начнёт кончаться.
const CLICKER_FLUSH = 15000;
const CLICKER_LOCAL = "schedule.clicker";
const NUMBER = new Intl.NumberFormat(LANG === "ru" ? "ru-RU" : LANG);
const clicker = {
  event: "",
  ends: 0,
  mine: 0,
  pending: 0,
  board: null,
  told: false,
  busy: false,
  timer: 0,
  view: "players",
  flush: CLICKER_FLUSH,
  pulse: null,
  bump: null,
};
let clickerNodes = null;
let clickerHooked = false;

function clickerEnded() {
  return Boolean(clicker.ends) && Date.now() >= clicker.ends;
}

function saveClickerLocal() {
  try {
    const { event, mine, pending, told } = clicker;
    localStorage.setItem(CLICKER_LOCAL, JSON.stringify({ event, mine, pending, told }));
  } catch {
    // Без хранилища счёт всё равно придёт с сервера.
  }
}

function readClickerLocal() {
  try {
    return JSON.parse(localStorage.getItem(CLICKER_LOCAL) || "{}") || {};
  } catch {
    return {};
  }
}

/** Строка под заголовком плашки: свои нажатия, место и кнопка таблицы. */
function clickerRow(event) {
  if (clicker.event !== event.id) {
    clicker.event = event.id;
    clicker.ends = Date.parse(event.clicker);
    const saved = readClickerLocal();
    if (saved.event === event.id) {
      clicker.mine = Number(saved.mine) || 0;
      // Не успевшие уйти нажатия прошлого раза отправим сейчас.
      clicker.pending = Number(saved.pending) || 0;
      clicker.told = Boolean(saved.told);
    }
  }
  const row = el("div", "event-clicker");
  const count = el("span", "event-count");
  const place = el("span", "event-place");
  const top = el("button", "event-top", `🏆 ${t("Топ")}`);
  top.type = "button";
  top.setAttribute("aria-label", t("Таблица лидеров"));
  top.addEventListener("click", (e) => {
    e.stopPropagation();
    openClickerSheet();
  });
  row.append(count, place, top);
  clickerNodes = { count, place };
  updateClickerRow();

  if (!clickerHooked) {
    clickerHooked = true;
    // Свернули приложение — досылаем пачку сразу, не дожидаясь таймера.
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden || !clicker.pending) return;
      clearTimeout(clicker.timer);
      clicker.timer = 0;
      clickerSync(true);
    });
  }
  clickerSync();
  return row;
}

function updateClickerRow(bump = false) {
  if (!clickerNodes) return;
  const { count, place } = clickerNodes;
  const board = clicker.board;
  if (clickerEnded()) {
    const champion = board?.top?.[0];
    count.textContent = !champion
      ? t("Кликер окончен")
      : champion.me
        ? t("👑 Первое место — твоё!")
        : `👑 ${champion.name}, ${champion.group}`;
    place.hidden = !champion;
    if (champion) place.textContent = NUMBER.format(champion.taps);
    return;
  }
  if (!clicker.mine) {
    count.textContent = t("👆 Жми — NFT лучшему");
    place.hidden = true;
    return;
  }
  count.replaceChildren(el("b", "", NUMBER.format(clicker.mine)), document.createTextNode(" 👆"));
  place.hidden = !board?.place;
  if (board?.place) place.textContent = `#${board.place}`;
  if (bump) {
    clicker.bump?.cancel();
    clicker.bump = count.animate([{ transform: "scale(1.12)" }, { transform: "none" }], {
      duration: 180,
      easing: "ease-out",
    });
  }
}

function clickerTap(e, card, fire) {
  if (e.button > 0) return;
  clicker.pulse?.cancel();
  clicker.pulse = fire.animate(
    [{ transform: "scale(1)" }, { transform: "scale(1.3) translateY(-2px)", offset: 0.35 }, { transform: "scale(1)" }],
    { duration: 280, easing: "ease-out" }
  );
  plusOne(card, e);
  if (clickerEnded()) {
    haptic("light");
    updateClickerRow();
    return;
  }
  clicker.mine += 1;
  clicker.pending += 1;
  haptic("light");
  updateClickerRow(true);
  // Каждая сотня — салют.
  if (clicker.mine % 100 === 0) {
    showConfetti();
    burstSparks(card);
    haptic("success");
  }
  if (!clicker.told) {
    clicker.told = true;
    toast(t("Кликер посвящения: кто нажмёт больше всех до полуночи с пятницы на субботу, получит NFT-подарок Light Sword #2776 и тему «Чемпион» 👑 В таблице лидеров видно имя из Telegram и группу."));
  }
  saveClickerLocal();
  if (tg?.initData) scheduleClickerFlush();
}

/** «+1» вылетает из-под пальца. */
function plusOne(card, e) {
  const rect = card.getBoundingClientRect();
  const node = el("span", "event-plus", "+1");
  node.style.left = `${e.clientX - rect.left}px`;
  node.style.top = `${e.clientY - rect.top}px`;
  node.style.setProperty("--dx", `${Math.round(Math.random() * 24 - 12)}px`);
  card.append(node);
  setTimeout(() => node.remove(), 700);
  const all = card.querySelectorAll(".event-plus");
  if (all.length > 12) all[0].remove();
}

function scheduleClickerFlush() {
  if (clicker.timer) return;
  clicker.timer = setTimeout(() => {
    clicker.timer = 0;
    clickerSync();
  }, clicker.flush);
}

/** Отправляет накопленные нажатия и забирает таблицу лидеров. */
async function clickerSync(keepalive = false) {
  const group = activeGroup();
  if (!tg?.initData || !group || group.teacher || !clicker.event || clicker.busy) return;
  clicker.busy = true;
  const taps = clicker.pending;
  clicker.pending = 0;
  let answered = false;
  try {
    const res = await fetch(CLICKER_URL, {
      method: "POST",
      keepalive,
      body: JSON.stringify({ initData: tg.initData, group: group.id, event: clicker.event, taps, board: true }),
    });
    answered = true;
    const body = await res.json();
    if (!body.ok) throw new Error(body.error || "error");
    if (body.ends) clicker.ends = body.ends;
    if (body.flush >= 4000 && body.flush <= 120000) clicker.flush = body.flush;
    // Сервер — источник правды: если пачку урезал предел скорости, счёт
    // честно станет меньше. Нажатия, сделанные пока шёл запрос, — сверху.
    if (typeof body.mine === "number") clicker.mine = body.mine + clicker.pending;
    if (body.board) clicker.board = body.board;
  } catch {
    // Не дошло — нажатия не теряем, уйдут со следующей пачкой. Если же
    // сервер ответил отказом, повторять бессмысленно.
    if (!answered) clicker.pending += taps;
  } finally {
    clicker.busy = false;
  }
  saveClickerLocal();
  updateClickerRow();
  if (clickerSheet && !clickerSheet.hidden) renderClickerSheet();
  if (clicker.pending && !clickerEnded()) scheduleClickerFlush();
}

/* Окно с таблицей лидеров. Собирается в коде: в закэшированной у Telegram
   старой разметке его нет. */
let clickerSheet = null;
let clickerPoll = 0;

function openClickerSheet() {
  if (!clickerSheet) {
    clickerSheet = el("div", "sheet-backdrop");
    clickerSheet.hidden = true;
    const sheet = el("div", "sheet sheet--abs sheet--clicker");
    sheet.setAttribute("role", "dialog");
    sheet.setAttribute("aria-modal", "true");
    const top = el("div", "sheet-top");
    const head = el("div");
    head.append(el("h2", "", t("🏆 Кликер посвящения")), el("div", "clicker-note"));
    const close = el("button", "icon", "×");
    close.type = "button";
    close.setAttribute("aria-label", t("Закрыть"));
    close.addEventListener("click", closeClickerSheet);
    top.append(head, close);
    sheet.append(top, el("div", "clicker-body"));
    clickerSheet.append(sheet);
    clickerSheet.addEventListener("click", (e) => {
      if (e.target === clickerSheet) closeClickerSheet();
    });
    document.body.append(clickerSheet);
  }
  renderClickerSheet();
  clickerSheet.classList.remove("sheet-backdrop--out");
  clickerSheet.hidden = false;
  haptic("light");
  clickerSync();
  // Пока таблица открыта — обновляем её, чтобы было видно, как обгоняют.
  // Вдвое реже пачек: таблица сама по себе дорогая для лимитов.
  clearTimeout(clickerPoll);
  const poll = () => {
    clickerPoll = setTimeout(() => {
      if (clickerSheet.hidden) return;
      if (clicker.busy) renderClickerSheet();
      else clickerSync();
      poll();
    }, clicker.flush * 2);
  };
  poll();
}

function closeClickerSheet() {
  const sheet = clickerSheet;
  clearTimeout(clickerPoll);
  if (!sheet || sheet.hidden || sheet.classList.contains("sheet-backdrop--out")) return;
  haptic("light");
  sheet.classList.add("sheet-backdrop--out");
  setTimeout(() => {
    sheet.hidden = true;
    sheet.classList.remove("sheet-backdrop--out");
  }, 260);
}

function clickerLine(place, title, sub, taps, me) {
  const row = el("div", me ? "clicker-row clicker-row--me" : "clicker-row");
  const who = el("span", "clicker-who");
  who.append(el("span", "clicker-name", title), el("span", "clicker-sub", sub));
  row.append(el("span", "clicker-place", place), who, el("b", "clicker-taps", NUMBER.format(taps)));
  return row;
}

// Главный приз — коллекционный подарок Telegram владельца бота. Картинка —
// с Fragment, где лежат все такие подарки; по нажатию подарок открывается
// в самом Telegram, со всеми его редкостями.
const CLICKER_NFT = {
  title: "Light Sword #2776",
  link: "https://t.me/nft/LightSword-2776",
  image: "https://nft.fragment.com/gift/lightsword-2776.medium.jpg",
};
const NEW_PRIZE_TEXT = "И тема «Чемпион» на месяц: золотое оформление и корона у названия группы — больше ни у кого такой нет. А имя победителя весь факультет увидит на этой плашке.";

function clickerNft() {
  const card = el("button", "clicker-nft");
  card.type = "button";
  const image = el("img", "clicker-nft-image");
  image.src = CLICKER_NFT.image;
  image.alt = "";
  image.loading = "lazy";
  // Картинка не загрузилась — остаётся меч-эмодзи на том же месте.
  image.addEventListener("error", () => image.replaceWith(el("span", "clicker-nft-image clicker-nft-image--none", "🗡")));
  const text = el("span", "clicker-nft-text");
  text.append(
    el("span", "clicker-nft-kicker", t("NFT-подарок Telegram")),
    el("span", "clicker-nft-title", CLICKER_NFT.title),
    el("span", "clicker-nft-traits", t("Jedi Princess 3% · фон Platinum 1,5% · символ Sea Horse 0,2%")),
    el("span", "clicker-nft-open", t("Посмотреть в Telegram ›"))
  );
  card.append(image, text);
  card.addEventListener("click", () => {
    haptic("light");
    if (tg?.openTelegramLink) tg.openTelegramLink(CLICKER_NFT.link);
    else window.open(CLICKER_NFT.link, "_blank");
  });
  return card;
}

function renderClickerSheet() {
  if (!clickerSheet) return;
  const left = clicker.ends - Date.now();
  clickerSheet.querySelector(".clicker-note").textContent =
    left > 0 ? t("До конца {time}", { time: humanLeft(left / 60000) }) : t("Кликер окончен — итоги");

  const nodes = [];
  const prize = el("div", "clicker-prize");
  prize.append(el("b", "", t("👑 Призы за первое место")), clickerNft(), el("p", "", t(NEW_PRIZE_TEXT)));
  nodes.push(prize);

  const board = clicker.board;
  if (!tg?.initData) nodes.push(el("p", "empty", t("Таблица работает только в Telegram")));
  else if (!board) nodes.push(el("p", "empty", t("Загружаем…")));
  else {
    const seg = el("div", "clicker-seg");
    for (const [id, label] of [
      ["players", t("Игроки")],
      ["groups", t("Группы")],
    ]) {
      const button = el("button", clicker.view === id ? "clicker-seg-on" : "", label);
      button.type = "button";
      button.addEventListener("click", () => {
        if (clicker.view === id) return;
        clicker.view = id;
        haptic("select");
        renderClickerSheet();
      });
      seg.append(button);
    }
    nodes.push(seg);

    const list = el("div", "clicker-list");
    const medal = (i) => ["🥇", "🥈", "🥉"][i] || String(i + 1);
    if (clicker.view === "players") {
      if (!board.top.length) list.append(el("p", "empty", t("Пока никто не кликал — будь первым!")));
      board.top.forEach((row, i) =>
        list.append(clickerLine(medal(i), row.name, row.me ? `${row.group} · ${t("это вы")}` : row.group, row.taps, row.me))
      );
      // Сам не в десятке — показываем своё место отдельной строкой снизу.
      if (board.place && !board.top.some((row) => row.me)) {
        list.append(el("div", "clicker-gap", "⋯"));
        list.append(clickerLine(String(board.place), t("Вы"), activeGroup()?.title || "", clicker.mine, true));
      }
    } else {
      board.groups.forEach((row, i) =>
        list.append(clickerLine(medal(i), row.group, t("игроков: {n}", { n: row.players }), row.taps, row.me))
      );
      const mine = board.myGroup;
      if (mine && !board.groups.some((row) => row.me)) {
        list.append(el("div", "clicker-gap", "⋯"));
        list.append(clickerLine(String(mine.place), mine.group, t("игроков: {n}", { n: mine.players }), mine.taps, true));
      }
    }
    nodes.push(list);
    nodes.push(
      el(
        "p",
        "clicker-total",
        t("Игроков: {players} · нажатий: {taps}", { players: NUMBER.format(board.players), taps: NUMBER.format(board.total) })
      )
    );
  }
  nodes.push(
    el(
      "p",
      "clicker-fine",
      t("В таблице видно имя из Telegram и группу. Больше 20 нажатий в секунду не засчитывается, а победителя проверяем вручную — автокликер не поможет.")
    )
  );
  clickerSheet.querySelector(".clicker-body").replaceChildren(...nodes);
}

/** В сам день своим — конфетти при первом открытии. Один раз. */
function celebrateEvent() {
  const group = activeGroup();
  const event = group ? upcomingEvent() : null;
  if (!event || event.days !== 0 || !event.ours(group)) return;
  if (storedList(EVENT_CELEBRATED_KEY).includes(event.id)) return;
  storeInList(EVENT_CELEBRATED_KEY, event.id);
  showConfetti();
  haptic("success");
}

/* ---------- Отсчёт до свободы ---------- */

/**
 * Строка под датой: сколько осталось до конца пары, до конца дня, до
 * выходных и до конца семестра. Считается по часам телефона и обновляется
 * вместе с подсветкой идущей пары.
 */
function refreshFreedom() {
  if (!els.freedom || !data) return;
  const now = new Date();
  const line = freedomLine(now);
  els.freedom.hidden = !line;
  if (line) els.freedom.textContent = line;
  refreshExamMode();
}

function freedomLine(now) {
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const today = isoDate(dateOfDay(selectedDay)) === isoDate(now);
  const weekday = ((now.getDay() + 6) % 7) + 1;

  if (today && visible.length) {
    const bells = new Map(data.bells.map((b) => [b.n, b]));
    const current = currentLesson();
    if (current) {
      // Пятница и это последняя пара — значит, считаем до выходных.
      const last = lastEndToday();
      const freedom = weekday >= 5 && last && minutes(last) - nowMinutes === Math.round(current.left);
      return freedom
        ? t("🎉 Выходные через {time}", { time: humanLeft(current.left) })
        : t("До конца пары {time}", { time: humanLeft(current.left) });
    }
    const end = lastEndToday();
    if (end && minutes(end) > nowMinutes) {
      // Преподавателю «учиться» не скажешь — ему эту строку не показываем.
      if (activeGroup()?.teacher) return "";
      return t("Сегодня учиться ещё {time}", { time: humanLeft(minutes(end) - nowMinutes) });
    }
  }

  // Пар на сегодня нет — считаем до конца семестра: это всегда приятно.
  const last = (data.weeks || []).at(-1)?.to;
  if (!last) return "";
  const left = Math.ceil((new Date(`${last}T23:59:59`) - now) / 86400000);
  if (left <= 0) return t("🏖 Семестр кончился");
  if (left <= 14) return t("😱 До конца занятий {days} дн., дальше сессия", { days: left });
  const weeks = Math.floor(left / 7);
  const days = left % 7;
  return weeks
    ? t("До конца семестра {weeks} нед. {days} дн.", { weeks, days })
    : t("До конца семестра {days} дн.", { days });
}

/**
 * Сессия: когда учебные недели кончились, интерфейс становится тревожным,
 * а отсчёт меняет смысл — считать до конца семестра уже поздно.
 */
function examMode() {
  const last = (data?.weeks || []).at(-1)?.to;
  if (!last) return false;
  const days = Math.ceil((new Date(`${last}T23:59:59`) - new Date()) / 86400000);
  // Две недели до конца занятий и весь январь — время сессии.
  return days <= 14;
}

function refreshExamMode() {
  document.body.classList.toggle("exams", examMode());
}

/* ---------- Напоминания ---------- */

const REMIND_URL = `${API_URL}/reminders`;

/**
 * План на две недели бот сам построить не может: языковая подгруппа,
 * военная кафедра и МФК известны только здесь. Поэтому при открытии
 * приложение присылает готовый список пар — из него и шлются напоминания.
 */
function reminderPlan() {
  const group = activeGroup();
  if (!group) return [];
  const bells = new Map(data.bells.map((b) => [b.n, b]));
  const plan = [];
  for (let week = 0; week < WEEKS; week++) {
    for (let day = 1; day <= 6; day++) {
      const date = dateOfDay(day, week);
      const iso = isoDate(date);
      if (iso < isoDate(new Date())) continue;
      for (const lesson of ownLessonsForDay(group, day, week)) {
        if (lessonCancelOn(lesson, iso)) continue;
        const time = timesOf(lesson, bells);
        if (!time) continue;
        plan.push({ day: iso, start: time.start, end: time.end, subject: tr(lesson.subject), raw: lesson.subject, room: roomLabel(lesson.room || "") });
      }
    }
  }
  // Пары одного предмета подряд — один блок: напоминать надо о его начале,
  // но конец у него — конец последней пары. Раньше от блока оставалась
  // первая пара со своим временем, и бот писал про сдвоенную как про одну.
  const blocks = [];
  const open = new Map();
  for (const item of plan) {
    const id = `${item.day}|${item.subject}`;
    const last = open.get(id);
    // Подряд — значит, между концом одной и началом другой только перемена
    // или обед. Языки не склеиваем: в расписании это тоже отдельные пары.
    const gap = last ? minutes(item.start) - minutes(last.end) : Infinity;
    if (last && item.start === last.start) continue;
    if (last && gap >= 0 && gap <= 60 && !isLanguage(item.raw)) {
      last.end = item.end;
      if (item.room && !last.room.split(", ").includes(item.room)) {
        last.room = [last.room, item.room].filter(Boolean).join(", ");
      }
      continue;
    }
    const block = { ...item };
    open.set(id, block);
    blocks.push(block);
  }
  for (const block of blocks) delete block.raw;
  return blocks;
}

async function sendReminderSettings() {
  if (!tg?.initData) return;
  // Без списка МФК в план ушла бы безымянная строка вместо своих курсов.
  await loadMfk();
  const group = activeGroup();
  if (!group || group.teacher) return;
  const body = {
    initData: tg.initData,
    group: group.id,
    morning: Boolean(prefs?.remindMorning),
    before: prefs?.remindBefore ? 15 : 0,
    // «Пора выходить»: за время дороги до начала первой пары.
    wake: prefs?.remindWake ? wakeLead() : 0,
    // Отмены, замены и изменения на сайте вуза — по умолчанию включены.
    changes: prefs?.remindChanges !== false,
    plan: prefs?.remindMorning || prefs?.remindBefore || prefs?.remindWake ? reminderPlan() : [],
  };
  fetch(REMIND_URL, { method: "POST", body: JSON.stringify(body) }).catch(() => {
    // Не дошло — отправим при следующем открытии.
  });
}

/**
 * Предложение включить напоминания — один раз, прямо в расписании.
 * В настройки за этим никто не пойдёт, а вещь полезная.
 */
/** Закрываем плавно: резко исчезающая карточка выглядит как сбой. */
function closeAsk(box) {
  box.classList.add("ask--gone");
  setTimeout(() => {
    box.hidden = true;
    box.classList.remove("ask--gone");
  }, 300);
}

function renderRemindAsk() {
  const box = els.remindAsk;
  if (!box) return;
  const off = !prefs?.remindMorning && !prefs?.remindBefore;
  const show = Boolean(tg?.initData) && off && !prefs?.remindAsked && !activeGroup()?.teacher;
  box.hidden = !show;
  if (!show) return;

  box.replaceChildren();
  const text = el("div", "ask-text");
  text.append(el("div", "ask-title", t("Напоминать вам о парах?")));
  text.append(el("div", "ask-line", t("Утром список на день и за 15 минут до пары")));
  const buttons = el("div", "ask-actions");

  // Два напоминания разные по смыслу: утренний список планируют с вечера,
  // а «через 15 минут» нужно тем, кто уже в корпусе. Выбирают по отдельности.
  // По умолчанию ничего не выбрано: человек сам решает, что ему нужно.
  const pick = { morning: false, before: false };
  const chips = el("div", "ask-chips");
  for (const [key, label] of [["morning", t("Утром в 7:30")], ["before", t("За 15 минут")]]) {
    const chip = el("button", "chip", label);
    chip.type = "button";
    chip.addEventListener("click", () => {
      haptic("light");
      pick[key] = !pick[key];
      chip.classList.toggle("chip--on", pick[key]);
    });
    chips.append(chip);
  }
  text.append(chips);

  const yes = el("button", "primary ask-yes", t("Напоминать"));
  yes.type = "button";
  yes.addEventListener("click", () => {
    if (!pick.morning && !pick.before) {
      // Ничего не выбрано — это то же самое, что «не надо».
      prefs = { ...prefs, remindAsked: true };
      savePrefs(prefs);
      closeAsk(box);
      return;
    }
    prefs = { ...prefs, remindMorning: pick.morning, remindBefore: pick.before, remindAsked: true };
    savePrefs(prefs);
    fillReminders();
    sendReminderSettings();
    closeAsk(box);
    haptic("success");
  });

  const no = el("button", "ghost", t("Не надо"));
  no.type = "button";
  no.addEventListener("click", () => {
    // Спрашиваем один раз: дальше это делается в настройках.
    haptic("light");
    prefs = { ...prefs, remindAsked: true };
    savePrefs(prefs);
    closeAsk(box);
  });

  buttons.append(yes, no);
  box.append(text, buttons);
}

/** Сколько ехать до вуза — за столько до первой пары «Пора выходить». */
function wakeLead() {
  const lead = Number(prefs?.remindWakeLead);
  return [15, 20, 30, 40, 50, 60, 75, 90, 120].includes(lead) ? lead : 40;
}

function fillReminders() {
  if (!els.remindRow) return;
  // Без Telegram писать некому: настройку прячем целиком.
  els.remindRow.hidden = !tg?.initData;
  els.remindMorning.checked = Boolean(prefs?.remindMorning);
  els.remindBefore.checked = Boolean(prefs?.remindBefore);
  if (els.remindChanges) els.remindChanges.checked = prefs?.remindChanges !== false;
  if (els.remindWake) {
    els.remindWake.checked = Boolean(prefs?.remindWake);
    els.remindWakeLead.value = String(wakeLead());
    els.remindWakeRow.hidden = els.remindWakeHint.hidden = !els.remindWake.checked;
  }
}

function initReminders() {
  const save = () => {
    const morning = els.remindMorning.checked;
    const before = els.remindBefore.checked;
    const wake = Boolean(els.remindWake?.checked);
    prefs = {
      ...prefs,
      remindMorning: morning,
      remindBefore: before,
      remindWake: wake,
      remindChanges: els.remindChanges ? els.remindChanges.checked : prefs?.remindChanges,
      remindWakeLead: Number(els.remindWakeLead?.value) || 40,
      // Выключили всё — значит, вопрос снова открыт: предложение вернётся.
      remindAsked: morning || before || wake ? true : false,
    };
    savePrefs(prefs);
    if (els.remindWakeRow) els.remindWakeRow.hidden = els.remindWakeHint.hidden = !wake;
    sendReminderSettings();
  };
  els.remindMorning?.addEventListener("change", save);
  els.remindBefore?.addEventListener("change", save);
  els.remindChanges?.addEventListener("change", save);
  els.remindWake?.addEventListener("change", () => {
    haptic("light");
    save();
  });
  els.remindWakeLead?.addEventListener("change", save);
}

/* ---------- Особые темы оформления ---------- */

// Брутал выдаёт владелец командой /theme, гламур человек находит сам —
// словом «гламур» в поиске по МФК. Тема с сервера сильнее найденной.
const THEMES = { glam: "glam", brutal: "glam-noir", champion: "champion", volunteer: "volunteer", cska: "cska", nokia: "nokia", ocean: "tint-ocean", sunset: "tint-sunset", mint: "tint-mint", lavender: "tint-lavender", graphite: "tint-graphite", cherry: "tint-cherry", devil: "devil", msu: "msu" };
const GLAM_KEY = "schedule.glam";
// Зелёную тему волонтёра человек может выключить сам и вернуть обратно.
// Остальные выданные темы так не умеют.
const VOLUNTEER_OFF_KEY = "schedule.volunteerOff";

function volunteerOff() {
  try {
    return localStorage.getItem(VOLUNTEER_OFF_KEY) === "1";
  } catch {
    return false;
  }
}

// Своя цветовая тема: человек выбирает сам в «Оформлении». Коллекционные
// (гламур, брутал, чемпион, ЦСКА, нокия, дьявол, волонтёр) так не выбрать —
// их выдают. МГУ — только тем, у кого факультет МГУ.
const COLOR_KEY = "schedule.colorTheme";
const MSU_THEME_KEY = "schedule.msuTheme";
// Оформление одно на всех — меняется только цвет акцента. МГУ — особая
// тема для тех, у кого факультет МГУ.
const COLOR_THEMES = [
  // Обычный — цвет меняется с чётностью недели (синий / оранжевый).
  ["", "Обычный", ["#2ea6ff", "#f0821e"]],
  ["ocean", "Бирюза", ["#0ea5e9", "#0ea5e9"]],
  ["mint", "Мята", ["#10b981", "#10b981"]],
  ["sunset", "Закат", ["#f97316", "#f97316"]],
  ["lavender", "Лаванда", ["#8b5cf6", "#8b5cf6"]],
  ["cherry", "Вишня", ["#e11d48", "#e11d48"]],
  ["msu", "МГУ", ["#c9a227", "#0b1733"]],
];
const COLOR_IDS = new Set(COLOR_THEMES.map(([id]) => id));

function colorTheme() {
  try {
    const saved = localStorage.getItem(COLOR_KEY);
    // Неон и графит убрали — у кого были, видят обычное оформление.
    if (saved !== null) return COLOR_IDS.has(saved) ? saved : "";
    // Раньше неон и МГУ включались отдельно — переносим их выбор.
    const neon = localStorage.getItem("schedule.neon");
    if (localStorage.getItem(MSU_THEME_KEY) === "1") return "msu";
  } catch {
    // Без памяти — обычная.
  }
  return "";
}

function msuThemeOn() {
  return colorTheme() === "msu";
}

function inMsu() {
  return tenant()?.university === "МГУ";
}

function initMsuTheme() {
  // Тема МГУ теперь плиткой в «Оформлении» (fillLook).
}

function initVolunteer() {
  const box = document.getElementById("volunteer-theme");
  box?.addEventListener("change", () => {
    try {
      localStorage.setItem(VOLUNTEER_OFF_KEY, box.checked ? "" : "1");
    } catch {
      // Без хранилища выбор доживёт до перезапуска.
    }
    haptic("light");
    applyTheme();
  });
}

let grantedTheme = "";

function ownGlam() {
  try {
    // Раньше гламур хранился по-разному — любую непустую запись считаем «да».
    return Boolean(localStorage.getItem(GLAM_KEY));
  } catch {
    return false;
  }
}

function setOwnGlam(on) {
  try {
    localStorage.setItem(GLAM_KEY, on ? "glam" : "");
  } catch {
    // Приватный режим: гламур доживёт до перезапуска, и ладно.
  }
  applyTheme();
}

// Владелец примеряет темы у себя прямо в настройках. Выбор лежит только в его
// браузере и сильнее темы с сервера; «как выдано» возвращает обычный порядок.
const OWNER_THEME_KEY = "schedule.ownerTheme";
const THEME_TITLES = {
  "": "Обычная", glam: "Гламур", brutal: "Брутал", champion: "Чемпион", volunteer: "Волонтёр", cska: "ЦСКА", nokia: "Нокия",
  ocean: "Океан", sunset: "Закат", mint: "Мята", lavender: "Лаванда", graphite: "Графит", cherry: "Вишня", devil: "Дьявол", msu: "МГУ",
};

function ownerTheme() {
  try {
    return localStorage.getItem(OWNER_THEME_KEY);
  } catch {
    return null;
  }
}

function fillOwnerThemes() {
  const box = document.getElementById("owner-themes");
  const list = document.getElementById("owner-theme-list");
  if (!box || !list) return;
  box.hidden = !notices.owner;
  if (box.hidden) return;
  const current = ownerTheme();
  const chips = [["auto", "Как выдано"], ...Object.entries(THEME_TITLES)].map(([id, title]) => {
    const on = id === "auto" ? current === null : current === id;
    const chip = el("button", on ? "chip chip--on" : "chip", title);
    chip.type = "button";
    chip.addEventListener("click", () => {
      haptic("light");
      try {
        if (id === "auto") localStorage.removeItem(OWNER_THEME_KEY);
        else localStorage.setItem(OWNER_THEME_KEY, id);
      } catch {
        // Без хранилища примерка живёт до перезапуска.
      }
      applyTheme();
      fillOwnerThemes();
    });
    return chip;
  });
  list.replaceChildren(...chips);
}

/** «rgb(7, 8, 15)» или «#07080f» → «#07080f»; иначе пусто. */
function toHex(color) {
  const value = String(color).trim();
  if (/^#[0-9a-f]{6}$/i.test(value)) return value;
  if (/^#[0-9a-f]{3}$/i.test(value)) return "#" + [...value.slice(1)].map((c) => c + c).join("");
  const rgb = value.match(/^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i);
  // color-mix() браузер отдаёт как color(srgb 0.1 0.5 0.9).
  const srgb = value.match(/^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/i);
  if (srgb) return "#" + srgb.slice(1, 4).map((n) => Math.round(Number(n) * 255).toString(16).padStart(2, "0")).join("");
  if (!rgb) return "";
  return "#" + rgb.slice(1, 4).map((n) => Number(n).toString(16).padStart(2, "0")).join("");
}

/* Вид с прошлого раза: классы темы и основные цвета. Заставка при
   следующем открытии берёт их до загрузки стилей (см. index.html). */
let lookTimer = 0;

function rememberLook() {
  clearTimeout(lookTimer);
  lookTimer = setTimeout(async () => {
    await window.__cssReady;
    // Цвет фона темы меряем у body без «прозрачности» (см. ниже).
    const root = document.documentElement;
    root.classList.remove("bg-root");
    const style = getComputedStyle(document.body);
    // То, что видно, когда страницу перетянули за край (пружина на iPhone), —
    // того же цвета, что расписание, а не цвета Telegram.
    const paint = style.backgroundColor && style.backgroundColor !== "rgba(0, 0, 0, 0)" ? style.backgroundColor : style.getPropertyValue("--bg").trim();
    if (paint) {
      // Красим html, а body делаем прозрачным: иначе фон body ложится
      // поверх неба, узора и свечения (они под ним, z-index меньше нуля).
      root.style.backgroundColor = paint;
      root.classList.add("bg-root");
      // :P над страницей — чёрный на светлом фоне, белый на тёмном.
      const rgb = (toHex(paint) || "#ffffff").slice(1).match(/../g).map((h) => parseInt(h, 16));
      const light = 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2] > 140;
      // Светлая или тёмная подложка — небо подбирает под неё свои краски,
      // чтобы шапка читалась и днём, и ночью.
      document.body.dataset.tone = light ? "light" : "dark";
      // Текст на плашке цвета акцента (выбранный день, аудитория): белый на
      // тёмном акценте, почти чёрный — на светлом (золото МГУ, мята, жёлтые).
      // Акцент бывает задан через color-mix — меряем его готовый цвет на пробнике.
      const probe = el("span");
      probe.style.cssText = "position:absolute;visibility:hidden;color:var(--accent)";
      document.body.append(probe);
      const accent = toHex(getComputedStyle(probe).color);
      probe.remove();
      if (accent) {
        const [ar, ag, ab] = accent.slice(1).match(/../g).map((h) => parseInt(h, 16) / 255);
        const lin = (v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
        const L = 0.2126 * lin(ar) + 0.7152 * lin(ag) + 0.0722 * lin(ab);
        // Белый выигрывает, если контраст с белым не хуже, чем с чёрным.
        document.body.style.setProperty("--on-accent", 1.05 / (L + 0.05) >= (L + 0.05) / 0.05 ? "#ffffff" : "#14141a");
      }
      document.querySelector(".over-egg")?.classList.toggle("over-egg--light", !light);
      // В Telegram за верхним и нижним краем виден не html, а само окно
      // мини-приложения — красим и его, и шапку, в цвет расписания.
      const hex = toHex(paint);
      if (hex) {
        try {
          tg?.setBackgroundColor?.(hex);
          tg?.setHeaderColor?.(hex);
          tg?.setBottomBarColor?.(hex);
        } catch {
          // Старый Telegram — красит сам.
        }
      }
    }
    const cls = [...Object.values(THEMES), "neon", "neon-day"].filter((c) => document.body.classList.contains(c));
    const pick = (name, fallback) => style.getPropertyValue(name).trim() || fallback;
    try {
      localStorage.setItem(
        "schedule.look",
        JSON.stringify({
          cls,
          bg: style.backgroundColor && style.backgroundColor !== "rgba(0, 0, 0, 0)" ? style.backgroundColor : pick("--bg", "#ffffff"),
          text: pick("--text", style.color),
          accent: pick("--accent", "#2ea6ff"),
        })
      );
    } catch {
      // Без памяти — в следующий раз заставка в цветах Telegram.
    }
  }, 300);
}

function applyTheme(granted = grantedTheme) {
  rememberLook();
  grantedTheme = granted || "";
  const tried = notices.owner ? ownerTheme() : null;
  if (tried !== null) {
    for (const cls of Object.values(THEMES)) document.body.classList.toggle(cls, THEMES[tried] === cls);
    renderChampion(tried === "champion");
    renderVolunteer(tried === "volunteer");
    renderCska(tried === "cska");
    renderNokia(tried === "nokia");
    return;
  }
  const volunteer = grantedTheme === "volunteer";
  const row = document.getElementById("volunteer-row");
  const box = document.getElementById("volunteer-theme");
  if (row) row.hidden = !volunteer;
  if (box) box.checked = volunteer && !volunteerOff();
  // Выданная тема сильнее; выключенный волонтёр уступает своей теме.
  const worn = volunteer && volunteerOff() ? "" : grantedTheme;
  const own = colorTheme();
  const ownName = own === "msu" ? (inMsu() ? "msu" : "") : THEMES[own] ? own : "";
  const name = worn || ownName || (ownGlam() ? "glam" : "");
  // Неон — свои классы, не из THEMES; под выданной темой не включаем.
  document.body.classList.toggle("neon", !worn && own === "neon");
  document.body.classList.toggle("neon-day", !worn && own === "neon-day");
  for (const cls of Object.values(THEMES)) {
    document.body.classList.toggle(cls, THEMES[name] === cls);
  }
  renderChampion(name === "champion");
  renderVolunteer(name === "volunteer");
  renderCska(name === "cska");
  renderNokia(name === "nokia");
}

/* Тема «Нокия» — экран старого телефона: два цвета, пиксели, рамки. Под
   датой — строка состояния с антенной и батарейкой. */
function renderNokia(on) {
  let ribbon = document.querySelector(".nokia-ribbon");
  let bezel = document.querySelector(".nokia-bezel");
  if (!on) {
    bezel?.remove();
    return ribbon?.remove();
  }
  // Корпус из пожелтевшего пластика вокруг экрана.
  if (!bezel) document.body.append(el("div", "nokia-bezel"));
  if (ribbon || !els.freedom) return;
  ribbon = el("button", "nokia-ribbon");
  ribbon.type = "button";
  const signal = el("span", "nokia-signal");
  for (let bar = 0; bar < 4; bar += 1) signal.append(el("i"));
  const battery = el("span", "nokia-battery");
  for (let bar = 0; bar < 3; bar += 1) battery.append(el("i"));
  ribbon.append(signal, el("span", "", "3310"), battery);
  ribbon.addEventListener("click", () => haptic("heavy"));
  els.freedom.after(ribbon);
}

/* Пасхалка: кодовая фраза в поиске. Ни фразы, ни того, что она открывает,
   в коде нет — файл зашифрован самой фразой. */
const EGG = { size: 12, mark: 211, busy: false };

async function checkEgg(value) {
  const word = String(value || "").toLowerCase().replace(/[^a-zа-яё0-9]/g, "");
  if (word.length !== EGG.size || EGG.busy || !globalThis.crypto?.subtle) return;
  EGG.busy = true;
  try {
    const text = new TextEncoder();
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", text.encode(`${word.length}:${word}`)));
    if (hash[0] !== EGG.mark) return;
    const file = new Uint8Array(await (await fetch("icons/sprite.bin")).arrayBuffer());
    const base = await crypto.subtle.importKey("raw", text.encode(word), "PBKDF2", false, ["deriveKey"]);
    const key = await crypto.subtle.deriveKey(
      { name: "PBKDF2", hash: "SHA-256", salt: file.slice(0, 16), iterations: 200000 },
      base,
      { name: "AES-GCM", length: 256 },
      false,
      ["decrypt"],
    );
    const code = new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: file.slice(16, 28) }, key, file.slice(28)));
    els.query.value = "";
    els.query.blur();
    runSearch();
    new Function("api", code)({ haptic, tg });
  } catch {
    // Не та фраза — молчим.
  } finally {
    EGG.busy = false;
  }
}

/* Тема «ЦСКА» — красно-синяя, выдаёт владелец. Лента под датой и салют в
   клубных цветах: при первом открытии за день и по нажатию на ленту. */
const CSKA_KEY = "schedule.cskaSalute";

function renderCska(on) {
  let ribbon = document.querySelector(".cska-ribbon");
  if (!on) return ribbon?.remove();
  if (!ribbon && els.freedom) {
    ribbon = el("button", "cska-ribbon");
    ribbon.type = "button";
    ribbon.append(el("span", "cska-star", "★"), el("span", "", t("Красно-синие")));
    ribbon.addEventListener("click", () => {
      haptic("success");
      showConfetti();
    });
    els.freedom.after(ribbon);
  }
  const today = isoDate(new Date());
  let last = "";
  try {
    last = localStorage.getItem(CSKA_KEY) || "";
    if (last === today) return;
    localStorage.setItem(CSKA_KEY, today);
  } catch {
    // Без хранилища салют будет при каждом открытии — не беда.
  }
  afterSplash(() => {
    showConfetti();
    haptic("success");
    if (!last) toast(t("★ Тема «ЦСКА» включена. Красно-синий — самый сильный!"));
  });
}

/* Тема «Волонтёр» — спасибо тем, кто разносит расписание по своим. Кроме
   зелени — лента под датой и листопад: при первом открытии за день и по
   нажатию на ленту. */
const VOLUNTEER_KEY = "schedule.volunteerLeaves";

function renderVolunteer(on) {
  let ribbon = document.querySelector(".volunteer-ribbon");
  if (!on) return ribbon?.remove();
  if (!ribbon && els.freedom) {
    ribbon = el("button", "volunteer-ribbon");
    ribbon.type = "button";
    ribbon.append(el("span", "volunteer-leaf", "🌿"), el("span", "", t("Волонтёр расписания")));
    ribbon.addEventListener("click", () => {
      haptic("success");
      showLeaves();
    });
    els.freedom.after(ribbon);
  }
  const today = isoDate(new Date());
  let last = "";
  try {
    last = localStorage.getItem(VOLUNTEER_KEY) || "";
    if (last === today) return;
    localStorage.setItem(VOLUNTEER_KEY, today);
  } catch {
    // Без хранилища листопад будет при каждом открытии — не беда.
  }
  afterSplash(() => {
    showLeaves();
    haptic("success");
    if (!last) toast(t("🌿 Тема «Волонтёр» — спасибо, что рассказываешь о расписании!"));
  });
}

/** Листопад: листья летят сверху, качаясь, каждый со своей скоростью. */
function showLeaves() {
  if (document.querySelector(".leaves")) return;
  const box = el("div", "leaves");
  const kinds = ["🍃", "🌿", "🍀", "🍃", "🌱"];
  for (let i = 0; i < 26; i++) {
    const leaf = el("i", "", kinds[i % kinds.length]);
    leaf.style.left = `${Math.random() * 96}%`;
    leaf.style.fontSize = `${16 + Math.random() * 16}px`;
    leaf.style.animationDelay = `${Math.random() * 0.9}s`;
    leaf.style.animationDuration = `${2.4 + Math.random() * 1.6}s`;
    leaf.style.setProperty("--sway", `${(Math.random() < 0.5 ? -1 : 1) * (30 + Math.random() * 50)}px`);
    box.append(leaf);
  }
  document.body.append(box);
  setTimeout(() => box.remove(), 5200);
}

/* Тема «Чемпион» — приз победителю кликера. Кроме золота — лента под
   датой с бликом и салют при первом открытии за день: приз должен
   чувствоваться, а не просто перекрашивать кнопки. */
const CHAMPION_KEY = "schedule.championSalute";

function renderChampion(on) {
  let ribbon = document.querySelector(".champion-ribbon");
  if (!on) return ribbon?.remove();
  if (!ribbon && els.freedom) {
    ribbon = el("button", "champion-ribbon");
    ribbon.type = "button";
    ribbon.append(el("span", "champion-crown", "👑"), el("span", "", t("Чемпион кликера посвящения")));
    // Тап по ленте — салют. Чемпиону можно.
    ribbon.addEventListener("click", () => {
      haptic("success");
      showConfetti();
    });
    els.freedom.after(ribbon);
  }
  championSalute();
}

function championSalute() {
  const today = isoDate(new Date());
  let last = "";
  try {
    last = localStorage.getItem(CHAMPION_KEY) || "";
    if (last === today) return;
    localStorage.setItem(CHAMPION_KEY, today);
  } catch {
    // Без хранилища салют будет при каждом открытии — не беда.
  }
  afterSplash(() => {
    showConfetti();
    haptic("success");
    if (!last) toast(t("👑 Тема «Чемпион» — твой приз за кликер посвящения. Носи с гордостью!"));
  });
}

// Что показать, когда уйдёт заставка: под ней салюта не видно.
const afterSplashQueue = [];

function afterSplash(fn) {
  const splash = els.splash;
  if (!splash || !splash.isConnected || splash.classList.contains("splash--gone")) {
    setTimeout(fn, 300);
    return;
  }
  afterSplashQueue.push(fn);
}

// Пасхалка открыта: слово набрано или гламур уже включён.
let glamFound = false;

/** Слово «гламур» в поиске по МФК открывает строку с темой. */
function checkGlamWord() {
  if (!els.mfkFind) return;
  const word = searchKey(els.mfkFind.value).replace(/[^а-яa-z]/g, "");
  if (word === "гламур" || word === "glamour" || word === "glam") {
    glamFound = true;
    els.mfkFind.value = "";
    renderMfkPicker();
    haptic("success");
  }
}

/** Строка гламура в списке МФК — выглядит как ещё один «курс». */
function renderGlamPick() {
  const on = ownGlam();
  const chip = el("button", on ? "q-pick q-pick--on q-pick--glam" : "q-pick q-pick--glam");
  chip.type = "button";
  chip.append(el("span", "q-pick-name", on ? "💅 Гламур включён" : "💅 Гламур"));
  chip.append(el("span", "q-pick-who", on ? t("Нажмите, чтобы вернуть обычный вид") : t("Секретная тема оформления")));
  chip.addEventListener("click", () => {
    setOwnGlam(!ownGlam());
    if (ownGlam()) haptic("success");
    renderMfkPicker();
  });
  return chip;
}

/**
 * Сессия: когда учебные недели кончились, интерфейс становится тревожным,
 * а отсчёт меняет смысл — считать до конца семестра уже поздно.
 */
function examMode() {
  const last = (data?.weeks || []).at(-1)?.to;
  if (!last) return false;
  const days = Math.ceil((new Date(`${last}T23:59:59`) - new Date()) / 86400000);
  // Две недели до конца занятий и весь январь — время сессии.
  return days <= 14;
}

function refreshExamMode() {
  document.body.classList.toggle("exams", examMode());
}

/* ---------- Межфакультетские курсы ---------- */

// Список МФК из личного кабинета МГУ: в расписании ФГП стоит только строка
// «Межфакультетские учебные курсы МГУ», без названия курса и его времени.
let MFK_LIST = null;

async function loadMfk() {
  if (MFK_LIST) return MFK_LIST;
  try {
    // Межфакультетские курсы — особенность МГУ, у других их нет. Каталог
    // общий на весь университет, поэтому лежит один, рядом с ФГП.
    const res = mfkAvailable() ? await fetch("data/mfk.json", { cache: "no-cache" }) : null;
    MFK_LIST = res?.ok ? await res.json() : [];
  } catch {
    MFK_LIST = [];
  }
  return MFK_LIST;
}

/** Выбор своих МФК — у всех факультетов МГУ: каталог курсов общий. */
function mfkAvailable() {
  return tenantHas("mfk") || tenant().university === "МГУ";
}

/**
 * Строка расписания, вместо которой встают выбранные МФК. У ФГП она одна,
 * остальные факультеты подписывают время под МФК по-своему.
 */
function isMfkLesson(subject) {
  return subject === MFK || isMfkSlot(subject);
}

/** Выбранные курсы — те, что человек отметил в настройках. */
function myMfk() {
  const chosen = new Set(prefs?.mfk || []);
  return (MFK_LIST || []).filter((course) => chosen.has(course.id));
}

function renderMfkPicker() {
  if (!els.mfkList) return;
  const query = searchKey(els.mfkFind?.value || "");
  const chosen = new Set(prefs?.mfk || []);
  const list = MFK_LIST || [];
  // До первого запроса показываем только выбранные: полторы сотни курсов
  // в настройках никто листать не станет.
  const items = query
    ? list.filter(
        (c) => searchKey(c.title).includes(query) || searchKey(c.faculty).includes(query)
      )
    : list.filter((c) => chosen.has(c.id));

  const nodes = items.slice(0, 40).map((course) => {
    const chip = el("button", chosen.has(course.id) ? "q-pick q-pick--on" : "q-pick");
    chip.type = "button";
    chip.append(el("span", "q-pick-name", course.title));
    const when = course.start ? `${DAYS[(course.day || 3) - 1]}, ${course.start}–${course.end}` : "";
    chip.append(el("span", "q-pick-who", [course.faculty, when, course.where].filter(Boolean).join(" · ")));
    chip.addEventListener("click", () => {
      haptic("light");
      const next = new Set(prefs.mfk || []);
      next.has(course.id) ? next.delete(course.id) : next.add(course.id);
      prefs = { ...prefs, mfk: [...next] };
      savePrefs(prefs);
      renderMfkPicker();
      // Бот напоминает по присланному плану — выбор курса должен в него попасть.
      sendReminderSettings();
    });
    return chip;
  });

  // Гламур стоит первой строкой списка — как ещё один «курс».
  if (glamFound || ownGlam()) nodes.unshift(renderGlamPick());

  if (!nodes.length) {
    nodes.push(el("p", "hint", query ? t("Ничего не нашлось") : t("Ничего не выбрано — начните вводить название")));
  }
  els.mfkList.replaceChildren(...nodes);
}

/**
 * Занятия по выбранным МФК на показанный день. В расписании факультета МФК
 * стоит безымянной строкой, поэтому свои курсы подставляем вместо неё —
 * с настоящим временем и аудиторией из личного кабинета.
 */
/** «Четвертый учебный корпус В, ауд. 555» → плашка «555» и корпус в строке. */
function place(course) {
  const where = String(course.where || "");
  const match = where.match(/^(.*?),?\s*ауд\.?\s*(.+)$/i);
  if (!match) return { building: where, room: "" };
  return { building: match[1].trim(), room: match[2].trim() };
}

function mfkLessons(day) {
  const bells = data.bells || [];
  return myMfk()
    .filter((course) => course.day === day && course.start)
    .map((course) => {
      // Номер пары — та, в которую курс попадает по времени; нужен только для
      // порядка карточек, само время показываем своё.
      const begin = minutes(course.start);
      const bell =
        bells.find((b) => begin >= minutes(b.start) && begin < minutes(b.end)) ||
        bells.find((b) => minutes(b.start) >= begin) ||
        bells[bells.length - 1];
      return {
        group: activeGroup()?.id || "",
        day,
        slot: bell?.n || 5,
        subgroup: null,
        elective: null,
        week: "all",
        note: [course.faculty, place(course).building].filter(Boolean).join(" · "),
        link: "",
        start: course.start,
        end: course.end,
        type: "МФК",
        subject: course.title,
        room: place(course).room,
        teacher: "",
      };
    });
}

/* ---------- Очереди ---------- */

const QUEUES_URL = `${API_URL}/queues`;

// Ответ воркера целиком: очереди группы, места в них и мои права.
let queues = { loaded: false, manager: false, owner: false, me: null, list: [], spots: [] };

async function queuesCall(payload = {}) {
  const group = activeGroup();
  if (!group || group.teacher) return null;
  try {
    const res = await fetch(QUEUES_URL, {
      method: "POST",
      body: JSON.stringify({ initData: tg?.initData || "", group: group.id, ...payload }),
    });
    const body = await res.json();
    if (!body.ok) return body;
    queues = {
      loaded: true,
      manager: body.manager,
      owner: Boolean(body.owner),
      me: body.me,
      list: body.queues,
      spots: body.spots,
    };
    return body;
  } catch {
    return null;
  }
}

function showQueues() {
  const group = activeGroup();
  if (!group) return showPicker();
  els.queuesGroup.textContent = group.teacher ? group.title : t("Группа {g}", { g: group.title });
  renderQueues();
  // Порядок меняется другими людьми — перечитываем при каждом открытии.
  queuesCall({ action: "list" }).then(() => {
    if (tab === "queues") renderQueues();
  });
}

function renderQueues() {
  const group = activeGroup();
  els.queueAdd.hidden = false;

  if (group?.teacher) {
    els.queuesBody.replaceChildren(el("p", "empty", t("Очереди есть только у групп")));
    return;
  }
  if (!tg?.initData) {
    // Без Telegram неизвестно, кто записывается, — записаться нельзя.
    els.queuesBody.replaceChildren(el("p", "empty", t("Очереди работают только в Telegram")));
    return;
  }
  if (!queues.loaded) {
    els.queuesBody.replaceChildren(el("p", "empty", t("Загружаем…")));
    return;
  }
  if (!queues.list.length) {
    els.queuesBody.replaceChildren(
      el("p", "empty", t("Очередей нет. Создайте первую кнопкой ＋"))
    );
    return;
  }

  // Удалённые — в самый низ: они уже не живые, но владелец должен их видеть.
  const ordered = [...queues.list].sort((a, b) => (a.deleted ? 1 : 0) - (b.deleted ? 1 : 0));
  const nodes = ordered.map((queue) => {
    const spots = queues.spots.filter((s) => s.queue === queue.id);
    const mine = spots.findIndex((s) => s.tg_id === queues.me);
    const card = el("article", `q-card${queue.closed ? " q-card--closed" : ""}${queue.deleted ? " q-card--deleted" : ""}`);

    const head = el("div", "q-head");
    head.append(el("div", "q-title", queue.title));
    const facts = [
      queue.subject ? tr(queue.subject) : null,
      queue.number ? t("Семинар {n}", { n: queue.number }) : null,
      queue.day ? SHORT_DATE.format(new Date(`${queue.day}T00:00:00`)) : null,
      t("записалось {n}", { n: spots.length }),
      queue.deleted ? t("удалена") : queue.closed ? t("запись закрыта") : null,
    ].filter(Boolean);
    head.append(el("div", "q-meta", facts.join(" · ")));
    card.append(head);

    const list = el("ol", "q-list");
    for (const [i, spot] of spots.entries()) {
      const row = el("li", spot.tg_id === queues.me ? "q-spot q-spot--me" : "q-spot");
      const place = spot.position || i + 1;
      // Золото, серебро, бронза: первые три места видно с одного взгляда.
      const medal = place <= 3 ? ` q-num--${["gold", "silver", "bronze"][place - 1]}` : "";
      row.append(el("span", `q-num${medal}`, `${place})`));
      row.append(el("span", "q-name", spot.name + (spot.note ? ` — ${spot.note}` : "")));
      // Порядок правит только владелец: иногда записавшиеся меняются местами
      // на словах, и список должен это уметь повторить.
      if (queues.owner) {
        const move = (shift) => {
          const order = spots.map((s) => s.tg_id);
          const to = i + shift;
          if (to < 0 || to >= order.length) return;
          [order[i], order[to]] = [order[to], order[i]];
          queueAction({ action: "order", queue: queue.id, order });
        };
        const up = el("button", "q-move", "↑");
        up.type = "button";
        up.addEventListener("click", () => move(-1));
        const down = el("button", "q-move", "↓");
        down.type = "button";
        down.addEventListener("click", () => move(1));
        row.append(up, down);
      }
      list.append(row);
    }
    if (spots.length) card.append(list);

    const actions = el("div", "card-actions");
    if (mine >= 0) {
      const out = el("button", "ghost", t("Выйти из очереди"));
      out.type = "button";
      out.addEventListener("click", () => queueAction({ action: "leave", queue: queue.id }));
      actions.append(out);
    } else if (!queue.closed && !queue.deleted) {
      const join = el("button", "primary q-join", t("Записаться"));
      join.type = "button";
      join.addEventListener("click", () => joinQueue(queue));
      actions.append(join);
    }
    if (queues.owner && queue.deleted) {
      // Убрать с глаз навсегда: в /queues очередь всё равно останется.
      const hide = el("button", "ghost", t("Скрыть"));
      hide.type = "button";
      hide.addEventListener("click", () => queueAction({ action: "hide", queue: queue.id }));
      actions.append(hide);
    }
    if (queues.owner && !queue.deleted) {
      const close = el("button", "ghost", queue.closed ? t("Открыть запись") : t("Закрыть запись"));
      close.type = "button";
      close.addEventListener("click", () => queueAction({ action: "close", queue: queue.id }));
      actions.append(close);
    }
    if ((queues.manager || queue.author === queues.me) && !queue.deleted) {
      const drop = el("button", "ghost", t("Удалить"));
      drop.type = "button";
      drop.addEventListener("click", () => {
        const ask = t("Удалить очередь вместе с записями?");
        if (tg?.showConfirm) tg.showConfirm(ask, (yes) => yes && queueAction({ action: "delete", queue: queue.id }));
        else if (confirm(ask)) queueAction({ action: "delete", queue: queue.id });
      });
      actions.append(drop);
    }
    card.append(actions);
    return card;
  });

  nodes.forEach((node, i) => node.style.setProperty("--i", i));
  els.queuesBody.replaceChildren(...nodes);
}

const QUEUE_ERRORS = {
  taken: "Этот номер уже занят",
  full: "Мест больше нет",
  closed: "Запись закрыта",
  banned: "Доступ закрыт",
  forbidden: "Это может только староста",
  "too many": "Слишком много очередей, закройте старые",
};

async function queueAction(payload) {
  haptic("light");
  const body = await queuesCall(payload);
  if (body?.ok) haptic(payload.action === "delete" || payload.action === "leave" ? "warning" : "success");
  if (body && !body.ok) {
    haptic("error");
    const text = t(QUEUE_ERRORS[body.error] || "Не получилось, попробуйте ещё раз");
    tg?.showAlert ? tg.showAlert(text) : alert(text);
  }
  renderQueues();
}

// Очередь, в которую записываемся прямо сейчас.
let joining = null;

/**
 * Записываясь, человек сам выбирает номер: «хочу пятым». Занятые номера в
 * списке недоступны, а «любой свободный» ставит в конец.
 */
function joinQueue(queue) {
  if (!els.qnSheet) return queueAction({ action: "join", queue: queue.id, note: "" });
  joining = queue;
  els.qnQueue.textContent = queue.title;
  els.qnNote.value = "";
  els.qnError.hidden = true;

  const taken = new Set(
    queues.spots.filter((s) => s.queue === queue.id && s.position).map((s) => s.position)
  );
  const options = [new Option(t("любой свободный"), "0")];
  for (let n = 1; n <= 99; n++) {
    const option = new Option(taken.has(n) ? t("{n} — занято", { n }) : String(n), String(n));
    option.disabled = taken.has(n);
    options.push(option);
  }
  els.qnNumber.replaceChildren(...options);
  // Предлагаем первый свободный номер: чаще всего хотят именно его.
  let free = 1;
  while (taken.has(free)) free++;
  els.qnNumber.value = String(free <= 99 ? free : 0);
  els.qnSheet.hidden = false;
}

async function submitJoin() {
  if (!joining) return;
  const queue = joining;
  els.qnSheet.hidden = true;
  joining = null;
  await queueAction({
    action: "join",
    queue: queue.id,
    position: Number(els.qnNumber.value) || 0,
    note: els.qnNote.value.trim(),
  });
}

/**
 * Пары, к которым заводят очереди: семинары. На лекции не отвечают по
 * очереди, а языковых «лабораторных» у группы под сотню — выбирать замучаешься.
 */
function seminarSubjects() {
  const group = activeGroup();
  if (!group || group.teacher) return [];
  const found = new Map();
  for (const lesson of data.lessons) {
    if (lesson.group !== group.id || !matchesPrefs(lesson)) continue;
    if (lesson.type !== "семинар" && lesson.type !== "практика") continue;
    if (MILITARY.test(lesson.subject)) continue;
    if (!found.has(lesson.subject)) found.set(lesson.subject, { subject: lesson.subject, teachers: new Set() });
    for (const person of teachersOf(lesson.teacher)) found.get(lesson.subject).teachers.add(person.key);
  }
  return [...found.values()].sort((a, b) => tr(a.subject).localeCompare(tr(b.subject), "ru"));
}

/**
 * Ближайшие даты этой пары — по расписанию, а не произвольным календарём:
 * очередь заводят к конкретному семинару, и он бывает раз в неделю.
 */
function subjectDates(subject) {
  const group = activeGroup();
  const dates = [];
  if (!group || !subject) return dates;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  // До конца семестра: последняя неделя в расписании — последняя учебная.
  const last = (data.weeks || []).at(-1)?.to || "";
  // Семинары нумеруем от начала семестра, а не от сегодня: «семинар 7» —
  // это седьмой по счёту, как его называет преподаватель.
  const start = new Date(`${(data.weeks || [])[0]?.from || isoDate(today)}T00:00:00`);
  let number = 0;
  for (let cursor = new Date(start); isoDate(cursor) <= last; cursor.setDate(cursor.getDate() + 1)) {
    const date = new Date(cursor);
    const weekday = date.getDay();
    if (weekday === 0) continue;
    const parity = parityOfDate(date);
    // Считаем только семинары: у предмета бывают ещё лекции, и если брать
    // их тоже, «семинар 2» превращается в «семинар 4».
    const has = data.lessons.some(
      (l) =>
        l.group === group.id &&
        l.subject === subject &&
        (l.type === "семинар" || l.type === "практика") &&
        l.day === weekday &&
        onDate(l, parity, isoDate(date)) &&
        matchesPrefs(l)
    );
    if (!has) continue;
    number += 1;
    // Прошедшие пары не предлагаем, но номер за ними сохраняется.
    if (isoDate(date) >= isoDate(today)) dates.push({ date, number });
  }
  return dates;
}

/** Чётность недели, в которую попадает дата, — по календарю из расписания. */
function parityOfDate(date) {
  const monday = mondayOf(date);
  const from = isoDate(monday);
  const saturday = new Date(monday);
  saturday.setDate(saturday.getDate() + 5);
  const to = isoDate(saturday);
  const week = (data.weeks || []).find((w) => w.from <= to && from <= w.to);
  return week ? week.parity : null;
}

// Выбранная в окне пара.
let queueSubject = "";

function renderQueuePicker() {
  if (!els.qSubjects) return;
  const query = searchKey(els.qFind?.value || "");
  const items = seminarSubjects().filter(
    (item) =>
      !query ||
      searchKey(tr(item.subject)).includes(query) ||
      [...item.teachers].some((key) => searchKey(key).includes(query))
  );

  const nodes = items.map((item) => {
    const chip = el("button", item.subject === queueSubject ? "q-pick q-pick--on" : "q-pick");
    chip.type = "button";
    chip.append(el("span", "q-pick-name", tr(item.subject)));
    const who = [...item.teachers].map((key) => teacherFull(key) || key).join(", ");
    if (who) chip.append(el("span", "q-pick-who", who));
    chip.addEventListener("click", () => {
      haptic("select");
      queueSubject = item.subject === queueSubject ? "" : item.subject;
      renderQueuePicker();
      fillQueueDates();
    });
    return chip;
  });
  if (!nodes.length) nodes.push(el("p", "hint", t("Семинаров не нашлось")));
  els.qSubjects.replaceChildren(...nodes);
}

/** Даты — только те, когда эта пара есть. Без пары дат не предлагаем. */
function fillQueueDates() {
  if (!els.qDay) return;
  const dates = subjectDates(queueSubject);
  els.qDay.replaceChildren(
    new Option(t("без даты"), ""),
    // FULL_DATE уже пишет день недели — второй раз его не повторяем.
    ...dates.map(({ date, number }) =>
      new Option(`${t("Семинар {n}", { n: number })} · ${FULL_DATE.format(date)}`, `${isoDate(date)}|${number}`)
    )
  );
  els.qDay.parentElement.hidden = !dates.length;
  if (dates.length) els.qDay.value = `${isoDate(dates[0].date)}|${dates[0].number}`;
}

function openQueueSheet() {
  if (!els.qSheet) return;
  queueSubject = "";
  if (els.qFind) els.qFind.value = "";
  els.qName.value = "";
  els.qError.hidden = true;
  loadTeacherNames().then(renderQueuePicker);
  renderQueuePicker();
  fillQueueDates();
  els.qSheet.hidden = false;
}

async function createQueue() {
  const subject = queueSubject;
  // Название можно не писать: очередь к семинару назовётся сама.
  const title = els.qName.value.trim() || (subject ? t("Доклады: {subject}", { subject: tr(subject) }) : "");
  if (!title) {
    els.qError.textContent = t("Без названия очередь не создать");
    els.qError.hidden = false;
    return;
  }
  els.qSheet.hidden = true;
  const [day = "", number = ""] = (els.qDay.value || "").split("|");
  await queueAction({ action: "create", title, subject, day, number: Number(number) || 0 });
}

/* ---------- Неделя целиком ---------- */

/** Эта неделя ↔ следующая — перелистыванием, как дни. */
function switchWeek(week, fromShift = 0) {
  if (week === selectedWeek || week < 0 || week >= WEEKS) return false;
  const direction = Math.sign(week - selectedWeek);
  haptic("select");
  selectedWeek = week;
  slideSwap(els.weekBody, direction, () => showWeek(), fromShift);
  return true;
}

/** Свайп по неделе листает недели. Вертикальная прокрутка не мешает. */
function initWeekSwipe() {
  const body = els.weekBody;
  if (!body) return;
  let start = null;
  let shift = 0;
  let dragging = false;
  let decided = false;
  body.addEventListener("pointerdown", (event) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    if (lessonViewBusy()) return;
    start = { x: event.clientX, y: event.clientY, at: performance.now(), id: event.pointerId };
    shift = 0;
    dragging = false;
    decided = false;
    body.style.transition = "none";
  });
  body.addEventListener("pointermove", (event) => {
    if (!start || event.pointerId !== start.id) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (!decided) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      decided = true;
      dragging = Math.abs(dx) > Math.abs(dy);
    }
    if (!dragging) return;
    // Дальше двух недель листать некуда — сопротивление на краю.
    const edge = (dx > 0 && selectedWeek === 0) || (dx < 0 && selectedWeek === WEEKS - 1);
    shift = edge ? dx * 0.25 : dx;
    body.style.transform = `translateX(${shift.toFixed(1)}px)`;
  });
  const finish = (event) => {
    if (!start || event.pointerId !== start.id) return;
    const was = start;
    start = null;
    if (!dragging) return;
    const velocity = Math.abs(shift) / Math.max(1, performance.now() - was.at);
    const far = Math.abs(shift) > body.clientWidth * SWIPE_DISTANCE;
    const target = selectedWeek + (shift < 0 ? 1 : -1);
    body.style.transition = "";
    if ((far || velocity > SWIPE_VELOCITY) && target >= 0 && target < WEEKS) {
      const from = shift;
      body.style.transform = "";
      switchWeek(target, from);
      return;
    }
    body.style.transition = "transform 260ms cubic-bezier(0.22, 0.8, 0.28, 1)";
    body.style.transform = "translateX(0)";
    body.addEventListener("transitionend", () => (body.style.transition = ""), { once: true });
  };
  body.addEventListener("pointerup", finish);
  body.addEventListener("pointercancel", finish);
}

function showWeek() {
  const group = activeGroup();
  if (!group) return showPicker();
  els.weekGroup.textContent = group.teacher ? group.title : t("Группа {g}", { g: group.title });
  const parity = weekParity(data.weeks, selectedWeek);
  document.body.dataset.parity = parity || "none";
  els.weekParity.textContent =
    parity === "odd" ? t("Нечётная неделя") : parity === "even" ? t("Чётная неделя") : t("Вне семестра");
  els.weekRange.textContent = `${SHORT_DATE.format(dateOfDay(1, selectedWeek))} — ${SHORT_DATE.format(dateOfDay(6, selectedWeek))}`;

  // Переключатель недель: их всего две, кнопки понятнее листания.
  els.weekSwitch.replaceChildren(
    ...[0, 1].map((week) => {
      const button = el("button", week === selectedWeek ? "day active" : "day");
      button.append(
        el("span", null, week === 0 ? t("Эта неделя") : t("Следующая")),
        el("span", "day-date", `${SHORT_DATE.format(dateOfDay(1, week))}`)
      );
      button.addEventListener("click", () => switchWeek(week));
      return button;
    })
  );

  // Неделя — одной сеткой: дни столбцами, пары строками.
  els.weekBody.replaceChildren(renderWeekGrid(group));
}

/* ---------- Блокировка ---------- */

let banTimer = null;

/** Рожица с крестиками вместо глаз и высунутым языком. */
function bannedFace() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 120 120");
  svg.setAttribute("class", "banned-face");
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = [
    '<g stroke="currentColor" stroke-width="7" stroke-linecap="round">',
    '<line x1="30" y1="41" x2="46" y2="57" /><line x1="46" y1="41" x2="30" y2="57" />',
    '<line x1="62" y1="41" x2="78" y2="57" /><line x1="78" y1="41" x2="62" y2="57" />',
    "</g>",
    // Рот — настоящая буква P, повёрнутая в другую сторону.
    '<text x="60" y="88" text-anchor="middle" dominant-baseline="central" fill="currentColor"',
    ' font-family="Arial, Helvetica, sans-serif" font-size="52" font-weight="700"',
    ' transform="rotate(90 60 82)">P</text>',
  ].join("");
  return svg;
}

/** Экран вместо расписания: рожица, причина и сколько осталось. */
function showBanned(ban) {
  els.picker.hidden = true;
  els.schedule.hidden = true;
  els.search.hidden = true;
  els.free.hidden = true;
  document.getElementById("banned")?.remove();

  const screen = el("section", "banned");
  screen.id = "banned";
  screen.append(bannedFace());
  screen.append(el("div", "banned-title", t("Отказано в доступе")));
  if (ban.reason) screen.append(el("div", "banned-reason", ban.reason));
  const left = el("div", "banned-left");
  screen.append(left);
  document.body.append(screen);

  const tick = () => {
    if (!ban.until) {
      left.textContent = t("Навсегда");
      return;
    }
    const ms = new Date(ban.until) - new Date();
    if (ms <= 0) return location.reload();
    const days = Math.floor(ms / 86400000);
    const pad = (n) => String(n).padStart(2, "0");
    const rest = `${pad(Math.floor(ms / 3600000) % 24)}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)}`;
    left.textContent = `${t("Осталось")}: ${days ? `${days} ${t("дн.")} ` : ""}${rest}`;
  };
  tick();
  clearInterval(banTimer);
  banTimer = setInterval(tick, 1000);
}

/* ---------- Важные пары ---------- */

const plainKey = (text) => String(text || "").toLowerCase().replace(/ё/g, "е");

/**
 * Пары, которые владелец пометил как важные (/important): преподаватель по
 * фамилии или предмет целиком. Красная полоса и метка — у всех студентов.
 */
function applyImportant() {
  const list = notices.important || [];
  for (const card of els.lessons.querySelectorAll(".card")) {
    const teachers = plainKey(card.dataset.teachers);
    const subject = plainKey(card.dataset.subject);
    const hit = list.some((row) =>
      row.kind === "subject"
        ? plainKey(row.value) === subject
        : new RegExp(`(^|[^а-яa-z])${plainKey(row.value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(teachers)
    );
    card.classList.toggle("card--important", hit);
    const head = card.querySelector(".time");
    const tag = head?.querySelector(".tag--important");
    if (hit && head && !tag) head.append(el("span", "tag tag--important", t("важно")));
    if (!hit) tag?.remove();
  }
}

/* ---------- Свои важные пары ---------- */

// Студент сам помечает важные ему предметы звёздочкой. Помечается пара, на
// которой нажали, и все следующие пары этого предмета — прошлые остаются
// как были. Хранится там же, где пропуски, — у него в Telegram.
const MINE_KEY = "mine";
let mine = { subjects: {}, told: false };
let mineLoaded = false;

async function loadMine() {
  if (mineLoaded) return mine;
  try {
    const parsed = JSON.parse((await cloudGet(MINE_KEY)) || "null");
    if (parsed && typeof parsed === "object") {
      mine = { subjects: parsed.subjects || {}, told: Boolean(parsed.told) };
    }
  } catch {
    // Испорченная запись — начинаем с чистого листа.
  }
  mineLoaded = true;
  return mine;
}

/** Отмечена ли эта пара: предмет в избранном с этой даты или раньше. */
function isMine(subject, date) {
  const from = mine.subjects[subject];
  return Boolean(from) && isoDate(date) >= from;
}

/**
 * Звёздочка на незвёздной паре — предмет в избранном с этого дня и дальше.
 * На звёздной — снимается со всего предмета: так проще, чем помнить, с
 * какой даты что отмечено.
 */
function toggleMine(subject, date) {
  if (isMine(subject, date)) delete mine.subjects[subject];
  else mine.subjects[subject] = isoDate(date);
  cloudSet(MINE_KEY, JSON.stringify(mine));
}

/** Короткая подсказка снизу — сама тает через несколько секунд. */
function toast(text) {
  document.querySelector(".toast")?.remove();
  const node = el("div", "toast", text);
  document.body.append(node);
  setTimeout(() => node.classList.add("toast--out"), 4200);
  setTimeout(() => node.remove(), 4600);
}

/** Звёздочка в строке номера пары: тап — важно для меня, ещё тап — снять. */
function applyMine() {
  const date = dateOfDay(selectedDay);
  for (const card of els.lessons.querySelectorAll(".card")) {
    card.querySelector(".mine-star")?.remove();
    const subject = card.dataset.subject;
    const head = card.querySelector(".time");
    if (!subject || !head) continue;
    const on = isMine(subject, date);
    card.classList.toggle("card--mine", on);
    const star = el("button", on ? "mine-star mine-star--on" : "mine-star", on ? "★" : "☆");
    star.type = "button";
    star.setAttribute("aria-label", t("Важно для меня"));
    star.addEventListener("click", (event) => {
      event.stopPropagation();
      toggleMine(subject, date);
      const now = isMine(subject, date);
      haptic(now ? "success" : "light");
      // Звезда переключается у всех карточек этого предмета на экране.
      applyMine();
      const fresh = [...els.lessons.querySelectorAll(".card")]
        .filter((c) => c.dataset.subject === subject)
        .map((c) => c.querySelector(".mine-star"));
      for (const node of fresh) {
        node?.animate(
          [{ transform: "scale(0.6) rotate(-30deg)" }, { transform: "scale(1.35) rotate(12deg)", offset: 0.55 }, { transform: "none" }],
          { duration: 460, easing: "cubic-bezier(0.3, 1.5, 0.5, 1)" }
        );
      }
      // Как это работает — объясняем один раз, при первой звезде.
      if (now && !mine.told) {
        mine.told = true;
        cloudSet(MINE_KEY, JSON.stringify(mine));
        toast(t("★ Отмечены эта пара и все следующие пары этого предмета. Снять — нажмите на звезду у любой из них."));
      }
    });
    head.append(star);
  }
}

/* ---------- Личные заметки к паре ---------- */

// «Принести доклад», «сдать до пятницы» — к конкретной паре конкретного
// дня. Хранятся в облаке Telegram у самого студента, как пропуски: никто
// другой их не видит, боту они не уходят. Облако берёт не больше 4096
// знаков на запись, поэтому заметки лежат по неделям.
const NOTE_MAX = 300;
const NOTE_WEEK_MAX = 3800;
const noteWeeks = new Map();

function noteWeekKey(date) {
  const monday = new Date(date);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  return `notes-${isoDate(monday)}`;
}

function noteId(date, slot, subject) {
  return `${isoDate(date)}|${slot}|${subject}`;
}

async function loadNotes() {
  for (let week = 0; week < WEEKS; week++) {
    const key = noteWeekKey(dateOfDay(1, week));
    if (noteWeeks.has(key)) continue;
    let items = {};
    try {
      const parsed = JSON.parse((await cloudGet(key)) || "{}");
      if (parsed && typeof parsed === "object") items = parsed;
    } catch {
      // Испорченная запись — начинаем неделю с чистого листа.
    }
    noteWeeks.set(key, items);
  }
}

function noteOf(date, slot, subject) {
  return noteWeeks.get(noteWeekKey(date))?.[noteId(date, slot, subject)] || "";
}

/** Сохраняет или стирает заметку. false — на неделю уже не лезет. */
function saveNote(date, slot, subject, text) {
  const key = noteWeekKey(date);
  const items = { ...(noteWeeks.get(key) || {}) };
  if (text) items[noteId(date, slot, subject)] = text;
  else delete items[noteId(date, slot, subject)];
  const value = JSON.stringify(items);
  if (value.length > NOTE_WEEK_MAX) return false;
  noteWeeks.set(key, items);
  cloudSet(key, value);
  return true;
}

/** Карандаш рядом со звездой и сама заметка под парой. */
function applyNotes() {
  const date = dateOfDay(selectedDay);
  for (const card of els.lessons.querySelectorAll(".card")) {
    card.querySelector(".note-pen")?.remove();
    card.querySelector(".my-note")?.remove();
    const subject = card.dataset.subject;
    const head = card.querySelector(".time");
    if (!subject || !head) continue;
    const slot = Number(card.dataset.slot);
    const text = noteOf(date, slot, subject);
    const open = (event) => {
      event.stopPropagation();
      openNote(card);
    };
    const pen = el("button", text ? "note-pen note-pen--on" : "note-pen", "✎");
    pen.type = "button";
    pen.setAttribute("aria-label", t("Заметка"));
    pen.addEventListener("click", open);
    // Перед звездой: она прижата к правому краю, карандаш встаёт слева от неё.
    const star = head.querySelector(".mine-star");
    if (star) star.before(pen);
    else head.append(pen);
    if (!text) continue;
    // Своё имя класса: «.note» — примечание из расписания, его не трогаем.
    const line = el("button", "my-note");
    line.type = "button";
    line.append(el("span", "note-icon", "📝"), el("span", "note-text", text));
    line.addEventListener("click", open);
    (card.querySelector(".card-body") || card).append(line);
  }
}

let noteSheet = null;
let noting = null;

function openNote(card) {
  if (!noteSheet) {
    // Окно с полем ввода встаёт сразу в верхней части экрана: под ним
    // остаётся место для клавиатуры, и она ничего не двигает.
    noteSheet = el("div", "sheet-backdrop sheet-backdrop--input");
    noteSheet.hidden = true;
    const sheet = el("div", "sheet sheet--note");
    sheet.setAttribute("role", "dialog");
    sheet.setAttribute("aria-modal", "true");
    const area = el("textarea", "note-area");
    area.rows = 4;
    area.maxLength = NOTE_MAX;
    area.placeholder = t("Принести доклад, сдать до пятницы…");
    const save = el("button", "primary note-save", t("Сохранить"));
    save.type = "button";
    const actions = el("div", "sheet-actions");
    const remove = el("button", "ghost note-delete", t("Удалить"));
    const cancel = el("button", "ghost", t("Отмена"));
    remove.type = cancel.type = "button";
    actions.append(remove, cancel);
    sheet.append(
      el("div", "group-name note-when"),
      el("h2", "note-title"),
      area,
      el("p", "note-private", t("🔒 Заметку видите только вы: она хранится в вашем Telegram.")),
      el("p", "error note-error"),
      save,
      actions
    );
    noteSheet.append(sheet);
    const submit = (text) => {
      if (!noting) return;
      if (!saveNote(noting.date, noting.slot, noting.subject, text.trim())) {
        const error = noteSheet.querySelector(".note-error");
        error.textContent = t("На эту неделю заметок уже слишком много — сократите или удалите старые.");
        error.hidden = false;
        return;
      }
      haptic(text.trim() ? "success" : "light");
      closeNote();
      applyNotes();
      if (tab === "week") showWeek();
    };
    save.addEventListener("click", () => submit(area.value));
    remove.addEventListener("click", () => submit(""));
    cancel.addEventListener("click", closeNote);
    noteSheet.addEventListener("click", (event) => {
      if (event.target === noteSheet) closeNote();
    });
    document.body.append(noteSheet);
  }
  const date = dateOfDay(selectedDay);
  noting = { date, slot: Number(card.dataset.slot), subject: card.dataset.subject };
  const label = FULL_DATE.format(date);
  const slotLabel = card.querySelector(".slot")?.textContent || "";
  noteSheet.querySelector(".note-when").textContent = `${label[0].toUpperCase()}${label.slice(1)} · ${slotLabel}`;
  noteSheet.querySelector(".note-title").textContent = tr(noting.subject);
  const existing = noteOf(date, noting.slot, noting.subject);
  const area = noteSheet.querySelector(".note-area");
  area.value = existing;
  noteSheet.querySelector(".note-delete").hidden = !existing;
  noteSheet.querySelector(".note-error").hidden = true;
  noteSheet.hidden = false;
  haptic("light");
  area.focus();
}

function closeNote() {
  if (noteSheet) noteSheet.hidden = true;
  noting = null;
  document.activeElement?.blur?.();
}

/* ---------- Свои дела ---------- */

// Тренировка, работа, кружок — то, чего нет в расписании факультета, но что
// занимает время в том же дне. Человек добавляет сам; карточка встаёт среди
// пар по своему времени. Хранится на этом устройстве и никуда не уходит,
// поэтому бот о своих делах не знает и не напоминает.
const OWN_KEY = "schedule.own";
const OWN_MAX = 40;

function ownEvents() {
  try {
    const list = JSON.parse(localStorage.getItem(OWN_KEY) || "[]");
    return Array.isArray(list) ? list.filter((e) => e && e.title && e.start && e.end) : [];
  } catch {
    return [];
  }
}

function saveOwnEvents(list) {
  try {
    localStorage.setItem(OWN_KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

/** Свои дела на дату: разовые — по числу, еженедельные — по дню недели. */
function ownEventsOn(date) {
  const iso = isoDate(date);
  const day = date.getDay() || 7;
  return ownEvents()
    .filter((e) => (e.date ? e.date === iso : e.day === day))
    .sort((a, b) => minutes(a.start) - minutes(b.start));
}

function renderOwnCard(event) {
  // Не кнопка, а блок с ролью кнопки: внутри своя кнопка — корзина.
  const card = el("div", "own-card");
  card.setAttribute("role", "button");
  card.tabIndex = 0;
  card.dataset.start = event.start;
  card.dataset.end = event.end;
  const when = el("div", "card-when");
  when.append(el("span", "card-start", event.start), el("span", "card-line"), el("span", "card-end", event.end));
  const body = el("div", "own-body");
  const head = el("div", "own-head");
  head.append(el("span", "own-tag", t("своё")));
  if (!event.date) head.append(el("span", "own-repeat", t("каждую неделю")));
  body.append(head, el("div", "subject", event.title));
  if (event.place) body.append(el("div", "own-place", event.place));
  // Корзина в углу. Первое нажатие только спрашивает: дело может быть
  // еженедельным, и случайный тап стёр бы его со всех недель разом.
  const bin = el("button", "own-bin");
  bin.type = "button";
  bin.setAttribute("aria-label", t("Удалить"));
  bin.innerHTML =
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>';
  const ask = el("span", "own-bin-ask", t("Удалить?"));
  bin.append(ask);
  let armed = 0;
  bin.addEventListener("click", (click) => {
    click.stopPropagation();
    if (!bin.classList.contains("own-bin--ask")) {
      bin.classList.add("own-bin--ask");
      haptic("light");
      clearTimeout(armed);
      armed = setTimeout(() => bin.classList.remove("own-bin--ask"), 3000);
      return;
    }
    clearTimeout(armed);
    saveOwnEvents(ownEvents().filter((e) => e.id !== event.id));
    haptic("success");
    refreshOwn();
  });
  card.append(when, body, bin);
  card.addEventListener("click", () => openOwn(event));
  card.addEventListener("keydown", (key) => {
    if (key.target === card && (key.key === "Enter" || key.key === " ")) {
      key.preventDefault();
      openOwn(event);
    }
  });
  return card;
}

function renderOwnAdd() {
  const button = el("button", "own-add");
  button.type = "button";
  const text = el("span", "own-add-text");
  text.append(el("span", "own-add-title", t("Своё дело")), el("span", "own-add-hint", t("Тренировка, работа, кружок…")));
  button.append(el("span", "own-add-plus", "+"), text);
  button.addEventListener("click", () => openOwn(null));
  return button;
}

/* Плашка «Вы староста?» — ведёт в бот, где заявка уходит владельцу на
   подтверждение. Её не видят преподаватели, уже назначенные старосты и те,
   кто закрыл её крестиком. */
const STAROSTA_ASK_KEY = "schedule.starostaAskOff";

function starostaAskHidden() {
  try {
    return localStorage.getItem(STAROSTA_ASK_KEY) === "1";
  } catch {
    return false;
  }
}

function renderStarostaAsk() {
  if (prefs.teacher || notices.canEdit || !activeGroup() || starostaAskHidden()) return null;
  const card = el("div", "starosta-ask");
  const open = el("button", "starosta-ask-main");
  open.type = "button";
  const text = el("span", "starosta-ask-text");
  text.append(
    el("span", "starosta-ask-title", t("Вы староста?")),
    el("span", "starosta-ask-hint", t("Напишите нам — выдадим права: домашка и объявления для группы"))
  );
  open.append(el("span", "starosta-ask-icon", "🎓"), text);
  open.addEventListener("click", () => {
    haptic("light");
    // Плашку часто задевают случайно, листая день, — переспрашиваем.
    const group = activeGroup();
    const question = t("Вы староста группы {g}? Откроем бота, чтобы запросить права старосты.", { g: group?.title || "" });
    const go = () => {
      const link = `${BOT_LINK}?start=starosta`;
      if (tg?.openTelegramLink) tg.openTelegramLink(link);
      else window.open(link, "_blank", "noopener");
    };
    if (tg?.showConfirm && tg.isVersionAtLeast?.("6.2")) {
      tg.showConfirm(question, (ok) => {
        if (ok) go();
      });
    } else if (window.confirm(question)) {
      go();
    }
  });
  const close = el("button", "starosta-ask-close", "×");
  close.type = "button";
  close.setAttribute("aria-label", t("Скрыть"));
  close.addEventListener("click", () => {
    haptic("light");
    try {
      localStorage.setItem(STAROSTA_ASK_KEY, "1");
    } catch {
      // Без хранилища плашка вернётся после перезапуска — не беда.
    }
    card.remove();
  });
  card.append(open, close);
  return card;
}

/** Ставит свои дела между карточками пар — по времени начала. */
function placeOwn(nodes, date) {
  for (const event of ownEventsOn(date)) {
    const card = renderOwnCard(event);
    const at = nodes.findIndex(
      (node) => node.dataset?.start && minutes(node.dataset.start) > minutes(event.start)
    );
    if (at < 0) nodes.push(card);
    else nodes.splice(at, 0, card);
  }
}

/** Свои дела в неделе: строка с точкой вместо номера пары. */
function appendOwnRows(column, date, day) {
  for (const event of ownEventsOn(date)) {
    const row = el("button", "week-row week-row--own");
    row.type = "button";
    row.append(el("span", "week-slot", "•"), el("span", "week-subject", event.title), el("span", "week-time", event.start));
    row.addEventListener("click", () => {
      selectedDay = day;
      openTab("schedule");
    });
    column.append(row);
  }
}

let ownSheet = null;
let owning = null;

function openOwn(event) {
  if (!ownSheet) {
    ownSheet = el("div", "sheet-backdrop sheet-backdrop--input");
    ownSheet.hidden = true;
    const sheet = el("div", "sheet sheet--own");
    sheet.setAttribute("role", "dialog");
    sheet.setAttribute("aria-modal", "true");
    const title = el("input", "own-title");
    title.type = "text";
    title.maxLength = 60;
    title.placeholder = t("Тренировка, работа, кружок…");
    const start = el("input", "own-start");
    const end = el("input", "own-end");
    start.type = end.type = "time";
    // Начало и конец — одной плашкой: два времени крупно, между ними
    // сколько это длится. Нажатие в любую половину открывает выбор времени.
    const times = el("div", "own-times");
    const from = el("label", "own-field");
    from.append(el("span", "own-field-name", t("Начало")), start);
    const to = el("label", "own-field");
    to.append(el("span", "own-field-name", t("Конец")), end);
    const length = el("span", "own-length");
    times.append(from, length, to);
    const measure = () => {
      const span = start.value && end.value ? minutes(end.value) - minutes(start.value) : 0;
      times.classList.toggle("own-times--bad", span <= 0);
      if (span <= 0) return (length.textContent = "→");
      const hours = Math.floor(span / 60);
      const rest = span % 60;
      length.textContent = [hours ? t("{n} ч", { n: hours }) : "", rest ? t("{n} мин", { n: rest }) : ""].filter(Boolean).join(" ");
    };
    start.addEventListener("input", measure);
    end.addEventListener("input", measure);
    times.measure = measure;
    for (const field of [start, end]) {
      // На телефоне выбор времени открывается сам; на компьютере — по нажатию.
      field.addEventListener("click", () => {
        try {
          field.showPicker?.();
        } catch {
          // Не умеет или уже открыт.
        }
      });
    }
    const place = el("input", "own-where");
    place.type = "text";
    place.maxLength = 60;
    place.placeholder = t("Где (необязательно)");
    const weekly = el("label", "check own-weekly");
    const box = el("input", "own-weekly-box");
    box.type = "checkbox";
    weekly.append(box, el("span", "", t("Каждую неделю в этот день")));
    const save = el("button", "primary own-save", t("Сохранить"));
    save.type = "button";
    const actions = el("div", "sheet-actions");
    const remove = el("button", "ghost own-delete", t("Удалить"));
    const cancel = el("button", "ghost", t("Отмена"));
    remove.type = cancel.type = "button";
    actions.append(remove, cancel);
    sheet.append(
      el("div", "group-name own-when"),
      el("h2", "own-heading"),
      title,
      times,
      place,
      weekly,
      el("p", "error own-error"),
      save,
      actions,
      // Пояснение — в самом низу: кнопки должны быть видны без прокрутки.
      el("p", "note-private", t("🔒 Своё дело видите только вы: оно хранится на этом устройстве. Бот о нём не напоминает."))
    );
    ownSheet.append(sheet);
    const fail = (text) => {
      const error = ownSheet.querySelector(".own-error");
      error.textContent = text;
      error.hidden = false;
    };
    save.addEventListener("click", () => {
      if (!owning) return;
      const name = title.value.trim();
      if (!name) return fail(t("Напишите, что это за дело."));
      if (!start.value || !end.value || minutes(end.value) <= minutes(start.value)) {
        return fail(t("Конец должен быть позже начала."));
      }
      const list = ownEvents().filter((e) => e.id !== owning.id);
      if (list.length >= OWN_MAX) return fail(t("Своих дел уже слишком много — удалите ненужные."));
      const entry = { id: owning.id, title: name, start: start.value, end: end.value, place: place.value.trim() };
      if (box.checked) entry.day = owning.date.getDay() || 7;
      else entry.date = isoDate(owning.date);
      if (!saveOwnEvents([...list, entry])) return fail(t("Не получилось сохранить: в телефоне нет места для данных."));
      haptic("success");
      closeOwn();
      refreshOwn();
    });
    remove.addEventListener("click", () => {
      if (!owning) return;
      saveOwnEvents(ownEvents().filter((e) => e.id !== owning.id));
      haptic("light");
      closeOwn();
      refreshOwn();
    });
    cancel.addEventListener("click", closeOwn);
    ownSheet.addEventListener("click", (click) => {
      if (click.target === ownSheet) closeOwn();
    });
    document.body.append(ownSheet);
  }
  const date = dateOfDay(selectedDay);
  owning = { id: event?.id || `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, date };
  const label = FULL_DATE.format(date);
  ownSheet.querySelector(".own-when").textContent = label[0].toUpperCase() + label.slice(1);
  ownSheet.querySelector(".own-heading").textContent = event ? t("Своё дело") : t("Новое своё дело");
  ownSheet.querySelector(".own-title").value = event?.title || "";
  ownSheet.querySelector(".own-start").value = event?.start || "19:00";
  ownSheet.querySelector(".own-end").value = event?.end || "20:30";
  ownSheet.querySelector(".own-where").value = event?.place || "";
  ownSheet.querySelector(".own-times").measure();
  ownSheet.querySelector(".own-weekly-box").checked = event ? !event.date : true;
  ownSheet.querySelector(".own-delete").hidden = !event;
  ownSheet.querySelector(".own-error").hidden = true;
  ownSheet.hidden = false;
  haptic("light");
  if (!event) ownSheet.querySelector(".own-title").focus();
}

function closeOwn() {
  if (ownSheet) ownSheet.hidden = true;
  owning = null;
  document.activeElement?.blur?.();
}

function refreshOwn() {
  if (tab === "week") showWeek();
  else showSchedule();
}

/* ---------- Мой семестр ---------- */

/**
 * Все пары семестра по своему расписанию: с подгруппами, языками и
 * военной кафедрой, как в настройках. Отмены и замены прошлых недель
 * приложение не знает, поэтому счёт — по расписанию, а не по журналу.
 */
function semesterLessons() {
  const group = activeGroup();
  const weeks = data.weeks || [];
  const out = [];
  if (!group || !weeks.length) return out;
  const now = new Date();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const todayIso = isoDate(now);
  const bells = new Map(data.bells.map((b) => [b.n, b]));
  const cursor = new Date(`${weeks[0].from}T00:00:00`);
  const last = weeks.at(-1).to;
  for (; isoDate(cursor) <= last; cursor.setDate(cursor.getDate() + 1)) {
    const weekday = cursor.getDay();
    if (weekday === 0) continue;
    const parity = parityOfDate(cursor);
    const list = group.teacher
      ? teacherLessons(group.teacher, parity, weekday, isoDate(cursor))
      : data.lessons.filter(
          (l) =>
            l.group === group.id &&
            l.day === weekday &&
            onDate(l, parity, isoDate(cursor)) &&
            matchesPrefs(l)
        );
    // Параллельные записи одной пары (подгруппы) — одна пара.
    const seen = new Set();
    const iso = isoDate(cursor);
    for (const lesson of list) {
      const id = `${lesson.slot}|${lesson.subject}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const time = timesOf(lesson, bells);
      const done = iso < todayIso || (iso === todayIso && time && minutes(time.end) <= nowMinutes);
      out.push({ iso, weekday, slot: lesson.slot, subject: lesson.subject, type: lesson.type || "", done: Boolean(done) });
    }
  }
  return out;
}

function semesterStats() {
  const lessons = semesterLessons();
  // Две пары в одно время (дисциплины по выбору, если не выбрано) — один поход.
  const slots = new Map();
  for (const l of lessons) slots.set(`${l.iso}|${l.slot}`, l);
  const all = [...slots.values()];
  const done = all.filter((l) => l.done).length;
  const bySubject = new Map();
  for (const l of lessons) {
    const item = bySubject.get(l.subject) || { subject: l.subject, total: 0, done: 0 };
    item.total += 1;
    if (l.done) item.done += 1;
    bySubject.set(l.subject, item);
  }
  const days = new Map();
  for (const l of all) {
    const day = days.get(l.iso) || { weekday: l.weekday, count: 0, first: 99, done: true };
    day.count += 1;
    day.first = Math.min(day.first, l.slot);
    day.done = day.done && l.done;
    days.set(l.iso, day);
  }
  const dayList = [...days.values()];
  const load = new Map();
  for (const day of dayList) {
    const item = load.get(day.weekday) || { sum: 0, n: 0 };
    item.sum += day.count;
    item.n += 1;
    load.set(day.weekday, item);
  }
  const heavy = [...load].map(([weekday, v]) => ({ weekday, avg: v.sum / v.n })).sort((a, b) => b.avg - a.avg)[0];
  return {
    total: all.length,
    done,
    subjects: [...bySubject.values()].sort((a, b) => b.total - a.total),
    daysLeft: dayList.filter((d) => !d.done).length,
    earlyLeft: dayList.filter((d) => !d.done && d.first === 1).length,
    lectures: all.filter((l) => l.type === "лекция").length,
    heavy,
  };
}

let semesterSheet = null;

function openSemester() {
  if (!data || !activeGroup()) return;
  if (!semesterSheet) {
    semesterSheet = el("div", "sheet-backdrop");
    semesterSheet.hidden = true;
    const sheet = el("div", "sheet sheet--abs sheet--semester");
    sheet.setAttribute("role", "dialog");
    sheet.setAttribute("aria-modal", "true");
    const top = el("div", "sheet-top");
    const head = el("div");
    head.append(el("h2", "", t("Мой семестр")), el("div", "sem-note"));
    const close = el("button", "icon", "×");
    close.type = "button";
    close.setAttribute("aria-label", t("Закрыть"));
    close.addEventListener("click", closeSemester);
    top.append(head, close);
    sheet.append(top, el("div", "sem-body"));
    semesterSheet.append(sheet);
    semesterSheet.addEventListener("click", (event) => {
      if (event.target === semesterSheet) closeSemester();
    });
    document.body.append(semesterSheet);
  }
  renderSemester();
  semesterSheet.classList.remove("sheet-backdrop--out");
  semesterSheet.hidden = false;
}

function closeSemester() {
  const sheet = semesterSheet;
  if (!sheet || sheet.hidden || sheet.classList.contains("sheet-backdrop--out")) return;
  haptic("light");
  sheet.classList.add("sheet-backdrop--out");
  setTimeout(() => {
    sheet.hidden = true;
    sheet.classList.remove("sheet-backdrop--out");
  }, 260);
}

function semBar(done, total) {
  const bar = el("span", "sem-bar");
  const fill = el("span", "sem-bar-fill");
  fill.style.setProperty("--p", total ? done / total : 0);
  bar.append(fill);
  return bar;
}

function renderSemester() {
  const stats = semesterStats();
  const body = semesterSheet.querySelector(".sem-body");
  semesterSheet.querySelector(".sem-note").textContent = t("По вашему расписанию, без учёта отмен");
  if (!stats.total) {
    body.replaceChildren(el("p", "empty", t("Пар в этом семестре нет")));
    return;
  }
  const percent = Math.round((stats.done / stats.total) * 100);
  const hero = el("div", "sem-hero");
  hero.append(
    el("div", "sem-percent", `${percent}%`),
    el("div", "sem-hero-text", t("семестра позади")),
    semBar(stats.done, stats.total)
  );

  const tile = (value, label) => {
    const node = el("div", "sem-tile");
    node.append(el("b", "", String(value)), el("span", "", label));
    return node;
  };
  const hours = (n) => Math.round(n * 1.5);
  const tiles = el("div", "sem-tiles");
  tiles.append(
    tile(stats.done, t("пар позади")),
    tile(stats.total - stats.done, t("пар впереди")),
    tile(hours(stats.done), t("часов на парах")),
    tile(stats.daysLeft, t("учебных дней осталось"))
  );

  const facts = el("div", "sem-facts");
  const fact = (icon, text) => {
    const node = el("div", "sem-fact");
    node.append(el("span", "sem-fact-icon", icon), el("span", "", text));
    return node;
  };
  if (stats.heavy) {
    facts.append(
      fact("🏋️", t("Самый тяжёлый день — {day}, в среднем пар: {n}", { day: new Intl.DateTimeFormat(LOCALE, { weekday: "long" }).format(new Date(2024, 0, stats.heavy.weekday)), n: stats.heavy.avg.toFixed(1).replace(".", ",") }))
    );
  }
  facts.append(fact("⏰", t("Подъёмов к первой паре осталось: {n}", { n: stats.earlyLeft })));
  facts.append(fact("🎓", t("Лекций {a}, семинаров и практик {b}", { a: stats.lectures, b: stats.total - stats.lectures })));

  const list = el("div", "sem-list");
  for (const item of stats.subjects) {
    const row = el("div", "sem-row");
    const headRow = el("div", "sem-row-head");
    headRow.append(el("span", "sem-row-name", tr(item.subject)), el("span", "sem-row-count", `${item.done} / ${item.total}`));
    row.append(headRow, semBar(item.done, item.total));
    list.append(row);
  }
  body.replaceChildren(hero, tiles, facts, el("h3", "sem-title", t("По предметам")), list);
}

/* ---------- Пропуски ---------- */

// Свой счётчик у каждого студента, в облаке Telegram: переживает смену
// телефона, и никто, кроме самого человека, его не видит. Вне Telegram —
// в памяти браузера. Отмечать можно любую пару — лекции тоже.
const ABS_KEY = "absences";
let absences = { on: false, marks: {}, limits: {} };
let absLoaded = false;
// Строки с раскрытыми датами — чтобы после отметки список не схлопывался.
const openRows = new Set();

function cloudGet(key) {
  return new Promise((resolve) => {
    const cloud = tg?.CloudStorage;
    if (cloud?.getItem) {
      try {
        cloud.getItem(key, (error, value) => resolve(error ? null : value || null));
        return;
      } catch {
        // Старый клиент — падаем на память браузера.
      }
    }
    try {
      resolve(localStorage.getItem(`schedule.${key}`));
    } catch {
      resolve(null);
    }
  });
}

function cloudSet(key, value) {
  try {
    localStorage.setItem(`schedule.${key}`, value);
  } catch {
    // Приватный режим — останется только облако.
  }
  try {
    tg?.CloudStorage?.setItem?.(key, value, () => {});
  } catch {
    // Облака нет — хватит и памяти браузера.
  }
}

async function loadAbsences() {
  if (absLoaded) return absences;
  const raw = await cloudGet(ABS_KEY);
  try {
    const parsed = JSON.parse(raw || "null");
    if (parsed && typeof parsed === "object") {
      absences = { on: Boolean(parsed.on), marks: parsed.marks || {}, limits: parsed.limits || {} };
    }
  } catch {
    // Испорченная запись — начинаем с чистого листа.
  }
  absLoaded = true;
  return absences;
}

function saveAbsences() {
  // Облако Telegram держит до 4 КБ на ключ — хранить даты коротко:
  // «0928-3» — 28 сентября, третья пара.
  cloudSet(ABS_KEY, JSON.stringify(absences));
}

const absMark = (date, slot) => `${isoDate(date).slice(5).replace("-", "")}-${slot}`;

// Отметка «пропустил» — на любой паре: лекции, семинары, практики. Раньше
// была только у семинаров и практик, но пропуск лекции тоже хочется учесть.

function isAbsTracked() {
  return true;
}

/** Пропущена ли пара этого предмета в этот день. */
function isMissed(subject, date, slot) {
  return (absences.marks[subject] || []).includes(absMark(date, slot));
}

function toggleMissed(subject, date, slot) {
  const mark = absMark(date, slot);
  const list = new Set(absences.marks[subject] || []);
  if (list.has(mark)) list.delete(mark);
  else list.add(mark);
  absences.marks[subject] = [...list];
  if (!absences.marks[subject].length) delete absences.marks[subject];
  saveAbsences();
}

/**
 * Кнопка «пропустил» под любой парой, которая уже началась. У будущих пар её
 * нет: пропуск отмечают после, а не заранее.
 */
function applyAbsenceButtons() {
  for (const card of els.lessons.querySelectorAll(".card")) card.querySelector(".abs-toggle")?.remove();
  if (!absences.on) return;
  const date = dateOfDay(selectedDay);
  const now = new Date();
  const today = isoDate(date) === isoDate(now);
  if (isoDate(date) > isoDate(now)) return;
  for (const card of els.lessons.querySelectorAll(".card")) {
    // Свои дела — не пары: у них нет предмета, пропуск к ним не относится.
    if (!card.dataset.subject || !isAbsTracked(card.dataset.type) || card.classList.contains("card--cancelled")) continue;
    if (today && card.dataset.start && minutes(card.dataset.start) > now.getHours() * 60 + now.getMinutes()) continue;
    const subject = card.dataset.subject;
    const slot = Number(card.dataset.slot);
    const missed = isMissed(subject, date, slot);
    const button = el("button", missed ? "abs-toggle abs-toggle--on" : "abs-toggle", missed ? t("пропуск ✕") : t("пропустил?"));
    button.type = "button";
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      toggleMissed(subject, date, slot);
      const now = isMissed(subject, date, slot);
      haptic(now ? "warning" : "light");
      // На месте, а не перерисовкой: так цвет перетекает, а кнопка
      // коротко пружинит под пальцем.
      button.classList.toggle("abs-toggle--on", now);
      button.textContent = now ? t("пропуск ✕") : t("пропустил?");
      button.animate(
        [{ transform: "scale(0.9)" }, { transform: "scale(1.06)", offset: 0.6 }, { transform: "scale(1)" }],
        { duration: 320, easing: "cubic-bezier(0.3, 1.5, 0.5, 1)" }
      );
    });
    (card.querySelector(".card-body") || card).append(button);
  }
}

/**
 * Все семинары предмета до конца семестра: прошедшие — чтобы отметить
 * пропуск задним числом, будущие — чтобы спланировать его заранее.
 */
function semesterSeminars(subject) {
  const group = activeGroup();
  const weeks = data.weeks || [];
  const out = [];
  if (!group || !weeks.length) return out;
  const now = new Date();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const bells = new Map(data.bells.map((b) => [b.n, b]));
  const cursor = new Date(`${weeks[0].from}T00:00:00`);
  const lastDay = weeks.at(-1).to;
  for (; isoDate(cursor) <= lastDay; cursor.setDate(cursor.getDate() + 1)) {
    const weekday = cursor.getDay();
    if (weekday === 0) continue;
    const parity = parityOfDate(cursor);
    const slots = [
      ...new Set(
        data.lessons
          .filter(
            (l) =>
              l.group === group.id &&
              l.subject === subject &&
              isAbsTracked(l.type) &&
              l.day === weekday &&
              onDate(l, parity, isoDate(cursor)) &&
              matchesPrefs(l)
          )
          .map((l) => l.slot)
      ),
    ].sort((a, b) => a - b);
    for (const slot of slots) {
      // Сегодняшний, который ещё не начался, — уже будущий.
      const start = bells.get(slot)?.start;
      const upcoming =
        isoDate(cursor) > isoDate(now) ||
        (isoDate(cursor) === isoDate(now) && start && minutes(start) > nowMinutes);
      out.push({ date: new Date(cursor), slot, upcoming: Boolean(upcoming) });
    }
  }
  return out;
}

/** Семинары предмета за семестр: сколько всего и сколько уже прошло. */
function seminarCount(subject) {
  const group = activeGroup();
  const weeks = data.weeks || [];
  if (!group || !weeks.length) return { total: 0, past: 0 };
  const todayIso = isoDate(new Date());
  let total = 0;
  let past = 0;
  const cursor = new Date(`${weeks[0].from}T00:00:00`);
  const last = weeks.at(-1).to;
  for (; isoDate(cursor) <= last; cursor.setDate(cursor.getDate() + 1)) {
    const weekday = cursor.getDay();
    if (weekday === 0) continue;
    const parity = parityOfDate(cursor);
    const slots = new Set(
      data.lessons
        .filter(
          (l) =>
            l.group === group.id &&
            l.subject === subject &&
            isAbsTracked(l.type) &&
            l.day === weekday &&
            onDate(l, parity, isoDate(cursor)) &&
            matchesPrefs(l)
        )
        .map((l) => l.slot)
    );
    total += slots.size;
    if (isoDate(cursor) <= todayIso) past += slots.size;
  }
  return { total, past };
}

/** Предметы, по которым считаем: семинары и практики своей группы. */
function absenceSubjects() {
  const group = activeGroup();
  if (!group || group.teacher) return [];
  const set = new Set(
    data.lessons
      .filter((l) => l.group === group.id && isAbsTracked(l.type) && matchesPrefs(l) && !MILITARY.test(l.subject))
      .map((l) => l.subject)
  );
  return [...set].sort((a, b) => tr(a).localeCompare(tr(b), "ru"));
}

async function openAbsences() {
  if (!els.absSheet) return;
  await loadAbsences();
  renderAbsences();
  els.absSheet.classList.remove("sheet-backdrop--out");
  els.absSheet.hidden = false;
  haptic("light");
}

/** Закрываем с анимацией: окно уезжает вниз, затемнение тает. */
function closeAbsences() {
  const sheet = els.absSheet;
  if (!sheet || sheet.hidden || sheet.classList.contains("sheet-backdrop--out")) return;
  haptic("light");
  sheet.classList.add("sheet-backdrop--out");
  setTimeout(() => {
    sheet.hidden = true;
    sheet.classList.remove("sheet-backdrop--out");
  }, 260);
  applyAbsenceButtons();
}

/** Состояние предмета: сколько пропущено, сколько можно, какого цвета строка. */
/** Отметка «0928-3» — уже прошедший семинар или ещё впереди. */
function markIsAhead(mark) {
  const today = isoDate(new Date()).slice(5).replace("-", "");
  return mark.slice(0, 4) > today;
}

function absState(subject) {
  const { total, past } = seminarCount(subject);
  const marks = absences.marks[subject] || [];
  const planned = marks.filter(markIsAhead).length;
  const missed = marks.length - planned;
  const limit = absences.limits[subject];
  const left = limit == null ? null : limit - missed - planned;
  const state = left == null ? "none" : left <= 0 ? (left < 0 ? "over" : "stop") : left === 1 ? "warn" : "ok";
  const plan = planned ? ` · ${t("в планах {n}", { n: planned })}` : "";
  const status =
    (left == null
      ? t("пропущено {n} · прошло {past} из {total}", { n: missed, past, total })
      : left < 0
        ? t("перебор на {n} — пора остановиться", { n: -left })
        : left === 0
          ? t("хватит — лимит исчерпан")
          : t("можно ещё {n} · прошло {past} из {total}", { n: left, past, total })) + plan;
  return { total, missed, planned, limit, state, status };
}

/** Число меняется с толчком — видно, что отметка засчиталась. */
function bump(node, text) {
  if (!node || node.textContent === text) return;
  node.textContent = text;
  node.animate(
    [
      { transform: "scale(0.7)", opacity: 0.4 },
      { transform: "scale(1.18)", opacity: 1, offset: 0.55 },
      { transform: "scale(1)" },
    ],
    { duration: 420, easing: "cubic-bezier(0.3, 1.5, 0.5, 1)" }
  );
}

/**
 * Обновить строку предмета на месте. Раньше экран пересобирался целиком,
 * и цвет не мог плавно смениться — элемент каждый раз рождался заново.
 */
function refreshAbsRow(row) {
  const subject = row.dataset.subject;
  const info = absState(subject);
  for (const name of ["none", "ok", "warn", "stop", "over"]) {
    row.classList.toggle(`abs-row--${name}`, info.state === name);
  }
  bump(row.querySelector(".abs-count"), String(info.missed + info.planned));
  const status = row.querySelector(".abs-status");
  if (status.textContent !== info.status) {
    status.textContent = info.status;
    status.animate([{ opacity: 0, transform: "translateY(3px)" }, { opacity: 1, transform: "none" }], {
      duration: 260,
      easing: "ease-out",
    });
  }
  bump(row.querySelector(".abs-limit-value"), info.limit == null ? "—" : String(info.limit));
  for (const chip of row.querySelectorAll(".abs-date")) {
    const date = new Date(chip.dataset.date);
    chip.classList.toggle("abs-date--on", isMissed(subject, date, Number(chip.dataset.slot)));
  }
}

function buildAbsRow(subject, index) {
  const row = el("div", "abs-row");
  row.dataset.subject = subject;
  row.style.setProperty("--i", index);

  const head = el("div", "abs-head");
  head.append(el("div", "abs-name", withFlag(tr(subject))), el("div", "abs-count", "0"));
  row.append(head, el("div", "abs-status"));

  // Лимит — степпером: − число +. Пусто — лимит не задан.
  const controls = el("div", "abs-limit");
  const minus = el("button", "abs-step", "−");
  const value = el("span", "abs-limit-value", "—");
  const plus = el("button", "abs-step", "+");
  minus.type = plus.type = "button";
  const change = (delta) => {
    const { total } = seminarCount(subject);
    const current = absences.limits[subject];
    let next = current == null ? (delta > 0 ? Math.max(1, Math.round(total / 4)) : null) : current + delta;
    if (next != null && next < 0) next = null;
    if (next == null) delete absences.limits[subject];
    else absences.limits[subject] = Math.min(next, Math.max(total, 1));
    saveAbsences();
    haptic("select");
    refreshAbsRow(row);
  };
  minus.addEventListener("click", () => change(-1));
  plus.addEventListener("click", () => change(1));
  controls.append(el("span", "abs-limit-label", t("лимит")), minus, value, plus);
  row.append(controls);

  // Отметить задним числом: расписание показывает только эту и следующую
  // неделю, и пропуск позапрошлой иначе было бы негде поставить. Даты
  // раскрываются плавно — высота растёт, а не прыгает.
  const held = semesterSeminars(subject);
  if (held.length) {
    const toggle = el("button", "abs-dates-toggle", t("все даты"));
    toggle.type = "button";
    controls.append(toggle);

    const fold = el("div", "abs-fold");
    const dates = el("div", "abs-dates");
    const several = new Set(held.map((p) => isoDate(p.date))).size < held.length;
    for (const { date, slot, upcoming } of held) {
      const label = several ? `${SHORT_DATE.format(date)} · ${slot}` : SHORT_DATE.format(date);
      const chip = el("button", upcoming ? "abs-date abs-date--ahead" : "abs-date", label);
      chip.type = "button";
      chip.dataset.date = date.toISOString();
      chip.dataset.slot = slot;
      chip.addEventListener("click", () => {
        toggleMissed(subject, date, slot);
        haptic(isMissed(subject, date, slot) ? "warning" : "light");
        refreshAbsRow(row);
        applyAbsenceButtons();
      });
      dates.append(chip);
    }
    fold.append(dates);
    row.append(fold);

    const open = openRows.has(subject);
    row.classList.toggle("abs-row--open", open);
    toggle.textContent = open ? t("скрыть даты") : t("все даты");
    toggle.addEventListener("click", () => {
      const now = !row.classList.contains("abs-row--open");
      if (now) openRows.add(subject);
      else openRows.delete(subject);
      row.classList.toggle("abs-row--open", now);
      toggle.textContent = now ? t("скрыть даты") : t("все даты");
      haptic("select");
    });
  }

  refreshAbsRow(row);
  // Первый показ — без толчков цифр: они для изменений, а не для появления.
  for (const running of row.querySelectorAll(".abs-count, .abs-limit-value, .abs-status")) {
    for (const animation of running.getAnimations()) animation.cancel();
  }
  return row;
}

/** Пропуски — личное: об этом напоминаем прямо в окне, коротко. */
function privacyNote() {
  const note = el("div", "abs-private");
  note.append(
    el("span", "abs-private-icon", "🔒"),
    el(
      "div",
      "abs-private-text",
      t("Это видите только вы. Пропуски хранятся в вашем Telegram и никому не передаются — ни старосте, ни преподавателю, ни боту.")
    )
  );
  return note;
}

function renderAbsences() {
  const body = els.absBody;
  const group = activeGroup();
  if (group?.teacher) {
    els.absNote.textContent = "";
    body.replaceChildren(el("p", "hint", t("Счётчик пропусков — для студентов.")));
    return;
  }

  if (!absences.on) {
    els.absNote.textContent = t("Личный счётчик пропусков");
    const intro = el("div", "abs-intro");
    intro.append(
      el("div", "abs-intro-title", t("Сколько ещё можно пропустить?")),
      el("p", null, t("Отмечайте пропущенные пары — приложение посчитает, сколько осталось до лимита, и подсветит, когда хватит.")),
      el("p", "abs-intro-hint", t("Под каждой прошедшей парой появится кнопка «пропустил?». Лимит для каждого предмета задаёте сами."))
    );
    const start = el("button", "primary abs-start", t("Начать считать"));
    start.type = "button";
    start.addEventListener("click", () => {
      absences.on = true;
      saveAbsences();
      haptic("success");
      renderAbsences();
      applyAbsenceButtons();
    });
    intro.append(start);
    body.replaceChildren(privacyNote(), intro);
    return;
  }

  els.absNote.textContent = t("Семинары и практики до конца семестра · будущие даты — план");
  const rows = absenceSubjects().map((subject, i) => buildAbsRow(subject, i));
  if (!rows.length) rows.push(el("p", "hint", t("У группы нет пар.")));

  const stop = el("button", "ghost abs-stop", t("Перестать считать"));
  stop.type = "button";
  stop.addEventListener("click", () => {
    haptic("medium");
    const ask = t("Выключить счётчик? Отметки сохранятся — их можно вернуть, включив снова.");
    const off = () => {
      absences.on = false;
      saveAbsences();
      haptic("warning");
      renderAbsences();
      applyAbsenceButtons();
    };
    if (tg?.showConfirm) tg.showConfirm(ask, (yes) => yes && off());
    else if (confirm(ask)) off();
  });

  body.replaceChildren(privacyNote(), ...rows, stop);
}

/* ---------- Отмена пар владельцем ---------- */

const CANCEL_URL = `${API_URL}/cancel`;

/** Отмены пары slot этого предмета — их и вернёт кнопка «Вернуть». */
function slotCancels(slot, subject) {
  return [...new Set(cancelsFor(slot, subject).map((c) => c.id).filter(Boolean))];
}

/**
 * Владелец отменяет и возвращает пары прямо здесь, без /cancel. У каждой
 * пары своя кнопка — и у склеенного блока, и у одинаковых карточек подряд.
 */
function addOwnerButtons(card) {
  const slots = cardSlots(card);
  const row = el("div", "card-actions owner-actions");
  for (const slot of slots) {
    const own = slotCancels(slot, card.dataset.subject);
    const label = slots.length > 1
      ? t(own.length ? "Вернуть {n} пару" : "Отменить {n} пару", { n: slot })
      : t(own.length ? "Вернуть пару" : "Отменить пару");
    const button = el("button", "hw-edit", label);
    button.type = "button";
    button.addEventListener("click", () => (own.length ? restoreLesson(own) : cancelLesson(card, [slot])));
    row.append(button);
  }
  (card.querySelector(".card-body") || card).append(row);
}

function askScope(group) {
  return new Promise((resolve) => {
    const text = t("Отменить эту пару?");
    if (tg?.showPopup) {
      try {
        tg.showPopup(
          {
            message: text,
            buttons: [
              { id: "group", type: "default", text: t("Только {g}", { g: group.title }) },
              { id: "course", type: "default", text: t("Весь курс") },
              { type: "cancel" },
            ],
          },
          (id) => resolve(id === "group" || id === "course" ? id : null)
        );
        return;
      } catch {
        // Старый Telegram без попапов — обычный вопрос ниже.
      }
    }
    resolve(confirm(text) ? "group" : null);
  });
}

async function sendCancel(body) {
  haptic("medium");
  try {
    const res = await fetch(CANCEL_URL, {
      method: "POST",
      body: JSON.stringify({ initData: tg?.initData || "", ...body }),
    });
    if (!res.ok) throw new Error();
  } catch {
    tg?.showAlert ? tg.showAlert(t("Не получилось, попробуйте ещё раз")) : alert(t("Не получилось, попробуйте ещё раз"));
    return;
  }
  // Перечитываем отмены — карточки зачеркнутся как у всех.
  const group = groupById(prefs.group);
  notices.group = null;
  await loadNotices(group);
}

/** Староста отменяет только у своей группы — спрашиваем просто «да или нет». */
function askConfirm(group) {
  const text = t("Отменить эту пару у группы {g}? Группа получит уведомление.", { g: group.title });
  return new Promise((resolve) => {
    if (tg?.showConfirm && tg.isVersionAtLeast?.("6.2")) {
      tg.showConfirm(text, (ok) => resolve(ok ? "group" : null));
      return;
    }
    resolve(confirm(text) ? "group" : null);
  });
}

async function cancelLesson(card, slots) {
  const group = groupById(prefs.group);
  const scope = notices.owner ? await askScope(group) : await askConfirm(group);
  if (!scope) return;
  await sendCancel({
    action: "cancel",
    scope,
    group: group.id,
    course: group.course,
    level: group.level,
    day: isoDate(dateOfDay(selectedDay)),
    slots,
    subject: card.dataset.subject,
  });
}

function restoreLesson(ids) {
  return sendCancel({ action: "restore", ids, group: groupById(prefs.group)?.id });
}

/* ---------- Комментарии ---------- */

const COMMENTS_URL = `${API_URL}/comments`;
const COMMENT_MAX = 300;

const commentKey = (day, subject) => `${day}|${subject}`;

/** Открыто ли окно снизу. Окон может не быть в закэшированном index.html. */
function sheetOpen() {
  return Boolean(document.querySelector(".sheet-backdrop:not([hidden])"));
}

/** Счётчики недели приходят целиком — заменяем её дни, остальные не трогаем. */
function mergeCommentCounts({ from, to }, list) {
  for (const key of [...notices.comments.keys()]) {
    const day = key.slice(0, 10);
    if (day >= from && day <= to) notices.comments.delete(key);
  }
  for (const item of list || []) notices.comments.set(commentKey(item.day, item.subject), item.count);
}

let commenting = null;

async function commentsRequest(action, payload) {
  const res = await fetch(`${COMMENTS_URL}/${action}`, {
    method: "POST",
    body: JSON.stringify({ initData: tg?.initData || "", ...payload }),
  });
  const body = await res.json().catch(() => ({}));
  // Состояние бана приходит и с успешным ответом, и с отказом.
  if ("banned" in body) applyCommentBan(body.banned);
  if (!res.ok || !body.ok) throw new Error(body.error || String(res.status));
  return body.comments || [];
}

/**
 * Забаненный читает, но не пишет: прячем поле ввода и говорим до какого
 * числа. Плашки может не быть в закэшированном index.html — тогда просто
 * прячем поле.
 */
function applyCommentBan(ban) {
  const compose = els.cmSheet?.querySelector(".cm-compose");
  const note = document.getElementById("cm-banned");
  const blocked = Boolean(ban);
  if (compose) compose.hidden = blocked;
  els.cmSend.hidden = blocked;
  if (!note) return;
  note.hidden = !blocked;
  if (!blocked) return;
  const until = ban.until
    ? t("Вы не можете оставлять комментарии до {date}.", {
        date: new Intl.DateTimeFormat(LOCALE, { day: "numeric", month: "long" }).format(new Date(ban.until)),
      })
    : t("Вам запрещено оставлять комментарии.");
  note.textContent = ban.reason ? `${until} ${t("Причина: {reason}", { reason: ban.reason })}` : until;
}

const COMMENT_ERRORS = {
  "user limit": "На сегодня хватит: не больше 10 комментариев в день.",
  "group limit": "Группа сегодня уже написала 300 комментариев. Продолжим завтра.",
  "too long": "Слишком длинно: до 300 знаков.",
  unauthorized: "Комментарии работают только в Telegram.",
};

function commentError(error) {
  // Про бан уже сказала плашка вместо поля ввода.
  if (error.message === "banned") return;
  els.cmError.textContent = t(COMMENT_ERRORS[error.message] || "Не получилось. Попробуйте ещё раз.");
  els.cmError.hidden = false;
}

function openComments(card) {
  commenting = {
    group: notices.group,
    subject: card.dataset.subject,
    day: isoDate(dateOfDay(selectedDay)),
  };
  const label = FULL_DATE.format(dateOfDay(selectedDay));
  els.cmTitle.textContent = tr(commenting.subject);
  els.cmDate.textContent = label[0].toUpperCase() + label.slice(1);
  els.cmList.replaceChildren(el("p", "hint", t("Загружаю…")));
  els.cmText.value = "";
  els.cmError.hidden = true;
  // Поле ввода — до ответа бота; бан, если есть, спрячет его.
  applyCommentBan(null);
  updateCommentCounter();
  els.cmSheet.hidden = false;
  loadComments();
}

function closeComments() {
  els.cmSheet.hidden = true;
  commenting = null;
}

async function loadComments() {
  if (!commenting) return;
  const current = commenting;
  els.cmRefresh.disabled = true;
  try {
    const list = await commentsRequest("list", current);
    if (commenting === current) renderComments(list);
  } catch (error) {
    if (commenting === current) {
      els.cmList.replaceChildren();
      commentError(error);
    }
  } finally {
    els.cmRefresh.disabled = false;
  }
}

const COMMENT_TIME = new Intl.DateTimeFormat(LOCALE, {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});

function renderComments(list) {
  // Счётчик под парой — по фактическому списку, без лишнего запроса.
  notices.comments.set(commentKey(commenting.day, commenting.subject), list.length);
  applyHomework();

  if (!list.length) {
    els.cmList.replaceChildren(el("p", "hint", t("Пока никто не писал. Напишите первым.")));
    return;
  }
  els.cmList.replaceChildren(
    ...list.map((comment) => {
      const item = el("div", comment.mine ? "cm-item cm-item--mine" : "cm-item");
      const head = el("div", "cm-head");
      head.append(
        el("span", "cm-name", comment.name),
        el("span", "cm-time", COMMENT_TIME.format(new Date(comment.created)))
      );
      if (comment.canDelete) head.append(commentAction(t("Удалить"), "delete", comment.id));
      if (!comment.mine) head.append(commentAction(t("Пожаловаться"), "report", comment.id));
      item.append(head, el("div", "cm-text", comment.text));
      return item;
    })
  );
  els.cmList.scrollTop = els.cmList.scrollHeight;
}

function commentAction(label, action, id) {
  const button = el("button", `cm-action cm-action--${action}`, label);
  button.type = "button";
  button.addEventListener("click", async () => {
    if (action === "delete" && !confirm(t("Удалить комментарий?"))) return;
    if (action === "report" && !confirm(t("Пожаловаться на комментарий? После трёх жалоб он скроется."))) return;
    button.disabled = true;
    els.cmError.hidden = true;
    const current = commenting;
    try {
      const list = await commentsRequest(action, { id });
      if (commenting === current) renderComments(list);
      if (action === "report") {
        els.cmError.textContent = t("Жалоба отправлена.");
        els.cmError.hidden = false;
      }
    } catch (error) {
      button.disabled = false;
      commentError(error);
    }
  });
  return button;
}

async function sendComment() {
  const text = els.cmText.value.trim();
  if (!commenting || !text) return;
  const current = commenting;
  els.cmSend.disabled = true;
  els.cmError.hidden = true;
  try {
    const list = await commentsRequest("add", { ...current, text });
    if (commenting !== current) return;
    els.cmText.value = "";
    updateCommentCounter();
    renderComments(list);
  } catch (error) {
    haptic("error");
    commentError(error);
  } finally {
    els.cmSend.disabled = false;
  }
}

function updateCommentCounter() {
  const left = COMMENT_MAX - els.cmText.value.length;
  els.cmCounter.textContent = String(left);
  els.cmCounter.classList.toggle("cm-counter--low", left < 30);
}

let editing = null;

function openHomework(card) {
  const subgroups = cardSubgroups(card);
  editing = { subject: card.dataset.subject, day: isoDate(dateOfDay(selectedDay)) };

  const label = FULL_DATE.format(dateOfDay(selectedDay));
  els.hwTitle.textContent = tr(editing.subject);
  els.hwDate.textContent = label[0].toUpperCase() + label.slice(1);

  // Подгруппу спрашиваем, только когда в карточке их несколько.
  els.hwSubgroupRow.hidden = subgroups.length < 2;
  els.hwSubgroup.replaceChildren(
    new Option(t("вся группа"), "0"),
    ...subgroups.map((n) => new Option(t("гр. {n}", { n }), String(n)))
  );
  els.hwSubgroup.value = "0";
  fillHomeworkText();

  els.hwError.hidden = true;
  els.hwSheet.hidden = false;
  els.hwText.focus();
}

function fillHomeworkText() {
  const subgroup = Number(els.hwSubgroup.value) || 0;
  const existing = notices.homework.find(
    (h) => h.day === editing.day && h.subject === editing.subject && (h.subgroup || 0) === subgroup
  );
  els.hwText.value = existing?.text || "";
  els.hwDelete.hidden = !existing;
}

function closeHomework() {
  els.hwSheet.hidden = true;
  editing = null;
}

/** Пустой текст удаляет задание — так же ведёт себя и кнопка «Удалить». */
async function submitHomework(text) {
  if (!editing) return;
  els.hwSave.disabled = els.hwDelete.disabled = true;
  els.hwError.hidden = true;
  try {
    const res = await fetch(HOMEWORK_URL, {
      method: "POST",
      body: JSON.stringify({
        initData: tg?.initData || "",
        group: notices.group,
        subject: editing.subject,
        subgroup: Number(els.hwSubgroup.value) || 0,
        day: editing.day,
        text,
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.ok) throw new Error(body.error || res.status);
    // Бот возвращает только сохранённый день — заменяем его, остальное не трогаем.
    notices.homework = notices.homework
      .filter((h) => h.day !== body.day)
      .concat(body.homework || []);
    haptic("success");
    closeHomework();
    applyHomework();
  } catch {
    els.hwError.textContent = t("Не удалось сохранить. Попробуйте ещё раз.");
    els.hwError.hidden = false;
  } finally {
    els.hwSave.disabled = els.hwDelete.disabled = false;
  }
}

const DAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"].map((day) => t(day));

// Основной язык: английский либо русский для иностранцев. Одновременно их
// не бывает, поэтому в опросе это один вопрос. Название зависит от курса.
const MAIN_LANGS = [
  "Английский язык",
  "Профессиональный английский язык",
  "Русский язык как иностранный",
  "Профессиональный русский язык",
];
// Второй и третий языки подписаны порядковым номером. Это разные предметы:
// третий берут вдобавок ко второму, а не вместо него.
const LANG2 = /^2-ой\s/;
const LANG3 = /^3-ий\s/;

// Флаг у каждого языка — чтобы свой находился в списке и в расписании с
// одного взгляда. Суахили — язык Танзании, арабский — Саудовской Аравии.
const LANGUAGE_FLAGS = [
  [/английск/i, "🇬🇧"],
  [/арабск/i, "🇸🇦"],
  [/испанск/i, "🇪🇸"],
  [/итальянск/i, "🇮🇹"],
  [/китайск/i, "🇨🇳"],
  [/корейск/i, "🇰🇷"],
  [/немецк/i, "🇩🇪"],
  [/русск/i, "🇷🇺"],
  [/суахили/i, "🇹🇿"],
  [/турецк/i, "🇹🇷"],
  [/французск/i, "🇫🇷"],
  [/японск/i, "🇯🇵"],
];

/** «🇪🇸 2-ой Испанский язык» — флаг только у языков, название переводится. */
function withFlag(subject) {
  const label = tr(subject);
  if (!/язык/i.test(subject)) return label;
  const flag = LANGUAGE_FLAGS.find(([pattern]) => pattern.test(subject))?.[1];
  return flag ? `${flag} ${label}` : label;
}

// Военная кафедра — факультатив, на который ходят не все. «Военно-
// политическое измерение…» — обычная дисциплина по выбору, её не трогаем.
const MILITARY = /^Военная подготовка/;
// Русский для иностранных студентов, записанный отдельной парой в общем
// расписании группы (как у ВШССН). Остальным он не нужен — по умолчанию скрыт.
const RKI = /^Иностранный язык \(русский язык\)$/;
// Время под МФК в расписании группы. Факультеты подписывают его по-разному:
// «Межфакультетские учебные курсы МГУ», «МФК», «факульт.МФК»… У ФГП вместо
// него встают курсы, выбранные из кабинета, — там своя настройка.
const MFK_SLOT = /^межфакультетск|^мфк(?![а-яё])|факул[а-яё]*\.?\s*мфк/i;

function isMfkSlot(subject) {
  return tenantId() !== "msu-fgp" && MFK_SLOT.test(subject);
}

const FULL_DATE = new Intl.DateTimeFormat(LOCALE, {
  weekday: "long",
  day: "numeric",
  month: "long",
});
const MONTH_NAME = new Intl.DateTimeFormat(LOCALE, { month: "long" });
const FULL_DAY = new Intl.DateTimeFormat(LOCALE, { weekday: "long" });
const SHORT_DATE = new Intl.DateTimeFormat(LOCALE, {
  day: "numeric",
  month: "numeric",
});

const ELECTIVE = "по выбору";
const MFK = "Межфакультетские учебные курсы МГУ";

const ANY = "";

const els = {
  picker: document.getElementById("picker"),
  schedule: document.getElementById("schedule"),
  course: document.getElementById("course"),
  group: document.getElementById("group"),
  mainRow: document.getElementById("main-row"),
  main: document.getElementById("main"),
  mainGroupRow: document.getElementById("main-group-row"),
  mainGroup: document.getElementById("main-group"),
  lang2Row: document.getElementById("lang2-row"),
  lang2: document.getElementById("lang2"),
  lang2GroupRow: document.getElementById("lang2-group-row"),
  lang2Group: document.getElementById("lang2-group"),
  lang3Row: document.getElementById("lang3-row"),
  lang3: document.getElementById("lang3"),
  militaryRow: document.getElementById("military-row"),
  rkiRow: document.getElementById("rki-row"),
  mfkSlotRow: document.getElementById("mfkslot-row"),
  mfkSlot: document.getElementById("mfkslot"),
  rki: document.getElementById("rki"),
  military: document.getElementById("military"),
  electivesRow: document.getElementById("electives-row"),
  electives: document.getElementById("electives"),
  pairsRow: document.getElementById("pairs-row"),
  pairs: document.getElementById("pairs"),
  save: document.getElementById("save"),
  lang: document.getElementById("lang"),
  home: document.getElementById("home"),
  homeHint: document.getElementById("home-hint"),
  homeIos: document.getElementById("home-ios"),
  homeCopy: document.getElementById("home-copy"),
  change: document.getElementById("change"),
  close: document.getElementById("close"),
  currentGroup: document.getElementById("current-group"),
  dateLabel: document.getElementById("date-label"),
  weekLabel: document.getElementById("week-label"),
  days: document.getElementById("days"),
  notices: document.getElementById("notices"),
  next: document.getElementById("next"),
  lessons: document.getElementById("lessons"),
  find: document.getElementById("find"),
  search: document.getElementById("search"),
  searchClose: document.getElementById("search-close"),
  query: document.getElementById("query"),
  searchHint: document.getElementById("search-hint"),
  results: document.getElementById("results"),
  rooms: document.getElementById("rooms"),
  free: document.getElementById("free"),
  freeClose: document.getElementById("free-close"),
  freeDate: document.getElementById("free-date"),
  freeSlots: document.getElementById("free-slots"),
  freeHint: document.getElementById("free-hint"),
  freeList: document.getElementById("free-list"),
  error: document.getElementById("error"),
  hwSheet: document.getElementById("hw-sheet"),
  hwTitle: document.getElementById("hw-title"),
  hwDate: document.getElementById("hw-date"),
  hwSubgroupRow: document.getElementById("hw-subgroup-row"),
  hwSubgroup: document.getElementById("hw-subgroup"),
  hwText: document.getElementById("hw-text"),
  hwError: document.getElementById("hw-error"),
  hwSave: document.getElementById("hw-save"),
  hwDelete: document.getElementById("hw-delete"),
  hwCancel: document.getElementById("hw-cancel"),
  cmSheet: document.getElementById("cm-sheet"),
  cmTitle: document.getElementById("cm-title"),
  cmDate: document.getElementById("cm-date"),
  cmList: document.getElementById("cm-list"),
  cmText: document.getElementById("cm-text"),
  cmCounter: document.getElementById("cm-counter"),
  cmError: document.getElementById("cm-error"),
  cmSend: document.getElementById("cm-send"),
  cmRefresh: document.getElementById("cm-refresh"),
  cmClose: document.getElementById("cm-close"),
  // Может не быть в закэшированном index.html — тогда режима просто нет.
  role: document.getElementById("role"),
  freedom: document.getElementById("freedom"),
  remindAsk: document.getElementById("remind-ask"),
  remindRow: document.getElementById("remind-row"),
  remindMorning: document.getElementById("remind-morning"),
  remindChanges: document.getElementById("remind-changes"),
  remindBefore: document.getElementById("remind-before"),
  remindWake: document.getElementById("remind-wake"),
  remindWakeRow: document.getElementById("remind-wake-row"),
  remindWakeLead: document.getElementById("remind-wake-lead"),
  remindWakeHint: document.getElementById("remind-wake-hint"),
  mfkRow: document.getElementById("mfk-row"),
  mfkFind: document.getElementById("mfk-find"),
  mfkList: document.getElementById("mfk-list"),
  splash: document.getElementById("splash"),
  menu: document.getElementById("menu"),
  absSheet: document.getElementById("abs-sheet"),
  absBody: document.getElementById("abs-body"),
  absNote: document.getElementById("abs-note"),
  absClose: document.getElementById("abs-close"),
  menuPop: document.getElementById("menu-pop"),
  splashDay: document.getElementById("splash-day"),
  splashTrack: document.getElementById("splash-track"),
  splashFill: document.getElementById("splash-fill"),
  splashComet: document.getElementById("splash-comet"),
  splashTimes: document.getElementById("splash-times"),
  month: document.getElementById("month"),
  tabs: document.getElementById("tabs"),
  tabsDrop: document.getElementById("tabs-drop"),
  queues: document.getElementById("queues"),
  queuesBody: document.getElementById("queues-body"),
  queuesGroup: document.getElementById("queues-group"),
  queueAdd: document.getElementById("queue-add"),
  qSheet: document.getElementById("q-sheet"),
  qFind: document.getElementById("q-find"),
  qSubjects: document.getElementById("q-subjects"),
  qnSheet: document.getElementById("qn-sheet"),
  qnQueue: document.getElementById("qn-queue"),
  qnNumber: document.getElementById("qn-number"),
  qnNote: document.getElementById("qn-note"),
  qnError: document.getElementById("qn-error"),
  qnSave: document.getElementById("qn-save"),
  qnCancel: document.getElementById("qn-cancel"),
  qName: document.getElementById("q-name"),
  qDay: document.getElementById("q-day"),
  qError: document.getElementById("q-error"),
  qSave: document.getElementById("q-save"),
  qCancel: document.getElementById("q-cancel"),
  week: document.getElementById("week"),
  weekBody: document.getElementById("week-body"),
  weekSwitch: document.getElementById("week-switch"),
  weekGroup: document.getElementById("week-group"),
  weekParity: document.getElementById("week-parity"),
  weekRange: document.getElementById("week-range"),
  searchTabs: document.getElementById("search-tabs"),
  teacher: document.getElementById("teacher"),
  teacherRow: document.getElementById("teacher-row"),
  studentFields: document.getElementById("student-fields") || {},
};

let data = null;
let prefs = null;

// Воскресенье — в полосе дней тоже: пар нет, но свои дела бывают. В
// воскресенье открываемся на нём, а не на понедельнике следующей недели.
const baseDate = new Date();

const weekStart = mondayOf(baseDate);

// Показываем текущую неделю и следующую: расписание на послезавтра нужно
// чаще, чем на месяц вперёд, а листать две недели можно одной полосой.
const WEEKS = 2;

let selectedDay = ((baseDate.getDay() + 6) % 7) + 1;
let selectedWeek = 0;

// Дни двух недель как одна лента: по ней и листаем.
const DAY_COUNT = DAYS.length * WEEKS;

function dayIndex() {
  return selectedWeek * DAYS.length + selectedDay - 1;
}

function setDayIndex(index) {
  selectedWeek = Math.floor(index / DAYS.length);
  selectedDay = (index % DAYS.length) + 1;
}

/** Понедельник недели, в которую попадает дата. */
function mondayOf(date) {
  const monday = new Date(date);
  monday.setHours(0, 0, 0, 0);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  return monday;
}

/** Дата дня недели (1 = понедельник); week 0 — текущая, 1 — следующая. */
function dateOfDay(day, week = selectedWeek) {
  const date = new Date(weekStart);
  date.setDate(date.getDate() + week * 7 + day - 1);
  return date;
}

/** ISO-дата по местному времени: toISOString() сдвинул бы день по UTC. */
function isoDate(date) {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${String(date.getDate()).padStart(2, "0")}`;
}

/**
 * Чётность недели берём из календаря в примечании к расписанию, а не считаем
 * по формуле: первая неделя семестра укорочена, и любая арифметика соврёт.
 * Вне семестра чётности нет — показываем все пары.
 */
function weekParity(weeks, week = selectedWeek) {
  // Чётность — свойство недели, а не дня: считаем по пересечению с
  // Пн–Сб, иначе понедельник 31.08 выпал бы из семестра, начатого 02.09.
  const from = isoDate(dateOfDay(1, week));
  const to = isoDate(dateOfDay(6, week));
  const found = (weeks || []).find((w) => w.from <= to && from <= w.to);
  return found ? found.parity : null;
}

function fail(message) {
  // Ошибку не прячем за заставкой.
  dropSplash();
  els.error.textContent = message;
  els.error.hidden = false;
}

/** Значения из JSON вставляем только как текст — никакого innerHTML. */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/* ---------- Вузы и факультеты ---------- */

// Каждый факультет — отдельная папка с расписанием (data/<папка>/). ФГП
// МГУ, с которого всё началось, лежит прямо в data/ и остаётся выбором по
// умолчанию: у тех, кто уже пользуется, ничего не меняется.
//
// Номера групп в разных вузах совпадают («101» есть везде), а бот хранит
// отмены, домашку и очереди по номеру группы. Поэтому у всех, кроме ФГП,
// к номеру при загрузке приписывается факультет: «spbu-law/101». Так и
// приложение, и бот различают группы, не зная друг о друге ничего нового.
const DEFAULT_TENANT = "msu-fgp";
const TENANTS_KEY = "schedule.tenants";
let TENANTS = [{ id: DEFAULT_TENANT, university: "МГУ", faculty: "Факультет глобальных процессов", path: "", features: ["mfk", "emails"], short: "ФГП" }];

function tenantId() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}")?.tenant || DEFAULT_TENANT;
  } catch {
    return DEFAULT_TENANT;
  }
}

function tenant() {
  return TENANTS.find((item) => item.id === tenantId()) || TENANTS[0];
}

/** Есть ли у факультета возможность: МФК и «слово недели» — не у всех. */
function tenantHas(feature) {
  return (tenant().features || []).includes(feature);
}

/** Путь к файлу данных своего факультета. */
function dataFile(name) {
  const path = tenant().path || "";
  return `data/${path ? `${path}/` : ""}${name}`;
}

/**
 * Смена факультета — это перезапуск приложения с другим расписанием. Голая
 * перезагрузка выглядела как зависание: экран замирал, потом мигал. Теперь
 * поверх выезжает плашка «куда переключаемся», за ней подгружается новое
 * расписание, и только потом страница перезапускается — уже на заставку
 * того же цвета, без белой вспышки.
 */
async function switchTenant(next) {
  if (!next) return;
  // Сменили факультет руками — это уже не тот профиль, что был выбран:
  // отвязываемся, чтобы не переписать его чужим факультетом.
  const store = readProfiles();
  if (store.active) writeProfiles({ ...store, active: null });
  await restartWith(next.faculty, next.university, next, () => savePrefs({ tenant: next.id }));
}

async function restartWith(title, sub, next, apply) {
  haptic("select");
  const cover = el("div", "switch");
  const box = el("div", "switch-box");
  const ring = el("span", "switch-ring");
  box.append(
    ring,
    el("div", "switch-note", t("Переключаем расписание")),
    el("div", "switch-name", title),
    el("div", "switch-uni", sub)
  );
  cover.append(box);
  document.body.append(cover);
  requestAnimationFrame(() => cover.classList.add("switch--on"));

  apply();
  // Расписание нового факультета успеет лечь в кэш, пока видна плашка:
  // после перезапуска оно откроется сразу. Сеть молчит — не ждём дольше 3 с.
  //
  // Самое долгое при перезапуске — не расписание, а сама страница: пока она
  // и скрипт Telegram не придут из сети, экран пустой и чёрный. Поэтому всё
  // это забираем заранее, под плашкой, и переходим по тому же адресу, что
  // только что скачали: страница встаёт из кэша, а не из сети. Обычная
  // перезагрузка так не умеет — она перепроверяет каждый файл заново.
  const url = new URL(location.href);
  url.searchParams.set("s", Date.now().toString(36));
  // Код «поделились расписанием» уже сработал — второй раз не предлагаем.
  url.searchParams.delete("cfg");
  url.searchParams.delete("grp");
  const quiet = (request) => request.catch(() => null);
  const folder = `data/${next.path ? `${next.path}/` : ""}`;
  const warm = Promise.all([
    quiet(fetch(url.href)),
    quiet(fetch("https://telegram.org/js/telegram-web-app.js", { mode: "no-cors" })),
    quiet(fetch(`${folder}schedule.json`, { cache: "no-cache" })),
    quiet(fetch("data/tenants.json", { cache: "no-cache" })),
  ]);
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  await Promise.all([pause(900), Promise.race([warm, pause(6000)])]);
  haptic("success");
  cover.classList.add("switch--done");
  await pause(260);
  location.replace(url.href);
}

/**
 * Список вузов: сначала тот, что запомнили с прошлого раза, — чтобы не
 * ждать сеть перед расписанием; свежий подтягиваем следом.
 */
async function loadTenants() {
  const apply = (list) => {
    if (Array.isArray(list) && list.length && list.every((item) => item?.id)) TENANTS = list;
  };
  let cached = false;
  try {
    const saved = JSON.parse(localStorage.getItem(TENANTS_KEY) || "null");
    if (saved) {
      apply(saved);
      cached = true;
    }
  } catch {
    // Испорченная запись — возьмём из сети.
  }
  const fresh = fetch("data/tenants.json", { cache: "no-cache" })
    .then((res) => (res.ok ? res.json() : null))
    .then((list) => {
      if (!list) return;
      apply(list);
      try {
        localStorage.setItem(TENANTS_KEY, JSON.stringify(list));
      } catch {
        // Не запомнилось — в следующий раз спросим снова.
      }
    })
    .catch(() => {});
  // Ждём сеть, только если выбранного факультета в памяти нет.
  if (!cached || !TENANTS.some((item) => item.id === tenantId())) await fresh;
}

/** Приписывает факультет к номерам групп — всем, кроме ФГП. */
function scopeData(schedule) {
  const id = tenant().id;
  if (id === DEFAULT_TENANT) return schedule;
  const scoped = (group) => `${id}/${group}`;
  for (const group of schedule.groups || []) group.id = scoped(group.id);
  for (const lesson of schedule.lessons || []) lesson.group = scoped(lesson.group);
  return schedule;
}

/** Выбор вуза и факультета на экране настроек — когда их больше одного. */
function fillTenants() {
  let row = document.getElementById("tenant-row");
  if (!row) {
    row = el("label");
    row.id = "tenant-row";
    const select = el("select");
    select.id = "tenant";
    // Подсказка для тех, чьего факультета ещё нет: как его добавить.
    const hint = el("div", "tenant-hint");
    hint.id = "tenant-hint";
    hint.hidden = true;
    const send = el("a", "tenant-send", t("Прислать расписание боту"));
    send.href = "https://t.me/FGPshedulebot?start=faculty";
    send.addEventListener("click", (event) => {
      if (!tg?.openTelegramLink) return;
      event.preventDefault();
      tg.openTelegramLink(send.href);
    });
    hint.append(
      el("p", "", t("Расписания вашего факультета пока нет. Пришлите его боту — файлом или ссылкой, с названием вуза и факультета. Добавим и сообщим.")),
      send
    );
    // Сначала вуз, потом факультет: одним списком на сотню строк свой
    // факультет приходилось выискивать пролистыванием.
    const uni = el("select");
    uni.id = "tenant-uni";
    uni.addEventListener("change", () => {
      haptic("light");
      hint.hidden = uni.value !== "";
      // Сам вуз ничего не переключает: расписание грузится, только когда
      // человек нажал на факультет — даже если он в вузе один.
      fillFaculties(uni.value);
    });
    select.addEventListener("change", () => {
      if (select.value === "") {
        hint.hidden = false;
        haptic("light");
        return;
      }
      hint.hidden = true;
      if (select.value === tenant().id) return;
      // Другой факультет — другое расписание целиком: проще начать с
      // чистого листа, чем менять данные под работающим приложением.
      switchTenant(TENANTS.find((item) => item.id === select.value));
    });
    const uniRow = el("label");
    uniRow.id = "tenant-uni-row";
    uniRow.append(el("span", "", t("Вуз")), uni);
    row.append(el("span", "", t("Факультет")), select);
    const anchor = document.getElementById("student-fields") || els.course.closest("label");
    anchor.before(uniRow, row, hint);
  }
  const uni = document.getElementById("tenant-uni");
  const names = [...new Set(TENANTS.map((item) => item.university))];
  // Свой вуз — первым, остальные по алфавиту.
  const own = tenant().university;
  names.sort((x, y) => (y === own) - (x === own) || x.localeCompare(y, "ru"));
  uni.replaceChildren(
    ...names.map((name) => new Option(`${name} · ${TENANTS.filter((item) => item.university === name).length}`, name)),
    new Option(t("Моего вуза нет в списке…"), "")
  );
  uni.value = tenant().university;
  fillFaculties(tenant().university);
  document.getElementById("tenant-hint").hidden = true;
  renderConsent();
}

/** Факультеты выбранного вуза — во второй список. */
function fillFaculties(university) {
  const select = document.getElementById("tenant");
  const row = document.getElementById("tenant-row");
  if (!select || !row) return;
  const list = TENANTS.filter((item) => item.university === university);
  row.hidden = !list.length;
  const options = list
    .slice()
    .sort((x, y) => (x.short || x.faculty).localeCompare(y.short || y.faculty, "ru"))
    // Сначала сокращение — по нему факультет и ищут глазами: «МЭО», «ФГП».
    .map((item) => new Option(item.short ? `${item.short} — ${item.faculty}` : item.faculty, item.id));
  const current = list.some((item) => item.id === tenant().id);
  if (!current && list.length) {
    const ask = new Option(t("— выберите факультет —"), "?");
    ask.disabled = true;
    options.unshift(ask);
  }
  select.replaceChildren(...options, new Option(t("Моего факультета нет в списке…"), ""));
  select.value = current ? tenant().id : list.length ? "?" : "";
}

/** Согласие на обработку данных — под кнопкой «Сохранить», со ссылкой на политику. */
function renderConsent() {
  if (document.getElementById("consent") || !els.save) return;
  const note = el("p", "consent");
  note.id = "consent";
  const link = el("a", "", t("политикой обработки данных"));
  link.href = "privacy.html";
  link.target = "_blank";
  link.rel = "noopener";
  note.append(t("Нажимая «Сохранить», вы соглашаетесь с"), " ", link, ". ", t("Стереть свои данные можно командой /forget в боте."));
  els.save.after(note);
}

/**
 * Идёт ли пара в этот день. Обычная пара повторяется по неделям: каждую,
 * по чётным или по нечётным. Но во многих вузах расписание составлено по
 * датам — «28.09–19.10», «09.11, 23.11» — и каждую неделю пары разные.
 * У такой пары есть список дат (dates), и решает только он.
 */
function onDate(lesson, parity, iso) {
  if (lesson.dates) return lesson.dates.includes(iso);
  return lesson.week === "all" || parity === null || lesson.week === parity;
}

function readPrefs() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
  } catch {
    return {};
  }
}

function savePrefs(value) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Приватный режим — настройки просто не переживут перезапуск.
  }
  // Выбранный профиль живёт вместе с настройками: поменяли язык или
  // подгруппу — в профиле то же самое.
  const store = readProfiles();
  const current = store.list.find((profile) => profile.id === store.active);
  if (current) {
    current.prefs = value;
    writeProfiles(store);
  }
}

/* ---------- Профили расписания ---------- */

/**
 * Профиль — это настройки под своим именем: «Моя группа», «Группа друга»,
 * «Второй вуз». Переключение между ними — одно касание вместо того, чтобы
 * каждый раз заново выбирать вуз, курс, группу и языки.
 */
const PROFILES_KEY = "schedule.profiles";
const PROFILES_MAX = 8;

function readProfiles() {
  try {
    const store = JSON.parse(localStorage.getItem(PROFILES_KEY));
    if (store && Array.isArray(store.list)) return store;
  } catch {
    // Испорченная запись — начинаем с пустого списка.
  }
  return { list: [], active: null };
}

function writeProfiles(store) {
  try {
    localStorage.setItem(PROFILES_KEY, JSON.stringify(store));
  } catch {
    // Приватный режим — профили не сохранятся.
  }
}

function switchProfile(profile) {
  const next = TENANTS.find((item) => item.id === profile.prefs?.tenant) || TENANTS[0];
  restartWith(profile.name, [next.university, next.faculty].filter(Boolean).join(" · "), next, () => {
    writeProfiles({ ...readProfiles(), active: profile.id });
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(profile.prefs || {}));
    } catch {
      // Не записалось — после перезапуска останется прежнее расписание.
    }
  });
}

const SHARE_URL = `${API_URL}/share`;
const BOT_LINK = "https://t.me/FGPshedulebot";

/** Настройки без личного: напоминания у каждого свои. */
function shareablePrefs(value) {
  const { remindMorning, remindBefore, remindAsked, remindWake, remindWakeLead, ...rest } = value || {};
  return rest;
}

/**
 * Поделиться расписанием: настройки уходят боту, тот даёт короткий код, и в
 * Telegram открывается обычное «переслать» со ссылкой. Друг нажимает — и
 * получает это расписание отдельным профилем.
 */
async function shareSchedule(button) {
  if (button.disabled) return;
  button.disabled = true;
  haptic("light");
  const store = readProfiles();
  const current = store.list.find((profile) => profile.id === store.active);
  const name = current?.name || activeGroup()?.title || "";
  try {
    const res = await fetch(SHARE_URL, {
      method: "POST",
      body: JSON.stringify({ initData: tg.initData, name, prefs: shareablePrefs(readPrefs()) }),
    });
    const body = await res.json();
    if (!body.ok) throw new Error(body.error);
    const link = `${BOT_LINK}?start=p_${body.code}`;
    const text = t("Моё расписание — открой, и оно добавится к твоему");
    const share = `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(text)}`;
    if (tg?.openTelegramLink) tg.openTelegramLink(share);
    else window.open(share, "_blank", "noopener");
    haptic("success");
  } catch {
    haptic("error");
    tg?.showAlert?.(t("Не получилось создать ссылку. Попробуйте ещё раз."));
  }
  button.disabled = false;
}

const INVITE_URL = `${API_URL}/invite`;

/**
 * Позвать группу: ссылка на расписание этой группы. Кто откроет — сразу
 * получит её расписание, ничего не выбирая. Ссылка у всей группы одна.
 */
async function inviteGroup(button) {
  if (button.disabled) return;
  const group = activeGroup();
  if (!group || prefs.teacher) return;
  button.disabled = true;
  haptic("light");
  try {
    const res = await fetch(INVITE_URL, {
      method: "POST",
      body: JSON.stringify({ tenant: tenantId(), group: group.id, name: group.title }),
    });
    const body = await res.json();
    if (!body.ok) throw new Error(body.error);
    const link = `${BOT_LINK}?start=g_${body.code}`;
    const text = t("Расписание группы {name} — открой, и оно сразу настроится 📅", { name: group.title });
    const share = `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(text)}`;
    if (tg?.openTelegramLink) tg.openTelegramLink(share);
    else window.open(share, "_blank", "noopener");
    haptic("success");
  } catch {
    haptic("error");
    tg?.showAlert?.(t("Не получилось создать ссылку. Попробуйте ещё раз."));
  }
  button.disabled = false;
}

/**
 * Открыли по ссылке-приглашению группы. Новичку сразу ставим эту группу;
 * у кого уже своя — предлагаем добавить её отдельным профилем.
 */
async function acceptInvite() {
  const code = new URLSearchParams(location.search).get("grp");
  if (!/^[a-z0-9]{8}$/.test(code || "")) return;
  let body = null;
  try {
    body = await (await fetch(`${SHARE_URL}?code=${code}`)).json();
  } catch {
    return;
  }
  const wanted = body?.ok && body.prefs;
  if (!wanted?.tenant || !wanted.group) return;
  const mine = readPrefs();
  if (mine.tenant === wanted.tenant && mine.group === wanted.group) return;
  const next = TENANTS.find((item) => item.id === wanted.tenant);
  if (!next) return;
  const name = String(body.name || "").slice(0, 40);
  if (!activeGroup()) {
    await restartWith(name || next.faculty, `${next.university} · ${next.short || next.faculty}`, next, () =>
      savePrefs({ ...mine, tenant: wanted.tenant, group: wanted.group, teacher: undefined })
    );
    return;
  }
  const store = readProfiles();
  if (store.list.length >= PROFILES_MAX) return;
  const add = () => {
    const fresh = readProfiles();
    if (!fresh.active && fresh.list.length < PROFILES_MAX - 1) {
      fresh.list.push({ id: `${Date.now().toString(36)}m`, name: t("Моё расписание"), prefs: readPrefs() });
    }
    const profile = { id: Date.now().toString(36), name: name || t("Группа"), prefs: { tenant: wanted.tenant, group: wanted.group } };
    fresh.list.push(profile);
    writeProfiles(fresh);
    switchProfile(profile);
  };
  const question = t("Добавить расписание группы «{name}» отдельным профилем?", { name: name || next.faculty });
  if (tg?.showConfirm) tg.showConfirm(question, (yes) => yes && add());
  else if (window.confirm(question)) add();
}

/** Открыли по ссылке друга: предлагаем добавить его расписание профилем. */
async function acceptShared() {
  const code = new URLSearchParams(location.search).get("cfg");
  if (!/^[a-z0-9]{8}$/.test(code || "")) return;
  let body = null;
  try {
    body = await (await fetch(`${SHARE_URL}?code=${code}`)).json();
  } catch {
    return;
  }
  if (!body?.ok || !body.prefs) return;
  const store = readProfiles();
  if (store.list.length >= PROFILES_MAX) {
    tg?.showAlert?.(t("Профилей уже максимум — удалите один в настройках и откройте ссылку снова."));
    return;
  }
  const name = String(body.name || "").slice(0, 24) || t("Расписание друга");
  const add = () => {
    const fresh = readProfiles();
    // Своё расписание не должно пропасть: если оно ещё не профиль — делаем.
    if (!fresh.active && activeGroup() && fresh.list.length < PROFILES_MAX - 1) {
      fresh.list.push({ id: `${Date.now().toString(36)}m`, name: t("Моё расписание"), prefs: readPrefs() });
    }
    const profile = { id: Date.now().toString(36), name, prefs: body.prefs };
    fresh.list.push(profile);
    writeProfiles(fresh);
    switchProfile(profile);
  };
  const question = t("Добавить расписание «{name}» отдельным профилем?", { name });
  if (tg?.showConfirm) tg.showConfirm(question, (yes) => yes && add());
  else if (window.confirm(question)) add();
}

/** Выбор шрифта цифр: три плитки с живым примером времени. */
function fillDigits() {
  if (!els.picker) return;
  let box = document.getElementById("digits");
  if (!box) {
    box = el("div", "profiles digits");
    box.id = "digits";
    (document.getElementById("profiles") || els.picker.querySelector(".bar")).after(box);
  }
  const nodes = [];
  for (const pick of FONT_PICKS) {
    const row = el("div", "profiles-row");
    for (const [id, title] of Object.entries(DIGITS)) {
      const chip = el("button", id === fontStyle(pick) ? "chip chip--on digits-chip" : "chip digits-chip");
      chip.type = "button";
      chip.dataset[pick.attr] = id;
      chip.append(el("span", "digits-sample", pick.sample()), el("span", "digits-title", t(title)));
      chip.addEventListener("click", () => {
        haptic("light");
        try {
          localStorage.setItem(pick.key, id);
        } catch {
          // Не сохранилось — выбор проживёт до закрытия.
        }
        document.body.dataset[pick.attr] = id;
        fillDigits();
        refitDate();
      });
      row.append(chip);
    }
    const title = el("div", "profiles-title", t(pick.title));
    if (nodes.length) title.classList.add("profiles-title--next");
    nodes.push(title, row);
  }
  // Тема: как в Telegram, светлая или тёмная.
  const themes = el("div", "profiles-row");
  for (const [id, name] of Object.entries(SCHEMES)) {
    const chip = el("button", id === scheme() ? "chip chip--on digits-chip scheme-chip" : "chip digits-chip scheme-chip");
    chip.type = "button";
    chip.dataset.scheme = id;
    chip.append(el("span", "scheme-dot"), el("span", "digits-title", t(name)));
    chip.addEventListener("click", () => {
      haptic("light");
      try {
        if (id === "auto") localStorage.removeItem(SCHEME_KEY);
        else localStorage.setItem(SCHEME_KEY, id);
      } catch {
        // Не сохранилось — выбор проживёт до закрытия.
      }
      applyScheme(id);
      rememberLook();
      fillDigits();
    });
    themes.append(chip);
  }
  const themeTitle = el("div", "profiles-title profiles-title--next", t("Светлая или тёмная"));
  nodes.push(themeTitle, themes);

  // Цветовые темы — плитками с образцом цвета.
  const colors = el("div", "look-themes");
  const current = colorTheme();
  for (const [id, name, [a, b]] of COLOR_THEMES) {
    if (id === "msu" && !inMsu()) continue;
    const chip = el("button", id === current ? "look-theme look-theme--on" : "look-theme");
    chip.type = "button";
    const swatch = el("span", "look-swatch");
    swatch.style.background = `linear-gradient(135deg, ${a} 0 50%, ${b} 50% 100%)`;
    chip.append(swatch, el("span", "look-name", t(name)));
    chip.addEventListener("click", () => {
      haptic(id ? "success" : "light");
      try {
        localStorage.setItem(COLOR_KEY, id);
        // Примерка темы владельцем (блок «Темы — видите только вы») сильнее
        // любого выбора, и плитки у него «не работали». Выбрал плитку — примерку
        // снимаем.
        localStorage.removeItem(OWNER_THEME_KEY);
      } catch {
        // Не сохранилось — выбор проживёт до закрытия.
      }
      applyTheme();
      fillDigits();
      fillOwnerThemes();
    });
    colors.append(chip);
  }
  nodes.push(el("div", "profiles-title profiles-title--next", t("Цвет акцента")), colors);
  if (grantedTheme && !(grantedTheme === "volunteer" && volunteerOff())) {
    nodes.push(el("p", "hint", t("Сейчас надета выданная тема — она сильнее. Выбранная включится, когда её снимут.")));
  }

  // Фон, вид карточек и галочки — из старого блока «Оформление», сюда же.
  const rest = document.getElementById("decor-row");
  if (rest) {
    const extra = el("div", "look-extra");
    for (const node of [...rest.children]) {
      if (node.tagName !== "LEGEND") extra.append(node);
    }
    rest.remove();
    box.dataset.extra = "1";
    box._extra = extra;
  }
  if (box._extra) nodes.push(box._extra);
  box.replaceChildren(el("div", "look-head", t("Оформление")), ...nodes);
}

/** Блок профилей вверху настроек. edit: { id } — открыто поле названия. */
function fillProfiles(edit = null) {
  if (!els.picker) return;
  let box = document.getElementById("profiles");
  if (!box) {
    box = el("div", "profiles");
    box.id = "profiles";
    els.picker.querySelector(".bar").after(box);
  }
  const store = readProfiles();
  const configured = Boolean(activeGroup());
  // Пока нечего ни сохранять, ни переключать — блок не нужен.
  box.hidden = !configured && !store.list.length;
  if (box.hidden) return;

  const nodes = [el("div", "profiles-title", t("Профили"))];
  const row = el("div", "profiles-row");
  for (const profile of store.list) {
    const on = profile.id === store.active;
    const chip = el("button", on ? "chip chip--on" : "chip", profile.name);
    chip.type = "button";
    chip.addEventListener("click", () => {
      haptic("light");
      // Свой профиль — правим название, чужой — переключаемся на него.
      if (on) fillProfiles(edit?.id === profile.id ? null : { id: profile.id });
      else switchProfile(profile);
    });
    row.append(chip);
  }
  if (configured && store.list.length < PROFILES_MAX) {
    const add = el("button", "chip chip--add", t(store.list.length ? "＋ Новый профиль" : "＋ Сохранить как профиль"));
    add.type = "button";
    add.addEventListener("click", () => {
      haptic("light");
      fillProfiles(edit && !edit.id ? null : { id: null });
    });
    row.append(add);
  }
  if (configured && tg?.initData) {
    const share = el("button", "chip chip--share", t("↗ Поделиться"));
    share.type = "button";
    share.addEventListener("click", () => shareSchedule(share));
    row.append(share);
    if (!prefs.teacher) {
      const invite = el("button", "chip chip--share", t("👥 Позвать группу"));
      invite.type = "button";
      invite.addEventListener("click", () => inviteGroup(invite));
      row.append(invite);
    }
  }
  nodes.push(row);

  if (edit) {
    const current = store.list.find((profile) => profile.id === edit.id);
    const form = el("div", "profiles-form");
    const input = el("input", "profiles-name");
    input.type = "text";
    input.maxLength = 24;
    input.placeholder = t("Название профиля");
    input.value = current ? current.name : store.list.length ? "" : activeGroup()?.title || "";
    const save = el("button", "profiles-save", t("Сохранить"));
    save.type = "button";
    const commit = () => {
      const name = input.value.trim().slice(0, 24);
      if (!name) return input.focus();
      const fresh = readProfiles();
      if (current) {
        const target = fresh.list.find((profile) => profile.id === current.id);
        if (target) target.name = name;
      } else {
        const id = Date.now().toString(36);
        fresh.list.push({ id, name, prefs: readPrefs() });
        fresh.active = id;
      }
      writeProfiles(fresh);
      haptic("success");
      fillProfiles();
    };
    save.addEventListener("click", commit);
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") commit();
    });
    form.append(input, save);
    if (current) {
      const remove = el("button", "profiles-remove", t("Удалить"));
      remove.type = "button";
      remove.addEventListener("click", () => {
        const fresh = readProfiles();
        // Удаляется только имя: само расписание остаётся на экране как было.
        writeProfiles({ list: fresh.list.filter((profile) => profile.id !== current.id), active: null });
        haptic("light");
        fillProfiles();
      });
      form.append(remove);
    }
    nodes.push(form);
    requestAnimationFrame(() => input.focus());
  } else if (!store.list.length) {
    nodes.push(el("p", "hint", t("Сохраните эти настройки под именем — и переключайтесь между своей группой, группой друга или другим вузом в одно касание.")));
  } else if (store.active) {
    nodes.push(el("p", "hint", t("Нажмите на выбранный профиль, чтобы переименовать или удалить. Новый профиль — копия текущих настроек: назовите его и смените вуз или группу ниже.")));
  }
  box.replaceChildren(...nodes);
}

function groupById(id) {
  return data.groups.find((g) => g.id === id) || null;
}

/**
 * Что показываем: группу студента или расписание преподавателя. У
 * преподавателя «группа» ненастоящая — ключ «Фамилия И.О.» из PDF.
 */
function activeGroup() {
  if (prefs.teacher) {
    return { id: `teacher:${prefs.teacher}`, title: prefs.teacherName || prefs.teacher, teacher: prefs.teacher };
  }
  return groupById(prefs.group);
}

/**
 * Как записать заход преподавателя. Раньше режим преподавателя вообще не
 * отмечался при открытии, и такого человека нельзя было найти в /who.
 */
function teacherVisit(key) {
  return { id: `преп:${key}`, course: null, level: "преподаватель" };
}

/** Все преподаватели из расписания: ключ «Фамилия И.О.», по алфавиту. */
function allTeachers() {
  const keys = new Set();
  for (const lesson of data.lessons) for (const person of teachersOf(lesson.teacher)) keys.add(person.key);
  return [...keys].sort((a, b) => a.localeCompare(b, "ru"));
}

/* ---------- Преподаватель на нескольких факультетах ----------
 * Многие ведут пары на двух-трёх факультетах вуза. Указатель
 * data/teacher-map.json (собирает tools/teacher_map.py) говорит, на каких
 * ещё факультетах встречается фамилия, — подгружаем только их расписания и
 * добавляем пары с подписью факультета. Звонки и чётность у факультетов
 * свои, поэтому у чужих пар сразу проставлены время и даты.
 */
let foreignFor = "";

async function loadForeignTeacher() {
  const key = prefs.teacher;
  if (!key || foreignFor === key || !data) return;
  foreignFor = key;
  data.lessons = data.lessons.filter((l) => !l.foreign);
  const here = tenant();
  let added = 0;
  try {
    const res = await fetch("data/teacher-map.json", { cache: "no-cache" });
    const map = res.ok ? await res.json() : {};
    const ids = (map[here.university]?.[key] || []).filter((id) => id !== here.id);
    for (const id of ids) {
      const other = TENANTS.find((item) => item.id === id);
      if (!other) continue;
      const got = await fetch(`data/${other.path ? `${other.path}/` : ""}schedule.json`, { cache: "no-cache" });
      if (!got.ok || foreignFor !== key) continue;
      const lessons = foreignLessons(await got.json(), other, key);
      data.lessons.push(...lessons);
      added += lessons.length;
    }
  } catch (error) {
    console.error(error);
  }
  if (added && prefs.teacher === key && !els.schedule.hidden) showSchedule();
}

function foreignLessons(schedule, other, key) {
  const bells = new Map((schedule.bells || []).map((b) => [b.n, b]));
  const titles = new Map((schedule.groups || []).map((g) => [g.id, g.title]));
  const short = other.short || other.faculty;
  const out = [];
  for (const lesson of schedule.lessons || []) {
    if (!teachersOf(lesson.teacher).some((p) => p.key === key)) continue;
    const bell = bells.get(lesson.slot);
    const start = lesson.start || bell?.start;
    const end = lesson.end || bell?.end;
    if (!start || !end) continue;
    out.push({
      ...lesson,
      group: `${other.id}/${lesson.group}`,
      groupLabel: `${short} · ${titles.get(lesson.group) || lesson.group}`,
      start,
      end,
      slot: nearestSlot(start, end),
      dates: lesson.dates || weekDates(schedule.weeks, lesson.day, lesson.week),
      foreign: other.id,
    });
  }
  return out;
}

/** Своя пара, с которой чужая совпадает по времени больше всего. */
function nearestSlot(start, end) {
  const from = minutes(start);
  const to = minutes(end);
  let best = data.bells[0];
  let score = -Infinity;
  for (const bell of data.bells) {
    const overlap = Math.min(to, minutes(bell.end)) - Math.max(from, minutes(bell.start));
    const value = overlap > 0 ? overlap : -Math.abs(minutes(bell.start) - from);
    if (value > score) [best, score] = [bell, value];
  }
  return best.n;
}

/** Даты дня недели в неделях нужной чётности по календарю чужого факультета. */
function weekDates(weeks, day, parity) {
  const out = [];
  for (const week of weeks || []) {
    if (parity && parity !== "all" && week.parity !== parity) continue;
    const date = mondayOf(new Date(`${week.from}T12:00:00`));
    date.setDate(date.getDate() + day - 1);
    const value = isoDate(date);
    if (value >= week.from && value <= week.to) out.push(value);
  }
  return out;
}

/* ---------- Сессия ----------
 * Экзамены, зачёты и консультации — те же занятия расписания, только с
 * датами и особым видом («экзамен», «семинар+зачет», «консультации перед
 * экзаменом»). Собираем ближайшие и показываем отдельным окном, а за две
 * недели до первого экзамена — плашкой над расписанием.
 */
const EXAM_KIND = /экзам|зач[её]т|консультац|аттестац|защит/i;
const EXAM_BANNER_DAYS = 14;
let examSheet = null;
let examBox = null;

function examKind(lesson) {
  const text = `${lesson.type || ""} ${lesson.subject}`.toLowerCase();
  if (/консультац/.test(text)) return t("Консультация");
  if (/защит/.test(text)) return t("Защита");
  if (/экзам/.test(text)) return t("Экзамен");
  if (/зач[её]т/.test(text)) return t("Зачёт");
  return t("Аттестация");
}

/** Ближайшие экзамены группы или преподавателя: по датам, от сегодня. */
function upcomingExams() {
  const group = activeGroup();
  if (!group || !data) return [];
  const today = isoDate(new Date());
  const bells = new Map(data.bells.map((b) => [b.n, b]));
  const own = group.teacher
    ? data.lessons.filter((l) => teachersOf(l.teacher).some((p) => p.key === group.teacher))
    : lessonsOf(group.id).filter((l) => matchesPrefs(l));
  const seen = new Set();
  const out = [];
  for (const lesson of own) {
    if (!lesson.dates || !EXAM_KIND.test(`${lesson.type || ""} ${lesson.subject}`)) continue;
    const time = timesOf(lesson, bells);
    for (const day of lesson.dates) {
      if (day < today) continue;
      const key = [day, time?.start, lesson.subject, examKind(lesson)].join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ day, start: time?.start || "", end: time?.end || "", subject: lesson.subject, kind: examKind(lesson), room: lesson.room || "", teacher: lesson.teacher || "", lesson });
    }
  }
  return out.sort((a, b) => (a.day + a.start).localeCompare(b.day + b.start));
}

function daysTill(day) {
  return daysUntil(day);
}

function tillLabel(n) {
  if (n === 0) return t("сегодня");
  if (n === 1) return t("завтра");
  if (LANG !== "ru") return t("через {n} дн.", { n });
  const tens = n % 100;
  const ones = n % 10;
  const word = tens >= 11 && tens <= 14 ? "дней" : ones === 1 ? "день" : ones >= 2 && ones <= 4 ? "дня" : "дней";
  return `через ${n} ${word}`;
}

/** Плашка над расписанием: ближайший экзамен в пределах двух недель. */
function renderExamBanner() {
  if (!examBox) {
    examBox = el("div", "exam-box");
    (document.getElementById("remind-ask") || els.days).before(examBox);
  }
  const next = upcomingExams().find((e) => e.kind !== t("Консультация"));
  const days = next ? daysTill(next.day) : null;
  if (!next || days > EXAM_BANNER_DAYS) {
    examBox.replaceChildren();
    return;
  }
  const card = el("button", `exam-banner${days <= 3 ? " exam-banner--soon" : ""}`);
  card.type = "button";
  card.append(
    el("span", "exam-icon", "🎓"),
    el("span", "exam-text", `${next.kind} · ${next.subject}`),
    el("span", "exam-till", tillLabel(days))
  );
  card.addEventListener("click", () => {
    haptic("light");
    openExams();
  });
  examBox.replaceChildren(card);
}

function openExams() {
  if (!data) return;
  if (!examSheet) {
    examSheet = el("div", "sheet-backdrop");
    examSheet.hidden = true;
    const sheet = el("div", "sheet sheet--abs sheet--exams");
    sheet.setAttribute("role", "dialog");
    sheet.setAttribute("aria-modal", "true");
    const top = el("div", "sheet-top");
    const close = el("button", "icon", "×");
    close.type = "button";
    close.setAttribute("aria-label", t("Закрыть"));
    close.addEventListener("click", closeExams);
    top.append(el("h2", "", t("Сессия")), close);
    sheet.append(top, el("div", "exam-body"));
    examSheet.append(sheet);
    examSheet.addEventListener("click", (event) => {
      if (event.target === examSheet) closeExams();
    });
    document.body.append(examSheet);
  }
  renderExams();
  examSheet.classList.remove("sheet-backdrop--out");
  examSheet.hidden = false;
}

function closeExams() {
  const sheet = examSheet;
  if (!sheet || sheet.hidden || sheet.classList.contains("sheet-backdrop--out")) return;
  haptic("light");
  sheet.classList.add("sheet-backdrop--out");
  setTimeout(() => {
    sheet.hidden = true;
    sheet.classList.remove("sheet-backdrop--out");
  }, 260);
}

function renderExams() {
  const body = examSheet.querySelector(".exam-body");
  const list = upcomingExams();
  if (!list.length) {
    body.replaceChildren(
      el("p", "empty", t("Экзаменов в расписании пока нет")),
      el("p", "hint", t("Когда вуз выложит расписание сессии, экзамены и зачёты появятся здесь сами. Если ваш факультет присылает сессию файлом — пришлите его боту."))
    );
    return;
  }
  const nodes = [];
  let lastDay = "";
  for (const exam of list) {
    if (exam.day !== lastDay) {
      lastDay = exam.day;
      const label = FULL_DATE.format(new Date(`${exam.day}T12:00:00`));
      const head = el("div", "exam-day");
      head.append(el("span", "", label[0].toUpperCase() + label.slice(1)), el("span", "exam-day-till", tillLabel(daysTill(exam.day))));
      nodes.push(head);
    }
    const row = el("div", `exam-row${exam.kind === t("Консультация") ? " exam-row--soft" : ""}`);
    const when = el("div", "exam-when", exam.start ? `${exam.start}${exam.end ? `–${exam.end}` : ""}` : "");
    const what = el("div", "exam-what");
    what.append(el("span", "exam-kind", exam.kind), el("b", "", tr(exam.subject)));
    const meta = [exam.room && t("ауд. {room}", { room: exam.room }), exam.teacher].filter(Boolean).join(" · ");
    if (meta) what.append(el("span", "exam-meta", meta));
    row.append(when, what);
    nodes.push(row);
  }
  body.replaceChildren(...nodes);
}

/* ---------- Где аудитория ----------
 * Нажатие на плашку аудитории — окно с корпусом и кнопкой «Открыть в
 * Яндекс Картах». Корпус угадываем по записи аудитории («ГЗ», «1 ГУМ»,
 * «химфак», «Шуваловский корп»), иначе ведём к зданию факультета: оно
 * у большинства и есть место занятий.
 */
const BUILDINGS = [
  [/шувалов|4\s*гум/i, "Шуваловский корпус МГУ"],
  [/1\s*гум/i, "Первый гуманитарный корпус МГУ"],
  [/2\s*гум/i, "Второй гуманитарный корпус МГУ"],
  [/3\s*гум/i, "Третий гуманитарный корпус МГУ"],
  [/(^|[^а-яё])гз([^а-яё]|$)|главн[а-яё]* здани/i, "Главное здание МГУ"],
  [/химфак|^бха$/i, "Химический факультет МГУ"],
  [/^бба$/i, "Биологический факультет МГУ"],
  [/почвовед/i, "Факультет почвоведения МГУ"],
  [/спортбаз|с\/база|спорткомплекс/i, "Спортивный комплекс МГУ"],
];

let mapSheet = null;

/** Корпус аудитории: по её записи, а нет — здание факультета. */
function buildingOf(room) {
  const text = String(room || "");
  const here = tenant();
  const msu = here.university === "МГУ";
  for (const [pattern, name] of BUILDINGS) {
    if (pattern.test(text) && (msu || !/МГУ/.test(name))) return { name, guessed: true };
  }
  // Мехмат и геофак занимают этажи Главного здания: «1624» — 16-й этаж ГЗ.
  if (["msu-mm", "msu-geo"].includes(here.id) && /^\d{4}$/.test(text.trim())) return { name: "Главное здание МГУ", guessed: true };
  // Корпус в скобках: «Е-250 (Шуваловский корп)», «599-Л (ф-т Почвоведения)».
  const inside = text.match(/\(([^)]*(корп|ф-т|факультет|здани)[^)]*)\)/i);
  if (inside) return { name: `${here.university} ${inside[1]}`, guessed: true };
  return { name: `${here.university} ${here.faculty}`, guessed: false };
}

function openRoomMap(room) {
  if (!room || REMOTE_ROOMS.includes(String(room).toLowerCase())) return;
  if (!mapSheet) {
    mapSheet = el("div", "sheet-backdrop");
    mapSheet.hidden = true;
    const sheet = el("div", "sheet sheet--abs sheet--map");
    sheet.setAttribute("role", "dialog");
    sheet.setAttribute("aria-modal", "true");
    const top = el("div", "sheet-top");
    const close = el("button", "icon", "×");
    close.type = "button";
    close.setAttribute("aria-label", t("Закрыть"));
    close.addEventListener("click", closeRoomMap);
    top.append(el("h2", "map-title"), close);
    sheet.append(top, el("div", "map-body"));
    mapSheet.append(sheet);
    mapSheet.addEventListener("click", (event) => {
      if (event.target === mapSheet) closeRoomMap();
    });
    document.body.append(mapSheet);
  }
  const place = buildingOf(room);
  mapSheet.querySelector(".map-title").textContent = roomLabel(room);
  const open = el("button", "cal-btn", t("Открыть в Яндекс Картах"));
  open.type = "button";
  open.addEventListener("click", () => {
    haptic("light");
    openOutside(`https://yandex.ru/maps/?text=${encodeURIComponent(place.name)}`);
  });
  mapSheet.querySelector(".map-body").replaceChildren(
    el("p", "map-where", place.name),
    open,
    el("p", "hint", place.guessed
      ? t("Корпус определён по записи аудитории в расписании. Внутри здания ищите по номеру.")
      : t("Показываем здание факультета. Если пара в другом корпусе, он обычно указан рядом с номером аудитории."))
  );
  mapSheet.classList.remove("sheet-backdrop--out");
  mapSheet.hidden = false;
}

function closeRoomMap() {
  const sheet = mapSheet;
  if (!sheet || sheet.hidden || sheet.classList.contains("sheet-backdrop--out")) return;
  haptic("light");
  sheet.classList.add("sheet-backdrop--out");
  setTimeout(() => {
    sheet.hidden = true;
    sheet.classList.remove("sheet-backdrop--out");
  }, 260);
}

/* ---------- Живое оформление ----------
 * Небо по времени суток за шапкой, сезонные детали на свободных днях и
 * гирлянда в декабре. Всё — лёгкие слои на CSS, без постоянных вычислений,
 * и выключается одной галочкой в настройках. При «уменьшить движение»
 * сезонные частицы не показываем вовсе.
 */
const DECOR_KEY = "schedule.decor";
let skyLayer = null;
let seasonLayer = null;
let garland = null;

function decorOn() {
  try {
    return localStorage.getItem(DECOR_KEY) !== "off";
  } catch {
    return true;
  }
}

function daypart(date = new Date()) {
  const h = date.getHours();
  if (h >= 5 && h < 11) return "morning";
  if (h >= 11 && h < 17) return "day";
  if (h >= 17 && h < 21) return "evening";
  return "night";
}

/* ---------- Небо по времени суток ----------
 * Настоящая сцена, а не пятно цвета: небо в несколько слоёв, солнце или
 * луна идут по дуге по часам, облака медленно плывут, ночью мерцают звёзды,
 * на закате у горизонта тёплое зарево.
 */
function buildSky(layer) {
  const stars = el("div", "sky-stars");
  // Звёзды — одни и те же у всех: сид от числа, а не случайно на каждый запуск.
  let seed = 7;
  const rnd = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  for (let i = 0; i < 46; i++) {
    const star = el("i");
    star.style.left = `${(rnd() * 100).toFixed(1)}%`;
    star.style.top = `${(rnd() * 70).toFixed(1)}%`;
    star.style.setProperty("--s", `${(1 + rnd() * 1.8).toFixed(1)}px`);
    star.style.setProperty("--d", `${(2 + rnd() * 4).toFixed(1)}s`);
    star.style.animationDelay = `${(-rnd() * 6).toFixed(1)}s`;
    stars.append(star);
  }
  const clouds = el("div", "sky-clouds");
  for (let i = 1; i <= 4; i++) clouds.append(el("span", `sky-cloud sky-cloud--${i}`));
  layer.append(el("div", "sky-grad"), el("div", "sky-glow"), stars, el("div", "sky-body"), clouds, el("div", "sky-haze"));
}

/** Солнце днём и луна ночью — по дуге слева направо, по часам. */
function placeSky() {
  if (!skyLayer) return;
  const now = new Date();
  const h = now.getHours() + now.getMinutes() / 60;
  // Солнце: 6:00 восход слева — 20:00 закат справа; луна: 20:00 — 6:00.
  const day = h >= 6 && h < 20;
  const part = day ? (h - 6) / 14 : ((h - 20 + 24) % 24) / 10;
  const x = 8 + part * 84;
  const y = 62 - Math.sin(part * Math.PI) * 48;
  skyLayer.style.setProperty("--sun-x", `${x.toFixed(1)}%`);
  skyLayer.style.setProperty("--sun-y", `${y.toFixed(1)}%`);
}

function season(date = new Date()) {
  const m = date.getMonth();
  if (m >= 8 && m <= 10) return "autumn";
  if (m === 11 || m <= 1) return "winter";
  if (m >= 2 && m <= 4) return "spring";
  return "summer";
}

/* ---------- Цвета предметов ----------
 * Человек сам красит предметы: полоска цвета на карточке, расписание
 * читается с одного взгляда. Хранится только в телефоне.
 */
const SUBJECT_COLORS_KEY = "schedule.subjectColors";
const SUBJECT_PALETTE = ["#ff5a5f", "#ff9f1c", "#ffd60a", "#2ec27e", "#1fb5c9", "#3a7bff", "#8b5cf6", "#ec4899"];

function subjectColors() {
  try {
    return JSON.parse(localStorage.getItem(SUBJECT_COLORS_KEY) || "{}") || {};
  } catch {
    return {};
  }
}

function subjectColor(subject) {
  return subjectColors()[subject] || "";
}

function setSubjectColor(subject, color) {
  const all = subjectColors();
  if (color) all[subject] = color;
  else delete all[subject];
  try {
    localStorage.setItem(SUBJECT_COLORS_KEY, JSON.stringify(all));
  } catch {
    // Без памяти — до перезапуска.
  }
  // Перекрашиваем карточки этого предмета на экране без перерисовки дня.
  for (const card of document.querySelectorAll(".card")) {
    if (card.dataset.subject !== subject) continue;
    paintSubject(card);
  }
}

function paintSubject(card) {
  const color = subjectColor(card.dataset.subject);
  card.classList.toggle("card--colored", Boolean(color));
  if (color) card.style.setProperty("--subject-color", color);
  else card.style.removeProperty("--subject-color");
}

/** Ряд кружков-цветов в окне пары. */
function subjectColorPicker(subject) {
  const row = el("div", "color-row");
  const current = subjectColor(subject);
  const make = (color) => {
    const dot = el("button", `color-dot${color === current ? " color-dot--on" : ""}${color ? "" : " color-dot--none"}`);
    dot.type = "button";
    dot.setAttribute("aria-label", color ? t("Цвет") : t("Без цвета"));
    if (color) dot.style.setProperty("--dot", color);
    dot.addEventListener("click", () => {
      haptic("select");
      setSubjectColor(subject, color);
      for (const node of row.children) node.classList.toggle("color-dot--on", node === dot);
      if (lessonView?.head) paintSubject(lessonView.head);
    });
    return dot;
  };
  row.append(make(""), ...SUBJECT_PALETTE.map(make));
  return row;
}

/* ---------- Вид карточек ---------- */
const CARDS_KEY = "schedule.cards";

function applyCardsStyle() {
  let style = "";
  try {
    // Виды карточек убраны: оформление одно на всех.
    style = "";
    // Стопку «как в Wallet» убрали — кто её выбрал, видит обычные карточки.
    if (style === "stack") style = "";
  } catch {
    style = "";
  }
  document.body.dataset.cards = style;
  const pick = document.getElementById("cards-pick");
  if (pick && pick.value !== style) pick.value = style;
}

/* ---------- Параллакс ----------
 * Фон чуть смещается при наклоне телефона. На iPhone нужен разрешение на
 * датчик движения — спрашиваем при включении галочки (по нажатию).
 */
const PARALLAX_KEY = "schedule.parallax";
let parallaxBound = false;
let parallaxFrame = 0;

function parallaxOn() {
  // Параллакс убран вместе с фонами на выбор.
  if (true) return false;
  try {
    return localStorage.getItem(PARALLAX_KEY) === "on";
  } catch {
    return false;
  }
}

function onTilt(event) {
  if (!parallaxOn()) return;
  const x = Math.max(-1, Math.min(1, (event.gamma || 0) / 30));
  const y = Math.max(-1, Math.min(1, ((event.beta || 0) - 45) / 30));
  if (parallaxFrame) return;
  parallaxFrame = requestAnimationFrame(() => {
    parallaxFrame = 0;
    document.body.style.setProperty("--tilt-x", `${(-x * 14).toFixed(1)}px`);
    document.body.style.setProperty("--tilt-y", `${(-y * 14).toFixed(1)}px`);
  });
}

async function enableParallax(ask) {
  const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!parallaxOn() || calm) {
    document.body.style.removeProperty("--tilt-x");
    document.body.style.removeProperty("--tilt-y");
    return;
  }
  // iPhone: разрешение на датчик — только по нажатию пользователя.
  if (ask && typeof DeviceOrientationEvent?.requestPermission === "function") {
    try {
      const answer = await DeviceOrientationEvent.requestPermission();
      if (answer !== "granted") return;
    } catch {
      return;
    }
  }
  if (!parallaxBound) {
    parallaxBound = true;
    window.addEventListener("deviceorientation", onTilt, { passive: true });
  }
}

function initCustomLook() {
  applyCardsStyle();
  document.getElementById("cards-pick")?.addEventListener("change", (event) => {
    haptic("select");
    try {
      localStorage.setItem(CARDS_KEY, event.target.value);
    } catch {
      // Без памяти — до перезапуска.
    }
    applyCardsStyle();
  });
  const tilt = document.getElementById("parallax");
  if (tilt) {
    tilt.checked = parallaxOn();
    tilt.addEventListener("change", () => {
      try {
        localStorage.setItem(PARALLAX_KEY, tilt.checked ? "on" : "off");
      } catch {
        // Без памяти — до перезапуска.
      }
      enableParallax(true);
    });
  }
  enableParallax(false);
}

/* ---------- Неделя сеткой ----------
 * Все шесть дней сразу, как бумажное расписание: строки — пары, столбцы —
 * дни. Цвет клетки — цвет предмета (свой или по названию). Тап — день.
 */
const GRID_PALETTE = ["#3a7bff", "#8b5cf6", "#2ec27e", "#ff9f1c", "#ec4899", "#1fb5c9", "#ff5a5f", "#6366f1", "#14b8a6", "#f59e0b"];

function gridColor(subject) {
  const own = subjectColor(subject);
  if (own) return own;
  let hash = 0;
  for (const ch of subject) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
  return GRID_PALETTE[hash % GRID_PALETTE.length];
}

function shortSubject(name) {
  // В клетке шириной в шестую часть экрана помещается слов пять-шесть букв:
  // режем каждое слово по слогу, а не посреди как придётся.
  const words = name.replace(/[«»"(),:]/g, " ").split(/\s+/).filter((w) => w && !/^(и|в|с|на|для|по|к)$/i.test(w));
  return words
    .slice(0, 3)
    .map((w) => (w.length > 6 ? w.slice(0, 5).replace(/[аеёиоуыэюяьъй]+$/i, "") + "." : w))
    .join(" ");
}

function renderWeekGrid(group) {
  const bells = new Map(data.bells.map((b) => [b.n, b]));
  const todayIso = isoDate(new Date());
  const days = [];
  let maxSlot = 0;
  let minSlot = 99;
  for (let day = 1; day <= 6; day++) {
    const date = dateOfDay(day, selectedWeek);
    const lessons = ownLessonsForDay(group, day, selectedWeek).filter((l) => !lessonCancelOn(l, isoDate(date)));
    for (const l of lessons) {
      maxSlot = Math.max(maxSlot, l.slot);
      minSlot = Math.min(minSlot, l.slot);
    }
    days.push({ day, date, lessons });
  }
  const grid = el("div", "wgrid");
  if (!maxSlot) {
    grid.append(el("div", "week-empty", t("Пар нет")));
    return grid;
  }
  grid.style.setProperty("--rows", String(maxSlot - minSlot + 1));
  grid.append(el("div", "wgrid-corner"));
  for (const { day, date } of days) {
    const head = el("div", isoDate(date) === todayIso ? "wgrid-day wgrid-day--today" : "wgrid-day");
    head.append(el("b", null, DAYS[day - 1].slice(0, 2)), el("span", null, String(date.getDate())));
    grid.append(head);
  }
  const clock = new Date();
  const nowMin = clock.getHours() * 60 + clock.getMinutes();
  for (let slot = minSlot; slot <= maxSlot; slot++) {
    const bell = bells.get(slot);
    grid.append(el("div", "wgrid-time", bell ? bell.start : String(slot)));
    for (const { day, date, lessons } of days) {
      const here = lessons.filter((l) => l.slot === slot);
      if (!here.length) {
        grid.append(el("div", "wgrid-cell wgrid-cell--empty"));
        continue;
      }
      const first = here[0];
      const cell = el("button", "wgrid-cell");
      cell.type = "button";
      cell.style.setProperty("--c", gridColor(first.subject));
      const time = timesOf(first, bells);
      if (time && isoDate(date) === todayIso) {
        const [sh, sm] = time.start.split(":").map(Number);
        const [eh, em] = time.end.split(":").map(Number);
        if (nowMin >= sh * 60 + sm && nowMin < eh * 60 + em) cell.classList.add("wgrid-cell--now");
      }
      const odd = here.length > 1 ? ` +${here.length - 1}` : "";
      cell.append(el("b", null, shortSubject(tr(first.subject)) + odd));
      if (first.room) cell.append(el("span", null, first.room.replace(/^ауд\.?\s*/i, "")));
      if (first.week === "odd" || first.week === "even") cell.classList.add("wgrid-cell--parity");
      cell.addEventListener("click", () => {
        haptic("light");
        selectedDay = day;
        openTab("schedule");
      });
      grid.append(cell);
    }
  }
  return grid;
}

/* Зазоры при перетягивании (пружина iPhone). За страницей лежит фон —
   узор, небо, сетка — и в зазоре он торчал обрывком. Закрываем зазоры
   сплошным цветом расписания; в верхнем при сильном рывке выглядывает :P. */
let overBottom = null;

/* Прокрутка расписания: крупная дата съёживается и уезжает, а сверху
   проявляется тонкая полоска с датой и лентой дня. Нижняя панель при
   листании вниз сворачивается в пилюлю, при листании вверх — раскрывается. */
function initScrollChrome() {
  const mini = el("button", "minihead");
  mini.type = "button";
  const miniDate = el("span", "minihead-date");
  const miniRibbon = el("span", "minihead-ribbon");
  mini.append(miniDate, miniRibbon);
  document.body.append(mini);
  mini.addEventListener("click", () => window.scrollTo({ top: 0, behavior: "smooth" }));

  const syncMini = () => {
    const date = document.getElementById("date-label");
    const ribbon = document.getElementById("ribbon");
    miniDate.textContent = (date?.querySelector(".date-new") || date)?.textContent.trim() || "";
    miniRibbon.replaceChildren(...(ribbon && !ribbon.hidden ? [ribbon.cloneNode(true)] : []));
    miniRibbon.firstChild?.removeAttribute("id");
  };
  const watched = ["date-label", "ribbon"].map((id) => document.getElementById(id)).filter(Boolean);
  const observer = new MutationObserver(syncMini);
  for (const node of watched) observer.observe(node, { childList: true, subtree: true, characterData: true, attributes: true });
  syncMini();

  let last = 0;
  let travel = 0;
  let frame = 0;
  const update = () => {
    frame = 0;
    const page = document.scrollingElement || document.documentElement;
    const y = Math.max(0, page.scrollTop);
    const onSchedule = !document.getElementById("schedule")?.hidden;
    const date = document.getElementById("date-label");
    if (date) {
      const k = onSchedule ? Math.min(1, y / 90) : 0;
      date.style.transform = k ? `translateY(${k * 6}px) scale(${1 - k * 0.22})` : "";
      date.style.opacity = k ? `${1 - k * 0.85}` : "";
    }
    document.body.classList.toggle("head-compact", onSchedule && y > 96);

    // Панель: копим путь в одну сторону, чтобы дрожь пальца её не дёргала.
    const delta = y - last;
    last = y;
    travel = Math.sign(delta) === Math.sign(travel) ? travel + delta : delta;
    const atEnd = y + window.innerHeight >= page.scrollHeight - 4;
    if (y < 40 || atEnd || travel < -24) document.body.classList.remove("tabs-mini");
    else if (travel > 24) document.body.classList.add("tabs-mini");
  };
  window.addEventListener("scroll", () => {
    if (!frame) frame = requestAnimationFrame(update);
  }, { passive: true });
  // Свёрнутую панель раскрывает и касание по ней.
  document.getElementById("tabs")?.addEventListener("click", (event) => {
    if (!document.body.classList.contains("tabs-mini")) return;
    document.body.classList.remove("tabs-mini");
    travel = 0;
    event.stopPropagation();
    event.preventDefault();
  }, true);
}

function initOverscroll() {
  // За краем страницы, пока её тянут, проглядывает фон (узор, небо). Закрываем
  // зазоры сплошным цветом. Пружину iPhone рисует сама система, а прокрутка
  // приходит в код с опозданием — поэтому верхняя заливка лежит ПОД страницей
  // и с большим запасом заходит под неё: отстала на кадр — всё равно закрыто,
  // а надписи шапки остаются поверх. :P — в самом зазоре, при сильном рывке.
  const overTop = el("div", "over over--top");
  const egg = el("span", "over-egg", ":P");
  overBottom = el("div", "over over--bottom");
  overBottom.append(egg);
  document.body.append(overTop, overBottom);
  const update = () => {
    const page = document.scrollingElement || document.documentElement;
    const top = Math.max(0, -page.scrollTop);
    const bottom = Math.max(0, page.scrollTop + window.innerHeight - page.scrollHeight);
    overTop.style.height = top ? `${top + 100 + 260}px` : "0";
    // :P — над нижней панелью, когда страницу сильно тянут вверх.
    overBottom.classList.toggle("over--egg", bottom > 130);
    overBottom.style.height = bottom ? `${bottom + 140}px` : "0";
  };
  window.addEventListener("scroll", update, { passive: true });
  // Пока палец на экране и пружина доигрывает — сверяемся каждый кадр.
  let until = 0;
  const loop = () => {
    update();
    if (performance.now() < until) requestAnimationFrame(loop);
  };
  const kick = () => {
    const idle = performance.now() >= until;
    until = performance.now() + 1200;
    if (idle) requestAnimationFrame(loop);
  };
  document.addEventListener("touchstart", kick, { passive: true });
  document.addEventListener("touchmove", kick, { passive: true });
  document.addEventListener("touchend", kick, { passive: true });
}

/* ---------- Неоновая ночь ---------- */
const NEON_KEY = "schedule.neon";

// Неон — одна из цветовых тем (COLOR_THEMES), классы ставит applyTheme.
function initNeon() {
  applyTheme();
}

/* ---------- Лента дня ----------
 * Под датой — тонкая полоса дня: пары отрезками, точка «сейчас» бежит по
 * ней. Прошедшие пары бледнеют, идущая подсвечена.
 */
function renderRibbon() {
  const box = document.getElementById("ribbon");
  if (!box || !data) return;
  const bells = new Map(data.bells.map((b) => [b.n, b]));
  const spans = new Map();
  // Пары именно выбранного дня: список «visible» в выходной не обновляется
  // и хранил пары прошлого дня — лента показывала их и в выходные.
  const group = activeGroup();
  const date = isoDate(dateOfDay(selectedDay, selectedWeek));
  const dayLessons = group && selectedDay <= 6 ? ownLessonsForDay(group, selectedDay, selectedWeek) : [];
  for (const lesson of dayLessons) {
    if (lessonCancelOn(lesson, date)) continue;
    const time = timesOf(lesson, bells);
    if (!time) continue;
    const start = minutes(time.start);
    const end = minutes(time.end);
    const known = spans.get(start);
    if (!known || end > known.end) spans.set(start, { start, end });
  }
  // Параллельные и пересекающиеся пары (языки по подгруппам, РКИ 8:00–10:40
  // поверх английского 9:00–10:30) сливаем в один отрезок — иначе они
  // рисовались друг на друге.
  const list = [];
  for (const span of [...spans.values()].sort((a, b) => a.start - b.start)) {
    const last = list[list.length - 1];
    if (last && span.start <= last.end) last.end = Math.max(last.end, span.end);
    else list.push({ ...span });
  }
  if (!list.length) {
    box.hidden = true;
    return;
  }
  const from = list[0].start;
  const to = Math.max(...list.map((s) => s.end));
  const width = Math.max(1, to - from);
  const today = isoDate(dateOfDay(selectedDay)) === isoDate(new Date());
  const clock = new Date();
  const now = clock.getHours() * 60 + clock.getMinutes() + clock.getSeconds() / 60;
  const track = el("div", "ribbon-track");
  for (const span of list) {
    const piece = el("span", "ribbon-seg");
    piece.style.left = `${((span.start - from) / width) * 100}%`;
    piece.style.width = `${((span.end - span.start) / width) * 100}%`;
    if (today && now >= span.end) piece.classList.add("ribbon-seg--past");
    if (today && now >= span.start && now < span.end) piece.classList.add("ribbon-seg--now");
    track.append(piece);
  }
  if (today && now >= from - 60 && now <= to) {
    const dot = el("span", "ribbon-dot");
    dot.style.left = `${Math.min(100, Math.max(0, ((now - from) / width) * 100))}%`;
    track.append(dot);
  }
  const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(Math.round(m % 60)).padStart(2, "0")}`;
  box.replaceChildren(el("span", "ribbon-time", hhmm(from)), track, el("span", "ribbon-time", hhmm(to)));
  box.hidden = false;
}

/* ---------- Карточка «Сейчас» ----------
 * Сверху дня — крупно то, что важно в эту минуту: идущая пара с таймером до
 * конца или ближайшая — с таймером до начала. Нажатие открывает пару.
 */
function renderNowCard() {
  const box = document.getElementById("nowcard");
  if (!box || !data) return;
  const running = currentLesson();
  const upcoming = running ? null : nextLesson();
  const cards = [...els.lessons.querySelectorAll("article.card")];
  let card = null;
  let mode = "";
  let left = 0;
  let part = 0;
  if (running) {
    card = cards.find((c) => c.classList.contains("card--now")) || null;
    mode = "now";
    left = running.left;
    part = Math.min(1, running.elapsed / Math.max(1, running.total));
  } else if (upcoming && upcoming.left <= 120) {
    card = cards.find((c) => c.dataset.start && minutes(c.dataset.start) === upcoming.start) || null;
    mode = "next";
    left = upcoming.left;
  }
  if (!card) {
    box.hidden = true;
    els.next.classList.remove("next--covered");
    return;
  }
  const subject = card.querySelector(".subject")?.textContent.trim() || "";
  const room = card.querySelector(".room-badge")?.textContent.replace(/\s+/g, " ").trim() || "";
  const leftText = humanLeft(left);
  const label = mode === "now" ? t("Идёт сейчас") : t("Дальше");
  const until = mode === "now" ? t("до конца") : t("до начала");
  const key = `${mode}|${subject}|${room}|${leftText}|${Math.round(part * 100)}`;
  if (box.dataset.key !== key) {
    box.dataset.key = key;
    const head = el("div", "nowcard-head");
    head.append(el("span", "nowcard-label", label), el("span", "nowcard-room", room));
    const timer = el("div", "nowcard-timer");
    timer.append(el("b", null, leftText), el("span", null, until));
    const nodes = [head, el("div", "nowcard-subject", subject), timer];
    if (mode === "now") {
      const bar = el("div", "nowcard-bar");
      const fill = el("i");
      fill.style.width = `${(part * 100).toFixed(1)}%`;
      bar.append(fill);
      nodes.push(bar);
    }
    box.replaceChildren(...nodes);
    box.classList.toggle("nowcard--next", mode === "next");
  }
  box._card = card;
  box.hidden = false;
  // Строка «через N мин» под днями дублирует карточку — прячем, пока она есть.
  els.next.classList.add("next--covered");
}

/* ---------- Карточки: учить выражения к экзамену ----------
 * Колоды: готовые (data/decks/*.json) и свои — из загруженного .docx/.txt,
 * разбираются прямо в телефоне и хранятся только в нём. Строка файла
 * «1. expression — перевод» становится карточкой. Прогресс — в телефоне.
 */
const FLASH_MINE_KEY = "schedule.decks";
let flash = { decks: [], deck: null, queue: [], known: new Set(), flipped: false, reverse: false, builtin: [] };

function flashEl(id) {
  return document.getElementById(id);
}

function myDecks() {
  return readLocal(FLASH_MINE_KEY, []);
}

function knownKey(deckId) {
  return `schedule.cardsKnown.${deckId}`;
}

function favKey(deckId) {
  return `schedule.cardsFav.${deckId}`;
}

/** Строки «1. a — b», «a — b», «a - b», «a<таб>b» → карточки. */
function parseCards(lines) {
  const cards = [];
  for (const raw of lines) {
    const line = raw.replace(/^\s*\d+[.)]\s*/, "").trim();
    if (!line) continue;
    const m = line.match(/^(.+?)\s+[—–-]\s+(.+)$/) || line.match(/^(.+?)\t+(.+)$/);
    if (m) cards.push({ front: m[1].trim(), back: m[2].trim().replace(/\.$/, "") });
  }
  return cards;
}

/** .docx и .xlsx — это zip: достаём нужный xml без сторонних библиотек. */
async function zipXml(buffer, wanted) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  // Конец центрального каталога — с конца файла.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 66000); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not zip");
  let ptr = view.getUint32(eocd + 16, true);
  const count = view.getUint16(eocd + 10, true);
  for (let n = 0; n < count; n++) {
    const method = view.getUint16(ptr + 10, true);
    const size = view.getUint32(ptr + 20, true);
    const nameLen = view.getUint16(ptr + 28, true);
    const extraLen = view.getUint16(ptr + 30, true);
    const commentLen = view.getUint16(ptr + 32, true);
    const local = view.getUint32(ptr + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(ptr + 46, ptr + 46 + nameLen));
    if (name === wanted) {
      const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
      const data = bytes.subarray(start, start + size);
      let xml;
      if (method === 0) xml = new TextDecoder().decode(data);
      else {
        const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
        xml = await new Response(stream).text();
      }
      return new DOMParser().parseFromString(xml, "application/xml");
    }
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

async function docxText(buffer) {
  const doc = await zipXml(buffer, "word/document.xml");
  if (!doc) throw new Error("no document");
  const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
  return [...doc.getElementsByTagNameNS(W, "p")].map((p) =>
    [...p.getElementsByTagNameNS(W, "*")].map((node) => (node.localName === "t" ? node.textContent : node.localName === "tab" ? "\t" : "")).join("")
  );
}

/** Первый лист .xlsx: каждая строка таблицы — ячейки через таб («слово<таб>перевод»). */
async function xlsxText(buffer) {
  const sheet = await zipXml(buffer, "xl/worksheets/sheet1.xml");
  if (!sheet) throw new Error("no sheet");
  const shared = await zipXml(buffer, "xl/sharedStrings.xml");
  const strings = shared ? [...shared.getElementsByTagName("si")].map((si) => [...si.getElementsByTagName("t")].map((t) => t.textContent).join("")) : [];
  return [...sheet.getElementsByTagName("row")].map((row) =>
    [...row.getElementsByTagName("c")]
      .map((c) => {
        const type = c.getAttribute("t");
        if (type === "inlineStr") return [...c.getElementsByTagName("t")].map((t) => t.textContent).join("");
        const v = c.getElementsByTagName("v")[0]?.textContent ?? "";
        return type === "s" ? strings[+v] ?? "" : v;
      })
      .filter((cell) => cell.trim())
      .join("\t")
  );
}

/** PDF: текст по строкам через pdf.js, библиотека грузится только при первом PDF. */
async function pdfText(buffer) {
  if (!window.pdfjsLib) {
    await new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
      script.onload = resolve;
      script.onerror = reject;
      document.head.append(script);
    });
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  }
  const pdf = await window.pdfjsLib.getDocument({ data: buffer }).promise;
  const lines = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const content = await (await pdf.getPage(n)).getTextContent();
    // Кусочки текста на одной высоте — одна строка.
    const rows = new Map();
    for (const item of content.items) {
      if (!item.str) continue;
      const y = Math.round(item.transform[5] / 2) * 2;
      if (!rows.has(y)) rows.set(y, []);
      rows.get(y).push(item);
    }
    for (const y of [...rows.keys()].sort((a, b) => b - a)) {
      lines.push(rows.get(y).sort((a, b) => a.transform[4] - b.transform[4]).map((i) => i.str).join(" ").replace(/\s+/g, " "));
    }
  }
  return lines;
}

/** Скриншоты: распознаём текст прямо в телефоне (tesseract.js), картинки никуда не уходят. */
async function imageText(images) {
  if (!window.Tesseract) {
    await new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js";
      script.onload = resolve;
      script.onerror = reject;
      document.head.append(script);
    });
  }
  const worker = await window.Tesseract.createWorker(["eng", "rus"]);
  const lines = [];
  try {
    for (const image of images) {
      const { data } = await worker.recognize(image);
      // OCR часто читает тире как «-», «–» или «_» — приводим к одному виду.
      lines.push(...data.text.split("\n").map((line) => line.replace(/\s[-–_~]{1,2}\s/, " — ").trim()));
    }
  } finally {
    await worker.terminate();
  }
  return lines;
}

async function loadBuiltinDecks(ids) {
  const out = [];
  for (const id of ids || []) {
    try {
      const res = await fetch(`data/decks/${id}.json?v=${window.__v || ""}`);
      if (res.ok) out.push(await res.json());
    } catch {
      // нет сети — без готовой колоды
    }
  }
  return out;
}

async function openFlash(ids = []) {
  flash.builtin = await loadBuiltinDecks(ids);
  flashEl("flash").hidden = false;
  document.body.classList.add("sheet-open");
  showDeckList();
}

function closeFlash() {
  const box = flashEl("flash");
  box.classList.add("flash--out");
  setTimeout(() => {
    box.hidden = true;
    box.classList.remove("flash--out");
  }, 260);
  document.body.classList.remove("sheet-open");
}

function showDeckList() {
  flash.deck = null;
  flashEl("flash-title").textContent = t("Карточки");
  flashEl("flash-back").style.visibility = "hidden";
  const body = flashEl("flash-body");
  const decks = [...flash.builtin.map((d) => ({ ...d, builtin: true })), ...myDecks()];
  const list = el("div", "deck-list");
  for (const deck of decks) {
    const known = readLocal(knownKey(deck.id), []).length;
    const item = el("button", "deck");
    item.type = "button";
    const share = deck.cards.length ? known / deck.cards.length : 0;
    const ring = el("span", "deck-ring");
    ring.style.setProperty("--p", share.toFixed(3));
    ring.append(el("b", null, `${Math.round(share * 100)}%`));
    const text = el("span", "deck-text");
    text.append(el("b", null, deck.title), el("span", null, `${t("выучено {k} из {n}", { k: known, n: deck.cards.length })}${deck.builtin ? "" : " · " + t("мой файл")}`));
    item.append(ring, text);
    item.addEventListener("click", () => startDeck(deck));
    list.append(item);
    const favs = readLocal(favKey(deck.id), []).filter((i) => i < deck.cards.length);
    if (favs.length) {
      const fav = el("button", "deck-fav");
      fav.type = "button";
      fav.append(el("span", null, "★"), el("span", null, t("Только избранные · {n}", { n: favs.length })));
      fav.addEventListener("click", () => startDeck(deck, true));
      list.append(fav);
    }
    if (!deck.builtin) {
      const remove = el("button", "deck-remove", "×");
      remove.type = "button";
      remove.setAttribute("aria-label", t("Удалить"));
      remove.addEventListener("click", (event) => {
        event.stopPropagation();
        writeLocal(FLASH_MINE_KEY, myDecks().filter((d) => d.id !== deck.id));
        showDeckList();
      });
      item.append(remove);
    }
  }
  const upload = el("button", "deck-upload");
  upload.type = "button";
  upload.append(el("span", null, "＋"), el("span", null, t("Загрузить файл или скрины (.docx, .xlsx, .pdf, .txt, фото)")));
  upload.addEventListener("click", () => flashEl("flash-file").click());
  const hint = el("p", "hint", t("Каждая строка вида «expression — перевод» станет карточкой. Файл остаётся только в вашем телефоне."));
  body.replaceChildren(list, upload, hint);
}

function startDeck(deck, favOnly = false) {
  flash.deck = deck;
  flash.favOnly = favOnly;
  flash.fav = new Set(readLocal(favKey(deck.id), []));
  flash.known = new Set(readLocal(knownKey(deck.id), []));
  // В избранном прогоняем все отмеченные, даже уже выученные.
  const order = favOnly ? [...flash.fav].filter((i) => i < deck.cards.length) : deck.cards.map((_, i) => i).filter((i) => !flash.known.has(i));
  flash.total = order.length;
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  flash.queue = order;
  flash.flipped = false;
  flashEl("flash-title").textContent = favOnly ? `★ ${deck.title}` : deck.title;
  flashEl("flash-back").style.visibility = "visible";
  haptic("light");
  showCard();
}

function showCard() {
  const deck = flash.deck;
  const body = flashEl("flash-body");
  const total = flash.favOnly ? flash.total : deck.cards.length;
  const passed = flash.favOnly ? total - new Set(flash.queue).size : flash.known.size;
  const progress = el("div", "flash-progress");
  const fill = el("i");
  fill.style.width = `${total ? (passed / total) * 100 : 0}%`;
  progress.append(fill);
  const stats = el("div", "flash-stats");
  stats.append(el("span", null, t(flash.favOnly ? "избранных пройдено {k} из {n}" : "выучено {k} из {n}", { k: passed, n: total })), el("span", null, t("осталось {n}", { n: flash.queue.length })));

  if (!flash.queue.length) {
    const done = el("div", "flash-done");
    done.append(el("div", "flash-done-icon", "🎉"), el("h3", null, t(flash.favOnly ? "Избранные пройдены!" : "Все карточки выучены!")), el("p", "hint", t("Отличная подготовка. Можно пройти ещё раз для закрепления.")));
    const again = el("button", "primary", t("Пройти заново"));
    again.type = "button";
    again.addEventListener("click", () => {
      if (!flash.favOnly) writeLocal(knownKey(deck.id), []);
      startDeck(deck, flash.favOnly);
    });
    done.append(again);
    body.replaceChildren(progress, stats, done);
    haptic("success");
    return;
  }

  const index = flash.queue[0];
  const card = deck.cards[index];
  const front = flash.reverse ? card.back : card.front;
  const back = flash.reverse ? card.front : card.back;
  const scene = el("div", "flash-scene");
  const inner = el("div", `flash-card${flash.flipped ? " flash-card--flipped" : ""}`);
  const faceA = el("div", "flash-face flash-face--front");
  faceA.append(el("span", "flash-lang", flash.reverse ? "RU" : "EN"), el("div", "flash-word", front), el("span", "flash-tip", t("нажмите, чтобы перевернуть")));
  const faceB = el("div", "flash-face flash-face--back");
  faceB.append(el("span", "flash-lang", flash.reverse ? "EN" : "RU"), el("div", "flash-word flash-word--small", front), el("div", "flash-answer", back));
  inner.append(faceA, faceB);
  const star = el("button", `flash-star${flash.fav.has(index) ? " flash-star--on" : ""}`, flash.fav.has(index) ? "★" : "☆");
  star.type = "button";
  star.setAttribute("aria-label", t("В избранное"));
  star.addEventListener("pointerdown", (e) => e.stopPropagation());
  star.addEventListener("click", (e) => {
    e.stopPropagation();
    if (flash.fav.has(index)) flash.fav.delete(index);
    else flash.fav.add(index);
    writeLocal(favKey(deck.id), [...flash.fav]);
    const on = flash.fav.has(index);
    star.textContent = on ? "★" : "☆";
    star.classList.toggle("flash-star--on", on);
    star.animate([{ transform: "scale(1)" }, { transform: "scale(1.35)" }, { transform: "scale(1)" }], { duration: 260, easing: "ease-out" });
    haptic(on ? "success" : "light");
  });
  scene.append(inner, star);
  scene.addEventListener("click", () => {
    flash.flipped = !flash.flipped;
    inner.classList.toggle("flash-card--flipped", flash.flipped);
    haptic("select");
  });
  // Свайп: вправо — знаю, влево — ещё раз.
  let startX = null;
  scene.addEventListener("pointerdown", (e) => {
    startX = e.clientX;
  });
  scene.addEventListener("pointermove", (e) => {
    if (startX === null) return;
    const dx = e.clientX - startX;
    if (Math.abs(dx) > 8) inner.style.transform = `translateX(${dx}px) rotate(${dx / 20}deg)${flash.flipped ? " rotateY(180deg)" : ""}`;
  });
  scene.addEventListener("pointerup", (e) => {
    if (startX === null) return;
    const dx = e.clientX - startX;
    startX = null;
    inner.style.transform = "";
    if (dx > 90) answer(true, inner, 1);
    else if (dx < -90) answer(false, inner, -1);
  });

  const buttons = el("div", "flash-buttons");
  const again = el("button", "flash-btn flash-btn--again", t("Следующая"));
  again.type = "button";
  again.addEventListener("click", () => answer(false, inner, -1));
  const know = el("button", "flash-btn flash-btn--know", t("Знаю"));
  know.type = "button";
  know.addEventListener("click", () => answer(true, inner, 1));
  buttons.append(again, know);

  const swap = el("button", "flash-swap", flash.reverse ? t("RU → EN · сменить") : t("EN → RU · сменить"));
  swap.type = "button";
  swap.addEventListener("click", () => {
    flash.reverse = !flash.reverse;
    flash.flipped = false;
    showCard();
  });
  body.replaceChildren(progress, stats, scene, buttons, swap);
}

function answer(known, inner, dir) {
  const index = flash.queue.shift();
  if (known) {
    flash.known.add(index);
    writeLocal(knownKey(flash.deck.id), [...flash.known]);
    if (flash.favOnly) flash.queue = flash.queue.filter((i) => i !== index);
    haptic("success");
  } else {
    // Трудную карточку вернём через несколько других.
    flash.queue.splice(Math.min(flash.queue.length, 4 + Math.floor(Math.random() * 3)), 0, index);
    haptic("light");
  }
  flash.flipped = false;
  inner.animate(
    [{ transform: inner.style.transform || "none", opacity: 1 }, { transform: `translateX(${dir * 420}px) rotate(${dir * 18}deg)`, opacity: 0 }],
    { duration: 260, easing: "ease-in" }
  ).finished.then(showCard, showCard);
}

function initFlash() {
  flashEl("flash-close")?.addEventListener("click", closeFlash);
  flashEl("flash-back")?.addEventListener("click", showDeckList);
  flashEl("flash-file")?.addEventListener("change", async (event) => {
    const files = [...(event.target.files || [])];
    event.target.value = "";
    const file = files[0];
    if (!file) return;
    const images = files.filter((f) => f.type.startsWith("image/"));
    const button = document.querySelector(".deck-upload span:last-child");
    try {
      if (images.length && button) button.textContent = t("Распознаю текст на скринах…");
      const lines = images.length
        ? await imageText(images)
        : /\.docx$/i.test(file.name)
        ? await docxText(await file.arrayBuffer())
        : /\.xlsx$/i.test(file.name)
          ? await xlsxText(await file.arrayBuffer())
        : /\.pdf$/i.test(file.name)
          ? await pdfText(await file.arrayBuffer())
          : (await file.text()).split(/\r?\n/);
      const cards = parseCards(lines);
      if (!cards.length) throw new Error("empty");
      const title = images.length ? t("Скрины · {d}", { d: new Date().toLocaleDateString("ru-RU", { day: "numeric", month: "long" }) }) : file.name.replace(/\.(docx|xlsx|txt|pdf)$/i, "");
      const deck = { id: `my-${Date.now()}`, title, cards };
      writeLocal(FLASH_MINE_KEY, [...myDecks(), deck]);
      haptic("success");
      showDeckList();
    } catch {
      showDeckList();
      tg?.showAlert?.(t("Не нашёл в файле карточек. Нужны строки вида «expression — перевод»."));
    }
  });
}

/* ---------- Особые дни: экзамен вместо обычных пар ----------
 * Вместо нескольких пар одного предмета — одна большая плашка (мидтерм,
 * контрольная). Группы — по курсу факультета, предмет — по началу названия.
 */
const SPECIALS = [
  { tenant: "msu-fgp", course: 3, date: "2026-10-27", subject: /английский/i, title: "Midterm", kind: "Английский язык", part: "Устная часть", icon: "🎤", decks: ["fgp-lsp-10", "fgp-lsp-1"] },
  { tenant: "msu-fgp", course: 3, date: "2026-10-28", subject: /английский/i, title: "Midterm", kind: "Английский язык", part: "Письменная часть · изложение", icon: "✍️" },
];

function applySpecials() {
  const group = activeGroup();
  if (!group || group.teacher || !els.lessons) return;
  const day = isoDate(dateOfDay(selectedDay));
  const rule = SPECIALS.find((r) => r.tenant === tenant().id && Number(group.course) === r.course && r.date === day);
  if (!rule || els.lessons.querySelector(".special")) return;
  const cards = [...els.lessons.querySelectorAll(":scope > article.card")].filter((c) => rule.subject.test(c.dataset.subject || ""));
  if (!cards.length) return;
  const start = cards.map((c) => c.dataset.start).filter(Boolean).sort()[0] || "";
  const end = cards.map((c) => c.dataset.end).filter(Boolean).sort().at(-1) || "";
  const box = el("div", "special");
  const head = el("div", "special-head");
  head.append(el("span", "special-badge", rule.kind), el("span", "special-time", start && end ? `${start} – ${end}` : ""));
  const title = el("div", "special-title");
  title.append(el("span", "special-icon", rule.icon), el("span", null, rule.title));
  box.append(head, title, el("div", "special-part", rule.part), el("div", "special-luck", "Удачи! 🍀"));
  if (rule.decks) {
    const study = el("button", "special-study", t("🃏 Учить выражения"));
    study.type = "button";
    study.addEventListener("click", (event) => {
      event.stopPropagation();
      haptic("light");
      openFlash(rule.decks);
    });
    box.append(study);
    box.addEventListener("click", () => openFlash(rule.decks));
    box.classList.add("special--tap");
  }
  for (let i = 0; i < 6; i++) box.append(el("i", `special-spark special-spark--${i + 1}`));
  cards[0].before(box);
  for (const card of cards) {
    // Перемена между скрытыми парами тоже не нужна.
    const next = card.nextElementSibling;
    if (next?.classList.contains("gap") && cards.includes(next.nextElementSibling)) next.remove();
    card.remove();
  }
}

function initNowCard() {
  // Сменили день (в том числе на выходной, где пар нет и список не
  // перерисовывается обычным путём) — лента и карточка тоже обновляются.
  new MutationObserver(() => {
    applySpecials();
    renderRibbon();
    renderNowCard();
  }).observe(els.lessons, { childList: true });
  const box = document.getElementById("nowcard");
  box?.addEventListener("click", () => {
    const card = box._card;
    if (!card || !document.body.contains(card)) return;
    haptic("light");
    openLessonView(card);
  });
}

/* ---------- Дедлайны ----------
 * Общие дедлайны группы (вносит староста, хранятся на сервере) и личные
 * (только в этом телефоне). «Сдано» — личная отметка, тоже в телефоне.
 */
const DEADLINE_URL = `${API_URL}/deadline`;
const POLL_URL = `${API_URL}/poll`;
const POLL_VOTE_URL = `${API_URL}/poll/vote`;
let dlEditing = null;

function personalKey() {
  return `schedule.deadlines.${activeGroup()?.id || ""}`;
}

function readLocal(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key) || "null") ?? fallback;
  } catch {
    return fallback;
  }
}

function writeLocal(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Без памяти — до перезапуска.
  }
}

function allDeadlines() {
  const group = (notices.deadlines || []).map((d) => ({ ...d, key: `g${d.id}`, shared: true }));
  const mine = readLocal(personalKey(), []).map((d) => ({ ...d, key: `p${d.id}`, shared: false }));
  return [...group, ...mine];
}

function dueDate(due) {
  const [day, time] = String(due).split("T");
  return new Date(`${day}T${time || "23:59"}:00`);
}

function dueLabel(due) {
  const at = dueDate(due);
  const now = new Date();
  const days = Math.round((new Date(at.toDateString()) - new Date(now.toDateString())) / 86400000);
  const time = String(due).includes("T") ? ` ${String(due).slice(11, 16)}` : "";
  if (at < now) return { text: t("просрочено"), cls: "dl-when--late" };
  if (days === 0) return { text: t("сегодня") + time, cls: "dl-when--soon" };
  if (days === 1) return { text: t("завтра") + time, cls: "dl-when--soon" };
  if (days < 7) return { text: t("через {n} дн.", { n: days }) + time, cls: "" };
  return { text: SHORT_DATE.format(at) + time, cls: "" };
}

function renderDeadlines() {
  const body = document.getElementById("dl-body");
  if (!body) return;
  const group = activeGroup();
  document.getElementById("dl-group").textContent = group ? (group.teacher ? group.title : t("Группа {g}", { g: group.title })) : "";
  const done = new Set(readLocal("schedule.deadlinesDone", []));
  const list = allDeadlines().sort((a, b) => {
    const da = done.has(a.key);
    const db = done.has(b.key);
    if (da !== db) return da ? 1 : -1;
    return dueDate(a.due) - dueDate(b.due);
  });
  if (!list.length) {
    const empty = el("div", "dl-empty");
    empty.append(
      el("div", "dl-empty-icon", "📌"),
      el("p", null, t("Дедлайнов пока нет")),
      el("p", "hint", notices.canEdit ? t("Добавьте свой или общий для группы — кнопкой ниже.") : t("Добавьте свой — кнопкой ниже. Общие для группы вносит староста."))
    );
    body.replaceChildren(empty);
    return;
  }
  body.replaceChildren(
    ...list.map((d) => {
      const isDone = done.has(d.key);
      const row = el("div", `dl-item${isDone ? " dl-item--done" : ""}`);
      const check = el("button", "dl-check", isDone ? "✓" : "");
      check.type = "button";
      check.setAttribute("aria-label", t("Сдано"));
      check.addEventListener("click", (event) => {
        event.stopPropagation();
        haptic(isDone ? "light" : "success");
        if (isDone) done.delete(d.key);
        else done.add(d.key);
        writeLocal("schedule.deadlinesDone", [...done]);
        renderDeadlines();
      });
      const text = el("div", "dl-text");
      text.append(el("div", "dl-title", d.title));
      const meta = [d.subject ? tr(d.subject) : "", d.shared ? t("для группы") : t("личное")].filter(Boolean).join(" · ");
      text.append(el("div", "dl-meta", meta));
      const when = dueLabel(d.due);
      row.append(check, text, el("div", `dl-when ${isDone ? "" : when.cls}`, isDone ? t("сдано") : when.text));
      if (!d.shared || notices.canEdit) {
        row.addEventListener("click", () => openDeadline(d));
      }
      return row;
    })
  );
}

function groupSubjects() {
  const group = activeGroup();
  if (!group || !data) return [];
  return [...new Set(data.lessons.filter((l) => l.group === group.id).map((l) => l.subject))].sort((a, b) => a.localeCompare(b, "ru"));
}

function openDeadline(item = null) {
  dlEditing = item;
  const sheet = document.getElementById("dl-sheet");
  document.getElementById("dl-title-head").textContent = item ? t("Дедлайн") : t("Новый дедлайн");
  document.getElementById("dl-title").value = item?.title || "";
  const subject = document.getElementById("dl-subject");
  subject.replaceChildren(new Option(t("— без предмета —"), ""), ...groupSubjects().map((s) => new Option(tr(s), s)));
  subject.value = item?.subject || "";
  const [day, time] = String(item?.due || "").split("T");
  const tomorrow = new Date(Date.now() + 86400000);
  document.getElementById("dl-date").value = day || isoDate(tomorrow);
  document.getElementById("dl-time").value = time || "";
  const groupRow = document.getElementById("dl-group-row");
  groupRow.hidden = !notices.canEdit || Boolean(item);
  document.getElementById("dl-for-group").checked = Boolean(item?.shared);
  document.getElementById("dl-delete").hidden = !item;
  document.getElementById("dl-error").hidden = true;
  syncDeadlineSheet();
  sheet.hidden = false;
  document.body.classList.add("sheet-open");
}

/** Подпись под заголовком и выбранная кнопка срока — по текущим полям. */
function syncDeadlineSheet() {
  const shared = dlEditing ? dlEditing.shared : document.getElementById("dl-for-group").checked;
  document.getElementById("dl-sub").textContent = shared ? t("Для группы — увидят все") : t("Личный — видите только вы");
  const value = document.getElementById("dl-date").value;
  for (const chip of document.querySelectorAll("#dl-chips .dl-chip")) {
    const day = isoDate(new Date(Date.now() + Number(chip.dataset.days) * 86400000));
    chip.classList.toggle("dl-chip--on", day === value);
  }
}

/** Окно уезжает вниз, затемнение тает — как у остальных окон. */
function slideSheetAway(sheet) {
  if (!sheet || sheet.hidden || sheet.classList.contains("sheet-backdrop--out")) return;
  sheet.classList.add("sheet-backdrop--out");
  setTimeout(() => {
    sheet.hidden = true;
    sheet.classList.remove("sheet-backdrop--out");
  }, 300);
  document.body.classList.remove("sheet-open");
}

function closeDeadline() {
  slideSheetAway(document.getElementById("dl-sheet"));
}

async function sendDeadline(payload) {
  const group = activeGroup();
  const res = await fetch(DEADLINE_URL, {
    method: "POST",
    body: JSON.stringify({ initData: tg?.initData || "", group: group.id, ...payload }),
  });
  const body = await res.json().catch(() => ({}));
  if (!body.ok) throw new Error(body.error || "error");
  notices.deadlines = body.deadlines || [];
}

async function saveDeadlineForm(remove = false) {
  const error = document.getElementById("dl-error");
  const title = document.getElementById("dl-title").value.trim();
  const subject = document.getElementById("dl-subject").value;
  const day = document.getElementById("dl-date").value;
  const time = document.getElementById("dl-time").value;
  const due = time ? `${day}T${time}` : day;
  const shared = dlEditing ? dlEditing.shared : document.getElementById("dl-for-group").checked;
  if (!remove && (!title || !day)) {
    error.textContent = t("Напишите, что сдать, и выберите срок.");
    error.hidden = false;
    return;
  }
  try {
    if (shared) {
      await sendDeadline(remove ? { remove: dlEditing.id } : { id: dlEditing?.id, title, subject, due });
    } else {
      const list = readLocal(personalKey(), []);
      const rest = list.filter((d) => d.id !== dlEditing?.id);
      if (!remove) rest.push({ id: dlEditing?.id || Date.now(), title, subject, due });
      writeLocal(personalKey(), rest);
    }
  } catch {
    error.textContent = t("Не получилось сохранить — проверьте интернет.");
    error.hidden = false;
    return;
  }
  haptic("success");
  closeDeadline();
  renderDeadlines();
}

function showDeadlines() {
  renderDeadlines();
}

function initDeadlines() {
  document.getElementById("dl-add")?.addEventListener("click", () => openDeadline());
  document.getElementById("dl-cancel")?.addEventListener("click", closeDeadline);
  document.getElementById("dl-x")?.addEventListener("click", closeDeadline);
  document.getElementById("dl-save")?.addEventListener("click", () => saveDeadlineForm(false));
  document.getElementById("dl-delete")?.addEventListener("click", () => saveDeadlineForm(true));
  document.getElementById("dl-sheet")?.addEventListener("click", (event) => {
    if (event.target.id === "dl-sheet") closeDeadline();
  });
  for (const chip of document.querySelectorAll("#dl-chips .dl-chip")) {
    chip.addEventListener("click", () => {
      haptic("select");
      document.getElementById("dl-date").value = isoDate(new Date(Date.now() + Number(chip.dataset.days) * 86400000));
      syncDeadlineSheet();
    });
  }
  document.getElementById("dl-date")?.addEventListener("change", syncDeadlineSheet);
  document.getElementById("dl-for-group")?.addEventListener("change", syncDeadlineSheet);
}

/* ---------- Опросы старосты ---------- */
function renderPolls() {
  const box = document.getElementById("polls");
  const menuPoll = document.getElementById("menu-poll");
  if (menuPoll) menuPoll.hidden = !notices.canEdit;
  if (!box) return;
  const polls = notices.polls || [];
  box.replaceChildren(
    ...polls.map((poll) => {
      const card = el("div", `poll${poll.closed ? " poll--closed" : ""}`);
      const total = poll.votes.reduce((a, b) => a + b, 0);
      const voted = poll.mine !== null && poll.mine !== undefined;
      const head = el("div", "poll-head");
      head.append(el("span", "poll-tag", poll.closed ? t("Опрос завершён") : t("Опрос группы")), el("span", "poll-total", t("голосов: {n}", { n: total })));
      card.append(head, el("div", "poll-question", poll.question));
      poll.options.forEach((option, i) => {
        const share = total ? Math.round((poll.votes[i] / total) * 100) : 0;
        const button = el("button", `poll-option${poll.mine === i ? " poll-option--mine" : ""}`);
        button.type = "button";
        button.disabled = poll.closed;
        const fill = el("i", "poll-fill");
        const shown = voted || poll.closed || notices.canEdit;
        const target = shown ? share : 0;
        // Плавно: полоса и число едут от прежнего значения к новому.
        const key = `${poll.id}|${i}`;
        const from = pollShares.has(key) ? pollShares.get(key) : 0;
        pollShares.set(key, target);
        fill.style.width = `${from}%`;
        const label = el("span", "poll-share", shown ? `${from}%` : "");
        button.append(fill, el("span", "poll-label", option), label);
        requestAnimationFrame(() => requestAnimationFrame(() => {
          fill.style.width = `${target}%`;
        }));
        if (shown && from !== target) countTo(label, from, target);
        button.addEventListener("click", () => votePollChoice(poll, poll.mine === i ? null : i));
        card.append(button);
      });
      if (notices.canEdit) {
        const tools = el("div", "poll-tools");
        if (!poll.closed) {
          const close = el("button", "ghost", t("Завершить"));
          close.type = "button";
          close.addEventListener("click", () => managePoll({ close: poll.id }));
          tools.append(close);
        }
        const remove = el("button", "ghost", t("Удалить"));
        remove.type = "button";
        remove.addEventListener("click", () => {
          haptic("light");
          const height = card.offsetHeight;
          card.style.overflow = "hidden";
          card.animate(
            [
              { opacity: 1, transform: "none", height: `${height}px`, marginBottom: "12px" },
              { opacity: 0, transform: "scale(0.96)", height: "0px", marginBottom: "0px", paddingTop: "0px", paddingBottom: "0px" },
            ],
            { duration: 320, easing: "cubic-bezier(0.4, 0, 0.2, 1)", fill: "forwards" }
          ).finished.then(() => managePoll({ remove: poll.id }), () => managePoll({ remove: poll.id }));
        });
        tools.append(remove);
        card.append(tools);
      }
      return card;
    })
  );
}

const pollShares = new Map();

/** Число процентов бежит от старого к новому за полсекунды. */
function countTo(node, from, to) {
  const start = performance.now();
  const step = (now) => {
    const k = Math.min(1, (now - start) / 500);
    const eased = 1 - Math.pow(1 - k, 3);
    node.textContent = `${Math.round(from + (to - from) * eased)}%`;
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

async function votePollChoice(poll, choice) {
  if (!tg?.initData) return;
  haptic("select");
  try {
    const res = await fetch(POLL_VOTE_URL, {
      method: "POST",
      body: JSON.stringify({ initData: tg.initData, group: activeGroup().id, poll: poll.id, choice }),
    });
    const body = await res.json();
    if (body.ok) {
      notices.polls = body.polls || [];
      renderPolls();
    }
  } catch {
    // Не дошло — попробуют ещё раз.
  }
}

async function managePoll(payload) {
  try {
    const res = await fetch(POLL_URL, {
      method: "POST",
      body: JSON.stringify({ initData: tg?.initData || "", group: activeGroup().id, ...payload }),
    });
    const body = await res.json();
    if (!body.ok) throw new Error(body.error);
    notices.polls = body.polls || [];
    renderPolls();
    return true;
  } catch {
    return false;
  }
}

function pollOptionInput(value = "") {
  // Строка варианта: кружок, поле и крестик (крестик — когда вариантов больше двух).
  const row = el("div", "poll-row");
  const input = el("input");
  input.type = "text";
  input.maxLength = 80;
  input.className = "poll-field poll-option-input";
  input.placeholder = t("Вариант ответа");
  input.value = value;
  const remove = el("button", "poll-remove", "×");
  remove.type = "button";
  remove.setAttribute("aria-label", t("Удалить"));
  remove.addEventListener("click", () => {
    row.remove();
    syncPollRows();
  });
  row.append(el("span", "poll-dot"), input, remove);
  return row;
}

function syncPollRows() {
  const rows = [...document.querySelectorAll("#poll-options .poll-row")];
  rows.forEach((row) => row.classList.toggle("poll-row--fixed", rows.length <= 2));
  const more = document.getElementById("poll-more");
  if (more) more.hidden = rows.length >= 6;
}

function openPollSheet() {
  document.getElementById("poll-question").value = "";
  document.getElementById("poll-options").replaceChildren(pollOptionInput(), pollOptionInput());
  syncPollRows();
  document.getElementById("poll-error").hidden = true;
  document.getElementById("poll-sheet").hidden = false;
  document.body.classList.add("sheet-open");
}

function closePollSheet() {
  slideSheetAway(document.getElementById("poll-sheet"));
}

function initPolls() {
  document.getElementById("poll-more")?.addEventListener("click", () => {
    const box = document.getElementById("poll-options");
    if (box.children.length < 6) {
      const row = pollOptionInput();
      box.append(row);
      syncPollRows();
      row.querySelector("input").focus();
    }
  });
  document.getElementById("poll-cancel")?.addEventListener("click", closePollSheet);
  document.getElementById("poll-x")?.addEventListener("click", closePollSheet);
  document.getElementById("poll-sheet")?.addEventListener("click", (event) => {
    if (event.target.id === "poll-sheet") closePollSheet();
  });
  document.getElementById("poll-save")?.addEventListener("click", async () => {
    const question = document.getElementById("poll-question").value.trim();
    const options = [...document.querySelectorAll(".poll-option-input")].map((i) => i.value.trim()).filter(Boolean);
    const error = document.getElementById("poll-error");
    if (!question || options.length < 2) {
      error.textContent = t("Нужен вопрос и хотя бы два варианта.");
      error.hidden = false;
      return;
    }
    const ok = await managePoll({ question, options });
    if (!ok) {
      error.textContent = t("Не получилось опубликовать — проверьте интернет.");
      error.hidden = false;
      return;
    }
    haptic("success");
    closePollSheet();
    openTab("schedule");
  });
}

/* ---------- Фото доски ----------
 * Фото привязаны к паре и дате и хранятся только в этом телефоне (IndexedDB).
 * На сервер ничего не уходит.
 */
const PHOTO_DB = "schedule-photos";
let photoViewing = null;

function photoDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(PHOTO_DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore("photos", { keyPath: "id", autoIncrement: true }).createIndex("lesson", "lesson");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function photoStore(mode) {
  const db = await photoDb();
  return db.transaction("photos", mode).objectStore("photos");
}

async function photosFor(lesson) {
  try {
    const store = await photoStore("readonly");
    return await new Promise((resolve) => {
      const req = store.index("lesson").getAll(lesson);
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    });
  } catch {
    return [];
  }
}

/** Ужимаем фото до 1600 px по длинной стороне — память телефона не резиновая. */
function shrinkPhoto(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      canvas.toBlob((blob) => resolve(blob || file), "image/jpeg", 0.82);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(file);
    };
    img.src = url;
  });
}

function boardPhotos(card) {
  const lesson = `${activeGroup()?.id || ""}|${card.dataset.subject}|${isoDate(dateOfDay(selectedDay))}`;
  const box = el("div", "board");
  const strip = el("div", "board-strip");
  const input = el("input");
  input.type = "file";
  input.accept = "image/*";
  input.hidden = true;
  const add = el("button", "lv-action", t("📷 Добавить фото"));
  add.type = "button";
  add.addEventListener("click", () => input.click());
  const fill = async () => {
    const photos = await photosFor(lesson);
    strip.replaceChildren(
      ...photos.map((p) => {
        const url = URL.createObjectURL(p.blob);
        const thumb = el("button", "board-thumb");
        thumb.type = "button";
        thumb.style.backgroundImage = `url(${url})`;
        thumb.addEventListener("click", () => openPhoto(p, url, fill));
        return thumb;
      })
    );
    strip.hidden = !photos.length;
  };
  input.addEventListener("change", async () => {
    for (const file of input.files || []) {
      const blob = await shrinkPhoto(file);
      try {
        const store = await photoStore("readwrite");
        store.add({ lesson, blob, added: Date.now() });
      } catch {
        // Без хранилища (приватный режим) — фото не сохранится.
      }
    }
    input.value = "";
    haptic("success");
    setTimeout(fill, 150);
  });
  box.append(strip, add, input, el("p", "hint", t("Фото хранятся только в вашем телефоне.")));
  fill();
  return box;
}

function openPhoto(photo, url, refresh) {
  photoViewing = { photo, refresh };
  document.getElementById("photo-img").src = url;
  document.getElementById("photo-view").hidden = false;
}

function initPhotos() {
  document.getElementById("photo-close")?.addEventListener("click", () => {
    document.getElementById("photo-view").hidden = true;
  });
  document.getElementById("photo-delete")?.addEventListener("click", async () => {
    if (!photoViewing) return;
    try {
      const store = await photoStore("readwrite");
      store.delete(photoViewing.photo.id);
    } catch {
      // нечего удалять
    }
    document.getElementById("photo-view").hidden = true;
    setTimeout(() => photoViewing?.refresh(), 150);
  });
}

/* ---------- Фон на выбор ----------
 * Живой градиент, узор или небо по времени суток на весь экран. Выбор
 * хранится только в памяти телефона. Слой фона лежит под содержимым и
 * не мешает темам: у них свои цвета карточек и акцента.
 */
const BG_KEY = "schedule.bg";
let bgLayer = null;

function bgChoice() {
  try {
    return localStorage.getItem(BG_KEY) || "";
  } catch {
    return "";
  }
}

function applyBackground() {
  // Фоны на выбор убраны: оформление одно — живой градиент в тон акцента,
  // как обои у iPhone. Небо по времени суток — галочкой, поверх.
  const choice = "mesh";
  const [kind, variant = ""] = choice.split(":");
  document.body.dataset.bg = kind || "";
  document.body.dataset.bgVariant = variant;
  if (!bgLayer) {
    bgLayer = el("div", "bg-layer");
    bgLayer.setAttribute("aria-hidden", "true");
    // Три пятна — для живого градиента; узорам и небу они не мешают.
    for (let i = 1; i <= 3; i++) bgLayer.append(el("span", `bg-blob bg-blob--${i}`));
    document.body.prepend(bgLayer);
  }
  const pick = document.getElementById("bg-pick");
  if (pick && pick.value !== choice) pick.value = choice;
}

function applyDecor() {
  const on = decorOn();
  document.body.dataset.decor = on ? "on" : "off";
  if (!skyLayer) {
    skyLayer = el("div", "daysky");
    skyLayer.setAttribute("aria-hidden", "true");
    buildSky(skyLayer);
    document.body.prepend(skyLayer);
  }
  document.body.dataset.daypart = daypart();
  placeSky();
  // Гирлянда — в декабре, над датой.
  const december = new Date().getMonth() === 11;
  if (on && december && !garland) {
    garland = el("div", "garland");
    garland.setAttribute("aria-hidden", "true");
    for (let i = 0; i < 14; i++) {
      const bulb = el("i");
      bulb.style.setProperty("--i", i);
      garland.append(bulb);
    }
    (document.querySelector(".date") || els.days)?.before(garland);
  }
  if (garland) garland.hidden = !(on && december);
  renderSeason();
}

/** Частицы сезона — только на свободном дне и только если не просили тишины. */
function renderSeason() {
  const free = Boolean(els.lessons?.querySelector(".free-day"));
  const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const kind = season();
  const show = decorOn() && free && !calm && kind !== "summer";
  if (!show) {
    seasonLayer?.remove();
    seasonLayer = null;
    return;
  }
  if (seasonLayer?.dataset.kind === kind) return;
  seasonLayer?.remove();
  seasonLayer = el("div", `season season--${kind}`);
  seasonLayer.dataset.kind = kind;
  seasonLayer.setAttribute("aria-hidden", "true");
  const glyphs = { autumn: ["🍂", "🍁", "🍂"], winter: ["❄", "❅", "❆"], spring: ["🌸", "🌼", "🌸"] }[kind];
  for (let i = 0; i < 9; i++) {
    const bit = el("span", "season-bit", glyphs[i % glyphs.length]);
    bit.style.left = `${(i * 37 + 7) % 96}%`;
    bit.style.setProperty("--d", `${(i * 1.7) % 9}s`);
    bit.style.setProperty("--t", `${11 + (i % 4) * 2.5}s`);
    bit.style.setProperty("--s", `${0.75 + (i % 3) * 0.2}`);
    bit.style.setProperty("--x", `${(i % 2 ? 1 : -1) * (18 + (i % 3) * 10)}px`);
    seasonLayer.append(bit);
  }
  document.body.append(seasonLayer);
}

/* ---------- Карточка пары раскрывается ----------
 * Контейнерный переход, как в iOS. Всё движение — только сдвиги, масштаб
 * и прозрачность: их iPhone проигрывает видеочипом, без перерисовки
 * экрана в каждом кадре.
 *  - фон окна — пустая подложка: растёт из карточки масштабом, углы
 *    пересчитываются под масштаб и не сплющиваются;
 *  - сама карточка (её копия) едет только сдвигом — шрифты и переносы
 *    не меняются, прыгать нечему;
 *  - подробности проявляются, когда окно уже раскрылось.
 * На время полёта карточка — в отдельном слое поверх всего; в покое она
 * переезжает в окно на то же место, пиксель в пиксель.
 */
let lessonView = null;

/** Открыта карточка пары или ещё идёт анимация её закрытия. */
function lessonViewBusy() {
  return Boolean(lessonView || document.querySelector(".lv-group"));
}
let lessonCard = null;
const VIEW_EASE = "cubic-bezier(0.32, 0.72, 0, 1)";
const OPEN_MS = 460;
const CLOSE_MS = 380;
const PANEL_RADIUS = 26;

/** Прямоугольник окна: отступы от краёв экрана. */
function panelRect() {
  const top = Math.max(48, Math.round(innerHeight * 0.08));
  const bottom = Math.round(innerHeight * 0.06);
  return { left: 12, top, width: innerWidth - 24, height: innerHeight - top - bottom };
}

/** Масштаб и сдвиг подложки, чтобы она совпала с прямоугольником rect. */
function surfaceFrame(rect, panel, radius) {
  const sx = rect.width / panel.width;
  const sy = rect.height / panel.height;
  return {
    transform: `translate(${rect.left - panel.left}px, ${rect.top - panel.top}px) scale(${sx}, ${sy})`,
    // Углы — в масштабе подложки, чтобы после масштаба остались круглыми.
    borderRadius: `${radius / sx}px / ${radius / sy}px`,
  };
}

function viewSection(title, ...children) {
  const box = el("section", "lv-section");
  box.append(el("h3", "lv-section-title", title), ...children.filter(Boolean));
  return box;
}

/** Дождаться конца анимации; если сигнал не придёт — подстраховка с запасом. */
function whenDone(animation, ms, fn) {
  let fired = false;
  const run = () => {
    if (fired) return;
    fired = true;
    fn();
  };
  animation?.finished?.then(run, run);
  setTimeout(run, ms + 600);
}

function openLessonView(card) {
  const subject = card.dataset.subject;
  if (!subject || lessonView) return;
  const slots = cardSlots(card);
  const entries = visible.filter((l) => l.subject === subject && slots.includes(l.slot));
  if (!entries.length) return;
  lessonCard = card;
  const r = card.getBoundingClientRect();
  const panel = panelRect();
  const radius = parseFloat(getComputedStyle(card).borderTopLeftRadius) || 18;

  const dim = el("div", "lv-dim");
  const group = el("div", "lv-group");
  const surface = el("div", "lv-surface");
  const scroller = el("div", "lv-scroll");
  scroller.setAttribute("role", "dialog");
  scroller.setAttribute("aria-modal", "true");
  for (const node of [surface, scroller]) {
    Object.assign(node.style, {
      left: `${panel.left}px`,
      top: `${panel.top}px`,
      width: `${panel.width}px`,
      height: `${panel.height}px`,
    });
  }

  const bar = el("div", "lv-bar");
  const back = el("button", "lv-back", `‹ ${t("Назад")}`);
  back.type = "button";
  back.addEventListener("click", closeLessonView);
  bar.append(back);

  // Место карточки в окне. Ширина — как у карточки в расписании.
  const slot = el("div", "lv-slot");
  slot.style.height = `${r.height}px`;
  const head = card.cloneNode(true);
  head.classList.add("lv-head");
  head.inert = true;
  head.setAttribute("aria-hidden", "true");
  head.style.width = `${r.width}px`;

  const sections = [];

  // Домашка — первой: за ней чаще всего и открывают пару.
  const items = homeworkFor(card);
  const hw = el("div", "lv-hw");
  if (items.length) {
    for (const item of items) {
      const line = el("div", "lv-hw-item");
      const prefix = item.subgroup ? `${t("гр. {n}", { n: item.subgroup })}: ` : "";
      line.textContent = prefix + item.text;
      hw.append(line);
    }
  } else {
    hw.append(el("div", "lv-empty", t("Домашки пока нет")));
  }
  let hwButton = null;
  if (notices.canEdit && els.hwSheet) {
    hwButton = el("button", "lv-action", items.length ? t("Изменить ДЗ") : t("＋ ДЗ"));
    hwButton.type = "button";
    hwButton.addEventListener("click", () => {
      closeLessonView(true);
      openHomework(card);
    });
  }
  sections.push(viewSection(t("Домашка"), hw, hwButton));

  if (notices.canComment && els.cmSheet) {
    const count = notices.comments.get(commentKey(isoDate(dateOfDay(selectedDay)), subject)) || 0;
    const open = el("button", "lv-action", count ? t("Открыть комментарии ({n})", { n: count }) : t("Написать комментарий"));
    open.type = "button";
    open.addEventListener("click", () => {
      closeLessonView(true);
      openComments(card);
    });
    sections.push(viewSection(t("Комментарии группы"), open));
  }

  const people = [...new Map(entries.flatMap((l) => teachersOf(l.teacher)).map((x) => [x.key, x])).values()];
  if (people.length) {
    const list = el("div", "lv-list");
    for (const person of people) {
      const line = el("div", "lv-person");
      line.append(el("div", "lv-strong", teacherFull(person.key) || person.key));
      if (person.title) line.append(el("div", "lv-muted", person.title));
      const email = TEACHER_EMAILS[person.key];
      if (email) {
        const link = el("a", "lv-link", email);
        link.href = `mailto:${email}`;
        line.append(link);
      }
      list.append(line);
    }
    sections.push(viewSection(people.length > 1 ? t("Преподаватели") : t("Преподаватель"), list));
  }

  const rooms = [...new Set(entries.map((l) => l.room).filter(Boolean))];
  if (rooms.length) {
    const list = el("div", "lv-list");
    for (const room of rooms) {
      const line = el("div", "lv-room");
      line.append(el("span", "lv-strong", roomLabel(room)));
      if (!REMOTE_ROOMS.includes(room.toLowerCase())) {
        const map = el("button", "lv-chip", t("Где это"));
        map.type = "button";
        map.addEventListener("click", () => {
          closeLessonView(true);
          openRoomMap(room);
        });
        line.append(map);
      }
      list.append(line);
    }
    sections.push(viewSection(t("Аудитория"), list));
  }

  const subs = [...new Set(entries.map((l) => l.subgroup).filter(Boolean))];
  if (subs.length) sections.push(viewSection(t("Подгруппы"), el("div", "lv-text", subs.join(", "))));
  const notes = [...new Set(entries.map((l) => l.note).filter(Boolean))];
  if (notes.length) sections.push(viewSection(t("Примечание"), el("div", "lv-text", notes.map(trNote).join("; "))));

  const mine = noteOf(dateOfDay(selectedDay), Number(card.dataset.slot), subject);
  const pen = el("button", "lv-action lv-action--soft", mine ? t("Изменить заметку") : t("Добавить заметку"));
  pen.type = "button";
  pen.addEventListener("click", () => {
    closeLessonView(true);
    openNote(card);
  });
  sections.push(viewSection(t("Моя заметка"), mine ? el("div", "lv-text", mine) : null, pen));
  // «Важно для меня» — теперь только здесь, со звёздочек на карточках убрали.
  const day = dateOfDay(selectedDay);
  const star = el("button", "lv-action lv-action--soft", isMine(subject, day) ? t("★ Важно для меня — снять") : t("☆ Отметить как важное"));
  star.type = "button";
  star.addEventListener("click", () => {
    toggleMine(subject, day);
    const on = isMine(subject, day);
    haptic(on ? "success" : "light");
    star.textContent = on ? t("★ Важно для меня — снять") : t("☆ Отметить как важное");
    applyMine();
  });
  sections.push(viewSection(t("Важно для меня"), star));
  sections.push(viewSection(t("Фото доски"), boardPhotos(card)));
  sections.push(viewSection(t("Цвет предмета"), subjectColorPicker(subject)));

  const rest = el("div", "lv-sections");
  rest.append(...sections);
  scroller.append(bar, slot, rest);
  group.append(surface, scroller);
  document.body.append(dim, group);
  // Карточка в окне — по центру, как в расписании относительно экрана.
  slot.style.marginLeft = `${r.left - panel.left}px`;
  slot.style.width = `${r.width}px`;

  lessonView = { dim, group, surface, scroller, head, slot, chrome: [bar, rest], panel, radius };
  dim.addEventListener("click", closeLessonView);
  dragToClose(lessonView);

  // Системная «назад» в Telegram закрывает подробности, а свайп вниз не
  // сворачивает приложение, пока окно открыто.
  if (tg?.BackButton) {
    tg.BackButton.onClick(closeLessonView);
    tg.BackButton.show();
  }
  try {
    tg?.disableVerticalSwipes?.();
  } catch {
    // Старый Telegram без этой возможности.
  }

  const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (calm) {
    slot.append(head);
    return;
  }

  // Полёт: копия карточки — в своём слое поверх окна, от места карточки
  // до места в окне.
  const s = slot.getBoundingClientRect();
  Object.assign(head.style, { position: "fixed", left: `${s.left}px`, top: `${s.top}px`, margin: "0", zIndex: "1002" });
  document.body.append(head);
  card.style.visibility = "hidden";

  const timing = { duration: OPEN_MS, easing: VIEW_EASE };
  const fly = head.animate(
    [{ transform: `translate(${r.left - s.left}px, ${r.top - s.top}px)` }, { transform: "translate(0px, 0px)" }],
    timing
  );
  const from = surfaceFrame(r, panel, radius);
  surface.animate([from, { transform: "none", borderRadius: `${PANEL_RADIUS}px` }], timing);
  dim.animate([{ opacity: 0 }, { opacity: 1 }], { duration: OPEN_MS * 0.8, easing: "ease-out" });
  for (const part of [bar, rest]) {
    part.animate([{ opacity: 0, transform: "translateY(16px)" }, { opacity: 1, transform: "translateY(0px)" }], {
      duration: OPEN_MS - 80,
      delay: 140,
      easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
      fill: "backwards",
    });
  }
  whenDone(fly, OPEN_MS, () => {
    // В покое карточка — внутри окна, на том же месте: листается вместе с ним.
    if (lessonView?.head !== head || head.parentNode !== document.body) return;
    Object.assign(head.style, { position: "", left: "", top: "", margin: "", zIndex: "" });
    slot.append(head);
    card.style.visibility = "";
  });
}

/**
 * Свайп вниз закрывает окно, как на iPhone: из самого верха окно едет за
 * пальцем, затемнение светлеет. Отпустили далеко или резко — окно
 * сворачивается обратно в карточку, чуть-чуть — мягко возвращается.
 */
function dragToClose(view) {
  const { scroller, group, dim } = view;
  let startY = 0;
  let startTime = 0;
  let shift = 0;
  let armed = false;
  let dragging = false;
  scroller.addEventListener("touchstart", (event) => {
    armed = scroller.scrollTop <= 0;
    dragging = false;
    shift = 0;
    startY = event.touches[0].clientY;
    startTime = performance.now();
  }, { passive: true });
  scroller.addEventListener("touchmove", (event) => {
    if (!armed) return;
    const dy = event.touches[0].clientY - startY;
    // С первого же движения вниз: иначе iPhone начинает сам «пружинить».
    if (!dragging && (dy <= 0 || scroller.scrollTop > 0)) {
      if (dy < 0) armed = false;
      return;
    }
    dragging = true;
    event.preventDefault();
    shift = Math.max(0, dy * 0.75);
    group.style.transform = `translateY(${shift}px)`;
    dim.style.opacity = String(Math.max(0.15, 1 - shift / 420));
  }, { passive: false });
  scroller.addEventListener("touchend", () => {
    if (!dragging) return;
    dragging = false;
    const speed = shift / Math.max(1, performance.now() - startTime);
    if (shift > 110 || speed > 0.55) {
      closeLessonView();
      return;
    }
    group.animate([{ transform: `translateY(${shift}px)` }, { transform: "translateY(0px)" }], {
      duration: 320,
      easing: "cubic-bezier(0.34, 1.3, 0.5, 1)",
    });
    group.style.transform = "";
    dim.style.opacity = "";
  });
  // Запасной путь: iPhone утянул содержимое вниз за верхний край.
  scroller.addEventListener("scroll", () => {
    if (scroller.scrollTop < -50 && lessonView === view) closeLessonView();
  }, { passive: true });
}

function closeLessonView(instant = false) {
  const view = lessonView;
  if (!view) return;
  // Место карточки — самым первым делом, до любых изменений.
  const card = lessonCard && document.body.contains(lessonCard) ? lessonCard : null;
  const r = card?.getBoundingClientRect();
  lessonView = null;
  if (tg?.BackButton) {
    tg.BackButton.offClick(closeLessonView);
    tg.BackButton.hide();
  }
  try {
    tg?.enableVerticalSwipes?.();
  } catch {
    // Старый Telegram без этой возможности.
  }
  const { dim, group, surface, scroller, head, panel, radius } = view;
  const finish = () => {
    if (card) card.style.visibility = "";
    dim.remove();
    group.remove();
    head.remove();
  };
  if (instant === true || !card || !r || !r.height || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    finish();
    return;
  }
  haptic("light");
  group.style.pointerEvents = "none";
  dim.style.pointerEvents = "none";

  // Сдвиг от свайпа: окно стартует оттуда, где его отпустили.
  const shift = Number((group.style.transform.match(/-?[\d.]+/) || [0])[0]) || 0;
  // Карточка — снова в свой слой поверх всего, ровно на том месте, где она сейчас.
  const h = head.getBoundingClientRect();
  Object.assign(head.style, { position: "fixed", left: `${h.left}px`, top: `${h.top}px`, width: `${h.width}px`, margin: "0", zIndex: "1002" });
  document.body.append(head);
  card.style.visibility = "hidden";

  const timing = { duration: CLOSE_MS, easing: VIEW_EASE, fill: "forwards" };
  const fly = head.animate(
    [{ transform: "translate(0px, 0px)" }, { transform: `translate(${r.left - h.left}px, ${r.top - h.top}px)` }],
    timing
  );
  // Подложку меряем без сдвига свайпа: сдвиг входит в первый кадр.
  group.style.transform = "";
  const start = { transform: `translate(0px, ${shift}px)`, borderRadius: `${PANEL_RADIUS}px` };
  surface.animate([start, surfaceFrame(r, panel, radius)], timing);
  scroller.animate([{ opacity: 1, transform: `translateY(${shift}px)` }, { opacity: 0, transform: `translateY(${shift}px)` }], {
    duration: CLOSE_MS * 0.35,
    easing: "ease-out",
    fill: "forwards",
  });
  dim.animate([{ opacity: Number(dim.style.opacity || 1) }, { opacity: 0 }], { duration: CLOSE_MS, easing: "ease-out", fill: "forwards" });
  whenDone(fly, CLOSE_MS, finish);
}

/* ---------- Заготовки, пока грузится расписание ---------- */
function renderSkeleton() {
  if (!els.lessons || els.lessons.children.length) return;
  const nodes = [];
  for (let i = 0; i < 3; i++) {
    const card = el("div", "skeleton");
    card.append(el("span", "skeleton-time"), el("span", "skeleton-lines"));
    nodes.push(card);
  }
  els.lessons.replaceChildren(...nodes);
}

/** Прогресс идущей пары кольцом рядом с «осталось». */
function setNowRing(badge, part) {
  let ring = badge.querySelector(".now-ring");
  if (!ring) {
    ring = el("span", "now-ring");
    badge.querySelector(".now-left")?.before(ring);
  }
  ring.style.setProperty("--p", Math.min(1, Math.max(0, part)).toFixed(3));
}

/* ---------- Подписка в календаре телефона ---------- */

let calendarSheet = null;

/** Ссылка на расписание группы в формате календаря — с выбранными языками и курсами. */
function calendarUrl() {
  // Преподаватель — его пары на всех факультетах вуза, как в приложении.
  if (prefs.teacher) return `${API_URL}/ics/${tenantId()}/teacher/${encodeURIComponent(prefs.teacher)}.ics`;
  const group = groupById(prefs.group);
  if (!group) return "";
  const id = tenantId();
  const raw = id === DEFAULT_TENANT ? group.id : group.id.slice(id.length + 1);
  const keep = {};
  for (const name of ["main", "mainGroup", "lang2", "lang2Group", "lang3", "military", "rki", "mfkSlot"]) {
    if (prefs[name] != null && prefs[name] !== "") keep[name] = prefs[name];
  }
  if (prefs.electives?.length) keep.electives = prefs.electives;
  if (mfkAvailable() && prefs.mfk?.length) keep.mfk = prefs.mfk;
  const json = JSON.stringify(keep);
  const query = json === "{}" ? "" : `?f=${btoa(String.fromCharCode(...new TextEncoder().encode(json))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
  return `${API_URL}/ics/${id}/${encodeURIComponent(raw)}.ics${query}`;
}

function openOutside(url) {
  if (tg?.openLink) tg.openLink(url);
  else window.open(url, "_blank");
}

function openCalendar() {
  if (!data) return;
  if (!calendarSheet) {
    calendarSheet = el("div", "sheet-backdrop");
    calendarSheet.hidden = true;
    const sheet = el("div", "sheet sheet--abs sheet--calendar");
    sheet.setAttribute("role", "dialog");
    sheet.setAttribute("aria-modal", "true");
    const top = el("div", "sheet-top");
    const close = el("button", "icon", "×");
    close.type = "button";
    close.setAttribute("aria-label", t("Закрыть"));
    close.addEventListener("click", closeCalendar);
    top.append(el("h2", "", t("В календарь телефона")), close);
    sheet.append(top, el("div", "cal-body"));
    calendarSheet.append(sheet);
    calendarSheet.addEventListener("click", (event) => {
      if (event.target === calendarSheet) closeCalendar();
    });
    document.body.append(calendarSheet);
  }
  renderCalendar();
  calendarSheet.classList.remove("sheet-backdrop--out");
  calendarSheet.hidden = false;
}

function closeCalendar() {
  const sheet = calendarSheet;
  if (!sheet || sheet.hidden || sheet.classList.contains("sheet-backdrop--out")) return;
  haptic("light");
  sheet.classList.add("sheet-backdrop--out");
  setTimeout(() => {
    sheet.hidden = true;
    sheet.classList.remove("sheet-backdrop--out");
  }, 260);
}

function renderCalendar() {
  const body = calendarSheet.querySelector(".cal-body");
  const url = calendarUrl();
  if (!url) {
    body.replaceChildren(el("p", "hint", t("Календарь пока собирается только для группы студента. Выберите группу в настройках.")));
    return;
  }
  const button = (label, action) => {
    const node = el("button", "cal-btn", label);
    node.type = "button";
    node.addEventListener("click", () => {
      haptic("light");
      action(node);
    });
    return node;
  };
  const google = button(t("Google Календарь (Android)"), () =>
    openOutside(`https://calendar.google.com/calendar/r?cid=${encodeURIComponent(url.replace(/^https:/, "webcal:"))}`)
  );
  // Telegram открывает только http(s) — сервер перенаправит на webcal://,
  // и iPhone сам предложит подписаться.
  const apple = button(t("iPhone и Mac"), () => openOutside(`${url}${url.includes("?") ? "&" : "?"}open=1`));
  const copy = button(t("Скопировать ссылку"), async (node) => {
    let done = false;
    try {
      await navigator.clipboard.writeText(url);
      done = true;
    } catch {
      const field = document.createElement("textarea");
      field.value = url;
      field.style.position = "fixed";
      field.style.opacity = "0";
      document.body.append(field);
      field.select();
      try {
        done = document.execCommand("copy");
      } catch {
        done = false;
      }
      field.remove();
    }
    const was = node.dataset.label || node.textContent;
    node.dataset.label = was;
    node.textContent = done ? t("Ссылка скопирована") : url;
    if (done) setTimeout(() => (node.textContent = was), 2500);
  });
  copy.classList.add("cal-btn--plain");
  body.replaceChildren(
    el("p", "", t("Пары появятся в обычном календаре — рядом с остальными делами и в его виджете на главном экране. Календарь сам обновляет их несколько раз в день.")),
    google,
    apple,
    copy,
    el("p", "hint", t("Яндекс, Outlook и другие: «Добавить календарь по ссылке» — вставьте скопированную ссылку. Учтены ваши языки, курсы по выбору и МФК, а отмены и замены появляются в календаре сами.")),
    el("p", "hint", prefs.teacher
      ? t("В ссылке только факультет и фамилия из расписания — без Telegram.")
      : t("В ссылке только факультет, группа и выбранные предметы — без имени и Telegram."))
  );
}

function lessonsOf(groupId) {
  return data.lessons.filter((l) => l.group === groupId);
}

function subgroupsOf(groupId, subject) {
  return [
    ...new Set(
      lessonsOf(groupId)
        .filter((l) => l.subject === subject && l.subgroup)
        .map((l) => l.subgroup)
    ),
  ].sort((a, b) => a - b);
}

/* ---------- Экран настройки ---------- */

/** «1 курс» бакалавриата и магистратуры — разные вещи, поэтому ключ общий. */
function courseKey(group) {
  return `${group.level}|${group.course}`;
}

function courseTitle(group) {
  return group.level === "магистратура"
    ? t("{n} курс магистратуры", { n: group.course })
    : t("{n} курс", { n: group.course });
}

function fillCourses() {
  const seen = new Map();
  for (const group of data.groups) {
    if (!seen.has(courseKey(group))) seen.set(courseKey(group), group);
  }
  els.course.replaceChildren(
    ...[...seen].map(([key, group]) => new Option(courseTitle(group), key))
  );

  const saved = prefs.group && groupById(prefs.group);
  if (saved) els.course.value = courseKey(saved);
  fillGroups();
}

function fillGroups() {
  const key = els.course.value;
  const groups = data.groups.filter((g) => courseKey(g) === key);
  els.group.replaceChildren(...groups.map((g) => new Option(g.title, g.id)));
  if (prefs.group && groups.some((g) => g.id === prefs.group)) {
    els.group.value = prefs.group;
  }
  fillLanguages();
}

function fillLanguages() {
  const groupId = els.group.value;
  const subjects = [...new Set(lessonsOf(groupId).map((l) => l.subject))];

  // Основной язык: студент ходит либо на английский, либо на русский.
  const mains = MAIN_LANGS.filter((name) => subjects.includes(name));
  els.mainRow.hidden = mains.length === 0;
  if (mains.length) {
    els.main.replaceChildren(
      new Option(t("не выбран — показывать все"), ANY),
      ...mains.map((s) => new Option(withFlag(s), s))
    );
    els.main.value = mains.includes(prefs.main) ? prefs.main : ANY;
  }
  fillMainSubgroups();

  const second = subjects.filter((s) => LANG2.test(s)).sort();
  els.lang2Row.hidden = second.length === 0;
  if (second.length) {
    els.lang2.replaceChildren(
      new Option(t("не выбран — показывать все"), ANY),
      ...second.map((s) => new Option(withFlag(s), s))
    );
    els.lang2.value = second.includes(prefs.lang2) ? prefs.lang2 : ANY;
  }

  // Третий язык берут вдобавок ко второму, поэтому спрашиваем отдельно.
  // По умолчанию его не показываем: ходят на него единицы.
  const third = subjects.filter((s) => LANG3.test(s)).sort();
  els.lang3Row.hidden = third.length === 0;
  if (third.length) {
    els.lang3.replaceChildren(
      new Option(t("не хожу"), ANY),
      ...third.map((s) => new Option(withFlag(s), s))
    );
    els.lang3.value = third.includes(prefs.lang3) ? prefs.lang3 : ANY;
  }

  // Военную кафедру спрашиваем только там, где она есть в расписании.
  if (els.militaryRow) {
    els.militaryRow.hidden = !subjects.some((s) => MILITARY.test(s));
    els.military.value = prefs.military === "no" ? "no" : "";
  }
  if (els.rkiRow) {
    els.rkiRow.hidden = !subjects.some((s) => RKI.test(s));
    els.rki.value = prefs.rki === "yes" ? "yes" : "";
  }
  if (els.mfkSlotRow) {
    els.mfkSlotRow.hidden = !subjects.some((s) => isMfkSlot(s));
    els.mfkSlot.value = prefs.mfkSlot === "no" ? "no" : "";
  }

  fillLang2Subgroups();
  fillElectives();
  fillPairs();
}

/* ---------- Мои пары ----------
   У многих факультетов в одно время у группы стоит несколько карточек: язык
   у разных преподавателей, курсы по выбору. В данных это никак не помечено,
   поэтому находим такие места сами и даём выбрать своё. У ФГП свои настройки
   (язык, подгруппа, дисциплины по выбору) — его не трогаем. */

/** Пара уже разобрана другими настройками — её в «Мои пары» не берём. */
function pairHandled(lesson) {
  return Boolean(lesson.elective || lesson.subgroup || LANG2.test(lesson.subject) || LANG3.test(lesson.subject) || MILITARY.test(lesson.subject));
}

function overlaps(a, b) {
  if (a.day !== b.day || a.slot !== b.slot) return false;
  if (a.week !== "all" && b.week !== "all" && a.week !== b.week) return false;
  if (a.dates?.length && b.dates?.length) {
    const mine = new Set(a.dates);
    return b.dates.some((day) => mine.has(day));
  }
  return true;
}

let parallelCache = { key: "", sets: [] };

/** Наборы пар группы, идущих в одно время (больше одной карточки). */
function parallelSets(groupId) {
  const key = `${tenantId()}|${groupId}|${data.lessons.length}`;
  if (parallelCache.key === key) return parallelCache.sets;
  let sets = [];
  if (tenantId() !== "msu-fgp") {
    const list = lessonsOf(groupId).filter((l) => !pairHandled(l));
    const parent = list.map((_, i) => i);
    const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        if (overlaps(list[i], list[j])) parent[find(i)] = find(j);
      }
    }
    const groups = new Map();
    list.forEach((lesson, i) => {
      const root = find(i);
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root).push(lesson);
    });
    sets = [...groups.values()].filter((set) => set.length > 1);
  }
  parallelCache = { key, sets };
  return sets;
}

/** Что можно выбрать: предметы, идущие в одно время, и преподаватели одного предмета. */
function pairChoices(groupId) {
  const subjects = new Set();
  const teachers = new Map();
  for (const set of parallelSets(groupId)) {
    const names = new Set(set.map((l) => l.subject));
    if (names.size > 1) names.forEach((name) => subjects.add(name));
    for (const name of names) {
      const who = new Set(set.filter((l) => l.subject === name && l.teacher).map((l) => l.teacher));
      if (who.size > 1) {
        if (!teachers.has(name)) teachers.set(name, new Set());
        who.forEach((person) => teachers.get(name).add(person));
      }
    }
  }
  return { subjects: [...subjects].sort(), teachers };
}

let hiddenCache = { key: "", hidden: new Set() };

/** Пары, которые студент скрыл выбором в «Моих парах». */
function pairsHidden() {
  const group = prefs?.group;
  const pick = prefs?.pick?.group === group ? prefs.pick : null;
  const key = `${tenantId()}|${group}|${data?.lessons?.length}|${JSON.stringify(pick)}`;
  if (hiddenCache.key === key) return hiddenCache.hidden;
  const hidden = new Set();
  if (pick && group) {
    const wanted = new Set(pick.subjects || []);
    const teachers = pick.teachers || {};
    for (const set of parallelSets(group)) {
      let keep = set;
      if (wanted.size && new Set(set.map((l) => l.subject)).size > 1) {
        const mine = keep.filter((l) => wanted.has(l.subject));
        if (mine.length) keep = mine;
      }
      for (const [subject, teacher] of Object.entries(teachers)) {
        if (keep.some((l) => l.subject === subject && l.teacher === teacher)) {
          keep = keep.filter((l) => l.subject !== subject || l.teacher === teacher);
        }
      }
      const kept = new Set(keep);
      set.forEach((lesson) => kept.has(lesson) || hidden.add(lesson));
    }
  }
  hiddenCache = { key, hidden };
  return hidden;
}

function fillPairs() {
  if (!els.pairsRow) return;
  const groupId = els.group.value;
  const { subjects, teachers } = pairChoices(groupId);
  els.pairsRow.hidden = !subjects.length && !teachers.size;
  if (els.pairsRow.hidden) return;
  const pick = prefs.pick?.group === groupId ? prefs.pick : {};
  const chosen = new Set(pick.subjects || []);
  const nodes = [];
  if (subjects.length) {
    nodes.push(el("p", "hint", t("Предметы в одно время — отметьте свои:")));
    for (const subject of subjects) {
      const row = el("label", "check");
      const box = document.createElement("input");
      box.type = "checkbox";
      box.value = subject;
      box.dataset.pick = "subject";
      box.checked = chosen.has(subject);
      row.append(box, el("span", null, tr(subject)));
      nodes.push(row);
    }
  }
  for (const [subject, who] of [...teachers].sort((a, b) => a[0].localeCompare(b[0], "ru"))) {
    const label = el("label", "pick-teacher");
    label.append(el("span", null, `${tr(subject)} — ${t("ваш преподаватель")}`));
    const select = document.createElement("select");
    select.dataset.pick = "teacher";
    select.dataset.subject = subject;
    select.append(new Option(t("показывать всех"), ""), ...[...who].sort().map((name) => new Option(name, name)));
    select.value = pick.teachers?.[subject] && who.has(pick.teachers[subject]) ? pick.teachers[subject] : "";
    label.append(select);
    nodes.push(label);
  }
  els.pairs.replaceChildren(...nodes);
}

function readPick() {
  if (!els.pairsRow || els.pairsRow.hidden) return null;
  const subjects = [...els.pairs.querySelectorAll('input[data-pick="subject"]:checked')].map((box) => box.value);
  const teachers = {};
  els.pairs.querySelectorAll('select[data-pick="teacher"]').forEach((select) => {
    if (select.value) teachers[select.dataset.subject] = select.value;
  });
  if (!subjects.length && !Object.keys(teachers).length) return null;
  return { group: els.group.value, subjects, teachers };
}

function fillElectives() {
  const subjects = [
    ...new Set(
      lessonsOf(els.group.value)
        .filter((l) => l.elective === ELECTIVE)
        .map((l) => l.subject)
    ),
  ].sort();

  els.electivesRow.hidden = subjects.length === 0;
  if (!subjects.length) return;

  // Настройки предыдущей группы к новой не относятся.
  const chosen = new Set(
    (prefs.electives || []).filter((s) => subjects.includes(s))
  );

  els.electives.replaceChildren(
    ...subjects.map((subject) => {
      const row = el("label", "check");
      const box = document.createElement("input");
      box.type = "checkbox";
      box.value = subject;
      box.checked = chosen.has(subject);
      row.append(box, el("span", null, tr(subject)));
      return row;
    })
  );
}

function fillMainSubgroups() {
  const subject = els.mainRow.hidden ? "" : els.main.value;
  const subgroups = subject ? subgroupsOf(els.group.value, subject) : [];
  // Спрашивать подгруппу, когда она одна, незачем.
  els.mainGroupRow.hidden = subgroups.length < 2;
  if (subgroups.length >= 2) {
    els.mainGroup.replaceChildren(
      new Option(t("показывать все"), ANY),
      ...subgroups.map((n) => new Option(t("гр. {n}", { n }), String(n)))
    );
    els.mainGroup.value = prefs.mainGroup != null ? String(prefs.mainGroup) : ANY;
  }
}

function fillLang2Subgroups() {
  const subject = els.lang2.value;
  const subgroups = subject ? subgroupsOf(els.group.value, subject) : [];
  // Спрашивать подгруппу, когда она одна, незачем.
  els.lang2GroupRow.hidden = subgroups.length < 2;
  if (subgroups.length >= 2) {
    els.lang2Group.replaceChildren(
      new Option(t("показывать все"), ANY),
      ...subgroups.map((n) => new Option(t("гр. {n}", { n }), String(n)))
    );
    els.lang2Group.value = prefs.lang2Group != null ? String(prefs.lang2Group) : ANY;
  }
}

function collectPrefs() {
  const main = els.mainRow.hidden ? "" : els.main.value;
  const lang2 = els.lang2Row.hidden ? "" : els.lang2.value;
  return {
    group: els.group.value,
    main: main || null,
    mainGroup:
      els.mainGroupRow.hidden || !els.mainGroup.value
        ? null
        : Number(els.mainGroup.value),
    lang2: lang2 || null,
    lang2Group:
      els.lang2GroupRow.hidden || !els.lang2Group.value
        ? null
        : Number(els.lang2Group.value),
    lang3: (els.lang3Row.hidden ? "" : els.lang3.value) || null,
    military: els.militaryRow && !els.militaryRow.hidden && els.military.value === "no" ? "no" : null,
    rki: els.rkiRow && !els.rkiRow.hidden && els.rki.value === "yes" ? "yes" : null,
    mfkSlot: els.mfkSlotRow && !els.mfkSlotRow.hidden && els.mfkSlot.value === "no" ? "no" : null,
    electives: [...els.electives.querySelectorAll("input:checked")].map(
      (box) => box.value
    ),
    pick: readPick(),
    // МФК и напоминания отмечают прямо в списке, без кнопки «Сохранить».
    mfk: prefs?.mfk || [],
    remindMorning: Boolean(prefs?.remindMorning),
    remindBefore: Boolean(prefs?.remindBefore),
    remindChanges: prefs?.remindChanges,
    remindWake: Boolean(prefs?.remindWake),
    remindWakeLead: wakeLead(),
    remindAsked: Boolean(prefs?.remindAsked),
  };
}

/** Студент или преподаватель: у преподавателя вместо группы — фамилия. */
function fillRole() {
  if (!els.role) return;
  els.role.value = prefs.teacher ? "teacher" : "student";
  loadTeacherNames().then(() => {
    const keys = allTeachers();
    els.teacher.replaceChildren(
      ...keys.map((key) => new Option(teacherFull(key) ? `${key} — ${teacherFull(key)}` : key, key))
    );
    if (prefs.teacher && keys.includes(prefs.teacher)) els.teacher.value = prefs.teacher;
  });
  applyRole();
}

function applyRole() {
  const teacher = els.role?.value === "teacher";
  els.studentFields.hidden = teacher;
  if (els.teacherRow) els.teacherRow.hidden = !teacher;
}

function showPicker() {
  els.schedule.hidden = true;
  els.week.hidden = true;
  if (els.queues) els.queues.hidden = true;
  document.getElementById("deadlines").hidden = true;
  els.search.hidden = true;
  els.free.hidden = true;
  if (els.tabs) els.tabs.hidden = true;
  els.picker.hidden = false;
  // Возвращаться некуда, пока группа не выбрана хотя бы раз.
  els.close.hidden = !activeGroup();
  fillProfiles();
  fillDigits();
  fillOwnerThemes();
  fillTenants();
  // Межфакультетские курсы — только там, где они есть.
  if (els.mfkRow) els.mfkRow.style.display = mfkAvailable() ? "" : "none";
  fillCourses();
  fillRole();
  fillReminders();
  loadMfk().then(renderMfkPicker);
  renderMfkPicker();
}

/* ---------- Разделы ---------- */

// Какой раздел открыт: today | schedule | week | search. Разделы
// переключает полоса снизу, свободные аудитории остаются внутри расписания.
let tab = "schedule";

const TAB_ORDER = ["schedule", "week", "deadlines", "search", "queues"];

/**
 * Подложка выбранного раздела переезжает к нему, а не появляется на новом
 * месте: так глаз видит, куда ушёл выбор. Ширину берём у самой кнопки —
 * у подписей разная длина, и одинаковая капля смотрелась бы кривой.
 */
/**
 * Нижняя полоса прибита к своему месту на экране. Обычно такие полосы
 * держатся за нижний край окна — и подпрыгивают, когда клавиатура этот край
 * поднимает, а потом съезжают обратно. Мы один раз меряем, где полоса стоит
 * при полном экране, и дальше держим её по расстоянию от верха: клавиатура
 * выезжает поверх, полоса не двигается ни вверх, ни вниз.
 * Перемеряем, только если экран по-настоящему изменился: повернули телефон
 * или окно стало выше, чем было.
 */
const tabsPin = { width: 0, height: 0 };

function pinTabs() {
  const tabs = els.tabs;
  if (!tabs || tabs.hidden || document.body.classList.contains("typing")) return;
  const width = window.innerWidth;
  const height = window.innerHeight;
  // Экран стал ниже при той же ширине — это клавиатура, а не новый экран.
  if (width === tabsPin.width && height <= tabsPin.height) return;
  tabsPin.width = width;
  tabsPin.height = height;
  document.body.classList.remove("tabs-pinned");
  const top = Math.round(tabs.getBoundingClientRect().top);
  document.documentElement.style.setProperty("--tabs-top", `${top}px`);
  document.body.classList.add("tabs-pinned");
}

// Поворот экрана и раскрытие окна Telegram на всю высоту — повод перемерить.
window.addEventListener("resize", pinTabs);
window.addEventListener("orientationchange", () => setTimeout(pinTabs, 300));

function moveDrop(name, animate = true) {
  pinTabs();
  const drop = els.tabsDrop;
  const button = els.tabs?.querySelector(`.tab[data-tab="${name}"]`);
  // Очереди переехали в меню — у них нет кнопки внизу, капля прячется.
  if (drop && !button) drop.classList.remove("tabs-drop--on");
  if (!drop || !button || els.tabs.hidden) return;
  if (!animate) drop.classList.add("tabs-drop--still");
  // Место капли — в долях панели, а не в пикселях: когда панель сжимается
  // в пилюлю, капля сжимается вместе с ней, без рывка после.
  const buttons = [...els.tabs.querySelectorAll(".tab")].filter((b) => !b.hidden);
  drop.style.setProperty("--i", buttons.indexOf(button));
  drop.style.setProperty("--n", buttons.length);
  drop.classList.add("tabs-drop--on");
  if (!animate) {
    // Отключили переход только на этот кадр: при первом показе капля должна
    // сразу стоять на месте, а не выезжать из левого угла.
    requestAnimationFrame(() => drop.classList.remove("tabs-drop--still"));
  }
}

function openTab(name) {
  // Раздел въезжает с той стороны, где он стоит в полосе снизу: так видно,
  // что переключение — это шаг вбок, а не новый экран поверх старого.
  const from = TAB_ORDER.indexOf(name) - TAB_ORDER.indexOf(tab);
  if (name !== tab) haptic("select");
  tab = name;
  for (const button of els.tabs?.querySelectorAll(".tab") || []) {
    button.classList.toggle("tab--on", button.dataset.tab === name);
  }
  // Меряем на следующем кадре, когда новый раздел уже показан: у одних
  // разделов есть полоса прокрутки, у других нет, и от этого вся панель
  // меняет ширину на несколько пикселей — капля вставала бы мимо.
  requestAnimationFrame(() => moveDrop(name));
  els.free.hidden = true;
  els.picker.hidden = true;
  els.week.hidden = name !== "week";
  if (els.queues) els.queues.hidden = name !== "queues";
  document.getElementById("deadlines").hidden = name !== "deadlines";
  els.schedule.hidden = name !== "schedule";
  els.search.hidden = name !== "search";
  if (els.tabs) {
    const wasHidden = els.tabs.hidden;
    els.tabs.hidden = false;
    if (wasHidden) requestAnimationFrame(() => moveDrop(name, false));
    // Место полосы меряем и без ожидания кадра: свёрнутое приложение кадров
    // не рисует, и полоса осталась бы неприбитой до первого поворота экрана.
    setTimeout(pinTabs, 0);
    setTimeout(pinTabs, 400);
  }
  window.scrollTo(0, 0);
  const screen = { schedule: els.schedule, week: els.week, queues: els.queues, search: els.search, deadlines: document.getElementById("deadlines") }[name];
  if (screen && from) {
    screen.style.setProperty("--slide-from", `${from > 0 ? 16 : -16}px`);
    screen.classList.remove("screen-slide");
    void screen.offsetWidth;
    screen.classList.add("screen-slide");
  }
  if (name !== "week") document.body.dataset.parity = weekParity(data.weeks) || "none";
  if (name === "week") showWeek();
  if (name === "queues") showQueues();
  if (name === "deadlines") showDeadlines();
  if (name === "schedule") showSchedule();
  if (name === "search") showSearch();
}

/** Пары дня с учётом настроек и замен — общая основа всех разделов. */
function lessonsForDay(group, day, week) {
  const parity = weekParity(data.weeks, week);
  const list = group.teacher
    ? teacherLessons(group.teacher, parity, day, isoDate(dateOfDay(day, week)))
    : data.lessons.filter(
        (l) =>
          l.group === group.id &&
          l.day === day &&
          onDate(l, parity, isoDate(dateOfDay(day, week))) &&
          matchesPrefs(l)
      );
  return list.map((l) => withChange(l, dateOfDay(day, week))).sort((a, b) => a.slot - b.slot);
}

/**
 * Пары дня так, как их видит сам человек: вместо безымянной строки
 * «Межфакультетские учебные курсы МГУ» — его собственные курсы со своим
 * временем. Раньше подстановка жила только на экране дня, и неделя,
 * напоминания и «Когда пересечься» про выбранные МФК не знали.
 */
function ownLessonsForDay(group, day, week) {
  const list = lessonsForDay(group, day, week);
  const mine = group.teacher ? [] : mfkLessons(day);
  if (!mine.length) return list;
  return [...list.filter((lesson) => !isMfkLesson(lesson.subject)), ...mine].sort((a, b) => a.slot - b.slot);
}

/* ---------- Экран расписания ---------- */

// Куда перелистнули: дата в шапке уезжает в ту же сторону, что и страница.
let pendingLabel = 0;

// Когда пришли отмены и замены — заставка ждёт их, чтобы не считать
// отменённую пару.
let noticesReady = Promise.resolve();

/**
 * Дата меняется как на табло: старая уезжает в сторону листания и гаснет,
 * новая выезжает следом. Поверх друг друга они не стоят ни кадра.
 */
/**
 * Дата всегда в одну строку: «Среда, 30 сентября» помещалась, а
 * «Понедельник, 28 сентября» переносилась — шапка меняла высоту, и при
 * листании прыгал весь экран. Длинную дату чуть уменьшаем, чтобы влезла.
 */
function fitDateLabel(text) {
  const label = els.dateLabel;
  label.style.fontSize = "";
  const probe = el("span", "date-probe", text);
  label.append(probe);
  const room = label.clientWidth;
  const need = probe.scrollWidth;
  probe.remove();
  if (!room || need <= room) return;
  const base = parseFloat(getComputedStyle(label).fontSize);
  label.style.fontSize = `${Math.max(17, Math.floor((base * room) / need))}px`;
}

/** Шрифт шапки сменился или догрузился — ширина даты уже другая. */
function refitDate() {
  const text = els.dateLabel?.dataset.target || els.dateLabel?.textContent;
  if (text) fitDateLabel(text);
}
document.fonts?.ready.then(refitDate);
document.fonts?.addEventListener?.("loadingdone", refitDate);

function setDateLabel(text, direction) {
  const label = els.dateLabel;
  // Откуда уезжаем — дата, к которой ехали, а не текст целиком: при быстром
  // листании в шапке ещё стоят обе надписи прошлого перехода, и склеенный
  // из них текст давал три даты разом.
  const from = label.dataset.target || label.textContent;
  if (from === text) return;
  label.dataset.target = text;
  fitDateLabel(text);
  // Прошлый переход не доиграл — обрываем его, чтобы надписи не копились.
  for (const child of label.children) {
    for (const running of child.getAnimations()) running.cancel();
  }
  const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  if (!direction || reduce || !from) {
    label.textContent = text;
    return;
  }
  const old = el("span", "date-old", from);
  const fresh = el("span", "date-new", text);
  label.replaceChildren(old, fresh);
  const shift = 22 * direction;
  old.animate(
    [
      { transform: "translateX(0)", opacity: 1, filter: "blur(0)" },
      { transform: `translateX(${-shift}px)`, opacity: 0, filter: "blur(2px)" },
    ],
    { duration: 180, easing: "cubic-bezier(0.4, 0, 1, 1)", fill: "forwards" }
  );
  fresh
    .animate(
      [
        { transform: `translateX(${shift}px)`, opacity: 0, filter: "blur(2px)" },
        { transform: "translateX(0)", opacity: 1, filter: "blur(0)" },
      ],
      { duration: 320, delay: 90, easing: "cubic-bezier(0.18, 0.89, 0.32, 1)", fill: "backwards" }
    )
    .finished.catch(() => {})
    .finally(() => {
      if (label.contains(fresh)) label.textContent = text;
    });
}

function showSchedule() {
  const group = activeGroup();
  if (!group) return showPicker();

  els.picker.hidden = true;
  els.schedule.hidden = false;
  els.currentGroup.textContent = group.teacher ? group.title : t("Группа {g}", { g: group.title });

  const label = FULL_DATE.format(dateOfDay(selectedDay));
  setDateLabel(label[0].toUpperCase() + label.slice(1), pendingLabel);
  pendingLabel = 0;
  const parity = weekParity(data.weeks);
  // Голубой интерфейс — нечётная неделя, оранжевый — чётная.
  document.body.dataset.parity = parity || "none";
  els.weekLabel.textContent =
    parity === "odd"
      ? t("Нечётная неделя")
      : parity === "even"
        ? t("Чётная неделя")
        : t("Вне семестра");

  renderDays();
  renderRemindAsk();
  renderEvent();
  renderExamBanner();
  renderLessons(group, parity);
  renderSeason();
  loadNotes().then(applyNotes);
  noticesReady = loadNotices(group);
  ensureHomeworkWeek(selectedWeek);
}

// Подложка выбранного дня. Живёт дольше самих кнопок: полоса дней
// перерисовывается при каждом переходе, а капля должна доехать, а не
// родиться заново на новом месте.
const dayDrop = el("span", "days-drop");
dayDrop.setAttribute("aria-hidden", "true");
// Внутри капли — копии тех же плиток, но цветом выбранного дня. Капля едет
// над полосой и показывает из них только то, что под ней, поэтому цифра
// перекрашивается ровно по её краю. Раньше капля ехала под плитками: цифра
// белела раньше, чем капля доезжала, и на миг пропадала на светлом фоне.
const dayDropInner = el("span", "days-drop-inner");
dayDrop.append(dayDropInner);
let dayDropPlaced = false;
let daysShown = false;
let lastDayIndex = -1;

function placeDayDrop() {
  const active = els.days.querySelector(":scope > .day.active");
  if (!active) return;
  // Первый раз ставим без движения — иначе капля выезжала бы из угла.
  if (!dayDropPlaced) dayDrop.classList.add("days-drop--still");
  // Копии плиток стоят в капле на тех же местах, что и сами плитки.
  const ghosts = [...els.days.querySelectorAll(":scope > .day")].map((tile) => {
    const ghost = tile.cloneNode(true);
    // Копия — не выбранный день: искать его должны только среди настоящих.
    ghost.classList.remove("active");
    ghost.tabIndex = -1;
    ghost.style.left = `${tile.offsetLeft}px`;
    ghost.style.top = `${tile.offsetTop}px`;
    ghost.style.width = `${tile.offsetWidth}px`;
    ghost.style.height = `${tile.offsetHeight}px`;
    return ghost;
  });
  dayDropInner.replaceChildren(...ghosts);
  const x = active.offsetLeft;
  const y = active.offsetTop;
  dayDrop.style.width = `${active.offsetWidth}px`;
  dayDrop.style.height = `${active.offsetHeight}px`;
  dayDrop.style.transform = `translate(${x}px, ${y}px)`;
  // Содержимое едет навстречу ровно на столько же: копии остаются над
  // своими плитками, пока сама капля скользит.
  dayDropInner.style.transform = `translate(${-x}px, ${-y}px)`;
  if (!dayDropPlaced) {
    dayDropPlaced = true;
    requestAnimationFrame(() => dayDrop.classList.remove("days-drop--still"));
  }
}

/** Сколько пар в этот день — для точек под числом. Считаем по карточкам. */
function dayLoad(day, week) {
  const group = activeGroup();
  if (!group) return 0;
  return dayBlocks(group, day, week).length;
}

/**
 * Карточка в конце дня: пары кончились, но день ещё сегодняшний. Показывает,
 * когда и с чего начнётся следующий учебный день.
 */
function renderDayEnd() {
  const group = activeGroup();
  if (!group) return null;
  const today = new Date();
  // Ищем ближайший день с парами — на этой неделе или на следующей.
  for (let shift = 1; shift <= 12; shift++) {
    const index = dayIndex() + shift;
    if (index >= DAY_COUNT) break;
    const week = Math.floor(index / DAYS.length);
    const day = (index % DAYS.length) + 1;
    const lessons = ownLessonsForDay(group, day, week).filter(
      (lesson) => !lessonCancelOn(lesson, isoDate(dateOfDay(day, week)))
    );
    if (!lessons.length) continue;
    const bells = new Map(data.bells.map((b) => [b.n, b]));
    const first = lessons
      .map((lesson) => timesOf(lesson, bells))
      .filter(Boolean)
      .sort((a, b) => minutes(a.start) - minutes(b.start))[0];
    const date = dateOfDay(day, week);
    // Карточка — кнопка: касание уводит на тот самый следующий учебный день.
    const card = el("button", "dayend");
    card.type = "button";
    const mark = el("span", "dayend-mark");
    mark.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
    const text = el("span", "dayend-text");
    text.append(el("div", "dayend-title", t("На сегодня всё")));
    text.append(
      el(
        "div",
        "dayend-next",
        t("Дальше — {day}, {date}, с {time}", {
          day: FULL_DAY.format(date),
          date: SHORT_DATE.format(date),
          time: first ? first.start : "?",
        })
      )
    );
    const go = el("span", "dayend-go");
    go.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg>';
    card.append(mark, text, go);
    card.addEventListener("click", () => {
      haptic("select");
      selectedDay = day;
      selectedWeek = week;
      enterFrom = 1;
      pendingLabel = 1;
      showSchedule();
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
    return card;
  }
  return null;
}

function renderDays() {
  const nodes = [];
  const todayIso = isoDate(new Date());
  const group = activeGroup();

  for (let week = 0; week < WEEKS; week++) {
    if (week > 0) nodes.push(el("span", "days-split"));

    for (let day = 1; day <= DAYS.length; day++) {
      const active = day === selectedDay && week === selectedWeek;
      const date = dateOfDay(day, week);

      const btn = el("button", active ? "day active" : "day");
      btn.dataset.week = week;
      if (day === 1) btn.classList.add("day--week-start");
      if (isoDate(date) === todayIso) btn.classList.add("day--today");
      // День праздника — огонёк в углу плитки, у тех, чей это праздник.
      const holiday = group && eventOn(isoDate(date));
      if (holiday && holiday.ours(group)) {
        btn.classList.add("day--event");
        btn.dataset.icon = holiday.icon;
      }
      btn.append(el("span", "day-name", DAYS[day - 1]), el("span", "day-num", String(date.getDate())));
      // Точки под числом — ровно столько, сколько пар в этот день, как на
      // заставке. Раньше больше четырёх не рисовали, и в пятипарный день
      // точки под датой и на заставке расходились.
      const count = dayLoad(day, week);
      // День без пар — выходной или свободный: вместо точек тонкая черта,
      // плитка приглушена. Видно сразу, но не спорит с учебными днями.
      if (!count) btn.classList.add("day--off");
      const dots = el("span", "day-dots");
      for (let i = 0; i < Math.min(count, 7); i++) {
        const dot = el("i");
        // Номер точки — для очереди, в которой они загораются.
        dot.style.setProperty("--d", i);
        dots.append(dot);
      }
      btn.append(dots);
      btn.addEventListener("click", () => {
        const direction = Math.sign(week * DAYS.length + day - 1 - dayIndex());
        if (!direction) return;
        haptic("select");
        selectedDay = day;
        selectedWeek = week;
        enterFrom = direction;
        pendingLabel = direction;
        showSchedule();
      });
      nodes.push(btn);
    }
  }

  els.days.replaceChildren(dayDrop, ...nodes);
  // На новом выбранном дне точки пар вспыхивают по очереди. Первый показ —
  // плитки выезжают лесенкой.
  const index = dayIndex();
  const changed = index !== lastDayIndex;
  const active = els.days.querySelector(":scope > .day.active");
  if (!daysShown) {
    els.days.classList.add("days--intro");
    nodes.filter((node) => node.classList?.contains("day")).forEach((node, i) => node.style.setProperty("--i", i));
    daysShown = true;
  } else if (active && index !== lastDayIndex) {
    els.days.classList.remove("days--intro");
    active.classList.add("day--pop");
  }
  lastDayIndex = index;
  placeDayDrop();
  if (els.month) {
    const month = MONTH_NAME.format(dateOfDay(selectedDay));
    els.month.textContent = month[0].toUpperCase() + month.slice(1);
  }
  // День не менялся (пришли отмены, полосу перерисовали) — полосу не
  // трогаем: её могли пролистать руками.
  if (changed || !daysScrolled) keepSelectedVisible();
}

/**
 * Полоса — две страницы по неделе. Внутри недели она стоит на месте и едет
 * только капля; к другой неделе полоса перелистывается целиком. Раньше
 * выбранный день каждый раз подводился к центру, и вся строка ехала при
 * любом тапе — вместе с каплей это выглядело дёргано.
 */
function keepSelectedVisible() {
  const strip = els.days;
  const active = strip.querySelector(":scope > .day.active");
  const first = strip.querySelector(`:scope > .day--week-start[data-week="${selectedWeek}"]`) || active;
  if (!active) return;
  const pad = parseFloat(getComputedStyle(strip).paddingLeft) || 0;
  const max = Math.max(0, strip.scrollWidth - strip.clientWidth);
  let left = Math.min(max, Math.max(0, first.offsetLeft - pad));
  // Узкий экран, неделя не влезла: выбранный день важнее начала недели.
  // Справа — свой отступ полосы: он больше, чтобы день помещался со свечением.
  const right = active.offsetLeft + active.offsetWidth + (parseFloat(getComputedStyle(strip).paddingRight) || pad);
  if (right > left + strip.clientWidth) left = Math.min(max, right - strip.clientWidth);
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const behavior = reduce || !daysScrolled ? "auto" : "smooth";
  daysScrolled = true;
  if (Math.abs(strip.scrollLeft - left) < 1) return;
  strip.scrollTo({ left, behavior });
}

let daysScrolled = false;

/** Отсеивает языковые пары чужих подгрупп по настройкам студента. */
function matchesPrefs(lesson) {
  if (prefs.military === "no" && MILITARY.test(lesson.subject)) return false;
  if (prefs.rki !== "yes" && RKI.test(lesson.subject)) return false;
  if (prefs.mfkSlot === "no" && isMfkSlot(lesson.subject)) return false;
  if (prefs.pick && pairsHidden().has(lesson)) return false;

  // Пустой список читаем как «показывать все» — иначе студент, ничего не
  // отметив, получил бы расписание без дисциплин по выбору.
  if (lesson.elective === ELECTIVE && prefs.electives?.length) {
    if (!prefs.electives.includes(lesson.subject)) return false;
  }

  // Языки проверяем до подгрупп: у третьего языка подгруппы нет вовсе, и
  // проверка «нет подгруппы — показываем» пропускала бы его мимо фильтра.
  if (MAIN_LANGS.includes(lesson.subject)) {
    if (!prefs.main) return true;
    if (lesson.subject !== prefs.main) return false;
    return !lesson.subgroup || prefs.mainGroup == null
      ? true
      : lesson.subgroup === prefs.mainGroup;
  }
  if (LANG2.test(lesson.subject)) {
    if (!prefs.lang2) return true;
    if (lesson.subject !== prefs.lang2) return false;
    return !lesson.subgroup || prefs.lang2Group == null
      ? true
      : lesson.subgroup === prefs.lang2Group;
  }
  if (LANG3.test(lesson.subject)) {
    return lesson.subject === prefs.lang3;
  }

  // Остальные подгруппы (русский как иностранный и т.п.) не спрашиваем.
  return true;
}

/** Языковой предмет: основной, второй, третий или профессиональный язык. */
function isLanguage(subject) {
  return MAIN_LANGS.includes(subject) || LANG2.test(subject) || LANG3.test(subject) || /язык/i.test(subject);
}

/**
 * Подпись занятия для склейки соседних пар: всё, что видно на карточке,
 * кроме номера пары. Пары со своим временем не склеиваются — null.
 */
function lessonSignature(entries) {
  if (entries.some((e) => e.start || e.end)) return null;
  return JSON.stringify(
    entries
      .map((e) => [e.subgroup, e.type, e.room, e.teacher, e.week, e.elective, e.note, e.link])
      .sort()
  );
}

/** Номера пар карточки: у склеенной их несколько. */
function cardSlots(card) {
  return (card.dataset.slots || card.dataset.slot || "").split(",").filter(Boolean).map(Number);
}

// Свободный день: вместо сухого «Пар нет» — фраза, своя на каждую дату.
// Листаешь туда-обратно — она не меняется, в другой день — другая.
// Подписи свободного дня — без привязки к вузу: приложением пользуются
// студенты разных городов. Своя подборка для воскресенья.
const FREE_DAYS = [
  ["😴", "Пар нет", "Будильник сегодня можно не ставить"],
  ["☕", "Пар нет", "Кофе без спешки — лучшее начало дня"],
  ["📚", "Пар нет", "Хороший день, чтобы закрыть хвосты"],
  ["🎮", "Пар нет", "Официально можно отдохнуть"],
  ["🍕", "Пар нет", "Повод собраться с друзьями"],
  ["🧘", "Пар нет", "Выдохните — день свободен"],
  ["🌙", "Пар нет", "Можно выспаться за всю неделю"],
  ["🎧", "Пар нет", "Время для своих дел и любимой музыки"],
];

const SUNDAYS = [
  ["☀️", "Воскресенье", "Пар нет — день целиком ваш"],
  ["🛌", "Воскресенье", "Выспаться и никуда не спешить"],
  ["🍳", "Воскресенье", "Поздний завтрак — законная традиция"],
  ["🚶", "Воскресенье", "Погулять, пока неделя не началась"],
  ["🎬", "Воскресенье", "Фильм, сериал или книга — выбирайте"],
];

/** Значок, заголовок и подпись свободного дня; у одной даты — всегда одни. */
function freeDayPhrase(date) {
  if (LANG !== "ru") return ["🎉", t("Пар нет 🎉").replace("🎉", "").trim(), ""];
  const list = date.getDay() === 0 ? SUNDAYS : FREE_DAYS;
  return list[(date.getDate() * 7 + date.getMonth()) % list.length];
}

function renderFreeDay() {
  const node = el("div", "empty free-day");
  const date = dateOfDay(selectedDay);
  const [emoji, title, line] = freeDayPhrase(date);
  // Сцена: значок падает сверху и пружинит, под ним расходится круг, вокруг
  // всплывают искры. Подписи поднимаются следом — день «собирается» за секунду.
  // Фон: три цветных пятна медленно плавают за значком, поверх мерцают
  // редкие точки. Пустой экран перестаёт быть белым листом.
  const sky = el("div", "free-day-sky");
  for (let i = 1; i <= 3; i++) sky.append(el("span", `free-day-blob free-day-blob--${i}`));
  const seed = date.getDate() * 31 + date.getMonth() * 7;
  for (let i = 0; i < 9; i++) {
    const star = el("span", "free-day-star");
    // Места точек — от даты: у каждого дня своё «небо», но оно не скачет.
    star.style.left = `${8 + ((seed * (i + 3) * 37) % 84)}%`;
    star.style.top = `${6 + ((seed * (i + 5) * 53) % 78)}%`;
    star.style.setProperty("--d", `${(i * 430) % 3000}ms`);
    star.style.setProperty("--s", `${3 + ((seed + i) % 3)}px`);
    sky.append(star);
  }
  node.append(sky);
  const stage = el("div", "free-day-stage");
  stage.append(el("span", "free-day-halo"), el("span", "free-day-ring"));
  for (let i = 0; i < 6; i++) {
    const spark = el("span", "free-day-spark");
    spark.style.setProperty("--a", `${i * 60 + 20}deg`);
    spark.style.setProperty("--d", `${i * 90}ms`);
    stage.append(spark);
  }
  stage.append(el("div", "free-day-emoji", emoji));
  node.append(stage, el("div", "free-day-title", title));
  if (line) node.append(el("div", "free-day-line", line));
  return node;
}

/**
 * Пары преподавателя в показанный день. Одну лекцию он читает сразу
 * нескольким группам — это одна пара, группы перечисляем в пометке.
 */
function teacherLessons(key, parity, day = selectedDay, iso = isoDate(dateOfDay(day))) {
  const merged = new Map();
  for (const l of data.lessons) {
    if (l.day !== day || !onDate(l, parity, iso)) continue;
    if (!teachersOf(l.teacher).some((p) => p.key === key)) continue;
    const id = [l.slot, l.subject, l.type, l.room, l.week, l.start, l.end, l.foreign || ""].join("|");
    if (!merged.has(id)) merged.set(id, { ...l, subgroup: null, groups: [] });
    merged.get(id).groups.push(l.groupLabel || groupById(l.group)?.title || l.group);
  }
  return [...merged.values()].map((l) => {
    const groups = [...new Set(l.groups)].sort((a, b) => a.localeCompare(b, "ru", { numeric: true }));
    // Группы другого факультета подписаны «Мехмат · 521» — факультет один раз.
    const byFaculty = new Map();
    for (const name of groups) {
      const [faculty, title] = name.includes(" · ") ? name.split(" · ") : ["", name];
      if (!byFaculty.has(faculty)) byFaculty.set(faculty, []);
      byFaculty.get(faculty).push(title);
    }
    const list = [...byFaculty].map(([faculty, titles]) => (faculty ? `${faculty} · ` : "") + titles.join(", ")).join("; ");
    const label = groups.length === 1 ? t("Группа {g}", { g: list }) : t("Группы: {list}", { list });
    return { ...l, note: [label, l.note].filter(Boolean).join(" · ") };
  });
}

function renderLessons(group, parity) {
  const bells = new Map(data.bells.map((b) => [b.n, b]));
  const list = (group.teacher ? teacherLessons(group.teacher, parity) : data.lessons
    .filter(
      (l) =>
        l.group === group.id &&
        l.day === selectedDay &&
        onDate(l, parity, isoDate(dateOfDay(selectedDay))) &&
        matchesPrefs(l)
    ))
    .map((lesson) => withChange(lesson))
    .sort((a, b) => a.slot - b.slot);

  // Свои МФК: строка «Межфакультетские учебные курсы МГУ» без названия и
  // времени никому не нужна, если человек указал, на что ходит.
  const mine = group.teacher ? [] : mfkLessons(selectedDay);
  if (mine.length) {
    const other = list.filter((lesson) => !isMfkLesson(lesson.subject));
    list.length = 0;
    list.push(...other, ...mine);
    list.sort((a, b) => a.slot - b.slot);
  }

  visible = list;

  if (list.length === 0) {
    // Пар нет, но свои дела в этот день могут быть — они под картинкой дня.
    const own = [];
    placeOwn(own, dateOfDay(selectedDay));
    els.lessons.replaceChildren(renderFreeDay(), ...own, renderOwnAdd(), ...[renderStarostaAsk()].filter(Boolean));
    refreshNext();
    return;
  }

  // Оставшиеся подгруппы одного предмета сводим в одну карточку.
  const bySlot = new Map();
  for (const lesson of list) {
    if (!bySlot.has(lesson.slot)) bySlot.set(lesson.slot, new Map());
    const buckets = bySlot.get(lesson.slot);
    if (!buckets.has(lesson.subject)) buckets.set(lesson.subject, []);
    buckets.get(lesson.subject).push(lesson);
  }

  const slots = [...bySlot.keys()].sort((a, b) => a - b);

  // Одно и то же несколько пар подряд — одна карточка «1–6 пара». Военная
  // кафедра на весь день иначе занимала полтора экрана одинаковых карточек.
  // Пары со своим временем не склеиваем: диапазон звонков соврал бы.
  const runs = [];
  const open = new Map();
  for (const slot of slots) {
    for (const [subject, entries] of bySlot.get(slot)) {
      // Языки не склеиваем: у них десятки подгрупп и своих аудиторий, и
      // блок «1–2 пара» прятал, что это две отдельные пары.
      const signature = isLanguage(subject) ? null : lessonSignature(entries);
      const run = open.get(subject);
      if (signature && run && run.signature === signature && run.slots.at(-1) === slot - 1) {
        run.slots.push(slot);
      } else {
        const fresh = { entries, signature, slots: [slot] };
        open.set(subject, fresh);
        runs.push(fresh);
      }
    }
  }

  const nodes = [];
  for (let slot = slots[0]; slot <= slots[slots.length - 1]; slot++) {
    if (bySlot.has(slot)) {
      for (const run of runs) {
        if (run.slots[0] !== slot) continue;
        const card = renderCard(run.entries, bells, run.slots);
        // Перемена — тонкой строкой между соседними парами: видно, где можно
        // выдохнуть, а где бежать в другой корпус.
        const prev = [...nodes].reverse().find((node) => node.classList?.contains("card"));
        const gap = prev && breakBetween(prev, card);
        if (gap && nodes.at(-1) === prev) nodes.push(gap);
        nodes.push(card);
      }
    } else {
      // Свободная пара между занятыми — показываем как окно, чтобы её было
      // видно прямо в расписании, а не считать по времени.
      nodes.push(renderWindow(slot, bells.get(slot)));
    }
  }

  placeOwn(nodes, dateOfDay(selectedDay));

  // Пришли листанием — новый день въезжает с той стороны, откуда его тянули.
  const from = enterFrom * 28;
  enterFrom = 0;
  els.lessons.classList.remove("no-cascade");
  nodes.forEach((node, i) => {
    node.style.setProperty("--i", i);
    // Глубина: чем ниже карточка, тем дальше она «стоит» и тем длиннее путь.
    node.style.setProperty("--from-x", `${Math.round(from * (1 + Math.min(i, 6) * 0.22))}px`);
  });

  // Кнопка своего дела — сразу после пар, перед «на сегодня всё».
  nodes.push(renderOwnAdd());
  const ask = renderStarostaAsk();
  if (ask) nodes.push(ask);

  // Сегодня и всё уже прошло — в конце списка карточка «на сегодня всё».
  const now = new Date();
  const overToday =
    isoDate(dateOfDay(selectedDay)) === isoDate(now) &&
    lastEndToday() &&
    minutes(lastEndToday()) <= now.getHours() * 60 + now.getMinutes();
  if (overToday) {
    const card = renderDayEnd();
    if (card) nodes.push(card);
  }

  els.lessons.replaceChildren(...nodes);
  applyCancels();
  applyHomework();
  refreshFreedom();
  scrollToNow();
}

/* ---------- Ярлык на главном экране ---------- */

/**
 * Позволяет вынести расписание на рабочий стол телефона: тогда оно
 * открывается одним касанием, минуя Telegram и чат с ботом.
 *
 * Кнопку показываем, только если клиент это умеет и ярлыка ещё нет —
 * предлагать то, что не сработает или уже сделано, незачем.
 */
/**
 * Копирует адрес приложения в буфер. Внутри Telegram обычный
 * `navigator.clipboard` доступен не всегда, поэтому есть запасной путь
 * через скрытое поле — иначе кнопка молча ничего бы не делала.
 */
async function copyAddress(button) {
  const address = location.origin + location.pathname;
  let done = false;

  try {
    await navigator.clipboard.writeText(address);
    done = true;
  } catch {
    const field = document.createElement("textarea");
    field.value = address;
    field.setAttribute("readonly", "");
    field.style.position = "fixed";
    field.style.opacity = "0";
    document.body.append(field);
    field.select();
    try {
      done = document.execCommand("copy");
    } catch {
      done = false;
    }
    field.remove();
  }

  const was = button.dataset.label || button.textContent.trim();
  button.dataset.label = was;

  if (done) {
    button.textContent = t("Адрес скопирован");
    setTimeout(() => (button.textContent = was), 2500);
    return;
  }

  // Скопировать не вышло — оставляем адрес на виду, чтобы его можно было
  // выделить руками. Прятать его обратно значило бы оставить ни с чем.
  button.textContent = address;
  button.classList.add("secondary--plain");
}

function initHomeScreen() {
  // Уже на рабочем столе — предлагать нечего.
  if (window.matchMedia("(display-mode: standalone)").matches) return;

  // На айфоне Telegram ярлык создать не может: iOS не даёт приложениям их
  // добавлять. Зато это умеет Safari — показываем, как.
  if (tg?.platform === "ios") {
    els.homeIos.hidden = false;
    els.homeCopy.addEventListener("click", () => copyAddress(els.homeCopy));
    return;
  }

  // Библиотека Telegram объявляет метод даже в старых клиентах и бросает
  // ошибку при вызове, поэтому спрашиваем версию, а не наличие функции.
  if (!tg?.isVersionAtLeast?.("8.0")) return;

  const show = (visible) => {
    els.home.hidden = !visible;
    els.homeHint.hidden = !visible;
  };

  try {
    tg.checkHomeScreenStatus((status) =>
      show(status === "missed" || status === "unknown")
    );
  } catch {
    return;
  }

  els.home.addEventListener("click", () => {
    try {
      tg.addToHomeScreen();
    } catch {
      // Клиент передумал — кнопка просто останется на месте.
    }
  });

  tg.onEvent?.("homeScreenAdded", () => show(false));
}

/* ---------- Поиск ---------- */

const SEARCH_LIMIT = 80;

function showSearch() {
  els.schedule.hidden = true;
  els.picker.hidden = true;
  els.search.hidden = false;
  // Имена преподавателей нужны только поиску — грузим при первом открытии.
  loadTeacherNames().then(() => {
    if (!els.search.hidden) runSearch();
  });
  runSearch();
}

function closeSearch() {
  openTab("schedule");
}

/** Ищем по преподавателю, аудитории, предмету и номеру группы разом. */
/* ---------- Преподаватели в поиске ---------- */

// Полные имена — из списка сотрудников факультета в «ИСТИНЕ» МГУ: в PDF
// только инициалы. Кого там нет (часто — языковые кафедры других
// факультетов), остаётся с инициалами; дописать можно в teacher_names.json.
let TEACHER_NAMES = null;
// Почты — собрали студенты, по ключу «Фамилия И.О.»: teacher_emails.json.
let TEACHER_EMAILS = {};

async function loadTeacherNames() {
  if (TEACHER_NAMES) return;
  const get = (file) =>
    fetch(file, { cache: "no-cache" })
      .then((res) => (res.ok ? res.json() : {}))
      .catch(() => ({}));
  [TEACHER_NAMES, TEACHER_EMAILS] = await Promise.all([
    get(dataFile("teacher_names.json")),
    tenantHas("emails") ? get(dataFile("teacher_emails.json")) : Promise.resolve({}),
  ]);
}

// Должность в PDF сокращена и пишется по-разному: «ст.пр.», «ст. пр.».
const TEACHER_TITLES = [
  [/^зав\.?\s*каф/i, "заведующий кафедрой"],
  [/^с\.\s*н\.\s*с/i, "старший научный сотрудник"],
  [/^н\.\s*с/i, "научный сотрудник"],
  [/^ст\.?\s*пр/i, "старший преподаватель"],
  [/^проф/i, "профессор"],
  [/^доц/i, "доцент"],
  [/^акад/i, "академик"],
  [/^асс/i, "ассистент"],
  [/^пр/i, "преподаватель"],
];

/**
 * «зав.каф. Гвозданный В.А., проф. Агафонова Н.В.» → люди с должностями.
 * То же, что tools/teachers_index.py: одно написание на человека.
 */
// Полные имена, прочитанные прямо из расписания: «Ложкин Сергей Андреевич».
const PARSED_NAMES = {};

/** Полное имя по ключу «Фамилия И.О.»: из справочника ФГП или из самого расписания. */
function teacherFull(key) {
  return TEACHER_NAMES?.[key] || PARSED_NAMES[key] || null;
}

// Не люди: «Преподаватели ВУЦ», «!Вакансия».
const NOT_A_PERSON = /^(преподавател|вакансия|кафедра|сотрудник)/i;
const SURNAME = "[А-ЯЁ][а-яё]+(?:-[А-ЯЁ][а-яё]+)?";
const NAME_SHORT = new RegExp(`^(${SURNAME})\\s*(?:([А-ЯЁ])\\.?\\s*(?:([А-ЯЁ])\\.?)?)?$`);
const NAME_FULL = new RegExp(`^(${SURNAME})\\s+([А-ЯЁ])[а-яё]+(?:\\s+([А-ЯЁ])[а-яё]+)?$`);
const NAME_FIRST = new RegExp(`^([А-ЯЁ])\\.\\s*(?:([А-ЯЁ])\\.\\s*)?(${SURNAME})$`);

/**
 * Три записи одного человека: «Гена Е.И.», «Гена Евгений Иванович» и
 * «Е.И.Гена» — у всех ключ «Гена Е.И.».
 */
function parseName(text) {
  if (NOT_A_PERSON.test(text)) return null;
  let m = text.match(NAME_SHORT);
  if (m) return { surname: m[1], initials: [m[2], m[3]].filter(Boolean), full: null };
  m = text.match(NAME_FULL);
  if (m) return { surname: m[1], initials: [m[2], m[3]].filter(Boolean), full: text.replace(/\s+/g, " ") };
  m = text.match(NAME_FIRST);
  if (m) return { surname: m[3], initials: [m[1], m[2]].filter(Boolean), full: null };
  return null;
}

function teachersOf(field) {
  const people = [];
  for (let part of String(field || "").split(/,\s*/)) {
    part = part.replace(/^\d{3}[А-ЯЁ]?\b\s*/, "").trim();
    const titled = part.match(/^((?:[а-яё]{1,6}\.*\s*)+)(?=[А-ЯЁA-Z])/);
    const titleRaw = titled ? titled[1].trim() : "";
    // Номер аудитории, приписанный после имени: «И. В. Максимова 453».
    const rest = (titled ? part.slice(titled[0].length) : part).replace(/\s+\d+\S*$/, "");
    const person = parseName(rest);
    if (!person) continue;
    const initials = person.initials.map((c) => `${c}.`).join("");
    const key = initials ? `${person.surname} ${initials}` : person.surname;
    if (person.full && !PARSED_NAMES[key]) PARSED_NAMES[key] = person.full;
    const title = TEACHER_TITLES.find(([pattern]) => pattern.test(titleRaw))?.[1] || null;
    people.push({ key, surname: person.surname, title, full: teacherFull(key) });
  }
  return people;
}

const searchKey = (text) => String(text).toLowerCase().replace(/ё/g, "е");

/** «12 пар», «3 пары» — по-русски склоняем, у переводов своё. */
function lessonsCount(n) {
  if (LANG !== "ru") return t("{n} пар в расписании", { n });
  const tens = n % 100;
  const ones = n % 10;
  const word = tens >= 11 && tens <= 14 ? "пар" : ones === 1 ? "пара" : ones >= 2 && ones <= 4 ? "пары" : "пар";
  return `${n} ${word} в расписании`;
}

/**
 * Преподаватели, подходящие под запрос: по началу фамилии или по имени и
 * отчеству. Короче трёх букв не ищем — «Ив» совпало бы с половиной списка.
 */
function matchTeachers(query) {
  const q = searchKey(query);
  if (q.length < 3) return [];
  const found = new Map();
  for (const lesson of data.lessons) {
    for (const person of teachersOf(lesson.teacher)) {
      const hit =
        searchKey(person.surname).startsWith(q) ||
        searchKey(person.key).startsWith(q) ||
        (person.full && searchKey(person.full).includes(q));
      if (!hit) continue;
      if (!found.has(person.key)) {
        found.set(person.key, { ...person, titles: new Map(), lessons: new Set(), subjects: new Set(), groups: new Set() });
      }
      const entry = found.get(person.key);
      if (person.title) entry.titles.set(person.title, (entry.titles.get(person.title) || 0) + 1);
      entry.lessons.add([lesson.day, lesson.slot, lesson.week, lesson.subject].join("|"));
      entry.subjects.add(lesson.subject);
      entry.groups.add(lesson.group);
    }
  }
  return [...found.values()].sort((a, b) => b.lessons.size - a.lessons.size);
}

function renderTeacherCard(teacher) {
  const card = el("article", "teacher-card");
  card.append(el("div", "teacher-avatar", teacher.surname[0]));
  const body = el("div", "teacher-body");
  body.append(el("div", "teacher-name", teacher.full || teacher.key));
  // Самая частая должность: в разных строках PDF её пишут по-разному.
  const title = [...teacher.titles].sort((a, b) => b[1] - a[1])[0]?.[0];
  const facts = [title ? t(title) : null, lessonsCount(teacher.lessons.size)].filter(Boolean);
  body.append(el("div", "teacher-meta", facts.join(" · ")));
  const where = teacherNow(teacher.key);
  if (where) body.append(el("div", where.now ? "teacher-now teacher-now--on" : "teacher-now", where.text));
  const subjects = el("div", "teacher-subjects");
  for (const subject of [...teacher.subjects].slice(0, 6)) subjects.append(el("span", "tag", tr(subject)));
  body.append(subjects);
  body.append(el("div", "groups", [...teacher.groups].sort().join(", ")));
  const email = TEACHER_EMAILS[teacher.key];
  if (email) {
    const link = el("a", "teacher-email", `✉️ ${email}`);
    link.href = `mailto:${email}`;
    body.append(link);
  }
  card.append(body);
  return card;
}

/**
 * Где преподаватель сейчас или когда его ближайшая пара — чтобы поймать
 * с зачёткой. По расписанию: отмены и замены у чужих групп приложение не
 * знает, поэтому это «должен быть», а не «точно там».
 */
function teacherNow(key) {
  const bells = new Map(data.bells.map((b) => [b.n, b]));
  const now = new Date();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  for (let shift = 0; shift < 14; shift++) {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + shift);
    const weekday = date.getDay();
    if (weekday === 0) continue;
    const lessons = teacherLessons(key, parityOfDate(date), weekday, isoDate(date))
      .map((lesson) => ({ lesson, time: timesOf(lesson, bells) }))
      .filter((item) => item.time)
      .sort((a, b) => minutes(a.time.start) - minutes(b.time.start));
    for (const { lesson, time } of lessons) {
      const place = roomLabel(lesson.room || "");
      if (shift === 0) {
        if (minutes(time.end) <= nowMinutes) continue;
        if (minutes(time.start) <= nowMinutes) {
          return { now: true, text: t("🟢 Сейчас: {place}, до {end}", { place: place || tr(lesson.subject), end: time.end }) };
        }
        return { now: false, text: t("Сегодня в {start} — {place}", { start: time.start, place: place || tr(lesson.subject) }) };
      }
      const day = shift === 1 ? t("Завтра") : SHORT_DATE.format(date);
      return { now: false, text: t("{day} в {start} — {place}", { day, start: time.start, place: place || tr(lesson.subject) }) };
    }
  }
  return null;
}

/* ---------- Когда пересечься ---------- */

// Общие окна с другой группой: когда оба свободны. Своё расписание — как в
// настройках (подгруппа, язык), чужое — все пары группы: чужих подгрупп
// приложение не знает, так что «занят» у друга — с запасом.
const MEET_KEY = "schedule.meetGroup";
let meetSheet = null;

function meetBusy(lessons) {
  return new Set(lessons.map((lesson) => lesson.slot));
}

function meetDay(group, friend, day, week) {
  const parity = weekParity(data.weeks, week);
  const mine = meetBusy(ownLessonsForDay(group, day, week).filter((l) => !lessonCancelOn(l, isoDate(dateOfDay(day, week)))));
  const theirs = meetBusy(
    data.lessons.filter((l) => l.group === friend.id && l.day === day && onDate(l, parity, isoDate(dateOfDay(day, week))))
  );
  return { mine, theirs };
}

function openMeet() {
  const group = activeGroup();
  if (!data || !group) return;
  if (!meetSheet) {
    meetSheet = el("div", "sheet-backdrop");
    meetSheet.hidden = true;
    const sheet = el("div", "sheet sheet--abs sheet--meet");
    sheet.setAttribute("role", "dialog");
    sheet.setAttribute("aria-modal", "true");
    const top = el("div", "sheet-top");
    const head = el("div");
    head.append(el("h2", "", t("Когда пересечься")), el("div", "meet-note", t("Общие окна с другой группой")));
    const close = el("button", "icon", "×");
    close.type = "button";
    close.setAttribute("aria-label", t("Закрыть"));
    close.addEventListener("click", closeMeet);
    top.append(head, close);
    const select = el("select", "meet-select");
    select.addEventListener("change", () => {
      try {
        localStorage.setItem(MEET_KEY, select.value);
      } catch {
        // Не запомнится — выберут ещё раз.
      }
      haptic("select");
      renderMeet();
    });
    sheet.append(top, select, el("div", "meet-body"));
    meetSheet.append(sheet);
    meetSheet.addEventListener("click", (event) => {
      if (event.target === meetSheet) closeMeet();
    });
    document.body.append(meetSheet);
  }
  // Группы — по курсам, своя не нужна.
  const select = meetSheet.querySelector(".meet-select");
  const byCourse = new Map();
  for (const g of data.groups) {
    if (g.id === group.id) continue;
    const title = courseTitle(g);
    if (!byCourse.has(title)) byCourse.set(title, []);
    byCourse.get(title).push(g);
  }
  const first = new Option(t("Выберите группу друга"), "");
  select.replaceChildren(
    first,
    ...[...byCourse].map(([title, groups]) => {
      const box = document.createElement("optgroup");
      box.label = title;
      box.append(...groups.map((g) => new Option(g.title, g.id)));
      return box;
    })
  );
  let saved = "";
  try {
    saved = localStorage.getItem(MEET_KEY) || "";
  } catch {
    // Без памяти — начнём с пустого выбора.
  }
  select.value = [...select.options].some((o) => o.value === saved) ? saved : "";
  renderMeet();
  meetSheet.classList.remove("sheet-backdrop--out");
  meetSheet.hidden = false;
}

function closeMeet() {
  const sheet = meetSheet;
  if (!sheet || sheet.hidden || sheet.classList.contains("sheet-backdrop--out")) return;
  haptic("light");
  sheet.classList.add("sheet-backdrop--out");
  setTimeout(() => {
    sheet.hidden = true;
    sheet.classList.remove("sheet-backdrop--out");
  }, 260);
}

function renderMeet() {
  const body = meetSheet.querySelector(".meet-body");
  const group = activeGroup();
  const friend = groupById(meetSheet.querySelector(".meet-select").value);
  if (!friend) {
    body.replaceChildren(el("p", "empty", t("Выберите группу — покажем, когда вы оба свободны на этой неделе")));
    return;
  }
  const bells = data.bells;
  const todayIso = isoDate(new Date());
  const nodes = [];
  for (let day = 1; day <= DAYS.length; day++) {
    const date = dateOfDay(day);
    if (isoDate(date) < todayIso) continue;
    const { mine, theirs } = meetDay(group, friend, day, selectedWeek);
    const used = [...mine, ...theirs];
    const row = el("div", "meet-day");
    const label = SHORT_DATE.format(date);
    row.append(el("div", "meet-day-title", `${DAYS[day - 1]}, ${label}`));
    if (!used.length) {
      row.append(el("div", "meet-free meet-free--all", t("Оба свободны весь день 🎉")));
      nodes.push(row);
      continue;
    }
    const last = Math.max(...used);
    const firstSlot = Math.min(...used);
    const shown = bells.filter((b) => b.n <= Math.max(last, 5));
    const grid = el("div", "meet-grid");
    grid.style.setProperty("--n", shown.length);
    const line = (name, busy) => {
      grid.append(el("span", "meet-who", name));
      for (const bell of shown) {
        const cell = el("i", busy.has(bell.n) ? "meet-cell meet-cell--busy" : "meet-cell");
        if (!mine.has(bell.n) && !theirs.has(bell.n) && bell.n > firstSlot && bell.n < last) cell.classList.add("meet-cell--both");
        grid.append(cell);
      }
    };
    grid.append(el("span", "meet-who"));
    for (const bell of shown) grid.append(el("span", "meet-time", bell.start));
    line(t("Вы"), mine);
    line(friend.title, theirs);
    row.append(grid);

    const facts = [];
    const gaps = shown.filter((b) => b.n > firstSlot && b.n < last && !mine.has(b.n) && !theirs.has(b.n));
    if (!theirs.size) facts.push([t("У {group} пар нет", { group: friend.title }), false]);
    if (!mine.size) facts.push([t("У вас пар нет"), false]);
    if (gaps.length) facts.push([t("Общее окно: {list}", { list: gaps.map((b) => `${b.start}–${b.end}`).join(", ") }), true]);
    const start = bells.find((b) => b.n === firstSlot);
    const end = bells.find((b) => b.n === last);
    if (firstSlot > 1 && start) facts.push([t("Оба свободны до {time}", { time: start.start }), false]);
    if (end) facts.push([t("Оба свободны после {time}", { time: end.end }), false]);
    for (const [text, good] of facts) row.append(el("div", good ? "meet-free meet-free--gap" : "meet-free", text));
    nodes.push(row);
  }
  if (!nodes.length) nodes.push(el("p", "empty", t("На этой неделе дни уже прошли — пролистайте на следующую")));
  nodes.push(el("p", "meet-fine", t("У друга учтены все пары группы — без его подгруппы и языка, так что свободен он может быть и чаще.")));
  body.replaceChildren(...nodes);
}

const CREATOR_WORDS = ["бодрин", "бодрин федор", "федор михайлович", "создатель", "bodryash"];

function renderCreatorCard() {
  const card = el("article", "teacher-card");
  card.append(el("div", "teacher-avatar", "Б"));
  const body = el("div", "teacher-body");
  body.append(el("div", "teacher-name", "Бодрин Фёдор Михайлович"));
  body.append(el("div", "teacher-meta", "создатель расписания · 0 пар, зато все остальные ✨"));
  const link = el("a", "teacher-email", "✉️ hello@bodryash.ru");
  link.href = "mailto:hello@bodryash.ru";
  body.append(link);
  card.append(body);
  return card;
}

// Вкладки поиска: all | teacher | room | subject.
let searchKind = "all";

/** Преподаватели своей группы — то, что показываем до первого запроса. */
function renderMyTeachers() {
  const group = activeGroup();
  if (!group || group.teacher) return [];
  const keys = new Map();
  for (const lesson of data.lessons) {
    if (lesson.group !== group.id || !matchesPrefs(lesson)) continue;
    for (const person of teachersOf(lesson.teacher)) {
      if (!keys.has(person.key)) {
        keys.set(person.key, { ...person, titles: new Map(), lessons: new Set(), subjects: new Set(), groups: new Set() });
      }
      const entry = keys.get(person.key);
      if (person.title) entry.titles.set(person.title, (entry.titles.get(person.title) || 0) + 1);
      entry.lessons.add([lesson.day, lesson.slot, lesson.week, lesson.subject].join("|"));
      entry.subjects.add(lesson.subject);
      entry.groups.add(lesson.group);
    }
  }
  return [...keys.values()].sort((a, b) => b.lessons.size - a.lessons.size);
}

/** Аудитории или предметы своей группы: что и сколько раз встречается. */
function groupFacts(kind) {
  const group = activeGroup();
  if (!group) return [];
  const counts = new Map();
  for (const lesson of data.lessons) {
    const mine = group.teacher
      ? teachersOf(lesson.teacher).some((p) => p.key === group.teacher)
      : lesson.group === group.id && matchesPrefs(lesson);
    if (!mine) continue;
    const key = kind === "room" ? lesson.room : lesson.subject;
    if (!key) continue;
    if (!counts.has(key)) counts.set(key, { key, lessons: 0, extra: new Set() });
    const item = counts.get(key);
    item.lessons += 1;
    item.extra.add(kind === "room" ? lesson.subject : lesson.room);
  }
  return [...counts.values()].sort((a, b) => b.lessons - a.lessons);
}

function renderFactCard(item) {
  const card = el("article", "teacher-card");
  const title = searchKind === "room" ? roomLabel(item.key) : tr(item.key);
  // У аудитории на кружке номер, а не буква «а» из слова «ауд.».
  card.append(el("div", "teacher-avatar", searchKind === "room" ? String(item.key).slice(0, 3) : String(title)[0]));
  const body = el("div", "teacher-body");
  body.append(el("div", "teacher-name", withFlag(title)));
  body.append(el("div", "teacher-meta", lessonsCount(item.lessons)));
  const tags = el("div", "teacher-subjects");
  for (const extra of [...item.extra].filter(Boolean).slice(0, 6)) {
    tags.append(el("span", "tag", searchKind === "room" ? tr(extra) : roomLabel(extra)));
  }
  body.append(tags);
  card.append(body);
  return card;
}

function runSearch() {
  const query = els.query.value.trim().toLowerCase();
  if (query.length < 2) {
    // Пустой поиск — не пустой экран: показываем то, что выбрано вкладкой.
    if (searchKind === "room" || searchKind === "subject") {
      const items = groupFacts(searchKind);
      els.results.replaceChildren(...items.map(renderFactCard));
      els.searchHint.textContent = items.length
        ? searchKind === "room"
          ? t("Аудитории вашей группы")
          : t("Предметы вашей группы")
        : t("Например: Шестова, 614, микроэкономика");
      return;
    }
    const mine = renderMyTeachers();
    els.results.replaceChildren(...mine.map(renderTeacherCard));
    els.searchHint.textContent = mine.length
      ? t("Преподаватели вашей группы")
      : t("Например: Шестова, 614, микроэкономика");
    return;
  }

  // Переведённое название тоже ищем: китаец наберёт «经济», а не «экономика».
  // И по имени-отчеству преподавателя: «Татьяна Львовна» найдёт Шестову.
  const teachers = searchKind === "room" || searchKind === "subject" ? [] : matchTeachers(query);
  const byName = new Set(teachers.filter((x) => x.full).map((x) => x.key));
  const fields = {
    all: (l) => [l.teacher, l.room, l.subject, tr(l.subject), l.group],
    teacher: (l) => [l.teacher],
    room: (l) => [l.room],
    subject: (l) => [l.subject, tr(l.subject)],
  }[searchKind];
  const found = data.lessons.filter(
    (l) =>
      fields(l).some((field) => (field || "").toLowerCase().includes(query)) ||
      (searchKind !== "room" &&
        searchKind !== "subject" &&
        byName.size &&
        teachersOf(l.teacher).some((person) => byName.has(person.key)))
  );

  // Одну лекцию читают сразу нескольким группам. Показывать её шесть раз
  // подряд бессмысленно — сводим в строку и перечисляем группы.
  const merged = new Map();
  for (const lesson of found) {
    const key = [
      lesson.day,
      lesson.slot,
      lesson.week,
      lesson.subject,
      lesson.teacher,
      lesson.room,
    ].join("|");
    if (!merged.has(key)) merged.set(key, { lesson, groups: [] });
    merged.get(key).groups.push(lesson.group);
  }

  const rows = [...merged.values()].sort(
    (a, b) => a.lesson.day - b.lesson.day || a.lesson.slot - b.lesson.slot
  );

  // Пасхалка: автор расписания находится поиском, хоть пар и не ведёт.
  const creator = CREATOR_WORDS.some((w) => w.startsWith(searchKey(query)) && query.length >= 3)
    ? renderCreatorCard()
    : null;

  if (!rows.length) {
    els.results.replaceChildren(...(creator ? [creator] : []));
    els.searchHint.textContent = creator ? "" : t("Ничего не нашлось");
    return;
  }

  const shown = rows.slice(0, SEARCH_LIMIT);
  els.searchHint.textContent =
    rows.length > SEARCH_LIMIT
      ? t("Найдено {n}, показаны первые {limit}", { n: rows.length, limit: SEARCH_LIMIT })
      : t("Найдено {n}", { n: rows.length });

  const bells = new Map(data.bells.map((b) => [b.n, b]));
  // Нашёлся преподаватель — сначала его карточка, потом пары. Больше трёх
  // карточек не показываем: при коротком запросе это уже не поиск человека.
  const people = teachers.length <= 3 ? teachers.map(renderTeacherCard) : [];
  const cascade = (nodes) => {
    nodes.forEach((node, i) => node.style.setProperty("--i", i));
    return nodes;
  };
  els.results.replaceChildren(
    ...cascade(creator ? [creator] : []),
    ...cascade(people),
    ...shown.map(({ lesson, groups }) => {
      const bell = timesOf(lesson, bells);
      const row = el("article", "card");

      const head = el("div", "time");
      head.append(
        el("span", "slot", t("{day}, {n} пара", { day: DAYS[lesson.day - 1], n: lesson.slot }))
      );
      if (bell) head.append(el("span", null, `${bell.start} – ${bell.end}`));
      if (lesson.week !== "all") {
        head.append(el("span", "tag", t(lesson.week === "odd" ? "нечётная" : "чётная")));
      }

      const body = el("div", "card-body");
      body.append(head, el("div", "subject", withFlag(lesson.subject)));
      body.append(metaLine(lesson, "", false));
      body.append(el("div", "groups", [...new Set(groups)].join(", ")));

      row.append(body);
      if (lesson.room) row.append(roomBadge(lesson.room));
      return row;
    })
  );
}

/* ---------- Свободные аудитории ---------- */

// Считаем только аудитории своего корпуса. «638Б ЮФ» и «558 ВШССН» —
// аудитории других факультетов: по расписанию ФГП они «свободны» почти
// всегда, а на деле заняты своими. Военная кафедра, спортбаза, дистант и
// виртуальные — не место, где можно сесть.
const OWN_ROOM = /^\d{3}[А-ЯЁ]?$/;

let freeSlot = null;

function clock(total) {
  const h = String(Math.floor(total / 60)).padStart(2, "0");
  return `${h}:${String(total % 60).padStart(2, "0")}`;
}

// На других факультетах аудитории записаны по-своему: «П-14», «Е232»,
// «В4/3601», «зал 5». Берём всё, где есть номер, кроме мест, где не сядешь,
// и тех, что встречаются в расписании пару раз — это чужие корпуса.
const NOT_A_ROOM = /вирт|дист|онлайн|online|эиос|с\/база|спорт|воен|кафедр|^каф|др\.?\s*фак|б\/а|в\.з\.|д\.а\.|ленинские|клиник/i;

function ownRoom(room) {
  if (tenantId() === DEFAULT_TENANT) return OWN_ROOM.test(room);
  return /\d/.test(room) && room.length <= 16 && !/[,;]/.test(room) && !NOT_A_ROOM.test(room);
}

function roomsOfBuilding() {
  const counts = new Map();
  for (const lesson of data.lessons) {
    const room = (lesson.room || "").trim();
    if (ownRoom(room)) counts.set(room, (counts.get(room) || 0) + 1);
  }
  const rare = tenantId() === DEFAULT_TENANT ? 0 : 2;
  return [...counts]
    .filter(([, n]) => n > rare)
    .map(([room]) => room)
    .sort((a, b) => a.localeCompare(b, "ru", { numeric: true }));
}

/** Заголовок блока: у ФГП этаж, у остальных — корпус по буквам перед номером. */
function roomBlock(room) {
  if (tenantId() === DEFAULT_TENANT) return t("{n} этаж", { n: room[0] });
  const prefix = room.split(/\d/)[0].replace(/[\s\-/.]+$/, "");
  if (prefix) return prefix;
  // «512» — пятый этаж, «1624» — шестнадцатый (высотки МГУ).
  const digits = room.match(/^(\d{3,4})(?!\d)/);
  if (digits) return t("{n} этаж", { n: digits[1].slice(0, digits[1].length - 2) });
  return t("Аудитории");
}

/**
 * Когда каждая аудитория занята в этот день. По времени, а не по номеру
 * пары: у части занятий своё время, и «12:00–13:30» задевает сразу две
 * соседние пары. Занятия всех групп, а не только своей.
 */
function busyIntervals(day, parity) {
  const bells = new Map(data.bells.map((b) => [b.n, b]));
  const busy = new Map();
  for (const lesson of data.lessons) {
    if (lesson.day !== day) continue;
    if (!onDate(lesson, parity, isoDate(dateOfDay(day)))) continue;
    const room = (lesson.room || "").trim();
    if (!ownRoom(room)) continue;
    const time = timesOf(lesson, bells);
    if (!time) continue;
    if (!busy.has(room)) busy.set(room, []);
    busy.get(room).push([minutes(time.start), minutes(time.end)]);
  }
  return busy;
}

/** По умолчанию — идущая пара или ближайшая следующая, если смотрим сегодня. */
function defaultFreeSlot() {
  const bells = data.bells;
  if (isoDate(dateOfDay(selectedDay)) !== isoDate(new Date())) return bells[0].n;
  const now = new Date();
  const current = now.getHours() * 60 + now.getMinutes();
  const bell = bells.find((b) => current < minutes(b.end));
  return (bell || bells[bells.length - 1]).n;
}

function showFree() {
  els.schedule.hidden = true;
  els.search.hidden = true;
  els.picker.hidden = true;
  els.free.hidden = false;
  freeSlot = defaultFreeSlot();
  renderFree();
  window.scrollTo(0, 0);
}

function closeFree() {
  els.free.hidden = true;
  showSchedule();
}

function renderFree() {
  const bells = data.bells;
  const bell = bells.find((b) => b.n === freeSlot) || bells[0];

  const label = FULL_DATE.format(dateOfDay(selectedDay));
  els.freeDate.textContent = label[0].toUpperCase() + label.slice(1);

  els.freeSlots.replaceChildren(
    ...bells.map((b) => {
      const button = el("button", b.n === bell.n ? "day active" : "day");
      button.type = "button";
      button.append(el("span", null, t("{n} пара", { n: b.n })), el("span", "day-date", b.start));
      button.addEventListener("click", () => {
        freeSlot = b.n;
        renderFree();
      });
      return button;
    })
  );

  // Поздние пары за правым краем полосы — подводим выбранную к центру.
  els.freeSlots.querySelector(".active")?.scrollIntoView({ inline: "center", block: "nearest" });

  const all = roomsOfBuilding();
  const busy = busyIntervals(selectedDay, weekParity(data.weeks));
  const from = minutes(bell.start);
  const to = minutes(bell.end);

  const free = [];
  for (const room of all) {
    const spans = busy.get(room) || [];
    if (spans.some(([start, end]) => start < to && end > from)) continue;
    // До какого времени свободна: до ближайшего занятия после этой пары.
    const later = spans.filter(([start]) => start >= to).map(([start]) => start);
    free.push({ room, until: later.length ? Math.min(...later) : null });
  }

  els.freeHint.textContent = t("Свободно {free} из {all} · {start} – {end}", {
    free: free.length,
    all: all.length,
    start: bell.start,
    end: bell.end,
  });
  // У других факультетов в здании бывают свои пары — мы видим только свои.
  if (tenantId() !== DEFAULT_TENANT) {
    els.freeHint.textContent += ` · ${t("по расписанию вашего факультета")}`;
  }
  // Итог меняется вместе с парой. Сам элемент не пересоздаётся, поэтому
  // CSS-анимация сработала бы один раз при открытии — запускаем явно.
  if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    els.freeHint.animate([{ opacity: 0.35 }, { opacity: 1 }], {
      duration: 180,
      easing: "cubic-bezier(0.23, 1, 0.32, 1)",
    });
  }

  if (!free.length) {
    els.freeList.replaceChildren(el("p", "empty", t("Все аудитории заняты")));
    return;
  }

  // Группируем по этажу — по первой цифре номера (у других факультетов — по корпусу).
  const floors = new Map();
  for (const item of free) {
    const floor = roomBlock(item.room);
    if (!floors.has(floor)) floors.set(floor, []);
    floors.get(floor).push(item);
  }

  // Сквозной порядок появления: этажи и плитки въезжают каскадом сверху вниз.
  let order = 0;

  els.freeList.replaceChildren(
    ...[...floors].map(([floor, items]) => {
      const block = el("div", "floor");
      const heading = el("h2", null, floor);
      heading.style.setProperty("--i", order++);
      block.append(heading);
      const grid = el("div", "free-grid");
      for (const item of items) {
        const tile = el("div", "free-room");
        tile.style.setProperty("--i", order++);
        tile.append(
          el("span", "free-num", item.room),
          el(
            "span",
            "free-until",
            item.until === null ? t("до конца дня") : t("до {time}", { time: clock(item.until) })
          )
        );
        grid.append(tile);
      }
      block.append(grid);
      return block;
    })
  );
}

/* ---------- Листание дней ---------- */


const SWIPE_DISTANCE = 0.22; // доля ширины экрана
const SWIPE_VELOCITY = 0.35; // px/мс — быстрый флик засчитываем без дистанции
const TAP_ZONE = 0.22; // доля ширины: касание у края листает, как в сторис
const TAP_SLOP = 8; // px — больше этого уже не касание, а жест

/**
 * Виброотклик Telegram. select — лёгкий щелчок при выборе (день, вкладка),
 * light/medium/heavy — нажатие кнопки, success/error/warning — итог
 * действия. Вне Telegram и на старых версиях молча ничего не делает.
 */
function haptic(kind = "select") {
  const feedback = tg?.HapticFeedback;
  if (!feedback) return;
  try {
    if (kind === "select") feedback.selectionChanged();
    else if (kind === "success" || kind === "error" || kind === "warning") feedback.notificationOccurred(kind);
    else feedback.impactOccurred(kind);
  } catch {
    // Старый клиент без вибрации — ничего страшного.
  }
}

/** Меню «⋯» в шапке: свободные аудитории и настройки. */
function initMenu() {
  const pop = els.menuPop;
  if (!els.menu || !pop) return;
  const close = () => {
    if (pop.hidden) return;
    pop.classList.add("menu-pop--out");
    setTimeout(() => {
      pop.hidden = true;
      pop.classList.remove("menu-pop--out");
    }, 200);
  };
  els.menu.addEventListener("click", (event) => {
    event.stopPropagation();
    haptic("light");
    if (pop.hidden) {
      // Меню встаёт под кнопкой, а носик смотрит ровно в её середину —
      // так видно, откуда оно выросло. Считаем по месту кнопки на экране.
      // Считаем по раскладке, а не по экрану: экранные координаты
      // искажает масштаб страницы.
      pop.hidden = false;
      const parent = pop.offsetParent || document.body;
      let x = 0;
      let y = 0;
      for (let node = els.menu; node && node !== parent; node = node.offsetParent) {
        x += node.offsetLeft;
        y += node.offsetTop;
      }
      // Носик — по возможности в 24 px от края меню. За край колонки меню
      // не выходит: там его обрезает; правый верхний угол у него поэтому
      // скруглён меньше, чтобы носик у самого края в скругление не упирался.
      const center = x + els.menu.offsetWidth / 2;
      const right = Math.max(0, parent.clientWidth - (center + 24));
      pop.style.right = `${right}px`;
      pop.style.top = `${y + els.menu.offsetHeight + 10}px`;
      pop.style.setProperty("--nose-x", `${parent.clientWidth - right - (x + els.menu.offsetWidth / 2)}px`);
    } else close();
  });
  pop.addEventListener("click", (event) => {
    const item = event.target.closest("[data-menu]");
    if (!item) return;
    haptic("select");
    pop.hidden = true;
    if (item.dataset.menu === "invite") inviteGroup(item);
    if (item.dataset.menu === "rooms") showFree();
    if (item.dataset.menu === "queues") openTab("queues");
    if (item.dataset.menu === "poll") openPollSheet();
    if (item.dataset.menu === "calendar") openCalendar();
    if (item.dataset.menu === "exams") openExams();
    if (item.dataset.menu === "settings") showPicker();
    if (item.dataset.menu === "absences") openAbsences();
    if (item.dataset.menu === "semester") openSemester();
    if (item.dataset.menu === "meet") openMeet();
  });
  if (!pop.querySelector('[data-menu="exams"]')) {
    const item = el("button");
    item.type = "button";
    item.dataset.menu = "exams";
    item.append(el("span", "", "🎓"), el("span", "", t("Сессия")));
    const semester = pop.querySelector('[data-menu="semester"]') || pop.querySelector('[data-menu="settings"]');
    if (semester) semester.before(item);
    else pop.append(item);
  }
  // Пункт календаря добавляем сами: в закэшированной старой разметке его нет.
  if (!pop.querySelector('[data-menu="calendar"]')) {
    const item = el("button");
    item.type = "button";
    item.dataset.menu = "calendar";
    item.append(el("span", "", "📅"), el("span", "", t("В календарь телефона")));
    const rooms = pop.querySelector('[data-menu="rooms"]');
    if (rooms) rooms.before(item);
    else pop.append(item);
  }
  if (!pop.querySelector('[data-menu="meet"]')) {
    const item = el("button");
    item.type = "button";
    item.dataset.menu = "meet";
    item.append(el("span", "", "🤝"), el("span", "", t("Когда пересечься")));
    const settings = pop.querySelector('[data-menu="settings"]');
    if (settings) settings.before(item);
    else pop.append(item);
  }
  // Пункт добавляем сами: в закэшированной старой разметке его нет.
  if (!pop.querySelector('[data-menu="semester"]')) {
    const item = el("button");
    item.type = "button";
    item.dataset.menu = "semester";
    item.append(el("span", "", "📊"), el("span", "", t("Мой семестр")));
    const settings = pop.querySelector('[data-menu="settings"]');
    if (settings) settings.before(item);
    else pop.append(item);
  }
  // Строка отсчёта под датой — тоже вход в статистику семестра.
  els.freedom?.addEventListener("click", () => {
    haptic("light");
    openSemester();
  });
  // Тап мимо меню закрывает его, как принято на телефонах.
  document.addEventListener("click", (event) => {
    if (!pop.hidden && !pop.contains(event.target)) close();
  });
}

/**
 * Смена содержимого как перелистывание страницы: старое уезжает в одну
 * сторону, новое въезжает с другой, вплотную. Раньше список стирался и
 * карточки проявлялись заново — на глаз это читалось как моргание.
 *
 * fromShift — где был палец: если день тянули свайпом, страница
 * продолжает движение с того места, а не прыгает в начало.
 */
function slideSwap(container, direction, render, fromShift = 0) {
  const parent = container.parentElement;
  const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  // Прошлый переход ещё не доиграл — снимаем его, иначе два призрака
  // наложатся и картинка задёргается при быстром листании.
  for (const old of parent?.querySelectorAll(":scope > .slide-ghost") || []) old.remove();
  for (const running of container.getAnimations()) running.cancel();
  if (!direction || !parent || reduce) {
    container.classList.add("no-cascade");
    render();
    return;
  }

  const width = container.offsetWidth || document.documentElement.clientWidth;
  const height = container.offsetHeight;
  // Старую страницу не перерисовываем, а переносим как есть в «призрака»
  // поверх того же места.
  const ghost = el("div", "slide-ghost");
  ghost.style.left = `${container.offsetLeft}px`;
  ghost.style.top = `${container.offsetTop}px`;
  ghost.style.width = `${width}px`;
  ghost.style.transform = `translateX(${fromShift}px)`;
  ghost.append(...container.childNodes);
  parent.append(ghost);

  // Высоту держим, пока идёт переход: иначе короткий день резко поднимет
  // низ страницы, прокрутка прыгнет — это и читалось как рывок.
  container.style.minHeight = `${height}px`;
  container.classList.add("no-cascade");
  render();

  // Новая страница стоит невидимой на старте, пока браузер не отрисовал её.
  // Анимацию запускаем через кадр: сборка дня тяжёлая, и если стартовать в
  // тот же кадр, первые кадры движения теряются — отсюда и рваность.
  const step = Math.min(28, width * 0.07);
  container.style.opacity = "0";
  container.style.transform = `translateX(${direction * step}px)`;

  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      container.style.opacity = "";
      container.style.transform = "";
      // «Проявление через»: старая страница быстро гаснет, чуть уходя в
      // сторону движения, новая плавно наплывает следом. Перекрытие короткое,
      // поэтому ни двух страниц разом, ни пустого экрана.
      ghost
        .animate(
          [
            { transform: `translateX(${fromShift}px)`, opacity: 1 },
            { transform: `translateX(${fromShift - direction * step}px)`, opacity: 0 },
          ],
          { duration: 130, easing: "cubic-bezier(0.4, 0, 1, 1)", fill: "forwards" }
        )
        .finished.catch(() => {})
        .finally(() => ghost.remove());
      container
        .animate(
          [
            { transform: `translateX(${direction * step}px)`, opacity: 0 },
            { transform: "translateX(0)", opacity: 1 },
          ],
          { duration: 280, delay: 70, easing: "cubic-bezier(0.2, 0.9, 0.3, 1)", fill: "backwards" }
        )
        .finished.catch(() => {})
        .finally(() => (container.style.minHeight = ""));
    })
  );
}

// Куда «уезжает» новый день при появлении: -1 — пришли справа, 1 — слева.
let enterFrom = 0;

/** Переход на соседний день: карточки въезжают с той стороны, куда листали. */
function goToDay(direction) {
  const next = dayIndex() + direction;
  if (next < 0 || next >= DAY_COUNT) return false;
  setDayIndex(next);
  enterFrom = direction;
  pendingLabel = direction;
  haptic("select");
  showSchedule();
  return true;
}

function initSwipe() {
  // Слушаем документ, а не блок расписания: у body есть отступ, и крайние
  // пиксели экрана блоку не принадлежат — именно туда и приходится
  // касание у края. Заодно решается случай пустого дня, где тянуть не за что.
  const strip = els.lessons;
  let pointer = null;
  let startX = 0;
  let startY = 0;
  let startTarget = null;
  let startedAt = 0;
  let shift = 0;
  let dragging = false;
  let decided = false;

  const release = () => {
    strip.style.transition = "";
    strip.style.transform = "";
    strip.style.opacity = "";
  };

  document.addEventListener("pointerdown", (event) => {
    if (els.schedule.hidden) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    // Полоса дней листается сама по себе, кнопки должны нажиматься.
    // Окно домашки лежит поверх расписания: печать в нём не должна листать дни.
    // Плашка праздника — кликер: тап у её края листал день, как в сторис.
    // Открыто окно — листать дни под ним нельзя, куда бы ни попал палец.
    if (document.body.classList.contains("sheet-open")) return;
    if (event.target.closest?.(".days, button, .sheet, .event")) return;
    if (sheetOpen()) return;
    // Развёрнута пара (или ещё закрывается) — дни не листаются.
    if (lessonViewBusy()) return;
    pointer = event.pointerId;
    startX = event.clientX;
    startY = event.clientY;
    startTarget = event.target;
    startedAt = performance.now();
    shift = 0;
    dragging = false;
    decided = false;
    strip.style.transition = "none";
  });

  document.addEventListener("pointermove", (event) => {
    if (event.pointerId !== pointer) return;
    const dx = event.clientX - startX;
    const dy = event.clientY - startY;

    // Пока непонятно, листают или прокручивают, не перехватываем: иначе
    // вертикальная прокрутка расписания сломается.
    if (!decided) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      decided = true;
      dragging = Math.abs(dx) > Math.abs(dy);
    }
    if (!dragging) return;

    // За краем ленты сопротивление растёт, но упора нет — так понятнее,
    // что дальше ничего нет, чем если бы палец просто упёрся в стену.
    const index = dayIndex();
    const atEdge =
      (dx > 0 && index === 0) || (dx < 0 && index === DAY_COUNT - 1);
    shift = atEdge ? dx * 0.25 : dx;

    strip.style.transform = `translateX(${shift.toFixed(1)}px)`;
    strip.style.opacity = String(1 - Math.min(Math.abs(shift) / 500, 0.35));
  });

  const finish = (event) => {
    if (event.pointerId !== pointer) return;
    pointer = null;

    if (!dragging) {
      // Палец не поехал — это касание. У края экрана листаем, как в сторис.
      const moved =
        Math.abs(event.clientX - startX) > TAP_SLOP ||
        Math.abs(event.clientY - startY) > TAP_SLOP;
      // Смотрим, на чём нажали, а не где отпустили: палец мог сместиться.
      const onControl = startTarget?.closest("summary, a, input, select, .link");
      if (!moved && !onControl) {
        const width = document.documentElement.clientWidth;
        const zone = width * TAP_ZONE;
        if (startX < zone) goToDay(-1);
        else if (startX > width - zone) goToDay(1);
      }
      release();
      return;
    }
    dragging = false;

    const velocity = Math.abs(shift) / Math.max(1, performance.now() - startedAt);
    const far = Math.abs(shift) > strip.clientWidth * SWIPE_DISTANCE;
    const direction = shift < 0 ? 1 : -1;

    const next = dayIndex() + direction;
    if ((far || velocity > SWIPE_VELOCITY) && next >= 0 && next < DAY_COUNT) {
      release();
      goToDay(direction);
      return;
    }

    // Не дотянули — возвращаем на место.
    strip.style.transition =
      "transform 240ms var(--ease-out), opacity 240ms var(--ease-out)";
    strip.style.transform = "translateX(0)";
    strip.style.opacity = "1";
    strip.addEventListener("transitionend", release, { once: true });
  };

  document.addEventListener("pointerup", finish);
  document.addEventListener("pointercancel", finish);
}

/** При открытии подводим к идущей паре, если она не попала на экран. */
let scrolledToNow = false;
function scrollToNow() {
  if (scrolledToNow) return;
  const card = els.lessons.querySelector(".card--now");
  if (!card) return;
  scrolledToNow = true;

  const box = card.getBoundingClientRect();
  if (box.top >= 0 && box.bottom <= window.innerHeight) return;
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  card.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "center" });
}

/** Минуты с полуночи для строки «09:00». */
function minutes(time) {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}

/**
 * Время пары. Часть занятий идёт не по сетке звонков и несёт своё время —
 * показывать для них звонок было бы враньём.
 */
function timesOf(lesson, bells) {
  if (lesson.start && lesson.end) return lesson;
  return bells.get(lesson.slot) || null;
}

/**
 * Какая пара идёт по часам телефона и насколько она прошла.
 * Только для сегодняшнего дня — в чужом дне «сейчас» не существует.
 */
function currentLesson(belongs = () => true) {
  if (!data || isoDate(dateOfDay(selectedDay)) !== isoDate(new Date())) return null;

  const now = new Date();
  const nowMinutes = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;

  // Идём по парам этой группы, а не по звонкам: звонок звенит для всех, но
  // пары в это время может не быть, а у части занятий время своё.
  const bells = new Map(data.bells.map((b) => [b.n, b]));
  for (const lesson of visible) {
    if (!belongs(lesson)) continue;
    const time = timesOf(lesson, bells);
    if (!time || lessonCancel(lesson)) continue;
    const start = minutes(time.start);
    const end = minutes(time.end);
    if (nowMinutes >= start && nowMinutes <= end) {
      return {
        slot: lesson.slot,
        elapsed: nowMinutes - start,
        total: end - start,
        left: end - nowMinutes,
      };
    }
  }
  return null;
}

/** «47 мин», «1 ч 5 мин» — сколько осталось до конца пары. */
function humanLeft(value) {
  const left = Math.max(0, Math.round(value));
  if (left < 1) return t("меньше минуты");
  const hours = Math.floor(left / 60);
  const rest = left % 60;
  if (hours && rest) return t("{h} ч {m} мин", { h: hours, m: rest });
  if (hours) return t("{h} ч", { h: hours });
  return t("{m} мин", { m: rest });
}

// Пары показанного дня после фильтров — нужны и для «дальше», и для «сейчас».
let visible = [];

/** Ближайшая пара сегодня, которая ещё не началась. */
/**
 * Та же пара шла номером раньше — значит, это продолжение, а не новая.
 * Отменённая предыдущая не в счёт: после неё пара начинается заново.
 */
function continuesPrevious(lesson) {
  if (lesson.start) return false;
  // Продолжение пропускаем, только пока предыдущая пара того же блока ещё
  // идёт. В перемене внутри блока следующая пара — и есть ближайшая, иначе
  // строка писала бы «Пары закончились» посреди дня.
  const now = new Date();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const bells = new Map(data.bells.map((b) => [b.n, b]));
  const same = (l, slot) =>
    l.slot === slot &&
    !l.start &&
    l.subject === lesson.subject &&
    l.room === lesson.room &&
    l.teacher === lesson.teacher &&
    (l.subgroup || 0) === (lesson.subgroup || 0) &&
    !lessonCancel(l);

  // Идём назад по цепочке одинаковых пар: 6-я — продолжение, если идёт 4-я,
  // а 5-я ещё впереди. Закончившаяся пара рвёт цепочку: значит, сейчас
  // перемена, и ближайшая пара — настоящая «следующая».
  for (let slot = lesson.slot - 1; slot >= 1; slot--) {
    const prev = visible.find((l) => same(l, slot));
    if (!prev) return false;
    const time = timesOf(prev, bells);
    if (!time) return false;
    if (nowMinutes >= minutes(time.end)) return false;
    if (nowMinutes >= minutes(time.start)) return true;
  }
  return false;
}

/** Когда кончаются сегодняшние пары — самое позднее окончание неотменённой. */
function lastEndToday() {
  const bells = new Map(data.bells.map((b) => [b.n, b]));
  let last = null;
  for (const lesson of visible) {
    const time = timesOf(lesson, bells);
    if (!time || lessonCancel(lesson)) continue;
    if (!last || minutes(time.end) > minutes(last)) last = time.end;
  }
  return last;
}

function nextLesson() {
  if (isoDate(dateOfDay(selectedDay)) !== isoDate(new Date())) return null;

  const now = new Date();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const bells = new Map(data.bells.map((b) => [b.n, b]));

  let best = null;
  for (const lesson of visible) {
    const time = timesOf(lesson, bells);
    if (!time || lessonCancel(lesson)) continue;
    const start = minutes(time.start);
    if (start <= nowMinutes) continue;
    // Продолжение той же склеенной карточки («1–6 пара») — не «следующая пара».
    if (continuesPrevious(lesson)) continue;
    if (!best || start < best.start) best = { lesson, start };
  }
  return best && { ...best, left: best.start - nowMinutes };
}

/** Строка «дальше» под днями: что и через сколько. */
function refreshNext() {
  const today = isoDate(dateOfDay(selectedDay)) === isoDate(new Date());
  if (!today || !visible.length) {
    els.next.hidden = true;
    return;
  }

  els.next.hidden = false;
  if (visible.every((lesson) => lessonCancel(lesson))) {
    els.next.textContent = t("Все пары на сегодня отменены");
    return;
  }

  const upcoming = nextLesson();

  if (!upcoming) {
    if (!currentLesson()) {
      els.next.textContent = t("Пары закончились");
      return;
    }
    // Новых пар нет, но идущий блок ещё не кончился («1–6 пара»): это не
    // «последняя пара», а пары до такого-то времени.
    const now = new Date();
    const end = lastEndToday();
    const current = currentLesson();
    const blockContinues = end && minutes(end) > now.getHours() * 60 + now.getMinutes() + current.left;
    els.next.textContent = blockContinues
      ? t("Пары до {time}", { time: end })
      : t("Это последняя пара");
    return;
  }

  const where = upcoming.lesson.room ? `, ${roomLabel(upcoming.lesson.room)}` : "";
  els.next.replaceChildren(
    el("span", "next-when", t("через {time}", { time: humanLeft(upcoming.left) })),
    el("span", null, `${tr(upcoming.lesson.subject)}${where}`)
  );
}

/**
 * Подсвечивает идущую пару. Работает поверх готовых карточек, а не через
 * перерисовку: иначе список заново проигрывал бы появление каждую минуту.
 */
/** Линия между началом и концом пары: сколько уже прошло. */
function refreshLines() {
  const today = isoDate(dateOfDay(selectedDay)) === isoDate(new Date());
  const clock = new Date();
  const now = clock.getHours() * 60 + clock.getMinutes() + clock.getSeconds() / 60;
  for (const card of els.lessons.querySelectorAll(".card")) {
    const fill = card.querySelector(".card-line-fill");
    if (!fill) continue;
    const start = card.dataset.start && minutes(card.dataset.start);
    const end = card.dataset.end && minutes(card.dataset.end);
    let part = 0;
    if (today && start != null && end > start && !card.classList.contains("card--cancelled")) {
      part = Math.min(1, Math.max(0, (now - start) / (end - start)));
    }
    // Высотой, а не масштабом: на конце заливки стоит точка, и масштаб
    // сплющил бы её вместе с полосой.
    fill.style.height = `${(part * 100).toFixed(2)}%`;
    card.classList.toggle("card--past", today && part >= 1);
    card.classList.toggle("card--running", today && part > 0 && part < 1);
  }
  // Все пары сегодня позади — «на сегодня всё» превращается в закат.
  const cards = [...els.lessons.querySelectorAll(".card[data-start]")];
  const over = today && cards.length > 0 && cards.every((card) => card.classList.contains("card--past") || card.classList.contains("card--cancelled"));
  els.lessons.classList.toggle("day-over", over);
  const title = els.lessons.querySelector(".dayend-title");
  if (title) {
    if (!title.dataset.idle) title.dataset.idle = title.textContent;
    title.textContent = over ? t("Пары закончились — хорошего вечера") : title.dataset.idle;
  }
  if (over && !els.lessons.querySelector(".dayend-sun")) {
    els.lessons.querySelector(".dayend-mark")?.append(el("span", "dayend-sun"));
  }
}

function refreshNow() {
  refreshLines();
  if (skyLayer) {
    document.body.dataset.daypart = daypart();
    placeSky();
  }
  const today = isoDate(dateOfDay(selectedDay)) === isoDate(new Date());
  const clockNow = new Date();
  const nowMinutes = clockNow.getHours() * 60 + clockNow.getMinutes() + clockNow.getSeconds() / 60;

  // Перемена или обед между карточками, которые идут прямо сейчас: строка
  // оживает — точка пульсирует, линии заполняются по ходу перемены.
  for (const gap of els.lessons.querySelectorAll(".gap")) {
    const from = gap.dataset.from ? minutes(gap.dataset.from) : null;
    const to = gap.dataset.to ? minutes(gap.dataset.to) : null;
    const inside = today && from != null && nowMinutes >= from && nowMinutes < to;
    const text = gap.querySelector(".gap-text");
    if (text && !text.dataset.idle) text.dataset.idle = text.textContent;
    gap.classList.toggle("gap--now", inside);
    if (!inside) {
      if (text) text.textContent = text.dataset.idle;
      gap.style.removeProperty("--gap-done");
      continue;
    }
    const left = Math.max(1, Math.ceil(to - nowMinutes));
    const long = gap.classList.contains("gap--long");
    text.textContent = t(long ? "☕ обед · ещё {n} мин" : "идёт перемена · ещё {n} мин", { n: left });
    gap.style.setProperty("--gap-done", String(Math.min(1, (nowMinutes - from) / (to - from))));
  }

  // Окно, которое идёт сейчас: дышит, как текущая пара, заполняется по ходу
  // и показывает, сколько осталось до следующей пары.
  for (const win of els.lessons.querySelectorAll(".window")) {
    const from = win.dataset.from ? minutes(win.dataset.from) : null;
    const to = win.dataset.to ? minutes(win.dataset.to) : null;
    const inside = today && from != null && nowMinutes >= from && nowMinutes < to;
    const label = win.querySelector(".window-label");
    win.classList.toggle("window--now", inside);
    if (!inside) {
      if (label) label.textContent = t("ОКНО");
      win.style.removeProperty("--win-done");
      continue;
    }
    const left = Math.max(1, Math.ceil(to - nowMinutes));
    if (label) label.textContent = t("окно · ещё {n} мин", { n: left });
    win.style.setProperty("--win-done", String(Math.min(1, (nowMinutes - from) / (to - from))));
  }

  for (const card of els.lessons.querySelectorAll(".card")) {
    // Идёт ли пара именно этой карточки — по её собственному времени. Номер
    // пары у всей группы общий, а время бывает своё: русский 12:15–14:45 идёт
    // в большую перемену, когда 3 пара военки ещё не началась.
    const slots = cardSlots(card);
    const current = currentLesson(
      (lesson) => lesson.subject === card.dataset.subject && slots.includes(lesson.slot)
    );
    let isNow = Boolean(current);

    // Внутри склеенной карточки: какая из пар идёт, или сейчас перемена.
    let pause = null;
    for (const row of card.querySelectorAll(".segment")) {
      row.classList.toggle("segment--now", Boolean(isNow && Number(row.dataset.slot) === current.slot));
    }
    for (const row of card.querySelectorAll(".segment-break")) {
      const inside =
        today &&
        !card.classList.contains("card--cancelled") &&
        nowMinutes >= minutes(row.dataset.from) &&
        nowMinutes < minutes(row.dataset.to);
      row.classList.toggle("segment-break--now", inside);
      if (inside) pause = row;
    }
    if (pause) isNow = true;
    card.classList.toggle("card--now", Boolean(isNow));

    let badge = card.querySelector(".now");
    let bar = card.querySelector(".now-bar");

    if (!isNow) {
      badge?.remove();
      bar?.remove();
      continue;
    }

    if (pause) {
      // Перемена: полоска прогресса пары здесь врала бы, убираем.
      bar?.remove();
      if (!badge) {
        badge = el("div", "now");
        badge.append(el("span", "now-dot"), el("span", "now-label"), el("span", "now-left"));
        (card.querySelector(".card-body") || card).append(badge);
      }
      badge.querySelector(".now-label").textContent = t("идёт перемена");
      badge.querySelector(".now-left").textContent = t("до {time}", { time: pause.dataset.to });
      continue;
    }

    if (!badge) {
      badge = el("div", "now");
      badge.append(
        el("span", "now-dot"),
        el("span", "now-label"),
        el("span", "now-left")
      );
      // Именно в тело карточки: сама карточка — горизонтальный ряд, и
      // строка, добавленная в неё, встала бы третьей колонкой рядом с
      // плашкой аудитории.
      (card.querySelector(".card-body") || card).append(badge);
    }
    badge.querySelector(".now-label").textContent = t("идёт сейчас");
    badge.querySelector(".now-left").textContent = t("осталось {time}", {
      time: humanLeft(current.left),
    });
    setNowRing(badge, current.total ? current.elapsed / current.total : 0);

    if (!bar) {
      bar = el("div", "now-bar");
      card.append(bar);
      // WAAPI: идёт на компоновщике, как CSS-анимация, но позицию можно
      // выставить по часам.
      bar.animate(
        [{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }],
        { duration: current.total * 60_000, fill: "forwards", easing: "linear" }
      );
    }
    // Сверяем с часами на каждом обновлении: пока приложение свёрнуто,
    // таймлайн анимаций стоит, и полоса отстала бы от реального времени.
    const [animation] = bar.getAnimations();
    if (animation) animation.currentTime = current.elapsed * 60_000;
  }
  renderRibbon();
  renderNowCard();
}

/**
 * Строка перемены между двумя карточками. Нет смысла рисовать её, если
 * пары идут в одно время (разные предметы параллельно) или время неизвестно.
 */
function breakBetween(prev, next) {
  const end = prev.dataset.end;
  const start = next.dataset.start;
  if (!end || !start) return null;
  const gap = minutes(start) - minutes(end);
  if (gap <= 0) return null;
  const long = gap >= LONG_BREAK;
  const node = el("div", long ? "gap gap--long" : "gap");
  // Время перемены — чтобы оживить строку, когда перемена идёт сейчас.
  node.dataset.from = end;
  node.dataset.to = start;
  node.append(
    el("span", "gap-line"),
    el("span", "gap-dot"),
    el("span", "gap-text", t(long ? "обед · {n} мин" : "перемена · {n} мин", { n: gap })),
    el("span", "gap-line")
  );
  return node;
}

function renderWindow(slot, bell) {
  const node = el("div", "window");
  node.append(el("span", "window-slot", t("{n} пара", { n: slot })));
  node.append(el("span", "window-label", t("ОКНО")));
  if (bell) {
    node.append(el("span", "window-time", `${bell.start} – ${bell.end}`));
    // Время окна — чтобы оживить его, когда оно идёт сейчас.
    node.dataset.from = bell.start;
    node.dataset.to = bell.end;
  }
  return node;
}

// «дистант» и «вирт» — не аудитории, приписывать к ним «ауд.» незачем.
const REMOTE_ROOMS = ["дистант", "дистанционно", "онлайн", "вирт"];

function roomLabel(room) {
  if (!room) return "";
  if (REMOTE_ROOMS.includes(room.toLowerCase())) return t(room);
  // «В.каф.», «с/база» — не номера: в переводе это слова, «ауд.» к ним не пишем.
  const named = t(room);
  return named !== room ? named : t("ауд. {room}", { room });
}

function describe(lesson) {
  return [t(lesson.type), lesson.teacher, roomLabel(lesson.room)]
    .filter(Boolean)
    .join(" · ");
}

/**
 * Строка под названием. Аудиторию сюда не пишем, когда она вынесена в
 * отдельную плашку справа — иначе она стояла бы дважды.
 */
function metaLine(lesson, prefix = "", withRoom = true) {
  const line = el("div", "meta");
  const before = [prefix, t(lesson.type), lesson.teacher].filter(Boolean).join(" · ");
  if (before) line.append(document.createTextNode(before));

  const room = withRoom ? roomLabel(lesson.room) : "";
  if (room) {
    if (before) line.append(document.createTextNode(" · "));
    line.append(el("span", "room", room));
  }
  return line;
}

/**
 * Аудитория отдельной плашкой справа. Когда бегут на пару, глазами ищут
 * именно её, а в общей серой строке она терялась. Вынесенная вправо, она
 * ещё и читается колонкой при пролистывании дня.
 */
function roomBadge(room) {
  const badge = el("div", "room-badge");
  const named = t(room);
  if (REMOTE_ROOMS.includes(room.toLowerCase()) || named !== room) {
    badge.classList.add("room-badge--remote");
    badge.textContent = named;
  } else {
    badge.append(el("span", "room-badge-label", t("ауд.")), el("span", null, room));
  }
  // Длинные имена вроде «П6 1 ГУМ» набираем мельче, чтобы плашка не росла.
  if (named.length > 5) badge.classList.add("room-badge--long");
  return badge;
}

// Большая перемена — обеденная: её стоит выделить, по ней планируют день.
const LONG_BREAK = 30;

/** Пары склеенной карточки и перемены между ними. */
function renderSegments(slots, bells) {
  const list = el("div", "segments");
  slots.forEach((slot, i) => {
    const bell = bells.get(slot);
    if (!bell) return;
    if (i > 0) {
      const prev = bells.get(slots[i - 1]);
      const gap = prev ? minutes(bell.start) - minutes(prev.end) : 0;
      if (gap > 0) {
        const pause = el("div", gap >= LONG_BREAK ? "segment-break segment-break--long" : "segment-break");
        pause.dataset.from = prev.end;
        pause.dataset.to = bell.start;
        pause.append(
          el(
            "span",
            null,
            gap >= LONG_BREAK
              ? t("большая перемена · {m} мин", { m: gap })
              : t("перемена · {m} мин", { m: gap })
          )
        );
        list.append(pause);
      }
    }
    const row = el("div", "segment");
    row.dataset.slot = slot;
    row.append(
      el("span", "segment-slot", t("{n} пара", { n: slot })),
      el("span", "segment-time", `${bell.start} – ${bell.end}`)
    );
    list.append(row);
  });
  return list;
}

/** «2 подгруппы», «5 подгрупп» — по-русски склоняем, у переводов своё. */
function subgroupsLabel(n) {
  if (LANG !== "ru") return t("{n} подгрупп — показать", { n });
  const tens = n % 100;
  const ones = n % 10;
  const word = tens >= 11 && tens <= 14 ? "подгрупп" : ones === 1 ? "подгруппа" : ones >= 2 && ones <= 4 ? "подгруппы" : "подгрупп";
  return `${n} ${word} — показать`;
}

// Пары в стилистике «Локомотива» — по просьбе 3 курса ФГП.
const LOKO_SUBJECTS = new Set(["Деловой протокол и этикет"]);

function renderCard(entries, bells, slots = [entries[0].slot]) {
  const first = entries[0];
  const bell = timesOf(first, bells);
  const lastBell = bells.get(slots[slots.length - 1]);

  // Дисциплины по выбору и межфакультетские курсы выделены цветом: их
  // посещают не все, и в общем списке их надо отличать с одного взгляда.
  let kind = "";
  if (LOKO_SUBJECTS.has(first.subject) && tenantId() === DEFAULT_TENANT) kind = " card--loko";
  else if (isMfkLesson(first.subject)) kind = " card--mfk";
  else if (first.elective === ELECTIVE) kind = " card--elective";
  else if (first.elective) kind = " card--optional";
  const card = el("article", `card${kind}`);
  card.dataset.slot = first.slot;
  card.dataset.slots = slots.join(",");
  card.dataset.subject = first.subject;
  paintSubject(card);
  card.dataset.subgroups = [...new Set(entries.map((e) => e.subgroup).filter(Boolean))].join(",");
  card.dataset.teachers = entries.map((e) => e.teacher || "").join(" | ");
  card.dataset.type = first.type || "";

  const head = el("div", "time");
  const range = slots.length > 1;
  head.append(
    el(
      "span",
      "slot",
      range
        ? t("{from}–{to} пара", { from: slots[0], to: slots[slots.length - 1] })
        : t("{n} пара", { n: first.slot })
    )
  );
  // Время — отдельной колонкой слева, как в таймлайне: начало крупно,
  // конец под ним. Так день читается сверху вниз по часам.
  // Колонка слева: начало наверху, конец внизу, между ними линия — она же
  // полоса прогресса, пока пара идёт.
  const when = el("div", "card-when");
  if (bell) {
    const end = range && lastBell ? lastBell.end : bell.end;
    const line = el("span", "card-line");
    line.append(el("span", "card-line-fill"));
    when.append(el("span", "card-start", bell.start), line, el("span", "card-end", end));
    card.dataset.start = bell.start;
    card.dataset.end = end;
  }
  if (isMfkLesson(first.subject)) head.append(el("span", "tag", t("МФК")));
  else if (first.elective) head.append(el("span", "tag", t(first.elective)));
  // Аудитория выносится вправо отдельной плашкой — но только когда она одна
  // на всю карточку. У подгрупп аудитории разные, и в списке они остаются.
  const single = entries.length === 1;
  const body = el("div", "card-body");
  body.append(head, el("div", "subject", withFlag(first.subject)));

  if (single) {
    body.append(metaLine(first, "", false));
  } else {
    const details = el("details", "subgroups");
    details.append(el("summary", null, subgroupsLabel(entries.length)));
    for (const entry of entries) {
      details.append(metaLine(entry, entry.subgroup ? t("гр. {n}", { n: entry.subgroup }) : ""));
    }
    body.append(details);
  }

  // Склеенная карточка: пары по отдельности и перемены между ними. Без этого
  // «1–6 пара · 09:00–19:40» выглядело бы как одно занятие на десять часов.
  if (range) {
    card.classList.add("card--range");
    body.append(renderSegments(slots, bells));
  }

  const notes = [...new Set(entries.map((e) => e.note).filter(Boolean))];
  if (notes.length) body.append(el("div", "note", notes.map(trNote).join("; ")));

  // Занятие на удалёнке — ссылка на встречу прямо в карточке.
  const link = entries.find((e) => e.link)?.link;
  if (link) {
    const button = el("button", "link", t("Подключиться"));
    button.type = "button";
    button.addEventListener("click", () => {
      if (tg?.openLink) tg.openLink(link);
      else window.open(link, "_blank", "noopener");
    });
    body.append(button);
  }

  card.append(when, body);
  // Аудитория — маленькой плашкой в правом нижнем углу, на одной линии со
  // временем конца пары: низ карточки читается как «до скольких и где».
  if (single && first.room) {
    card.classList.add("card--room");
    const badge = roomBadge(first.room);
    // Нажатие на аудиторию — где это на карте.
    if (!badge.classList.contains("room-badge--remote")) {
      badge.setAttribute("role", "button");
      badge.addEventListener("click", (event) => {
        event.stopPropagation();
        haptic("light");
        openRoomMap(first.room);
      });
    }
    card.append(badge);
  }
  return card;
}

/* ---------- Обновление версии ---------- */

// Ярлык на экране айфона iOS не перезагружает: при возврате показывает
// страницу из памяти, и студент сидит на старой версии, пока не выгрузит
// приложение. Поэтому сверяем дату index.html на сервере с датой той
// страницы, что загружена сейчас, и перезагружаемся сами. Запрос идёт к
// GitHub Pages — нагрузки на бота нет.
const UPDATE_CHECK_INTERVAL = 5 * 60_000;
const RELOADED_KEY = "schedule.reloadedFor";
let lastUpdateCheck = 0;

async function serverPageDate() {
  try {
    const res = await fetch(location.pathname, { method: "HEAD", cache: "no-store" });
    const header = res.ok && res.headers.get("last-modified");
    return header ? Date.parse(header) : null;
  } catch {
    return null;
  }
}

async function checkForUpdate() {
  // Вне сайта (локальный файл) и чаще раза в пять минут не проверяем.
  if (!location.protocol.startsWith("http")) return;
  const now = Date.now();
  if (now - lastUpdateCheck < UPDATE_CHECK_INTERVAL) return;
  lastUpdateCheck = now;

  const server = await serverPageDate();
  // Дата загруженной страницы. Без заголовка браузер ставит «сейчас» —
  // тогда сервер окажется старше, и мы ничего не сделаем: безопасно.
  const loaded = Date.parse(document.lastModified);
  if (!server || !loaded || server <= loaded + 2000) return;

  // Если после перезагрузки кэш опять отдал старое, второй раз не пробуем:
  // иначе страница перезагружалась бы бесконечно.
  try {
    if (sessionStorage.getItem(RELOADED_KEY) === String(server)) return;
    sessionStorage.setItem(RELOADED_KEY, String(server));
  } catch {
    return;
  }
  // Не перезагружаем посреди ввода домашки или настроек — проверим позже.
  if (sheetOpen() || !els.picker.hidden) {
    lastUpdateCheck = 0;
    try {
      sessionStorage.removeItem(RELOADED_KEY);
    } catch {}
    return;
  }
  // Свежая страница мимо кэша: метка в адресе, как у app.js и style.css.
  const url = new URL(location.href);
  url.searchParams.set("v", String(server));
  location.replace(url);
}

/* ---------- Приветствие на заставке ---------- */

// Над датой — пара тёплых слов по времени суток.
// Владелец может написать человеку или группе своё (/hello у бота): оно
// приходит вместе с объявлениями и запоминается, чтобы в следующий раз
// появиться с первого кадра, не дожидаясь сети.
const HELLO_KEY = "schedule.hello";
const HELLO_WISHES = [
  "Пусть пары пролетят незаметно",
  "Лёгкого дня и добрых преподавателей",
  "Пусть сегодня всё получится",
  "Сил, кофе и хорошего настроения",
  "Пусть спросят то, что вы знаете",
  "Хорошего дня — он будет что надо",
  "Пусть в столовой не будет очереди",
];

// Преподавателю студенческие пожелания не годятся: «добрых преподавателей»
// и «пусть спросят то, что вы знаете» — не про него.
const HELLO_TEACHER = [
  "Пусть аудитория будет внимательной",
  "Лёгких пар и сильных вопросов",
  "Пусть все придут подготовленными",
  "Сил, кофе и хорошего настроения",
  "Пусть проектор заработает с первого раза",
  "Хорошего дня — он будет что надо",
];

/** Режим преподавателя — из сохранённых настроек: приложение их ещё не разобрало. */
function helloTeacher() {
  try {
    return Boolean(JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}")?.teacher);
  } catch {
    return false;
  }
}

function helloName() {
  return String(tg?.initDataUnsafe?.user?.first_name || "").trim().slice(0, 24);
}

function helloLines() {
  const name = helloName();
  let custom = "";
  try {
    custom = localStorage.getItem(HELLO_KEY) || "";
  } catch {
    // Без памяти — обычное приветствие.
  }
  if (custom) {
    // Имени может не быть (открыли вне Telegram) — тогда убираем и осиротевшие
    // запятые: «{имя}, удачи!» становится «Удачи!», а не «, удачи!».
    let filled = custom.replace(/{имя}|{name}/gi, name).replace(/ +([,!.?])/g, "$1");
    if (!name) filled = filled.replace(/^[\s,]+/, "").replace(/,\s*([!.?])/g, "$1");
    filled = filled.trim();
    return { title: filled.charAt(0).toUpperCase() + filled.slice(1), wish: "", custom: true };
  }
  const now = new Date();
  const hour = now.getHours();
  const hi = hour >= 5 && hour < 11 ? "Доброе утро" : hour < 17 ? "Добрый день" : hour < 23 ? "Добрый вечер" : "Доброй ночи";
  // Пожелание своё на каждый день, а не на каждое открытие.
  const wish =
    hour >= 20 || hour < 5
      ? "Отдыхайте — завтра всё успеется"
      : (() => {
          const list = helloTeacher() ? HELLO_TEACHER : HELLO_WISHES;
          return list[(now.getDate() * 5 + now.getMonth()) % list.length];
        })();
  // Без имени: в Telegram там часто ник, а не имя, и «Доброе утро, xX_fox_Xx!»
  // звучит странно. Имя остаётся только в надписи владельца — через {имя}.
  return { title: `${t(hi)}!`, wish: t(wish), custom: false };
}

/** Слова выезжают по одному — надпись как будто произносится. */
function renderHello() {
  const splash = els.splash;
  if (!splash || !splash.isConnected) return;
  let box = splash.querySelector(".splash-hello");
  if (!box) {
    box = el("div", "splash-hello");
    splash.prepend(box);
  }
  const { title, wish, custom } = helloLines();
  const key = `${title}|${wish}`;
  if (box.dataset.key === key) return;
  box.dataset.key = key;
  box.classList.toggle("splash-hello--custom", custom);
  let index = 0;
  const words = (text, cls) => {
    const line = el("div", cls);
    for (const word of text.split(/\s+/).filter(Boolean)) {
      const span = el("span", "", word);
      span.style.setProperty("--w", index++);
      line.append(span, " ");
    }
    return line;
  };
  // На заставке — только приветствие и дата, без пожелания.
  box.replaceChildren(words(title, "splash-hello-title"));
}

/** Надпись от владельца пришла — запоминаем; если заставка ещё на экране, меняем сразу. */
function saveHello(text) {
  try {
    if (text) localStorage.setItem(HELLO_KEY, text);
    else localStorage.removeItem(HELLO_KEY);
  } catch {
    // Не запомнилось — покажем в этот раз, если успеем.
  }
  renderHello();
}

renderHello();

/* ---------- Заставка: день собирается из точек ---------- */

// Не короче: иначе сборка и приветствие не успевают прочитаться. Кто уже
// заходил, видел их не раз — ему заставка короче.
const SPLASH_MIN = document.body.dataset.returning ? 1000 : 1700;
const SPLASH_MAX = 3200; // и не дольше, даже если сеть тормозит
const splashStarted = performance.now();

/**
 * Пары ближайшего учебного дня как отрезки времени — из них и собирается
 * полоса. Сегодня пары кончились или воскресенье — берём следующий день.
 */
/**
 * Пары дня так, как их показывает расписание: одинаковые пары подряд —
 * один блок, параллельные (языки, подгруппы) — одно время. Раньше заставка
 * и точки под датами считали каждую пару отдельно и расходились с
 * карточками: военная кафедра на весь день давала шесть точек вместо одной.
 */
function dayBlocks(group, day, week) {
  const date = dateOfDay(day, week);
  const bells = new Map(data.bells.map((b) => [b.n, b]));
  let list = ownLessonsForDay(group, day, week);
  list = list.filter((lesson) => !lessonCancelOn(lesson, isoDate(date))).sort((a, b) => a.slot - b.slot);

  const bySlot = new Map();
  for (const lesson of list) {
    if (!bySlot.has(lesson.slot)) bySlot.set(lesson.slot, new Map());
    const buckets = bySlot.get(lesson.slot);
    if (!buckets.has(lesson.subject)) buckets.set(lesson.subject, []);
    buckets.get(lesson.subject).push(lesson);
  }

  // Та же склейка, что у карточек в renderLessons.
  const runs = [];
  const open = new Map();
  for (const slot of [...bySlot.keys()].sort((a, b) => a - b)) {
    for (const [subject, entries] of bySlot.get(slot)) {
      const signature = isLanguage(subject) ? null : lessonSignature(entries);
      const run = open.get(subject);
      if (signature && run && run.signature === signature && run.slots.at(-1) === slot - 1) {
        run.slots.push(slot);
      } else {
        const fresh = { entries, signature, slots: [slot] };
        open.set(subject, fresh);
        runs.push(fresh);
      }
    }
  }

  // Время блока — как на карточке: начало первой пары, конец последней.
  const byStart = new Map();
  for (const run of runs) {
    const time = timesOf(run.entries[0], bells);
    if (!time) continue;
    const last = run.slots.length > 1 ? bells.get(run.slots.at(-1)) : null;
    const block = { start: time.start, end: last ? last.end : time.end };
    const known = byStart.get(block.start);
    if (!known || minutes(block.end) > minutes(known.end)) byStart.set(block.start, block);
  }
  return [...byStart.values()].sort((a, b) => minutes(a.start) - minutes(b.start));
}

/**
 * Заставка собирает ровно тот день, на котором откроется расписание. Раньше
 * вечером она показывала завтрашний, а под ней открывался сегодняшний — и
 * точек было не столько, сколько пар на экране.
 */
function splashDayPlan() {
  const group = activeGroup();
  if (!group || !data) return null;
  const times = dayBlocks(group, selectedDay, selectedWeek);
  return times.length ? { date: dateOfDay(selectedDay), times } : null;
}

// Сколько летит комета через весь день — совпадает с переходом в CSS.
const COMET_FLIGHT = 600;

/**
 * Сборка: на полосу по одной падают все пары дня, кроме последней. Потом
 * через весь день пролетает комета, долетает до правого края и сама
 * становится последней парой. Точек и толчков вибрации ровно столько,
 * сколько пар в расписании.
 */
function assembleSplash(plan) {
  const track = els.splashTrack;
  if (!track) return 0;
  track.classList.add("splash-track--ready");

  if (!plan) {
    // Группа ещё не выбрана — показывать нечего, сразу к настройкам.
    if (!activeGroup()) {
      els.splashDay.textContent = "";
      els.splash.classList.add("splash--free");
      return 0;
    }
    return assembleFreeSplash();
  }

  const label = FULL_DATE.format(plan.date);
  const holiday = eventOn(isoDate(plan.date));
  const icon = holiday && holiday.ours(activeGroup()) ? ` ${holiday.icon}` : "";
  els.splashDay.textContent = label[0].toUpperCase() + label.slice(1) + icon;

  const times = plan.times.slice(0, 8);
  // Шкала — от первой пары до последней: последняя стоит ровно у правого
  // края, туда и прилетает комета. Одна пара — она посередине.
  const from = minutes(times[0].start);
  const span = minutes(times.at(-1).start) - from;
  const place = (time) => (span > 0 ? ((minutes(time.start) - from) / span) * 100 : 50);

  const landing = (dot, i) => {
    dot.style.setProperty("--fly-x", `${(i % 2 ? 1 : -1) * (18 + i * 6)}px`);
    dot.style.setProperty("--fly-y", `${26 + (i % 3) * 10}px`);
    dot.style.animationDelay = `${120 + i * 110}ms`;
    // Щелчок вибрации — в момент приземления, а не старта: так точки
    // ощущаются пальцем, как будто падают на экран.
    setTimeout(() => haptic("soft"), 120 + i * 110 + 300);
  };

  // Одна пара — просто падает на середину, комете лететь некуда.
  if (times.length === 1) {
    const dot = el("span", "splash-dot splash-dot--pair");
    dot.style.left = "50%";
    landing(dot, 0);
    track.append(dot);
    showSplashTimes(plan, 520);
    return 1100;
  }

  const dots = times.slice(0, -1).map((time, i) => {
    const dot = el("span", "splash-dot splash-dot--pair");
    dot.style.left = `${place(time)}%`;
    landing(dot, i);
    return dot;
  });
  track.append(...dots);

  // Комета стартует, когда последняя из упавших точек легла на место.
  const fillAt = 120 + dots.length * 110 + 280;
  els.splashFill.style.transitionDelay = `${fillAt}ms`;
  if (els.splashComet) els.splashComet.style.transitionDelay = `${fillAt}ms`;
  requestAnimationFrame(() => track.classList.add("splash-track--fill"));

  // Долетела — гаснет и оставляет на своём месте последнюю пару.
  setTimeout(() => {
    track.classList.add("splash-track--landed");
    const last = el("span", "splash-dot splash-dot--pair splash-dot--comet");
    last.style.left = "100%";
    track.append(last);
    haptic("soft");
  }, fillAt + COMET_FLIGHT);

  showSplashTimes(plan, fillAt + 200);
  return fillAt + COMET_FLIGHT + 420;
}

/**
 * Заставка свободного дня — своя сцена вместо полосы с парами: от центра
 * расходятся три кольца, каждое отдаётся в пальцы чуть сильнее прошлого, а
 * в середину выпрыгивает значок дня. Дата остаётся на месте — сцена
 * встаёт под ней, там, где у учебного дня летит комета.
 */
function assembleFreeSplash() {
  const splash = els.splash;
  splash.classList.add("splash--free");
  const date = dateOfDay(selectedDay);
  const [emoji, title] = freeDayPhrase(date);
  const scene = el("div", "splash-free");
  const rect = els.splashTrack.getBoundingClientRect();
  scene.style.top = `${Math.round(rect.top + rect.height / 2)}px`;
  for (let i = 0; i < 3; i++) {
    const ring = el("span", "splash-free-ring");
    ring.style.setProperty("--i", i);
    scene.append(ring);
  }
  for (let i = 0; i < 8; i++) {
    const ray = el("span", "splash-free-ray");
    ray.style.setProperty("--a", `${i * 45}deg`);
    scene.append(ray);
  }
  scene.append(el("span", "splash-free-emoji", emoji), el("span", "splash-free-title", title));
  splash.append(scene);
  // Три толчка по нарастающей — и короткий «успех», когда значок встал.
  ["soft", "light", "medium"].forEach((kind, i) => setTimeout(() => haptic(kind), 120 + i * 170));
  setTimeout(() => haptic("success"), 760);
  return 1500;
}

/** Время начала и конца дня под полосой. */
function showSplashTimes(plan, delay) {
  els.splashTimes.replaceChildren(
    el("span", null, plan.times[0].start),
    el("span", null, plan.times.at(-1).end)
  );
  els.splashTimes.style.transitionDelay = `${delay}ms`;
  requestAnimationFrame(() => els.splashTimes.classList.add("splash-times--on"));
}

/** Уходим, когда готовы и расписание, и шрифты — и сборка доиграла. */
async function finishSplash() {
  if (!els.splash) return;
  const fonts = document.fonts?.ready || Promise.resolve();
  // Ждём и отмены с заменами: они приходят от бота чуть позже расписания,
  // и без них заставка ставила точку на уже отменённую пару — в расписании
  // она зачёркнута, а точка есть. Но не дольше 0,6 с: обычно бот отвечает
  // за 0,2–0,4, а ждать дольше — значит показывать пустой экран.
  await Promise.race([
    Promise.all([fonts, noticesReady]),
    new Promise((r) => setTimeout(r, 600)),
  ]);
  const played = assembleSplash(splashDayPlan());
  const waited = performance.now() - splashStarted;
  const rest = Math.max(played, SPLASH_MIN - waited);
  setTimeout(dropSplash, Math.min(rest, SPLASH_MAX));
}

function dropSplash() {
  const splash = els.splash;
  if (!splash || splash.classList.contains("splash--gone")) return;
  // Схлопываемся к полосе, а не к центру экрана: кажется, что день
  // сворачивается в линию, из которой потом разворачивается расписание.
  const free = splash.classList.contains("splash--free");
  const track = els.splashTrack?.getBoundingClientRect();
  if (!free && track && track.height) {
    const y = ((track.top + track.height / 2) / window.innerHeight) * 100;
    splash.style.setProperty("--fold-y", `${y}%`);
  }
  // Свободный день: заставка не складывается в пустую линию, а тает, и
  // в этот же момент на экране заново собирается сцена «пар нет» — раньше
  // она успевала отыграть под заставкой, и открывалась уже застывшей.
  if (free && els.lessons?.querySelector(".free-day")) {
    // Значок не исчезает вместе с заставкой, а переезжает на своё место на
    // экране «пар нет»: заставка тает, он летит, сцена собирается вокруг.
    const scene = renderFreeDay();
    scene.classList.add("free-day--await");
    // Меняем только сцену: «Своё дело» и другие плашки под ней остаются.
    els.lessons.querySelector(".free-day").replaceWith(scene);
    const from = splash.querySelector(".splash-free-emoji");
    const to = scene.querySelector(".free-day-emoji");
    if (from && to) flyEmoji(from, to, scene);
    else scene.classList.remove("free-day--await");
  }
  splash.classList.add("splash--gone");
  setTimeout(() => splash.remove(), 700);
  // Расписание развернулось — теперь можно и салют в честь праздника.
  setTimeout(() => {
    celebrateEvent();
    afterSplashQueue.splice(0).forEach((fn) => fn());
  }, 450);
}

/** Перелёт значка с заставки на экран: один и тот же предмет, а не два. */
function flyEmoji(from, to, scene) {
  const a = from.getBoundingClientRect();
  const b = to.getBoundingClientRect();
  const fly = el("span", "free-fly", from.textContent);
  fly.style.left = `${a.left}px`;
  fly.style.top = `${a.top}px`;
  fly.style.width = `${a.width}px`;
  fly.style.height = `${a.height}px`;
  fly.style.fontSize = getComputedStyle(from).fontSize;
  document.body.append(fly);
  from.style.visibility = "hidden";
  const dx = b.left + b.width / 2 - (a.left + a.width / 2);
  const dy = b.top + b.height / 2 - (a.top + a.height / 2);
  const scale = b.height / a.height || 1;
  let landed = false;
  const land = () => {
    if (landed) return;
    landed = true;
    fly.remove();
    scene.classList.remove("free-day--await");
    scene.classList.add("free-day--landed");
    haptic("light");
  };
  if (!fly.animate) return land();
  // Страховка: если экран в этот момент не рисуется, анимация стоит — и
  // значок иначе завис бы посреди экрана.
  setTimeout(land, 900);
  // Летит по дуге: сначала чуть приподнимается и растёт, потом садится.
  fly
    .animate(
      [
        { transform: "none" },
        { transform: `translate(${dx * 0.45}px, ${dy * 0.3 - 26}px) scale(${scale * 1.18}) rotate(-8deg)`, offset: 0.45 },
        { transform: `translate(${dx}px, ${dy}px) scale(${scale})` },
      ],
      { duration: 680, easing: "cubic-bezier(0.45, 0, 0.2, 1)", fill: "forwards" }
    )
    .finished.then(land, land);
}

/* ---------- Окна снизу: плавный уход для всех ---------- */

/**
 * Окно снизу закрывают по-разному: у одних есть своя анимация ухода, другие
 * просто ставят hidden и пропадают рывком. Чтобы не переписывать каждое,
 * следим за всеми сразу: как только окну поставили hidden, на мгновение
 * возвращаем его, даём уехать вниз и только потом прячем по-настоящему.
 */
const SHEET_OUT = 300;
const sheetLeaving = new WeakMap();

/**
 * Пока открыто окно, всё, что под ним, выключено: не нажимается, не
 * листается и не прокручивается. Иначе палец, промахнувшись мимо окна,
 * переключал день или открывал пару под размытым фоном.
 */
/**
 * Окно снизу привязано к видимой части экрана, а не к странице. Когда
 * выезжает клавиатура, телефон сообщает новую видимую высоту — окно встаёт
 * ровно над клавиатурой одним движением, а не догоняет её рывками.
 */
const KEYBOARD_KEY = "schedule.keyboard";

function pinSheetsToViewport() {
  const style = document.documentElement.style;
  // Полная высота экрана — самая большая из виденных: когда выезжает
  // клавиатура, часть телефонов сжимает само окно приложения.
  let full = window.innerHeight;
  let keyboard = 0;
  try {
    keyboard = Number(localStorage.getItem(KEYBOARD_KEY)) || 0;
  } catch {
    // Память недоступна — возьмём оценку.
  }
  const reserve = () => {
    // Сколько места оставить клавиатуре: её настоящую высоту, если уже
    // видели, иначе — чуть меньше половины экрана, с запасом.
    const guess = keyboard > 150 && keyboard < full * 0.7 ? keyboard : Math.round(full * 0.46);
    style.setProperty("--full-height", `${full}px`);
    style.setProperty("--keyboard", `${guess}px`);
  };
  reserve();
  const viewport = window.visualViewport;
  if (!viewport) return;
  let frame = 0;
  const apply = () => {
    frame = 0;
    style.setProperty("--vv-top", `${Math.max(0, Math.round(viewport.offsetTop))}px`);
    style.setProperty("--vv-height", `${Math.round(viewport.height)}px`);
    if (window.innerHeight > full) full = window.innerHeight;
    // Печатают — значит, разница между полной и видимой высотой и есть
    // клавиатура. Запоминаем самую высокую: в следующий раз окно встанет точно.
    const gap = Math.round(full - viewport.height);
    if (document.body.classList.contains("typing") && gap > 150 && gap < full * 0.7 && gap > keyboard) {
      keyboard = gap;
      try {
        localStorage.setItem(KEYBOARD_KEY, String(gap));
      } catch {
        // Не запомнилось — останется оценка.
      }
    }
    reserve();
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(apply);
  };
  viewport.addEventListener("resize", schedule);
  viewport.addEventListener("scroll", schedule);
  apply();
}
pinSheetsToViewport();

let frozenAt = 0;

function lockBehindSheets() {
  const open = Boolean(document.querySelector(".sheet-backdrop:not([hidden])"));
  if (document.body.classList.contains("sheet-open") === open) return;
  // Страницу под окном прибиваем на месте. Одного «не прокручивать» мало:
  // айфон всё равно двигает её, когда тянут само окно или выезжает клавиатура.
  if (open) {
    frozenAt = window.scrollY;
    document.body.style.top = `${-frozenAt}px`;
  }
  document.body.classList.toggle("sheet-open", open);
  if (!open) {
    document.body.style.top = "";
    window.scrollTo(0, frozenAt);
  }
  for (const node of document.body.children) {
    if (node.classList.contains("sheet-backdrop") || node.tagName === "SCRIPT") continue;
    node.inert = open;
  }
}

/**
 * Ручка вверху окна: потянули за неё вниз — окно едет за пальцем и
 * закрывается, если увели достаточно далеко или смахнули быстро.
 */
function addSheetGrab(backdrop) {
  const sheet = backdrop.querySelector(".sheet");
  if (!sheet || sheet.querySelector(".sheet-grab")) return;
  const grab = el("div", "sheet-grab");
  grab.setAttribute("aria-hidden", "true");
  sheet.prepend(grab);
  let start = null;
  const reset = () => {
    sheet.style.transition = "transform 220ms cubic-bezier(0.2, 0.8, 0.2, 1)";
    sheet.style.transform = "";
    setTimeout(() => (sheet.style.transition = ""), 240);
  };
  grab.addEventListener("pointerdown", (event) => {
    start = { y: event.clientY, at: performance.now(), last: 0 };
    grab.setPointerCapture?.(event.pointerId);
    sheet.style.transition = "none";
    // Иначе доигранная анимация въезда держит окно на месте и не даёт его сдвинуть.
    sheet.style.animation = "none";
  });
  grab.addEventListener("pointermove", (event) => {
    if (!start) return;
    start.last = Math.max(0, event.clientY - start.y);
    sheet.style.transform = `translateY(${start.last}px)`;
  });
  const finish = (event) => {
    if (!start) return;
    const moved = start.last;
    const speed = moved / Math.max(1, performance.now() - start.at);
    start = null;
    grab.releasePointerCapture?.(event.pointerId);
    sheet.style.animation = "";
    if (moved < 80 && !(moved > 30 && speed > 0.6)) return reset();
    haptic("light");
    sheet.style.transition = "";
    // Закрываем так же, как нажатием мимо окна: у каждого окна свой порядок закрытия.
    backdrop.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    setTimeout(() => {
      if (!backdrop.hidden && !backdrop.classList.contains("sheet-backdrop--out")) backdrop.hidden = true;
    }, 60);
    // Сдвиг пальцем снимаем, когда окно уже ушло: иначе оно дёрнулось бы назад.
    setTimeout(() => (sheet.style.transform = ""), SHEET_OUT + 80);
  };
  grab.addEventListener("pointerup", finish);
  grab.addEventListener("pointercancel", finish);
}

function watchSheets() {
  if (!("MutationObserver" in window)) return;
  const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const observer = new MutationObserver((changes) => {
    // Сверяем замок после того, как разберём все изменения этого кадра.
    queueMicrotask(lockBehindSheets);
    for (const change of changes) {
      const node = change.target;
      if (change.type === "childList") {
        for (const added of change.addedNodes) {
          if (!added.classList?.contains("sheet-backdrop")) continue;
          observer.observe(added, { attributes: true, attributeFilter: ["hidden", "class"] });
          addSheetGrab(added);
        }
        continue;
      }
      if (!node.classList?.contains("sheet-backdrop")) continue;
      // У окна своя анимация ухода — запоминаем, чтобы не играть вторую.
      if (change.attributeName === "class") {
        if (node.classList.contains("sheet-backdrop--out")) sheetLeaving.set(node, performance.now());
        continue;
      }
      if (!node.hidden || still) continue;
      if (performance.now() - (sheetLeaving.get(node) || -1e9) < SHEET_OUT + 400) continue;
      sheetLeaving.set(node, performance.now());
      node.hidden = false;
      node.classList.add("sheet-backdrop--out");
      setTimeout(() => {
        node.hidden = true;
        node.classList.remove("sheet-backdrop--out");
        lockBehindSheets();
      }, SHEET_OUT);
    }
  });
  for (const sheet of document.querySelectorAll(".sheet-backdrop")) {
    observer.observe(sheet, { attributes: true, attributeFilter: ["hidden", "class"] });
    addSheetGrab(sheet);
  }
  // Часть окон создаётся при первом открытии — подхватываем и их.
  observer.observe(document.body, { childList: true });
}
watchSheets();

/* ---------- Запуск ---------- */

/**
 * Telegram кэширует index.html надолго, а app.js мы каждый раз берём свежим.
 * Тогда новый код рисует старую разметку — и на секунду видно прошлую версию
 * приложения, пока проверка обновлений не перезагрузит страницу. Поэтому
 * проверяем разметку сразу: нет нужных разделов — перезагружаемся, ничего
 * не показав. Один раз за сеанс, иначе получился бы вечный круг.
 */
const STALE_KEY = "schedule.staleReload";

function htmlIsStale() {
  // data-shell — номер редакции разметки: у старой страницы из кэша Telegram
  // заставка ещё прежняя, и её не стоит показывать вместе с новым кодом.
  return !document.getElementById("queues") || !document.getElementById("tabs") || document.body.dataset.shell !== "2";
}

function reloadFreshPage() {
  try {
    if (sessionStorage.getItem(STALE_KEY)) return false;
    sessionStorage.setItem(STALE_KEY, "1");
  } catch {
    return false;
  }
  // Старую разметку даже не показываем: перезагрузка идёт с пустым экраном.
  document.body.style.visibility = "hidden";
  const url = new URL(location.href);
  url.searchParams.set("v", String(Date.now()));
  location.replace(url);
  return true;
}

async function init() {
  tg?.ready();
  tg?.expand();
  if (htmlIsStale() && reloadFreshPage()) return;
  translatePage();
  renderSkeleton();
  // Страховка: что бы ни случилось с загрузкой, заставка не зависнет.
  setTimeout(dropSplash, SPLASH_MAX + 1500);

  await loadTenants();

  // Переводы названий грузим вместе с расписанием; не загрузились —
  // покажем по-русски, но расписание откроется.
  // Общий словарь (с ФГП) работает у всех факультетов; свой, если есть, —
  // поверх него.
  const dictionary = (file) =>
    fetch(file, { cache: "no-cache" })
      .then((res) => (res.ok ? res.json() : {}))
      .catch(() => ({}));
  const subjects =
    LANG === "ru"
      ? Promise.resolve({})
      : Promise.all([
          dictionary("data/subjects.json"),
          tenant().path ? dictionary(dataFile("subjects.json")) : Promise.resolve({}),
        ]).then(([common, own]) => ({ ...common, ...own }));

  try {
    const res = await fetch(dataFile("schedule.json"), { cache: "no-cache" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = scopeData(await res.json());
  } catch (e) {
    fail(t("Не удалось загрузить расписание. Попробуйте позже."));
    console.error(e);
    return;
  }
  SUBJECTS = await subjects;
  // Преподаватель с парами на других факультетах вуза — догружаем их в фоне.
  setTimeout(loadForeignTeacher, 0);

  // Telegram может отдать из кэша старый index.html без переключателя при
  // свежем app.js — без проверки расписание не открылось бы вовсе.
  if (els.lang) els.lang.value = LANG;
  els.lang?.addEventListener("change", () => {
    try {
      localStorage.setItem(LANG_KEY, els.lang.value);
    } catch {
      // Не запомнилось — язык всё равно сменится до закрытия.
    }
    // Проще перезагрузить, чем перерисовывать каждый экран: словарь
    // подключается при загрузке страницы.
    const url = new URL(location.href);
    url.searchParams.set("lang", els.lang.value);
    location.replace(url);
  });

  prefs = readPrefs();

  els.course.addEventListener("change", fillGroups);
  els.role?.addEventListener("change", applyRole);
  els.mfkFind?.addEventListener("input", () => {
    renderMfkPicker();
    checkGlamWord();
  });
  initConfetti();
  initReminders();
  initVolunteer();
  initMsuTheme();
  applyTheme();
  applyDecor();
  applyBackground();
  initCustomLook();
  initOverscroll();
  initScrollChrome();
  initNowCard();
  initDeadlines();
  initPolls();
  initPhotos();
  initFlash();
  initNeon();
  document.getElementById("bg-pick")?.addEventListener("change", (event) => {
    haptic("select");
    try {
      localStorage.setItem(BG_KEY, event.target.value);
    } catch {
      // Без памяти — до перезапуска.
    }
    applyBackground();
  });
  const decorBox = document.getElementById("decor");
  if (decorBox) {
    decorBox.checked = decorOn();
    decorBox.addEventListener("change", () => {
      try {
        localStorage.setItem(DECOR_KEY, decorBox.checked ? "on" : "off");
      } catch {
        // Без памяти — до перезапуска.
      }
      applyDecor();
    });
  }
  // 5. Нажатие на карточку пары — подробности. Кнопки внутри — сами по себе.
  els.lessons.addEventListener("click", (event) => {
    const card = event.target.closest("article.card");
    if (!card || event.target.closest("button, a, summary, details, input, .room-badge")) return;
    haptic("light");
    openLessonView(card);
  });
  els.group.addEventListener("change", fillLanguages);
  els.main.addEventListener("change", fillMainSubgroups);
  els.lang2.addEventListener("change", fillLang2Subgroups);
  els.save.addEventListener("click", () => {
    haptic("success");
    const before = prefs.group;
    // Настройки собираются заново — выбранный вуз надо сохранить.
    prefs = { ...collectPrefs(), tenant: tenantId() };
    if (els.role?.value === "teacher" && els.teacher?.value) {
      prefs = { ...prefs, teacher: els.teacher.value, teacherName: teacherFull(els.teacher.value) || els.teacher.value };
    }
    savePrefs(prefs);
    notices.group = null;
    openTab(tab === "search" ? "schedule" : tab);
    // Сменили группу — сообщаем боту, чтобы статистика знала новую группу.
    const group = !prefs.teacher && groupById(prefs.group);
    if (group && group.id !== before) countOpen({ id: group.id, course: group.course, level: group.level });
    if (prefs.teacher) countOpen(teacherVisit(prefs.teacher));
    loadForeignTeacher();
  });
  // Telegram может отдать из кэша старый index.html без окна комментариев
  // при свежем app.js. Тогда комментариев просто нет, но расписание открывается.
  if (els.cmSheet) {
    els.cmSend.addEventListener("click", sendComment);
    els.cmRefresh.addEventListener("click", loadComments);
    els.cmClose.addEventListener("click", closeComments);
    els.cmText.addEventListener("input", updateCommentCounter);
    els.cmSheet.addEventListener("click", (event) => {
      if (event.target === els.cmSheet) closeComments();
    });
  }
  els.change.addEventListener("click", showPicker);
  initMenu();
  els.absClose?.addEventListener("click", closeAbsences);
  els.absSheet?.addEventListener("click", (event) => {
    if (event.target === els.absSheet) closeAbsences();
  });
  // Счётчик и свои пометки нужны сразу: их кнопки стоят в карточках.
  loadAbsences().then(() => applyAbsenceButtons());
  loadMine().then(() => applyMine());
  initWeekSwipe();
  window.addEventListener("resize", () => {
    moveDrop(tab, false);
    // Поворот экрана меняет ширину — размер даты подбираем заново.
    const text = els.dateLabel?.dataset.target || els.dateLabel?.textContent;
    if (text) fitDateLabel(text);
  });
  els.queueAdd?.addEventListener("click", openQueueSheet);
  els.qSave?.addEventListener("click", createQueue);
  els.qCancel?.addEventListener("click", () => (els.qSheet.hidden = true));
  els.qSheet?.addEventListener("click", (event) => {
    if (event.target === els.qSheet) els.qSheet.hidden = true;
  });
  els.qFind?.addEventListener("input", renderQueuePicker);
  keepFieldVisible();
  els.qnSave?.addEventListener("click", submitJoin);
  els.qnCancel?.addEventListener("click", () => {
    els.qnSheet.hidden = true;
    joining = null;
  });
  els.qnSheet?.addEventListener("click", (event) => {
    if (event.target === els.qnSheet) els.qnSheet.hidden = true;
  });
  for (const button of els.tabs?.querySelectorAll(".tab") || []) {
    button.addEventListener("click", () => openTab(button.dataset.tab));
  }
  initHomeScreen();
  els.find.addEventListener("click", () => openTab("search"));
  els.rooms.addEventListener("click", showFree);
  els.freeClose.addEventListener("click", closeFree);
  els.searchClose.addEventListener("click", closeSearch);
  els.query.addEventListener("input", runSearch);
  els.query.addEventListener("input", () => checkEgg(els.query.value));
  for (const chip of els.searchTabs?.querySelectorAll(".chip") || []) {
    chip.addEventListener("click", () => {
      if (searchKind !== chip.dataset.kind) haptic("select");
      searchKind = chip.dataset.kind;
      for (const other of els.searchTabs.querySelectorAll(".chip")) {
        other.classList.toggle("chip--on", other === chip);
      }
      runSearch();
    });
  }
  initSwipe();
  // Как и с комментариями: без окна в закэшированном index.html домашка
  // просто не редактируется, а расписание открывается.
  if (els.hwSheet) {
    els.hwSubgroup.addEventListener("change", fillHomeworkText);
    els.hwSave.addEventListener("click", () => submitHomework(els.hwText.value.trim()));
    els.hwDelete.addEventListener("click", () => submitHomework(""));
    els.hwCancel.addEventListener("click", closeHomework);
    // Тап по затемнению вокруг окна закрывает его, как принято на телефонах.
    els.hwSheet.addEventListener("click", (event) => {
      if (event.target === els.hwSheet) closeHomework();
    });
  }
  // Крестик закрывает настройки, не сохраняя изменений.
  els.close.addEventListener("click", () => openTab(tab === "picker" ? "today" : tab));

  // Возврат в свёрнутое приложение — момент, когда расхождение с часами
  // максимально, а следующий тик ещё не наступил.
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && !els.schedule.hidden) refreshNow();
    if (!document.hidden) checkForUpdate();
  });
  // iOS возвращает ярлык с экрана «Домой» из памяти, без visibilitychange.
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) checkForUpdate();
  });
  checkForUpdate();

  const openedOn = isoDate(new Date());
  setInterval(() => {
    // Приложение могли оставить открытым до следующего дня — тогда неделя и
    // выбранный день устарели, и точечного обновления уже мало.
    if (isoDate(new Date()) !== openedOn) return location.reload();
    if (!els.schedule.hidden) {
      refreshNow();
      refreshNext();
      refreshFreedom();
    }

  }, 30_000);

  loadMfk().then(() => {
    if (!els.schedule.hidden) showSchedule();
  });
  // Стили грузятся параллельно с расписанием, не задерживая заставку.
  // Показывать и мерить экран (капля, размер даты) — только с ними,
  // иначе всё посчиталось бы по голой разметке.
  await Promise.race([window.__cssReady, new Promise((r) => setTimeout(r, 4000))]);
  const group = activeGroup();
  if (group?.teacher) {
    loadTeacherNames();
    openTab("schedule");
    countOpen(teacherVisit(group.teacher));
  } else if (group) {
    openTab("schedule");
    countOpen({ id: group.id, course: group.course, level: group.level });
  } else {
    showPicker();
  }
  // Расписание уже нарисовано под заставкой — теперь она может собраться и уйти.
  finishSplash();
  // Пришли по ссылке «поделиться» — спросим, когда заставка уйдёт.
  setTimeout(acceptShared, SPLASH_MIN + 600);
  setTimeout(acceptInvite, SPLASH_MIN + 700);
}

init();
