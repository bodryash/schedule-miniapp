const tg = window.Telegram?.WebApp;
const STORAGE_KEY = "schedule.prefs";

const DAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];

// Основной язык: английский либо русский для иностранцев. Одновременно их
// не бывает, поэтому в опросе это один вопрос. Название зависит от курса.
const MAIN_LANGS = [
  "Английский язык",
  "Профессиональный английский язык",
  "Русский язык как иностранный",
  "Профессиональный русский язык",
];
// Второй и третий языки подписаны порядковым номером.
const EXTRA_LANG = /^\d+-(ой|ий)\s/;

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
  electivesRow: document.getElementById("electives-row"),
  electives: document.getElementById("electives"),
  save: document.getElementById("save"),
  change: document.getElementById("change"),
  close: document.getElementById("close"),
  currentGroup: document.getElementById("current-group"),
  dateLabel: document.getElementById("date-label"),
  weekLabel: document.getElementById("week-label"),
  days: document.getElementById("days"),
  lessons: document.getElementById("lessons"),
  error: document.getElementById("error"),
};

let data = null;
let prefs = null;

// В воскресенье занятий нет, поэтому показываем понедельник — уже следующей
// недели, а не той, что закончилась.
const baseDate = new Date();
if (baseDate.getDay() === 0) baseDate.setDate(baseDate.getDate() + 1);

const weekStart = mondayOf(baseDate);
let selectedDay = Math.min((baseDate.getDay() + 6) % 7, 5) + 1;

/** Понедельник недели, в которую попадает дата. */
function mondayOf(date) {
  const monday = new Date(date);
  monday.setHours(0, 0, 0, 0);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  return monday;
}

/** Дата дня недели (1 = понедельник) в показываемой неделе. */
function dateOfDay(day) {
  const date = new Date(weekStart);
  date.setDate(date.getDate() + day - 1);
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
  const from = isoDate(weekStart);
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

function fillCourses() {
  const courses = [...new Set(data.groups.map((g) => g.course))].sort((a, b) => a - b);
  els.course.replaceChildren(...courses.map((c) => new Option(`${c} курс`, String(c))));
  if (prefs.group) {
    const group = groupById(prefs.group);
    if (group) els.course.value = String(group.course);
  }
  fillGroups();
}

function fillGroups() {
  const course = Number(els.course.value);
  const groups = data.groups.filter((g) => g.course === course);
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

  // Второй и третий языки: студент ходит только на один.
  const extras = subjects.filter((s) => EXTRA_LANG.test(s)).sort();
  els.lang2Row.hidden = extras.length === 0;
  if (extras.length) {
    els.lang2.replaceChildren(
      new Option("не выбран — показывать все", ANY),
      ...extras.map((s) => new Option(s, s))
    );
    els.lang2.value = extras.includes(prefs.lang2) ? prefs.lang2 : ANY;
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
}

function renderDays() {
  els.days.replaceChildren(
    ...DAYS.map((name, i) => {
      const day = i + 1;
      const btn = el("button", day === selectedDay ? "day active" : "day");
      btn.append(
        el("span", null, name),
        el("span", "day-date", SHORT_DATE.format(dateOfDay(day)))
      );
      btn.addEventListener("click", () => {
        selectedDay = day;
        showSchedule();
      });
      return btn;
    })
  );
}

/** Отсеивает языковые пары чужих подгрупп по настройкам студента. */
function matchesPrefs(lesson) {
  // Пустой список читаем как «показывать все» — иначе студент, ничего не
  // отметив, получил бы расписание без дисциплин по выбору.
  if (lesson.elective === ELECTIVE && prefs.electives?.length) {
    if (!prefs.electives.includes(lesson.subject)) return false;
  }

  if (!lesson.subgroup) return true;

  if (MAIN_LANGS.includes(lesson.subject)) {
    if (!prefs.main) return true;
    if (lesson.subject !== prefs.main) return false;
    return prefs.mainGroup == null || lesson.subgroup === prefs.mainGroup;
  }
  if (EXTRA_LANG.test(lesson.subject)) {
    if (!prefs.lang2) return true;
    if (lesson.subject !== prefs.lang2) return false;
    return prefs.lang2Group == null || lesson.subgroup === prefs.lang2Group;
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

  if (list.length === 0) {
    els.lessons.replaceChildren(el("p", "empty", "Пар нет 🎉"));
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

  nodes.forEach((node, i) => node.style.setProperty("--i", i));
  els.lessons.replaceChildren(...nodes);
  refreshNow();
  scrollToNow();
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
 * Какая пара идёт по часам телефона и насколько она прошла.
 * Только для сегодняшнего дня — в чужом дне «сейчас» не существует.
 */
function currentLesson() {
  if (!data || isoDate(dateOfDay(selectedDay)) !== isoDate(new Date())) return null;

  const now = new Date();
  const nowMinutes = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;

  for (const bell of data.bells) {
    const start = minutes(bell.start);
    const end = minutes(bell.end);
    if (nowMinutes >= start && nowMinutes <= end) {
      return {
        slot: bell.n,
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
      card.append(badge);
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

function describe(lesson) {
  return [lesson.type, lesson.teacher, lesson.room && `ауд. ${lesson.room}`]
    .filter(Boolean)
    .join(" · ");
}

function renderCard(entries, bells) {
  const first = entries[0];
  const bell = bells.get(first.slot);

  // Дисциплины по выбору и межфакультетские курсы выделены цветом: их
  // посещают не все, и в общем списке их надо отличать с одного взгляда.
  let kind = "";
  if (first.subject === MFK) kind = " card--mfk";
  else if (first.elective === ELECTIVE) kind = " card--elective";
  const card = el("article", `card${kind}`);
  card.dataset.slot = first.slot;

  const head = el("div", "time");
  head.append(el("span", "slot", `${first.slot} пара`));
  if (bell) head.append(el("span", null, `${bell.start} – ${bell.end}`));
  if (first.subject === MFK) head.append(el("span", "tag", "МФК"));
  else if (first.elective) head.append(el("span", "tag", first.elective));
  card.append(head, el("div", "subject", first.subject));

  if (entries.length === 1) {
    const meta = describe(first);
    if (meta) card.append(el("div", "meta", meta));
  } else {
    const details = el("details", "subgroups");
    details.append(el("summary", null, `${entries.length} подгрупп — показать`));
    for (const entry of entries) {
      const label = entry.subgroup ? `гр. ${entry.subgroup} · ` : "";
      details.append(el("div", "meta", label + describe(entry)));
    }
    card.append(details);
  }

  const notes = [...new Set(entries.map((e) => e.note).filter(Boolean))];
  if (notes.length) card.append(el("div", "note", notes.join("; ")));
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
    if (!els.schedule.hidden) refreshNow();
  }, 30_000);

  if (prefs.group && groupById(prefs.group)) showSchedule();
  else showPicker();
}

init();
