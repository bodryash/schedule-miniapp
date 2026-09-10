/**
 * Расписание прямо в чатах: пишешь «@FGPshedulebot 311гэу завтра» в любой
 * переписке — и отправляешь карточку с парами, не открывая приложение.
 *
 * Данные берём из файлов по группам (docs/data/groups/<id>.json): целое
 * расписание весит мегабайт, а отвечать нужно быстро.
 */

const DATA_URL = "https://bodryash.github.io/schedule-miniapp/data/";
const APP_LINK = "https://t.me/FGPshedulebot/schedule";

// Факультет живёт по Москве, а воркер — по UTC. Без сдвига после 21:00
// «сегодня» было бы уже завтрашним днём.
const MSK = 3 * 3600 * 1000;

const WEEKDAYS = ["Воскресенье", "Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота"];
const SHORT = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];
const MONTHS = [
  "января", "февраля", "марта", "апреля", "мая", "июня",
  "июля", "августа", "сентября", "октября", "ноября", "декабря",
];

// Как люди пишут дни: «чт», «четверг», «в четверг».
const DAY_WORDS = new Map([
  ["пн", 1], ["понедельник", 1],
  ["вт", 2], ["вторник", 2],
  ["ср", 3], ["среда", 3], ["среду", 3],
  ["чт", 4], ["четверг", 4],
  ["пт", 5], ["пятница", 5], ["пятницу", 5],
  ["сб", 6], ["суббота", 6], ["субботу", 6],
]);

// Сколько групп подсказываем по началу названия: на каждую — отдельный
// запрос к файлу, а их за один запуск воркера немного.
const SUGGEST = 8;

function escape(text) {
  return String(text).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c]);
}

/** Сравниваем без регистра, ё, пробелов и подчёркиваний: «251 гэу ин». */
export function normalize(text) {
  return String(text).toLowerCase().replace(/ё/g, "е").replace(/[\s_\-]/g, "");
}

function plural(n, one, few, many) {
  const tens = n % 100;
  const ones = n % 10;
  if (tens >= 11 && tens <= 14) return many;
  if (ones === 1) return one;
  if (ones >= 2 && ones <= 4) return few;
  return many;
}

