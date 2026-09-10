/**
 * Расписание прямо в чатах: пишешь «@FGPshedulebot 311гэу завтра» в любой
 * переписке — и отправляешь карточку с парами, не открывая приложение.
 *
 * Данные берём из файлов по группам (docs/data/groups/<id>.json): целое
 * расписание весит мегабайт, а отвечать нужно быстро.
 *
 * Языки: «@FGPshedulebot 311гэу en» или «zh» — явно; без пометки китайский
 * включается сам по языку Telegram. Английский сам не включается: многие
 * русские студенты держат Telegram на английском, а карточку отправляют
 * в общий чат группы.
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

const LANG_WORDS = new Map([
  ["en", "en"], ["eng", "en"], ["english", "en"], ["англ", "en"],
  ["zh", "zh"], ["cn", "zh"], ["中文", "zh"], ["汉语", "zh"], ["кит", "zh"],
  ["ru", "ru"], ["рус", "ru"],
]);

// Сколько групп подсказываем по началу названия: на каждую — отдельный
// запрос к файлу, а их за один запуск воркера немного.
const SUGGEST = 8;

// Ключ — русская строка, как в приложении (docs/i18n.js).
const WORDS = {
  en: {
    "Сегодня": "Today", "Завтра": "Tomorrow", "Послезавтра": "Day after tomorrow",
    "Вся неделя": "Whole week", "Эта неделя": "This week", "Следующая неделя": "Next week",
    "Все дни одним сообщением": "All days in one message",
    "Пн": "Mon", "Вт": "Tue", "Ср": "Wed", "Чт": "Thu", "Пт": "Fri", "Сб": "Sat",
    "Пар нет 🎉": "No classes 🎉", "Пар нет": "No classes", "Воскресенье": "Sunday",
    "Все пары отменены": "All classes cancelled", ", отменено {n}": ", {n} cancelled",
    "окно": "free period", "по подгруппам": "by subgroups", "ауд. {room}": "room {room}",
    "отменена": "cancelled", "чётная неделя": "even week", "нечётная неделя": "odd week",
    "чётная": "even", "нечётная": "odd", "неделя {span}": "week {span}",
    "📅 Открыть расписание": "📅 Open schedule",
    "Напишите группу, например 311гэу": "Type your group, e.g. 311гэу",
    "Такой группы нет — открыть расписание": "No such group — open the schedule",
    "2-ой иностранный язык": "Second foreign language",
    "3-ий иностранный язык": "Third foreign language",
    "Английский / русский язык": "English / Russian",
    "по выбору": "elective", "факультатив": "optional",
    "дистант": "online", "вирт": "virtual", "В.каф.": "Military dept.", "с/база": "Sports base",
  },
  zh: {
    "Сегодня": "今天", "Завтра": "明天", "Послезавтра": "后天",
    "Вся неделя": "整周", "Эта неделя": "本周", "Следующая неделя": "下周",
    "Все дни одним сообщением": "一条消息显示全部日期",
    "Пн": "周一", "Вт": "周二", "Ср": "周三", "Чт": "周四", "Пт": "周五", "Сб": "周六",
    "Пар нет 🎉": "没有课 🎉", "Пар нет": "没有课", "Воскресенье": "星期日",
    "Все пары отменены": "课程全部取消", ", отменено {n}": "，取消 {n} 节",
    "окно": "空堂", "по подгруппам": "分小组", "ауд. {room}": "{room}教室",
    "отменена": "已取消", "чётная неделя": "双周", "нечётная неделя": "单周",
    "чётная": "双周", "нечётная": "单周", "неделя {span}": "{span} 这一周",
    "📅 Открыть расписание": "📅 打开课表",
    "Напишите группу, например 311гэу": "输入班级，例如 311гэу",
    "Такой группы нет — открыть расписание": "没有这个班级 — 打开课表",
    "2-ой иностранный язык": "第二外语",
    "3-ий иностранный язык": "第三外语",
    "Английский / русский язык": "英语 / 俄语",
    "по выбору": "选修", "факультатив": "任选",
    "дистант": "线上", "вирт": "线上", "В.каф.": "军事教研室", "с/база": "体育基地",
  },
};

/** Перевод по русскому ключу; нет перевода — русский. */
function w(lang, key, vars) {
  const template = WORDS[lang]?.[key] ?? key;
  return vars ? template.replace(/\{(\w+)\}/g, (_, name) => vars[name]) : template;
}

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

