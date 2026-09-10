const tg = window.Telegram?.WebApp;
const STORAGE_KEY = "schedule.prefs";
const HIT_URL = "https://fgp-schedule-bot.bodryash.workers.dev/hit";

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
const NOTICES_URL = "https://fgp-schedule-bot.bodryash.workers.dev/notices";
const DISMISSED_KEY = "schedule.dismissedNotices";

// cancels — отменённые пары (/cancel), приходят тем же запросом.
let notices = { group: null, list: [], cancels: [] };

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
  notices = { group: groupId, list: [], cancels: [] };
  renderNotices(false);
  try {
    // Курс и ступень — для объявлений на весь курс («/notice 3курс»).
    const query = new URLSearchParams({ group: groupId, course: group.course, level: group.level });
    const res = await fetch(`${NOTICES_URL}?${query}`);
    if (!res.ok) return;
    const body = await res.json();
    if (notices.group !== groupId) return;
    notices.list = body.notices || [];
    notices.cancels = body.cancels || [];
    renderNotices(true);
    applyCancels();
  } catch {
    // Без объявлений расписание остаётся расписанием.
  }
}

function renderNotices(animate) {
  const dismissed = readDismissed();
  const nodes = notices.list
    .filter((n) => !dismissed.includes(n.id))
    .map((n) => {
      const node = el("div", animate ? "notice notice--enter" : "notice");
      const close = el("button", "notice-close", "×");
      close.type = "button";
      close.setAttribute("aria-label", "Скрыть объявление");
      close.addEventListener("click", () => {
        dismissNotice(n.id);
        node.remove();
      });
      node.append(el("div", "notice-text", n.text), close);
      return node;
    });
  els.notices.replaceChildren(...nodes);
}

/** Отмена пары в показанный день: по номеру; отмена без номеров — весь день. */
function cancelFor(slot) {
  const day = isoDate(dateOfDay(selectedDay));
  return (
    notices.cancels.find((c) => c.day === day && (!c.slots.length || c.slots.includes(slot))) ||
    null
  );
}

/**
 * Зачёркивает отменённые пары поверх готовых карточек, как refreshNow:
 * отмены приходят позже расписания, и перерисовка заново проиграла бы
 * появление списка.
 */
function applyCancels() {
  for (const card of els.lessons.querySelectorAll(".card")) {
    const cancel = cancelFor(Number(card.dataset.slot));
    card.classList.toggle("card--cancelled", Boolean(cancel));
    let note = card.querySelector(".cancel-note");
    if (!cancel) {
      note?.remove();
      continue;
    }
    if (!note) {
      note = el("div", "cancel-note");
      (card.querySelector(".card-body") || card).append(note);
    }
    note.textContent = cancel.reason ? `Отменена · ${cancel.reason}` : "Отменена";
  }
  refreshNow();
  refreshNext();
}

const DAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];

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

const FULL_DATE = new Intl.DateTimeFormat("ru-RU", {
  weekday: "long",
  day: "numeric",
  month: "long",
});
const SHORT_DATE = new Intl.DateTimeFormat("ru-RU", {
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
  electivesRow: document.getElementById("electives-row"),
  electives: document.getElementById("electives"),
  save: document.getElementById("save"),
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
function weekParity(weeks) {
  // Чётность — свойство недели, а не дня: считаем по пересечению с
  // Пн–Сб, иначе понедельник 31.08 выпал бы из семестра, начатого 02.09.
  const from = isoDate(dateOfDay(1));
  const to = isoDate(dateOfDay(6));
  const week = (weeks || []).find((w) => w.from <= to && from <= w.to);
  return week ? week.parity : null;
}

function fail(message) {
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
    ? `${group.course} курс магистратуры`
    : `${group.course} курс`;
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
      new Option("не выбран — показывать все", ANY),
      ...mains.map((s) => new Option(s, s))
    );
    els.main.value = mains.includes(prefs.main) ? prefs.main : ANY;
  }
  fillMainSubgroups();

  const second = subjects.filter((s) => LANG2.test(s)).sort();
  els.lang2Row.hidden = second.length === 0;
  if (second.length) {
    els.lang2.replaceChildren(
      new Option("не выбран — показывать все", ANY),
      ...second.map((s) => new Option(s, s))
    );
    els.lang2.value = second.includes(prefs.lang2) ? prefs.lang2 : ANY;
  }

  // Третий язык берут вдобавок ко второму, поэтому спрашиваем отдельно.
  // По умолчанию его не показываем: ходят на него единицы.
  const third = subjects.filter((s) => LANG3.test(s)).sort();
  els.lang3Row.hidden = third.length === 0;
  if (third.length) {
    els.lang3.replaceChildren(
      new Option("не хожу", ANY),
      ...third.map((s) => new Option(s, s))
    );
    els.lang3.value = third.includes(prefs.lang3) ? prefs.lang3 : ANY;
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
      row.append(box, el("span", null, subject));
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
      new Option("показывать все", ANY),
      ...subgroups.map((n) => new Option(`гр. ${n}`, String(n)))
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
      new Option("показывать все", ANY),
      ...subgroups.map((n) => new Option(`гр. ${n}`, String(n)))
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
    electives: [...els.electives.querySelectorAll("input:checked")].map(
      (box) => box.value
    ),
  };
}