/** Полночь сегодняшнего дня по Москве; дальше работаем с UTC-полями. */
export function today() {
  const now = new Date(Date.now() + MSK);
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export function addDays(date, count) {
  return new Date(date.getTime() + count * 86400000);
}

export const iso = (date) => date.toISOString().slice(0, 10);

/** «14.09», «14.09.2026», «сегодня», «завтра», «чт» → дата по Москве. */
export function parseDay(word) {
  const key = String(word).toLowerCase().replace(/ё/g, "е");
  const now = today();
  if (key === "сегодня") return now;
  if (key === "завтра") return addDays(now, 1);
  if (key === "послезавтра") return addDays(now, 2);
  // «Чт» — ближайший четверг, сегодняшний тоже считается.
  if (DAY_WORDS.has(key)) return addDays(now, (DAY_WORDS.get(key) - now.getUTCDay() + 7) % 7);

  const match = key.match(/^(\d{1,2})\.(\d{1,2})(?:\.(\d{2}|\d{4}))?$/);
  if (!match) return null;
  const year = match[3] ? Number(match[3].length === 2 ? `20${match[3]}` : match[3]) : now.getUTCFullYear();
  const date = new Date(Date.UTC(year, Number(match[2]) - 1, Number(match[1])));
  // 31.02 Date молча превратил бы в 3 марта.
  if (date.getUTCDate() !== Number(match[1]) || date.getUTCMonth() !== Number(match[2]) - 1) return null;
  // Без года «12.01», набранное в декабре, — это январь следующего года.
  if (!match[3] && date < addDays(now, -180)) date.setUTCFullYear(year + 1);
  return date;
}

/** Отмена, которая касается пары: по дате и номеру; без номеров — весь день. */
export function cancelOf(cancels, day, slot) {
  return cancels.find((c) => c.day === day && (!c.slots.length || c.slots.includes(slot))) || null;
}

/** Понедельник недели; для воскресенья — следующей, как в приложении. */
function mondayOf(date) {
  const day = date.getUTCDay();
  return addDays(date, day === 0 ? 1 : 1 - day);
}

/** Чётность — по календарю из расписания, по пересечению с Пн–Сб. */
function parityOf(weeks, date) {
  const monday = addDays(date, 1 - (date.getUTCDay() || 7));
  const from = iso(monday);
  const to = iso(addDays(monday, 5));
  const week = (weeks || []).find((w) => w.from <= to && from <= w.to);
  return week ? week.parity : null;
}

export function dateLabel(date) {
  return `${WEEKDAYS[date.getUTCDay()]}, ${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
}

/** Разбирает запрос на группу и день. Порядок слов любой. */
export function parseQuery(text) {
  const rest = [];
  let when = null;
  for (const word of String(text).toLowerCase().replace(/ё/g, "е").split(/\s+/)) {
    if (!word || word === "в" || word === "на") continue;
    if (word === "сегодня") when = { kind: "day", offset: 0 };
    else if (word === "завтра") when = { kind: "day", offset: 1 };
    else if (word === "послезавтра") when = { kind: "day", offset: 2 };
    else if (word.startsWith("недел")) when = { kind: "week", offset: 0 };
    else if (DAY_WORDS.has(word)) when = { kind: "weekday", day: DAY_WORDS.get(word) };
    else rest.push(word);
  }
  return { group: rest.join(""), when };
}

/** Точное совпадение — одна группа; иначе все, чьё название так начинается. */
export function findGroups(groups, token) {
  const key = normalize(token);
  if (!key) return [];
  const exact = groups.filter((g) => normalize(g.id) === key);
  if (exact.length) return exact;
  return groups.filter((g) => normalize(g.id).startsWith(key));
}

/** Пары группы на дату, сведённые по номеру пары и предмету. */
function lessonsOn(file, date, cancels = []) {
  const day = date.getUTCDay();
  const parity = parityOf(file.weeks, date);
  const list = file.lessons
    .filter((l) => l.day === day && (l.week === "all" || parity === null || l.week === parity))
    .sort((a, b) => a.slot - b.slot);

  const buckets = new Map();
  for (const lesson of list) {
    const key = `${lesson.slot}|${lesson.subject}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(lesson);
  }
  const values = [...buckets.values()];
  for (const entries of values) entries.cancel = cancelOf(cancels, iso(date), entries[0].slot);
  return { parity, buckets: values };
}

function timesOf(lesson, bells) {
  if (lesson.start && lesson.end) return lesson;
  return bells.find((b) => b.n === lesson.slot) || null;
}

// В чате мы не знаем, какой язык у человека: приложение хранит выбор на
// телефоне. Поэтому языки одной пары сводим в строку «по подгруппам» —
// иначе у 311гэу в понедельник было бы восемь строк на одну пару.
const LANGUAGE_KINDS = [
  [/^2-ой\s/, "2-ой иностранный язык"],
  [/^3-ий\s/, "3-ий иностранный язык"],
  [/язык/i, "Английский / русский язык"],
];

function kindOf(subject) {
  const kind = LANGUAGE_KINDS.find(([pattern]) => pattern.test(subject));
  return kind ? kind[1] : subject;
}

function lessonLines(file, buckets) {
  // Строка на предмет в паре; сводим языки одного рода.
  const cells = new Map();
  for (const entries of buckets) {
    const first = entries[0];
    const key = `${first.slot}|${kindOf(first.subject)}`;
    if (!cells.has(key)) cells.set(key, { slot: first.slot, entries: [], cancel: null });
    cells.get(key).entries.push(...entries);
    if (entries.cancel) cells.get(key).cancel = entries.cancel;
  }

  // Одно и то же несколько пар подряд — одной строкой «1–6»: военная
  // кафедра на весь день иначе заняла бы полэкрана.
  const rows = [];
  for (const { slot, entries, cancel } of cells.values()) {
    const first = entries[0];
    const subjects = new Set(entries.map((e) => e.subject));
    const label = subjects.size === 1 ? first.subject : kindOf(first.subject);
    const where = entries.length > 1 ? "по подгруппам" : first.room ? `ауд. ${first.room}` : "";
    const tag = first.elective ? ` <i>(${escape(first.elective)})</i>` : "";
    const plain = `${escape(label)}${tag}${where ? ` · ${escape(where)}` : ""}`;
    const text = cancel
      ? `<s>${plain}</s> — <b>отменена</b>${cancel.reason ? `: ${escape(cancel.reason)}` : ""}`
      : plain;
    const time = timesOf(first, file.bells);

    const same = rows.find((r) => r.text === text && r.to === slot - 1);
    if (same) {
      same.to = slot;
      if (time) same.end = time.end;
    } else {
      rows.push({ from: slot, to: slot, text, start: time?.start, end: time?.end });
    }
  }
  rows.sort((a, b) => a.from - b.from);

  const lines = [];
  const busy = new Set(rows.flatMap((r) => Array.from({ length: r.to - r.from + 1 }, (_, i) => r.from + i)));
  let last = 0;
  for (const row of rows) {
    // Окно между парами — как в приложении, чтобы его было видно сразу.
    for (let slot = last + 1; last && slot < row.from; slot++) {
      if (!busy.has(slot)) lines.push(`${slot} · <i>окно</i>`);
    }
    last = Math.max(last, row.to);
    const slots = row.from === row.to ? `${row.from}` : `${row.from}–${row.to}`;
    const time = row.start ? ` · ${row.start}–${row.end}` : "";
    lines.push(`<b>${slots}</b>${time} · ${row.text}`);
  }
  return lines;
}