function classCount(n, lang) {
  if (lang === "en") return `${n} ${n === 1 ? "class" : "classes"}`;
  if (lang === "zh") return `${n}节课`;
  return `${n} ${plural(n, "пара", "пары", "пар")}`;
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

/** «Пятница, 11 сентября» — по-русски; для команд владельца. */
export function dateLabel(date) {
  return `${WEEKDAYS[date.getUTCDay()]}, ${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
}

const LOCALES = { en: "en-GB", zh: "zh-CN" };

function localDate(date, lang) {
  if (lang === "ru") return dateLabel(date);
  return new Intl.DateTimeFormat(LOCALES[lang], {
    weekday: "long", day: "numeric", month: "long", timeZone: "UTC",
  }).format(date);
}

function shortDate(date, lang) {
  if (lang === "ru") return `${SHORT[date.getUTCDay()]}, ${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
  return new Intl.DateTimeFormat(LOCALES[lang], {
    weekday: "short", day: "numeric", month: "short", timeZone: "UTC",
  }).format(date);
}

/** Разбирает запрос на группу, день и язык. Порядок слов любой. */
export function parseQuery(text) {
  const rest = [];
  let when = null;
  let lang = null;
  for (const word of String(text).toLowerCase().replace(/ё/g, "е").split(/\s+/)) {
    if (!word || word === "в" || word === "на") continue;
    if (word === "сегодня") when = { kind: "day", offset: 0 };
    else if (word === "завтра") when = { kind: "day", offset: 1 };
    else if (word === "послезавтра") when = { kind: "day", offset: 2 };
    else if (word.startsWith("недел")) when = { kind: "week", offset: 0 };
    else if (DAY_WORDS.has(word)) when = { kind: "weekday", day: DAY_WORDS.get(word) };
    else if (LANG_WORDS.has(word)) lang = LANG_WORDS.get(word);
    else rest.push(word);
  }
  return { group: rest.join(""), when, lang };
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

function subjectName(subject, ctx) {
  return (ctx.lang !== "ru" && ctx.subjects?.[subject]?.[ctx.lang]) || subject;
}

function roomText(room, ctx) {
  if (ctx.lang === "ru") return `ауд. ${room}`;
  const named = w(ctx.lang, room);
  return named !== room ? named : w(ctx.lang, "ауд. {room}", { room });
}

function lessonLines(file, buckets, ctx) {
  const { lang } = ctx;
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
    const label =
      subjects.size === 1 ? subjectName(first.subject, ctx) : w(lang, kindOf(first.subject));
    const where =
      entries.length > 1 ? w(lang, "по подгруппам") : first.room ? roomText(first.room, ctx) : "";
    const tag = first.elective ? ` <i>(${escape(w(lang, first.elective))})</i>` : "";
    const plain = `${escape(label)}${tag}${where ? ` · ${escape(where)}` : ""}`;
    const text = cancel
      ? `<s>${plain}</s> — <b>${w(lang, "отменена")}</b>${cancel.reason ? `: ${escape(cancel.reason)}` : ""}`
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
      if (!busy.has(slot)) lines.push(`${slot} · <i>${w(lang, "окно")}</i>`);
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

function parityWords(parity, lang, long) {
  if (!parity) return "";
  const key = parity === "odd" ? "нечётная" : "чётная";
  return ` · ${w(lang, long ? `${key} неделя` : key)}`;
}

function dayMessage(file, date, ctx) {
  const { notices = [], cancels = [], lang } = ctx;
  const { parity, buckets } = lessonsOn(file, date, cancels);
  const head = `📅 <b>${escape(file.group.title)}</b> · ${localDate(date, lang)}${parityWords(parity, lang, true)}`;
  const body = buckets.length ? lessonLines(file, buckets, ctx) : [w(lang, "Пар нет 🎉")];
  const top = notices.length ? [...noticeLines(notices), ""] : [];
  return [head, "", ...top, ...body].join("\n");
}

function weekMessage(file, monday, ctx) {
  const { notices = [], cancels = [], lang } = ctx;
  const parity = parityOf(file.weeks, monday);
  const saturday = addDays(monday, 5);
  let span;
  if (lang !== "ru") {
    const dm = (d) => `${String(d.getUTCDate()).padStart(2, "0")}.${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    span = `${dm(monday)}–${dm(saturday)}`;
  } else if (monday.getUTCMonth() === saturday.getUTCMonth()) {
    span = `${monday.getUTCDate()}–${saturday.getUTCDate()} ${MONTHS[saturday.getUTCMonth()]}`;
  } else {
    span = `${monday.getUTCDate()} ${MONTHS[monday.getUTCMonth()]} – ${saturday.getUTCDate()} ${MONTHS[saturday.getUTCMonth()]}`;
  }
  const lines = [
    `📅 <b>${escape(file.group.title)}</b> · ${w(lang, "неделя {span}", { span })}${parityWords(parity, lang, false)}`,
  ];
  if (notices.length) lines.push("", ...noticeLines(notices));
  for (let i = 0; i < 6; i++) {
    const date = addDays(monday, i);
    const { buckets } = lessonsOn(file, date, cancels);
    lines.push("", `<b>${shortDate(date, lang)}</b>`);
    lines.push(...(buckets.length ? lessonLines(file, buckets, ctx) : [w(lang, "Пар нет")]));
  }
  // Режем по строке, а не посреди тега: иначе Telegram отвергнет разметку.
  let text = lines.join("\n");
  while (text.length > 4000) text = `${text.slice(0, text.lastIndexOf("\n", text.length - 3))}\n…`;
  return text;
}

function summary(file, date, ctx) {
  const { cancels = [], lang } = ctx;
  if (date.getUTCDay() === 0) return w(lang, "Воскресенье");
  const { buckets: all } = lessonsOn(file, date, cancels);
  if (!all.length) return w(lang, "Пар нет");
  const buckets = all.filter((b) => !b.cancel);
  if (!buckets.length) return w(lang, "Все пары отменены");
  const cancelled = new Set(all.filter((b) => b.cancel).map((b) => b[0].slot)).size;
  const slots = new Set(buckets.map((b) => b[0].slot)).size;
  const first = timesOf(buckets[0][0], file.bells);
  const last = timesOf(buckets[buckets.length - 1][0], file.bells);
  // В китайском своя запятая: латинская посреди иероглифов режет глаз.
  const comma = lang === "zh" ? "，" : ", ";
  const span = first && last ? `${comma}${first.start}–${last.end}` : "";
  const tail = cancelled ? w(lang, ", отменено {n}", { n: cancelled }) : "";
  return `${classCount(slots, lang)}${span}${tail}`;
}

function article(id, title, description, text, lang) {
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
      inline_keyboard: [[{ text: w(lang, "📅 Открыть расписание"), url: APP_LINK }]],
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
// Не загрузились переводы — карточка уйдёт с русскими названиями, но уйдёт.
const loadSubjects = () => loadJson("subjects.json").catch(() => ({}));

/** Варианты для одной группы: какие дни предложить. */
function groupResults(file, when, ctx) {
  const { lang } = ctx;
  const now = today();
  const results = [];
  const titled = (title) => `${w(lang, title)} · ${file.group.title}`;
  const day = (date, title) =>
    results.push(
      article(
        `d${iso(date)}`,
        titled(title),
        `${localDate(date, lang)} — ${summary(file, date, ctx)}`,
        dayMessage(file, date, ctx),
        lang
      )
    );
  const week = (monday, title) =>
    results.push(
      article(`w${iso(monday)}`, titled(title), w(lang, "Все дни одним сообщением"), weekMessage(file, monday, ctx), lang)
    );

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
  const parsed = parseQuery(query.query || "");
  const code = String(query.from?.language_code || "").toLowerCase();
  const lang = parsed.lang || (code.startsWith("zh") ? "zh" : "ru");
  const [groups, subjects] = await Promise.all([
    loadGroups(),
    lang === "ru" ? Promise.resolve({}) : loadSubjects(),
  ]);

  let matched = findGroups(groups, parsed.group);
  if (!parsed.group) {
    const own = await ctx.groupOf(query.from?.id);
    matched = own ? groups.filter((g) => g.id === own) : [];
  }
  // Ответ зависит от человека, если группа взята из его открытий или язык —
  // из его Telegram. Иначе Telegram отдал бы закэшированную китайскую
  // карточку русскому студенту с тем же запросом.
  const personal = !parsed.group || !parsed.lang;

  let results = [];
  if (matched.length === 1) {
    const [file, notices, cancels] = await Promise.all([
      loadGroup(matched[0].id),
      ctx.notices(matched[0]),
      ctx.cancels(matched[0]),
    ]);
    results = groupResults(file, parsed.when, { notices, cancels, lang, subjects });
  } else if (matched.length > 1) {
    // Начало названия — подсказываем группы с сегодняшним днём.
    const now = today();
    const date = now.getUTCDay() === 0 ? addDays(now, 1) : now;
    const files = await Promise.all(
      matched.slice(0, SUGGEST).map(async (g) => ({ file: await loadGroup(g.id), cancels: await ctx.cancels(g) }))
    );
    results = files.map(({ file, cancels }) => {
      const extra = { cancels, lang, subjects };
      return article(
        `g${file.group.id}`.slice(0, 64),
        file.group.title,
        `${localDate(date, lang)} — ${summary(file, date, extra)}`,
        dayMessage(file, date, extra),
        lang
      );
    });
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
      text: w(lang, parsed.group ? "Такой группы нет — открыть расписание" : "Напишите группу, например 311гэу"),
      start_parameter: "inline",
    };
  }
  return payload;
}