function showPicker() {
  els.schedule.hidden = true;
  els.picker.hidden = false;
  // Возвращаться некуда, пока группа не выбрана хотя бы раз.
  els.close.hidden = !prefs.group || !groupById(prefs.group);
  fillCourses();
}

/* ---------- Экран расписания ---------- */

function showSchedule() {
  const group = groupById(prefs.group);
  if (!group) return showPicker();

  els.picker.hidden = true;
  els.schedule.hidden = false;
  els.currentGroup.textContent = `Группа ${group.title}`;

  const label = FULL_DATE.format(dateOfDay(selectedDay));
  els.dateLabel.textContent = label[0].toUpperCase() + label.slice(1);
  const parity = weekParity(data.weeks);
  // Голубой интерфейс — нечётная неделя, оранжевый — чётная.
  document.body.dataset.parity = parity || "none";
  els.weekLabel.textContent =
    parity === "odd"
      ? "Нечётная неделя"
      : parity === "even"
        ? "Чётная неделя"
        : "Вне семестра";

  renderDays();
  renderLessons(group, parity);
  loadNotices(group);
}

function renderDays() {
  const nodes = [];
  const todayIso = isoDate(new Date());

  for (let week = 0; week < WEEKS; week++) {
    if (week > 0) nodes.push(el("span", "days-split"));

    for (let day = 1; day <= DAYS.length; day++) {
      const active = day === selectedDay && week === selectedWeek;
      const date = dateOfDay(day, week);

      const btn = el("button", active ? "day active" : "day");
      if (isoDate(date) === todayIso) btn.classList.add("day--today");
      btn.append(
        el("span", null, DAYS[day - 1]),
        el("span", "day-date", SHORT_DATE.format(date))
      );
      btn.addEventListener("click", () => {
        selectedDay = day;
        selectedWeek = week;
        showSchedule();
      });
      nodes.push(btn);
    }
  }

  els.days.replaceChildren(...nodes);
  keepSelectedVisible();
}

/** Полоса шире экрана, поэтому подводим выбранный день к центру. */
function keepSelectedVisible() {
  const active = els.days.querySelector(".day.active");
  if (!active) return;
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  active.scrollIntoView({
    behavior: reduce || !daysScrolled ? "auto" : "smooth",
    inline: "center",
    block: "nearest",
  });
  daysScrolled = true;
}

let daysScrolled = false;