function noticeLines(notices) {
  return notices.map((n) => `📌 ${escape(n.text)}`);
}

function dayMessage(file, date, { notices = [], cancels = [] } = {}) {
  const { parity, buckets } = lessonsOn(file, date, cancels);
  const week = parity ? ` · ${parity === "odd" ? "нечётная" : "чётная"} неделя` : "";
  const head = `📅 <b>${escape(file.group.title)}</b> · ${dateLabel(date)}${week}`;
  const body = buckets.length ? lessonLines(file, buckets) : ["Пар нет 🎉"];
  const top = notices.length ? [...noticeLines(notices), ""] : [];
  return [head, "", ...top, ...body].join("\n");
}

function weekMessage(file, monday, { notices = [], cancels = [] } = {}) {
  const parity = parityOf(file.weeks, monday);
  const week = parity ? ` · ${parity === "odd" ? "нечётная" : "чётная"}` : "";
  const saturday = addDays(monday, 5);
  const span =
    monday.getUTCMonth() === saturday.getUTCMonth()
      ? `${monday.getUTCDate()}–${saturday.getUTCDate()} ${MONTHS[saturday.getUTCMonth()]}`
      : `${monday.getUTCDate()} ${MONTHS[monday.getUTCMonth()]} – ${saturday.getUTCDate()} ${MONTHS[saturday.getUTCMonth()]}`;
  const lines = [`📅 <b>${escape(file.group.title)}</b> · неделя ${span}${week}`];
  if (notices.length) lines.push("", ...noticeLines(notices));
  for (let i = 0; i < 6; i++) {
    const date = addDays(monday, i);
    const { buckets } = lessonsOn(file, date, cancels);
    lines.push("", `<b>${SHORT[date.getUTCDay()]}, ${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}</b>`);
    lines.push(...(buckets.length ? lessonLines(file, buckets) : ["Пар нет"]));
  }
  // Предел сообщения в Telegram — 4096 знаков.
  // Режем по строке, а не посреди тега: иначе Telegram отвергнет разметку.
  let text = lines.join("\n");
  while (text.length > 4000) text = `${text.slice(0, text.lastIndexOf("\n", text.length - 3))}\n…`;
  return text;
}

function summary(file, date, cancels = []) {
  if (date.getUTCDay() === 0) return "Воскресенье";
  const { buckets: all } = lessonsOn(file, date, cancels);
  if (!all.length) return "Пар нет";
  const buckets = all.filter((b) => !b.cancel);
  if (!buckets.length) return "Все пары отменены";
  const cancelled = new Set(all.filter((b) => b.cancel).map((b) => b[0].slot)).size;
  const slots = new Set(buckets.map((b) => b[0].slot)).size;
  const first = timesOf(buckets[0][0], file.bells);
  const last = timesOf(buckets[buckets.length - 1][0], file.bells);
  if (cancelled) {
    const span = first && last ? `, ${first.start}–${last.end}` : "";
    return `${slots} ${plural(slots, "пара", "пары", "пар")}${span}, отменено ${cancelled}`;
  }
  const span = first && last ? `, ${first.start}–${last.end}` : "";
  return `${slots} ${plural(slots, "пара", "пары", "пар")}${span}`;
}

