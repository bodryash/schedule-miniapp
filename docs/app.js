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
}
const STORAGE_KEY = "schedule.prefs";
// Где живёт бот. Приложение на своём домене ходит к боту на том же домене,
// на прежнем адресе — к прежнему боту в Cloudflare. Одна сборка работает и
// там, и там: так новый сервер можно проверить, не трогая студентов.
const API_URL = /(^|\.)bodryash\.ru$/.test(location.hostname)
  ? "https://api.bodryash.ru"
  : "https://fgp-schedule-bot.bodryash.workers.dev";
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
    applyCrown(body.crown || null);
    notices.homework = body.homework || [];
    notices.canEdit = Boolean(body.canEdit);
    notices.canComment = Boolean(body.canComment);
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
    if (subject && notices.owner) addOwnerButtons(card);
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
    // Полоса разделов внизу на клавиатуре только мешает — прячем её.
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
      for (const lesson of lessonsForDay(group, day, week)) {
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

function sendReminderSettings() {
  if (!tg?.initData) return;
  const group = activeGroup();
  if (!group || group.teacher) return;
  const body = {
    initData: tg.initData,
    group: group.id,
    morning: Boolean(prefs?.remindMorning),
    before: prefs?.remindBefore ? 15 : 0,
    plan: prefs?.remindMorning || prefs?.remindBefore ? reminderPlan() : [],
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

function fillReminders() {
  if (!els.remindRow) return;
  // Без Telegram писать некому: настройку прячем целиком.
  els.remindRow.hidden = !tg?.initData;
  els.remindMorning.checked = Boolean(prefs?.remindMorning);
  els.remindBefore.checked = Boolean(prefs?.remindBefore);
}

function initReminders() {
  const save = () => {
    const morning = els.remindMorning.checked;
    const before = els.remindBefore.checked;
    prefs = {
      ...prefs,
      remindMorning: morning,
      remindBefore: before,
      // Выключили оба — значит, вопрос снова открыт: предложение вернётся.
      remindAsked: morning || before ? true : false,
    };
    savePrefs(prefs);
    sendReminderSettings();
  };
  els.remindMorning?.addEventListener("change", save);
  els.remindBefore?.addEventListener("change", save);
}

/* ---------- Особые темы оформления ---------- */

// Брутал выдаёт владелец командой /theme, гламур человек находит сам —
// словом «гламур» в поиске по МФК. Тема с сервера сильнее найденной.
const THEMES = { glam: "glam", brutal: "glam-noir", champion: "champion" };
const GLAM_KEY = "schedule.glam";

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

function applyTheme(granted = grantedTheme) {
  grantedTheme = granted || "";
  const name = grantedTheme || (ownGlam() ? "glam" : "");
  for (const cls of Object.values(THEMES)) {
    document.body.classList.toggle(cls, THEMES[name] === cls);
  }
  renderChampion(name === "champion");
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
    const res = await fetch("data/mfk.json", { cache: "no-cache" });
    MFK_LIST = res.ok ? await res.json() : [];
  } catch {
    MFK_LIST = [];
  }
  return MFK_LIST;
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
        (l.week === "all" || parity === null || l.week === parity) &&
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
    const who = [...item.teachers].map((key) => TEACHER_NAMES?.[key] || key).join(", ");
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

  const bells = new Map(data.bells.map((b) => [b.n, b]));
  const todayIso = isoDate(new Date());
  const nodes = [];
  for (let day = 1; day <= 6; day++) {
    const date = dateOfDay(day, selectedWeek);
    const lessons = lessonsForDay(group, day, selectedWeek);
    const column = el("div", isoDate(date) === todayIso ? "week-day week-day--today" : "week-day");
    const head = el("div", "week-head");
    head.append(el("span", "week-name", DAYS[day - 1]), el("span", "week-date", SHORT_DATE.format(date)));
    column.append(head);

    if (!lessons.length) {
      column.append(el("div", "week-empty", t("Пар нет")));
      nodes.push(column);
      continue;
    }

    // В неделе важен объём дня, а не подробности: одна строка на пару.
    // Языки идут девятью потоками в одной паре — их сводим в «+8».
    const bySlot = new Map();
    for (const lesson of lessons) {
      if (!bySlot.has(lesson.slot)) bySlot.set(lesson.slot, []);
      const subjects = bySlot.get(lesson.slot);
      if (!subjects.some((l) => l.subject === lesson.subject)) subjects.push(lesson);
    }
    for (const [slot, entries] of [...bySlot].sort((a, b) => a[0] - b[0])) {
      const lesson = entries[0];
      const extra = entries.length - 1;
      const time = timesOf(lesson, bells);
      const row = el("button", lessonCancelOn(lesson, isoDate(date)) ? "week-row week-row--off" : "week-row");
      row.type = "button";
      row.append(el("span", "week-slot", String(slot)));
      if (entries.some((entry) => isMine(entry.subject, date))) row.classList.add("week-row--mine");
      row.append(
        el("span", "week-subject", extra ? `${withFlag(tr(lesson.subject))} +${extra}` : withFlag(tr(lesson.subject)))
      );
      row.append(el("span", "week-time", time ? time.start : ""));
      row.addEventListener("click", () => {
        selectedDay = day;
        openTab("schedule");
      });
      column.append(row);
    }
    nodes.push(column);
  }
  nodes.forEach((node, i) => node.style.setProperty("--i", i));
  els.weekBody.replaceChildren(...nodes);
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
    card.querySelector(".note")?.remove();
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
    const line = el("button", "note");
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
    noteSheet = el("div", "sheet-backdrop");
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
      ? teacherLessons(group.teacher, parity, weekday)
      : data.lessons.filter(
          (l) =>
            l.group === group.id &&
            l.day === weekday &&
            (l.week === "all" || parity === null || l.week === parity) &&
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
// в памяти браузера. Считаем только семинары и практики: посещаемость
// отмечают там.
const ABS_KEY = "absences";
const ABS_TYPES = ["семинар", "практика"];
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

function isAbsTracked(type) {
  return ABS_TYPES.includes(String(type || "").toLowerCase());
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
 * Кнопка «пропустил» под семинаром, который уже начался. У будущих пар её
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
    if (!isAbsTracked(card.dataset.type) || card.classList.contains("card--cancelled")) continue;
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
              (l.week === "all" || parity === null || l.week === parity) &&
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
            (l.week === "all" || parity === null || l.week === parity) &&
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
    els.absNote.textContent = t("Личный счётчик по семинарам");
    const intro = el("div", "abs-intro");
    intro.append(
      el("div", "abs-intro-title", t("Сколько ещё можно пропустить?")),
      el("p", null, t("Отмечайте пропущенные семинары — приложение посчитает, сколько осталось до лимита, и подсветит, когда хватит.")),
      el("p", "abs-intro-hint", t("Под каждым прошедшим семинаром появится кнопка «пропустил?». Лимит для каждого предмета задаёте сами."))
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
  if (!rows.length) rows.push(el("p", "hint", t("У группы нет семинаров и практик.")));

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

async function cancelLesson(card, slots) {
  const group = groupById(prefs.group);
  const scope = await askScope(group);
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
  return sendCancel({ action: "restore", ids });
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

const DAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб"].map((day) => t(day));

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
  military: document.getElementById("military"),
  electivesRow: document.getElementById("electives-row"),
  electives: document.getElementById("electives"),
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
  remindBefore: document.getElementById("remind-before"),
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

// В воскресенье занятий нет, поэтому показываем понедельник — уже следующей
// недели, а не той, что закончилась.
const baseDate = new Date();
if (baseDate.getDay() === 0) baseDate.setDate(baseDate.getDate() + 1);

const weekStart = mondayOf(baseDate);

// Показываем текущую неделю и следующую: расписание на послезавтра нужно
// чаще, чем на месяц вперёд, а листать две недели можно одной полосой.
const WEEKS = 2;

let selectedDay = Math.min((baseDate.getDay() + 6) % 7, 5) + 1;
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

  fillLang2Subgroups();
  fillElectives();
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
    electives: [...els.electives.querySelectorAll("input:checked")].map(
      (box) => box.value
    ),
    // МФК и напоминания отмечают прямо в списке, без кнопки «Сохранить».
    mfk: prefs?.mfk || [],
    remindMorning: Boolean(prefs?.remindMorning),
    remindBefore: Boolean(prefs?.remindBefore),
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
      ...keys.map((key) => new Option(TEACHER_NAMES?.[key] ? `${key} — ${TEACHER_NAMES[key]}` : key, key))
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
  els.search.hidden = true;
  els.free.hidden = true;
  if (els.tabs) els.tabs.hidden = true;
  els.picker.hidden = false;
  // Возвращаться некуда, пока группа не выбрана хотя бы раз.
  els.close.hidden = !activeGroup();
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

const TAB_ORDER = ["schedule", "week", "queues", "search"];

/**
 * Подложка выбранного раздела переезжает к нему, а не появляется на новом
 * месте: так глаз видит, куда ушёл выбор. Ширину берём у самой кнопки —
 * у подписей разная длина, и одинаковая капля смотрелась бы кривой.
 */
function moveDrop(name, animate = true) {
  const drop = els.tabsDrop;
  const button = els.tabs?.querySelector(`.tab[data-tab="${name}"]`);
  if (!drop || !button || els.tabs.hidden) return;
  if (!animate) drop.classList.add("tabs-drop--still");
  drop.style.width = `${button.offsetWidth}px`;
  drop.style.transform = `translateX(${button.offsetLeft}px)`;
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
  els.schedule.hidden = name !== "schedule";
  els.search.hidden = name !== "search";
  if (els.tabs) {
    const wasHidden = els.tabs.hidden;
    els.tabs.hidden = false;
    if (wasHidden) requestAnimationFrame(() => moveDrop(name, false));
  }
  window.scrollTo(0, 0);
  const screen = { schedule: els.schedule, week: els.week, queues: els.queues, search: els.search }[name];
  if (screen && from) {
    screen.style.setProperty("--slide-from", `${from > 0 ? 16 : -16}px`);
    screen.classList.remove("screen-slide");
    void screen.offsetWidth;
    screen.classList.add("screen-slide");
  }
  if (name !== "week") document.body.dataset.parity = weekParity(data.weeks) || "none";
  if (name === "week") showWeek();
  if (name === "queues") showQueues();
  if (name === "schedule") showSchedule();
  if (name === "search") showSearch();
}

/** Пары дня с учётом настроек и замен — общая основа всех разделов. */
function lessonsForDay(group, day, week) {
  const parity = weekParity(data.weeks, week);
  const list = group.teacher
    ? teacherLessons(group.teacher, parity, day)
    : data.lessons.filter(
        (l) =>
          l.group === group.id &&
          l.day === day &&
          (l.week === "all" || parity === null || l.week === parity) &&
          matchesPrefs(l)
      );
  return list.map((l) => withChange(l, dateOfDay(day, week))).sort((a, b) => a.slot - b.slot);
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
  renderLessons(group, parity);
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
    const lessons = lessonsForDay(group, day, week).filter(
      (lesson) => !lessonCancelOn(lesson, isoDate(dateOfDay(day, week)))
    );
    if (!lessons.length) continue;
    const bells = new Map(data.bells.map((b) => [b.n, b]));
    const first = lessons
      .map((lesson) => timesOf(lesson, bells))
      .filter(Boolean)
      .sort((a, b) => minutes(a.start) - minutes(b.start))[0];
    const date = dateOfDay(day, week);
    const card = el("div", "dayend");
    card.append(el("div", "dayend-title", t("На сегодня всё")));
    card.append(
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
  const right = active.offsetLeft + active.offsetWidth + pad;
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
const FREE_DAYS = [
  ["😴", "Пар нет", "Будильник можно не ставить"],
  ["🎉", "Свободный день", "Преподаватели тоже отдыхают"],
  ["☕", "Пар нет", "Идеальный день для кофе и сериала"],
  ["🛋️", "Выходной", "Диван ждёт"],
  ["📚", "Пар нет", "Можно наконец сделать домашку. Или нет"],
  ["🌳", "Свободно", "Воробьёвы горы в двух шагах"],
  ["🎮", "Пар нет", "Официально разрешено ничего не делать"],
  ["🍕", "Выходной", "Отличный повод собраться с группой"],
  ["🧘", "Пар нет", "Выдохни"],
  ["🌙", "Свободный день", "Можно выспаться за всю неделю"],
];

function renderFreeDay() {
  const node = el("div", "empty free-day");
  if (LANG !== "ru") {
    node.textContent = t("Пар нет 🎉");
    return node;
  }
  const date = dateOfDay(selectedDay);
  const [emoji, title, line] = FREE_DAYS[(date.getDate() * 7 + date.getMonth()) % FREE_DAYS.length];
  node.append(el("div", "free-day-emoji", emoji), el("div", "free-day-title", title), el("div", "free-day-line", line));
  return node;
}

/**
 * Пары преподавателя в показанный день. Одну лекцию он читает сразу
 * нескольким группам — это одна пара, группы перечисляем в пометке.
 */
function teacherLessons(key, parity, day = selectedDay) {
  const merged = new Map();
  for (const l of data.lessons) {
    if (l.day !== day || !(l.week === "all" || parity === null || l.week === parity)) continue;
    if (!teachersOf(l.teacher).some((p) => p.key === key)) continue;
    const id = [l.slot, l.subject, l.type, l.room, l.week, l.start, l.end].join("|");
    if (!merged.has(id)) merged.set(id, { ...l, subgroup: null, groups: [] });
    merged.get(id).groups.push(l.group);
  }
  return [...merged.values()].map((l) => {
    const groups = [...new Set(l.groups)].sort();
    const label = groups.length === 1 ? t("Группа {g}", { g: groups[0] }) : t("Группы: {list}", { list: groups.join(", ") });
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
        (l.week === "all" || parity === null || l.week === parity) &&
        matchesPrefs(l)
    ))
    .map((lesson) => withChange(lesson))
    .sort((a, b) => a.slot - b.slot);

  // Свои МФК: строка «Межфакультетские учебные курсы МГУ» без названия и
  // времени никому не нужна, если человек указал, на что ходит.
  const mine = group.teacher ? [] : mfkLessons(selectedDay);
  if (mine.length) {
    const other = list.filter((lesson) => lesson.subject !== MFK);
    list.length = 0;
    list.push(...other, ...mine);
    list.sort((a, b) => a.slot - b.slot);
  }

  visible = list;

  if (list.length === 0) {
    els.lessons.replaceChildren(renderFreeDay());
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

  // Пришли листанием — новый день въезжает с той стороны, откуда его тянули.
  const from = enterFrom * 28;
  enterFrom = 0;
  els.lessons.classList.remove("no-cascade");
  nodes.forEach((node, i) => {
    node.style.setProperty("--i", i);
    node.style.setProperty("--from-x", `${from}px`);
  });

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
    get("data/teacher_names.json"),
    get("data/teacher_emails.json"),
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
function teachersOf(field) {
  const people = [];
  for (let part of String(field || "").split(/,\s*/)) {
    part = part.replace(/^\d{3}[А-ЯЁ]?\b\s*/, "").trim();
    const titled = part.match(/^((?:[а-яё]{1,6}\.*\s*)+)(?=[А-ЯЁA-Z])/);
    const titleRaw = titled ? titled[1].trim() : "";
    const rest = titled ? part.slice(titled[0].length) : part;
    const name = rest.match(/^([А-ЯЁ][а-яё]+(?:-[А-ЯЁ][а-яё]+)?)\s*(?:([А-ЯЁ])\.?\s*(?:([А-ЯЁ])\.?)?)?$/);
    if (!name) continue;
    const initials = [name[2], name[3]].filter(Boolean).map((c) => `${c}.`).join("");
    const key = initials ? `${name[1]} ${initials}` : name[1];
    const title = TEACHER_TITLES.find(([pattern]) => pattern.test(titleRaw))?.[1] || null;
    people.push({ key, surname: name[1], title, full: TEACHER_NAMES?.[key] || null });
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
    const lessons = teacherLessons(key, parityOfDate(date), weekday)
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

/* ---------- Слово недели ---------- */

// Раз в неделю — одно трудное слово из глобалистики на весь факультет.
// Буквы подсвечиваются: зелёная — на месте, жёлтая — есть в слове, серая —
// нет. Три попытки в день. Первый угадавший забирает корону себе и своей
// группе на неделю. Слово знает только бот: сюда приходит одна раскраска.
const WORD_URL = `${API_URL}/word`;
const WORD_KEYS = ["ЙЦУКЕНГШЩЗХЪ", "ФЫВАПРОЛДЖЭ", "ЯЧСМИТЬБЮ"];
const CROWN_TOLD = "schedule.crownTold";
const word = { state: null, typed: "", busy: false, fresh: -1 };
let wordSheet = null;

/** Корона у названия группы: её носит вся группа угадавшего. */
function applyCrown(crown) {
  document.body.classList.toggle("word-crown", Boolean(crown));
  if (!crown) return;
  const stamp = `${crown.group}|${crown.name}`;
  try {
    if (localStorage.getItem(CROWN_TOLD) === stamp) return;
    localStorage.setItem(CROWN_TOLD, stamp);
  } catch {
    return;
  }
  afterSplash(() =>
    toast(
      crown.me
        ? t("👑 Корона ваша: вы первыми угадали слово недели. Она у вас и у всей группы на неделю.")
        : t("👑 Корона у вашей группы: слово недели первым угадал(а) {name} 🎉", { name: crown.name })
    )
  );
}

async function wordCall(guess = "") {
  const group = activeGroup();
  if (!tg?.initData || !group) return null;
  const res = await fetch(WORD_URL, {
    method: "POST",
    body: JSON.stringify({ initData: tg.initData, group: group.id, guess }),
  });
  const body = await res.json();
  return body.ok ? body : null;
}

function openWord() {
  if (!wordSheet) {
    wordSheet = el("div", "sheet-backdrop");
    wordSheet.hidden = true;
    const sheet = el("div", "sheet sheet--abs sheet--word");
    sheet.setAttribute("role", "dialog");
    sheet.setAttribute("aria-modal", "true");
    const top = el("div", "sheet-top");
    const head = el("div");
    head.append(el("h2", "", t("Слово недели")), el("div", "word-note"));
    const close = el("button", "icon", "×");
    close.type = "button";
    close.setAttribute("aria-label", t("Закрыть"));
    close.addEventListener("click", closeWord);
    top.append(head, close);
    sheet.append(top, el("div", "word-body"));
    wordSheet.append(sheet);
    wordSheet.addEventListener("click", (event) => {
      if (event.target === wordSheet) closeWord();
    });
    document.body.append(wordSheet);
  }
  word.typed = "";
  word.fresh = -1;
  renderWord();
  wordSheet.classList.remove("sheet-backdrop--out");
  wordSheet.hidden = false;
  haptic("light");
  wordCall()
    .then((state) => {
      word.state = state || { offline: true };
      renderWord();
    })
    .catch(() => {
      word.state = { offline: true };
      renderWord();
    });
}

function closeWord() {
  const sheet = wordSheet;
  if (!sheet || sheet.hidden || sheet.classList.contains("sheet-backdrop--out")) return;
  haptic("light");
  sheet.classList.add("sheet-backdrop--out");
  setTimeout(() => {
    sheet.hidden = true;
    sheet.classList.remove("sheet-backdrop--out");
  }, 260);
}

function wordRow(letters, marks, length, fresh) {
  const row = el("div", "word-row");
  row.style.setProperty("--n", length);
  for (let i = 0; i < length; i++) {
    const tile = el("span", "word-tile", letters[i] || "");
    if (marks) tile.classList.add(`word-tile--${marks[i]}`);
    else if (letters[i]) tile.classList.add("word-tile--typed");
    if (fresh) {
      tile.classList.add("word-tile--flip");
      tile.style.setProperty("--i", i);
    }
    row.append(tile);
  }
  return row;
}

function wordType(letter) {
  const state = word.state;
  if (!state || word.busy || state.winner || !state.left) return;
  if (letter === "⌫") word.typed = word.typed.slice(0, -1);
  else if (word.typed.length < state.length) word.typed += letter;
  else return;
  haptic("light");
  renderWord();
}

async function wordSubmit() {
  const state = word.state;
  if (!state || word.busy || word.typed.length !== state.length) return;
  word.busy = true;
  renderWord();
  try {
    const next = await wordCall(word.typed);
    if (next) {
      const errors = {
        limit: t("На сегодня попытки кончились — приходите завтра"),
        repeat: t("Это слово вы уже пробовали"),
        solved: t("Слово уже угадали — вас опередили"),
        length: t("Не та длина слова"),
      };
      if (next.error) toast(errors[next.error] || t("Не получилось, попробуйте ещё раз"));
      else {
        word.fresh = next.guesses.length - 1;
        word.typed = "";
        haptic(next.winner?.me ? "success" : "light");
        if (next.winner?.me) setTimeout(showConfetti, 900);
      }
      word.state = next;
    } else toast(t("Не получилось, попробуйте ещё раз"));
  } catch {
    toast(t("Нет связи — попытка не засчитана"));
  }
  word.busy = false;
  renderWord();
  word.fresh = -1;
}

function renderWord() {
  if (!wordSheet) return;
  const note = wordSheet.querySelector(".word-note");
  const body = wordSheet.querySelector(".word-body");
  const state = word.state;
  note.textContent = t("Первый угадавший забирает корону себе и группе");
  if (!tg?.initData) return body.replaceChildren(el("p", "empty", t("Игра работает только в Telegram")));
  if (!state) return body.replaceChildren(el("p", "empty", t("Загружаем…")));
  if (state.offline) return body.replaceChildren(el("p", "empty", t("Не удалось загрузить игру — проверьте связь")));
  if (state.empty) return body.replaceChildren(el("p", "empty", t("Слово на эту неделю ещё не загадано")));

  const nodes = [];
  const info = el("div", "word-info");
  info.append(
    el("span", "word-chip", t("{n} букв", { n: state.length })),
    ...(state.hint ? [el("span", "word-chip word-chip--hint", state.hint)] : []),
    el("span", "word-chip", t("играют: {n}", { n: state.people }))
  );
  nodes.push(info);

  if (state.winner) {
    const done = el("div", "word-done");
    done.append(
      el("div", "word-done-crown", "👑"),
      el("div", "word-done-word", state.winner.word),
      el(
        "div",
        "word-done-who",
        state.winner.me
          ? t("Вы угадали первыми! Корона у вас и вашей группы на неделю.")
          : t("Первым угадал(а) {name}, {group}. Корона у этой группы на неделю.", { name: state.winner.name, group: state.winner.group })
      ),
      el("div", "word-done-next", t("Новое слово — в понедельник в 12:00"))
    );
    nodes.push(done);
  }

  const board = el("div", "word-board");
  state.guesses.forEach((g, i) => board.append(wordRow(g.guess, g.marks, state.length, i === word.fresh)));
  if (!state.winner && state.left) board.append(wordRow(word.typed, null, state.length, false));
  nodes.push(board);

  if (!state.winner) {
    nodes.push(
      el(
        "p",
        "word-left",
        state.left
          ? t("Сегодня осталось попыток: {n} из {max}", { n: state.left, max: state.perDay })
          : t("На сегодня попытки кончились — приходите завтра")
      )
    );
    if (state.left) {
      // Цвет клавиши — лучшее, что про букву уже известно.
      const known = {};
      const rank = { g: 3, y: 2, x: 1 };
      for (const g of state.guesses) {
        [...g.guess].forEach((letter, i) => {
          if ((rank[g.marks[i]] || 0) > (rank[known[letter]] || 0)) known[letter] = g.marks[i];
        });
      }
      const keys = el("div", "word-keys");
      WORD_KEYS.forEach((line, n) => {
        const row = el("div", "word-keyrow");
        for (const letter of line) {
          const key = el("button", known[letter] ? `word-key word-key--${known[letter]}` : "word-key", letter);
          key.type = "button";
          key.addEventListener("click", () => wordType(letter));
          row.append(key);
        }
        if (n === 2) {
          const back = el("button", "word-key word-key--wide", "⌫");
          back.type = "button";
          back.addEventListener("click", () => wordType("⌫"));
          row.append(back);
        }
        keys.append(row);
      });
      const send = el("button", "primary word-send", word.busy ? t("Проверяем…") : t("Проверить"));
      send.type = "button";
      send.disabled = word.busy || word.typed.length !== state.length;
      send.addEventListener("click", wordSubmit);
      nodes.push(keys, send);
    }
  }
  nodes.push(el("p", "word-fine", t("🟩 буква на месте · 🟨 есть в слове, но не здесь · ⬜ такой буквы нет. Три попытки в день, Ё = Е.")));
  body.replaceChildren(...nodes);
  // Свежая строка и поле ввода — в поле зрения.
  board.lastElementChild?.scrollIntoView({ block: "nearest" });
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
  const mine = meetBusy(lessonsForDay(group, day, week).filter((l) => !lessonCancelOn(l, isoDate(dateOfDay(day, week)))));
  const theirs = meetBusy(
    data.lessons.filter((l) => l.group === friend.id && l.day === day && (l.week === "all" || parity === null || l.week === parity))
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

function roomsOfBuilding() {
  return [
    ...new Set(data.lessons.map((l) => l.room.trim()).filter((r) => OWN_ROOM.test(r))),
  ].sort((a, b) => a.localeCompare(b, "ru", { numeric: true }));
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
    if (!(lesson.week === "all" || parity === null || lesson.week === parity)) continue;
    const room = lesson.room.trim();
    if (!OWN_ROOM.test(room)) continue;
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

  // Группируем по этажу — по первой цифре номера.
  const floors = new Map();
  for (const item of free) {
    const floor = item.room[0];
    if (!floors.has(floor)) floors.set(floor, []);
    floors.get(floor).push(item);
  }

  // Сквозной порядок появления: этажи и плитки въезжают каскадом сверху вниз.
  let order = 0;

  els.freeList.replaceChildren(
    ...[...floors].map(([floor, items]) => {
      const block = el("div", "floor");
      const heading = el("h2", null, t("{n} этаж", { n: floor }));
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
    }, 160);
  };
  els.menu.addEventListener("click", (event) => {
    event.stopPropagation();
    haptic("light");
    if (pop.hidden) pop.hidden = false;
    else close();
  });
  pop.addEventListener("click", (event) => {
    const item = event.target.closest("[data-menu]");
    if (!item) return;
    haptic("select");
    pop.hidden = true;
    if (item.dataset.menu === "rooms") showFree();
    if (item.dataset.menu === "settings") showPicker();
    if (item.dataset.menu === "absences") openAbsences();
    if (item.dataset.menu === "semester") openSemester();
    if (item.dataset.menu === "meet") openMeet();
    if (item.dataset.menu === "word") openWord();
  });
  if (!pop.querySelector('[data-menu="word"]')) {
    const item = el("button");
    item.type = "button";
    item.dataset.menu = "word";
    item.append(el("span", "", "🔤"), el("span", "", t("Слово недели")));
    pop.prepend(item);
  }
  // Корона у названия группы — тоже вход в игру.
  els.currentGroup?.addEventListener("click", () => {
    if (document.body.classList.contains("word-crown")) openWord();
  });
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
    if (event.target.closest?.(".days, button, .sheet, .event")) return;
    if (sheetOpen()) return;
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
}

function refreshNow() {
  refreshLines();
  const today = isoDate(dateOfDay(selectedDay)) === isoDate(new Date());
  const clockNow = new Date();
  const nowMinutes = clockNow.getHours() * 60 + clockNow.getMinutes() + clockNow.getSeconds() / 60;

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
  node.append(
    el("span", "gap-line"),
    el("span", "gap-text", t(long ? "обед · {n} мин" : "перемена · {n} мин", { n: gap })),
    el("span", "gap-line")
  );
  return node;
}

function renderWindow(slot, bell) {
  const node = el("div", "window");
  node.append(el("span", "window-slot", t("{n} пара", { n: slot })));
  node.append(el("span", null, t("ОКНО")));
  if (bell) node.append(el("span", "window-time", `${bell.start} – ${bell.end}`));
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

function renderCard(entries, bells, slots = [entries[0].slot]) {
  const first = entries[0];
  const bell = timesOf(first, bells);
  const lastBell = bells.get(slots[slots.length - 1]);

  // Дисциплины по выбору и межфакультетские курсы выделены цветом: их
  // посещают не все, и в общем списке их надо отличать с одного взгляда.
  let kind = "";
  if (first.subject === MFK) kind = " card--mfk";
  else if (first.elective === ELECTIVE) kind = " card--elective";
  else if (first.elective) kind = " card--optional";
  const card = el("article", `card${kind}`);
  card.dataset.slot = first.slot;
  card.dataset.slots = slots.join(",");
  card.dataset.subject = first.subject;
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
  if (first.subject === MFK) head.append(el("span", "tag", t("МФК")));
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
    card.append(roomBadge(first.room));
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
  box.replaceChildren(words(title, "splash-hello-title"), ...(wish ? [words(wish, "splash-hello-wish")] : []));
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

const SPLASH_MIN = 1700; // не короче: иначе сборка и приветствие не успевают прочитаться
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
  let list = lessonsForDay(group, day, week);
  const mine = group.teacher ? [] : mfkLessons(day);
  if (mine.length) list = [...list.filter((lesson) => lesson.subject !== MFK), ...mine];
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
    els.splashDay.textContent = activeGroup() ? t("Пар нет 🎉") : "";
    return activeGroup() ? 500 : 0;
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
  const track = els.splashTrack?.getBoundingClientRect();
  if (track && track.height) {
    const y = ((track.top + track.height / 2) / window.innerHeight) * 100;
    splash.style.setProperty("--fold-y", `${y}%`);
  }
  splash.classList.add("splash--gone");
  setTimeout(() => splash.remove(), 700);
  // Расписание развернулось — теперь можно и салют в честь праздника.
  setTimeout(() => {
    celebrateEvent();
    afterSplashQueue.splice(0).forEach((fn) => fn());
  }, 450);
}

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
  return !document.getElementById("queues") || !document.getElementById("tabs");
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
  // Страховка: что бы ни случилось с загрузкой, заставка не зависнет.
  setTimeout(dropSplash, SPLASH_MAX + 1500);

  // Переводы названий грузим вместе с расписанием; не загрузились —
  // покажем по-русски, но расписание откроется.
  const subjects =
    LANG === "ru"
      ? Promise.resolve({})
      : fetch("data/subjects.json", { cache: "no-cache" })
          .then((res) => (res.ok ? res.json() : {}))
          .catch(() => ({}));

  try {
    const res = await fetch("data/schedule.json", { cache: "no-cache" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
  } catch (e) {
    fail(t("Не удалось загрузить расписание. Попробуйте позже."));
    console.error(e);
    return;
  }
  SUBJECTS = await subjects;

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
  applyTheme();
  els.group.addEventListener("change", fillLanguages);
  els.main.addEventListener("change", fillMainSubgroups);
  els.lang2.addEventListener("change", fillLang2Subgroups);
  els.save.addEventListener("click", () => {
    haptic("success");
    const before = prefs.group;
    prefs = collectPrefs();
    if (els.role?.value === "teacher" && els.teacher?.value) {
      prefs = { ...prefs, teacher: els.teacher.value, teacherName: TEACHER_NAMES?.[els.teacher.value] || els.teacher.value };
    }
    savePrefs(prefs);
    notices.group = null;
    openTab(tab === "search" ? "schedule" : tab);
    // Сменили группу — сообщаем боту, чтобы статистика знала новую группу.
    const group = !prefs.teacher && groupById(prefs.group);
    if (group && group.id !== before) countOpen({ id: group.id, course: group.course, level: group.level });
    if (prefs.teacher) countOpen(teacherVisit(prefs.teacher));
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
}

init();