/** Отсеивает языковые пары чужих подгрупп по настройкам студента. */
function matchesPrefs(lesson) {
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

function renderLessons(group, parity) {
  const bells = new Map(data.bells.map((b) => [b.n, b]));
  const list = data.lessons
    .filter(
      (l) =>
        l.group === group.id &&
        l.day === selectedDay &&
        (l.week === "all" || parity === null || l.week === parity) &&
        matchesPrefs(l)
    )
    .sort((a, b) => a.slot - b.slot);

  visible = list;

  if (list.length === 0) {
    els.lessons.replaceChildren(el("p", "empty", "Пар нет 🎉"));
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
  const nodes = [];
  for (let slot = slots[0]; slot <= slots[slots.length - 1]; slot++) {
    const buckets = bySlot.get(slot);
    if (buckets) {
      for (const entries of buckets.values()) nodes.push(renderCard(entries, bells));
    } else {
      // Свободная пара между занятыми — показываем как окно, чтобы её было
      // видно прямо в расписании, а не считать по времени.
      nodes.push(renderWindow(slot, bells.get(slot)));
    }
  }

  // Пришли листанием — новый день въезжает с той стороны, откуда его тянули.
  const from = enterFrom * 24;
  enterFrom = 0;
  nodes.forEach((node, i) => {
    node.style.setProperty("--i", i);
    node.style.setProperty("--from-x", `${from}px`);
  });

  els.lessons.replaceChildren(...nodes);
  applyCancels();
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
    button.textContent = "Адрес скопирован";
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
  els.query.focus();
}

function closeSearch() {
  els.search.hidden = true;
  showSchedule();
}

/** Ищем по преподавателю, аудитории, предмету и номеру группы разом. */
function runSearch() {
  const query = els.query.value.trim().toLowerCase();
  if (query.length < 2) {
    els.results.replaceChildren();
    els.searchHint.textContent = "Например: Шестова, 614, микроэкономика";
    return;
  }

  const found = data.lessons.filter((l) =>
    [l.teacher, l.room, l.subject, l.group].some((field) =>
      (field || "").toLowerCase().includes(query)
    )
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

  if (!rows.length) {
    els.results.replaceChildren();
    els.searchHint.textContent = "Ничего не нашлось";
    return;
  }

  const shown = rows.slice(0, SEARCH_LIMIT);
  els.searchHint.textContent =
    rows.length > SEARCH_LIMIT
      ? `Найдено ${rows.length}, показаны первые ${SEARCH_LIMIT}`
      : `Найдено ${rows.length}`;

  const bells = new Map(data.bells.map((b) => [b.n, b]));
  els.results.replaceChildren(
    ...shown.map(({ lesson, groups }) => {
      const bell = timesOf(lesson, bells);
      const row = el("article", "card");

      const head = el("div", "time");
      head.append(el("span", "slot", `${DAYS[lesson.day - 1]}, ${lesson.slot} пара`));
      if (bell) head.append(el("span", null, `${bell.start} – ${bell.end}`));
      if (lesson.week !== "all") {
        head.append(el("span", "tag", lesson.week === "odd" ? "нечётная" : "чётная"));
      }

      const body = el("div", "card-body");
      body.append(head, el("div", "subject", lesson.subject));
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
      button.append(el("span", null, `${b.n} пара`), el("span", "day-date", b.start));
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

  els.freeHint.textContent = `Свободно ${free.length} из ${all.length} · ${bell.start} – ${bell.end}`;
  // Итог меняется вместе с парой. Сам элемент не пересоздаётся, поэтому
  // CSS-анимация сработала бы один раз при открытии — запускаем явно.
  if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    els.freeHint.animate([{ opacity: 0.35 }, { opacity: 1 }], {
      duration: 180,
      easing: "cubic-bezier(0.23, 1, 0.32, 1)",
    });
  }

  if (!free.length) {
    els.freeList.replaceChildren(el("p", "empty", "Все аудитории заняты"));
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
      const heading = el("h2", null, `${floor} этаж`);
      heading.style.setProperty("--i", order++);
      block.append(heading);
      const grid = el("div", "free-grid");
      for (const item of items) {
        const tile = el("div", "free-room");
        tile.style.setProperty("--i", order++);
        tile.append(
          el("span", "free-num", item.room),
          el("span", "free-until", item.until === null ? "до конца дня" : `до ${clock(item.until)}`)
        );
        grid.append(tile);
      }
      block.append(grid);
      return block;
    })
  );
}

/* ---------- Листание дней ---------- */

// Куда «уезжает» новый день при появлении: -1 — пришли справа, 1 — слева.
let enterFrom = 0;

const SWIPE_DISTANCE = 0.22; // доля ширины экрана
const SWIPE_VELOCITY = 0.35; // px/мс — быстрый флик засчитываем без дистанции
const TAP_ZONE = 0.22; // доля ширины: касание у края листает, как в сторис
const TAP_SLOP = 8; // px — больше этого уже не касание, а жест

/** Переход на соседний день с анимацией въезда с нужной стороны. */
function goToDay(direction) {
  const next = dayIndex() + direction;
  if (next < 0 || next >= DAY_COUNT) return false;
  setDayIndex(next);
  enterFrom = direction;
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
    if (event.target.closest?.(".days, button")) return;
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
function currentLesson() {
  if (!data || isoDate(dateOfDay(selectedDay)) !== isoDate(new Date())) return null;

  const now = new Date();
  const nowMinutes = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;

  // Идём по парам этой группы, а не по звонкам: звонок звенит для всех, но
  // пары в это время может не быть, а у части занятий время своё.
  const bells = new Map(data.bells.map((b) => [b.n, b]));
  for (const lesson of visible) {
    const time = timesOf(lesson, bells);
    if (!time || cancelFor(lesson.slot)) continue;
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
  if (left < 1) return "меньше минуты";
  const hours = Math.floor(left / 60);
  const rest = left % 60;
  if (hours && rest) return `${hours} ч ${rest} мин`;
  if (hours) return `${hours} ч`;
  return `${rest} мин`;
}

// Пары показанного дня после фильтров — нужны и для «дальше», и для «сейчас».
let visible = [];

/** Ближайшая пара сегодня, которая ещё не началась. */
function nextLesson() {
  if (isoDate(dateOfDay(selectedDay)) !== isoDate(new Date())) return null;

  const now = new Date();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const bells = new Map(data.bells.map((b) => [b.n, b]));

  let best = null;
  for (const lesson of visible) {
    const time = timesOf(lesson, bells);
    if (!time || cancelFor(lesson.slot)) continue;
    const start = minutes(time.start);
    if (start <= nowMinutes) continue;
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
  if (visible.every((lesson) => cancelFor(lesson.slot))) {
    els.next.textContent = "Все пары на сегодня отменены";
    return;
  }

  const upcoming = nextLesson();

  if (!upcoming) {
    els.next.textContent = currentLesson() ? "Это последняя пара" : "Пары закончились";
    return;
  }

  const where = upcoming.lesson.room ? `, ${roomLabel(upcoming.lesson.room)}` : "";
  els.next.replaceChildren(
    el("span", "next-when", `через ${humanLeft(upcoming.left)}`),
    el("span", null, `${upcoming.lesson.subject}${where}`)
  );
}

/**
 * Подсвечивает идущую пару. Работает поверх готовых карточек, а не через
 * перерисовку: иначе список заново проигрывал бы появление каждую минуту.
 */
function refreshNow() {
  const current = currentLesson();

  for (const card of els.lessons.querySelectorAll(".card")) {
    const isNow = current && Number(card.dataset.slot) === current.slot;
    card.classList.toggle("card--now", Boolean(isNow));

    let badge = card.querySelector(".now");
    let bar = card.querySelector(".now-bar");

    if (!isNow) {
      badge?.remove();
      bar?.remove();
      continue;
    }

    if (!badge) {
      badge = el("div", "now");
      badge.append(
        el("span", "now-dot"),
        el("span", null, "идёт сейчас"),
        el("span", "now-left")
      );
      // Именно в тело карточки: сама карточка — горизонтальный ряд, и
      // строка, добавленная в неё, встала бы третьей колонкой рядом с
      // плашкой аудитории.
      (card.querySelector(".card-body") || card).append(badge);
    }
    badge.querySelector(".now-left").textContent = `осталось ${humanLeft(current.left)}`;

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

function renderWindow(slot, bell) {
  const node = el("div", "window");
  node.append(el("span", "window-slot", `${slot} пара`));
  node.append(el("span", null, "ОКНО"));
  if (bell) node.append(el("span", "window-time", `${bell.start} – ${bell.end}`));
  return node;
}

// «дистант» и «вирт» — не аудитории, приписывать к ним «ауд.» незачем.
const REMOTE_ROOMS = ["дистант", "дистанционно", "онлайн", "вирт"];

function roomLabel(room) {
  if (!room) return "";
  return REMOTE_ROOMS.includes(room.toLowerCase()) ? room : `ауд. ${room}`;
}

function describe(lesson) {
  return [lesson.type, lesson.teacher, roomLabel(lesson.room)]
    .filter(Boolean)
    .join(" · ");
}

/**
 * Строка под названием. Аудиторию сюда не пишем, когда она вынесена в
 * отдельную плашку справа — иначе она стояла бы дважды.
 */
function metaLine(lesson, prefix = "", withRoom = true) {
  const line = el("div", "meta");
  const before = [prefix, lesson.type, lesson.teacher].filter(Boolean).join(" · ");
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
  if (REMOTE_ROOMS.includes(room.toLowerCase())) {
    badge.classList.add("room-badge--remote");
    badge.textContent = room;
  } else {
    badge.append(el("span", "room-badge-label", "ауд."), el("span", null, room));
  }
  // Длинные имена вроде «П6 1 ГУМ» набираем мельче, чтобы плашка не росла.
  if (room.length > 5) badge.classList.add("room-badge--long");
  return badge;
}

function renderCard(entries, bells) {
  const first = entries[0];
  const bell = timesOf(first, bells);

  // Дисциплины по выбору и межфакультетские курсы выделены цветом: их
  // посещают не все, и в общем списке их надо отличать с одного взгляда.
  let kind = "";
  if (first.subject === MFK) kind = " card--mfk";
  else if (first.elective === ELECTIVE) kind = " card--elective";
  else if (first.elective) kind = " card--optional";
  const card = el("article", `card${kind}`);
  card.dataset.slot = first.slot;

  const head = el("div", "time");
  head.append(el("span", "slot", `${first.slot} пара`));
  if (bell) head.append(el("span", null, `${bell.start} – ${bell.end}`));
  if (first.subject === MFK) head.append(el("span", "tag", "МФК"));
  else if (first.elective) head.append(el("span", "tag", first.elective));
  // Аудитория выносится вправо отдельной плашкой — но только когда она одна
  // на всю карточку. У подгрупп аудитории разные, и в списке они остаются.
  const single = entries.length === 1;
  const body = el("div", "card-body");
  body.append(head, el("div", "subject", first.subject));

  if (single) {
    body.append(metaLine(first, "", false));
  } else {
    const details = el("details", "subgroups");
    details.append(el("summary", null, `${entries.length} подгрупп — показать`));
    for (const entry of entries) {
      details.append(metaLine(entry, entry.subgroup ? `гр. ${entry.subgroup}` : ""));
    }
    body.append(details);
  }

  const notes = [...new Set(entries.map((e) => e.note).filter(Boolean))];
  if (notes.length) body.append(el("div", "note", notes.join("; ")));

  // Занятие на удалёнке — ссылка на встречу прямо в карточке.
  const link = entries.find((e) => e.link)?.link;
  if (link) {
    const button = el("button", "link", "Подключиться");
    button.type = "button";
    button.addEventListener("click", () => {
      if (tg?.openLink) tg.openLink(link);
      else window.open(link, "_blank", "noopener");
    });
    body.append(button);
  }

  card.append(body);
  if (single && first.room) card.append(roomBadge(first.room));
  return card;
}

/* ---------- Запуск ---------- */

async function init() {
  tg?.ready();
  tg?.expand();

  try {
    const res = await fetch("data/schedule.json", { cache: "no-cache" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
  } catch (e) {
    fail("Не удалось загрузить расписание. Попробуйте позже.");
    console.error(e);
    return;
  }

  prefs = readPrefs();

  els.course.addEventListener("change", fillGroups);
  els.group.addEventListener("change", fillLanguages);
  els.main.addEventListener("change", fillMainSubgroups);
  els.lang2.addEventListener("change", fillLang2Subgroups);
  els.save.addEventListener("click", () => {
    prefs = collectPrefs();
    savePrefs(prefs);
    showSchedule();
  });
  els.change.addEventListener("click", showPicker);
  initHomeScreen();
  els.find.addEventListener("click", showSearch);
  els.rooms.addEventListener("click", showFree);
  els.freeClose.addEventListener("click", closeFree);
  els.searchClose.addEventListener("click", closeSearch);
  els.query.addEventListener("input", runSearch);
  initSwipe();
  // Крестик закрывает настройки, не сохраняя изменений.
  els.close.addEventListener("click", showSchedule);

  // Возврат в свёрнутое приложение — момент, когда расхождение с часами
  // максимально, а следующий тик ещё не наступил.
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && !els.schedule.hidden) refreshNow();
  });

  const openedOn = isoDate(new Date());
  setInterval(() => {
    // Приложение могли оставить открытым до следующего дня — тогда неделя и
    // выбранный день устарели, и точечного обновления уже мало.
    if (isoDate(new Date()) !== openedOn) return location.reload();
    if (!els.schedule.hidden) {
      refreshNow();
      refreshNext();
    }
  }, 30_000);

  const group = prefs.group && groupById(prefs.group);
  if (group) {
    showSchedule();
    countOpen({ id: group.id, course: group.course, level: group.level });
  } else {
    showPicker();
  }
}

init();