function article(id, title, description, text) {
  return {
    type: "article",
    id,
    title,
    description,
    input_message_content: {
      message_text: text,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    },
    reply_markup: {
      inline_keyboard: [[{ text: "📅 Открыть расписание", url: APP_LINK }]],
    },
  };
}

async function loadJson(path) {
  // Файлы меняются раз в неделю — пусть Cloudflare держит их у себя.
  const response = await fetch(`${DATA_URL}${path}`, { cf: { cacheTtl: 300, cacheEverything: true } });
  if (!response.ok) throw new Error(`${path}: ${response.status}`);
  return response.json();
}

export const loadGroups = () => loadJson("groups.json");
const loadGroup = (id) => loadJson(`groups/${encodeURIComponent(id)}.json`);

/** Варианты для одной группы: какие дни предложить. */
function groupResults(file, when, extra) {
  const now = today();
  const results = [];
  const day = (date, title) =>
    results.push(
      article(`d${iso(date)}`, `${title} · ${file.group.title}`, `${dateLabel(date)} — ${summary(file, date, extra.cancels)}`, dayMessage(file, date, extra))
    );
  const week = (monday, title) =>
    results.push(article(`w${iso(monday)}`, `${title} · ${file.group.title}`, "Все дни одним сообщением", weekMessage(file, monday, extra)));

  if (when?.kind === "weekday") {
    // «Чт» — ближайший четверг, сегодняшний тоже считается.
    const date = addDays(now, (when.day - now.getUTCDay() + 7) % 7);
    day(date, SHORT[when.day]);
    week(mondayOf(date), "Вся неделя");
    return results;
  }
  if (when?.kind === "week") {
    week(mondayOf(now), "Эта неделя");
    week(addDays(mondayOf(now), 7), "Следующая неделя");
    return results;
  }
  if (when?.kind === "day" && when.offset > 1) {
    day(addDays(now, when.offset), "Послезавтра");
    return results;
  }

  // В воскресенье «сегодня» пустое — сразу предлагаем понедельник.
  const tomorrow = addDays(now, 1);
  if (when?.offset === 1 || now.getUTCDay() === 0) {
    day(tomorrow, "Завтра");
    if (now.getUTCDay() !== 0) day(now, "Сегодня");
  } else {
    day(now, "Сегодня");
    day(tomorrow, "Завтра");
  }
  week(mondayOf(now), now.getUTCDay() === 0 ? "Следующая неделя" : "Вся неделя");
  return results;
}

/**
 * Отвечает на inline-запрос. `ctx.groupOf(userId)` — группа из статистики,
 * чтобы пустой запрос сразу показывал своё; `ctx.notices(group)` —
 * объявления для группы, её курса и всех; `ctx.cancels(group)` — отмены пар.
 */
export async function answerInline(query, ctx) {
  const groups = await loadGroups();
  const parsed = parseQuery(query.query || "");

  let matched = findGroups(groups, parsed.group);
  let personal = false;
  if (!parsed.group) {
    const own = await ctx.groupOf(query.from?.id);
    matched = own ? groups.filter((g) => g.id === own) : [];
    personal = true;
  }

  let results = [];
  if (matched.length === 1) {
    const [file, notices, cancels] = await Promise.all([
      loadGroup(matched[0].id),
      ctx.notices(matched[0]),
      ctx.cancels(matched[0]),
    ]);
    results = groupResults(file, parsed.when, { notices, cancels });
  } else if (matched.length > 1) {
    // Начало названия — подсказываем группы с сегодняшним днём.
    const now = today();
    const date = now.getUTCDay() === 0 ? addDays(now, 1) : now;
    const files = await Promise.all(
      matched.slice(0, SUGGEST).map(async (g) => ({ file: await loadGroup(g.id), cancels: await ctx.cancels(g) }))
    );
    results = files.map(({ file, cancels }) =>
      article(`g${file.group.id}`.slice(0, 64), file.group.title, `${dateLabel(date)} — ${summary(file, date, cancels)}`, dayMessage(file, date, { cancels }))
    );
  }

  const payload = {
    inline_query_id: query.id,
    results,
    cache_time: personal ? 60 : 300,
    is_personal: personal,
  };
  // Ничего не нашли — кнопка над списком ведёт в приложение.
  if (!results.length) {
    payload.button = {
      text: parsed.group ? "Такой группы нет — открыть расписание" : "Напишите группу, например 311гэу",
      start_parameter: "inline",
    };
  }
  return payload;
}
