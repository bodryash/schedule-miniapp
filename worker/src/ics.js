// Подписка на расписание в календаре телефона (Google, Apple, Яндекс).
//
// Календарь сам раз в несколько часов скачивает ссылку
// /ics/<факультет>/<группа>.ics?f=<настройки>. В ссылке только факультет,
// группа и выбранные языки и курсы — ни имени, ни идентификатора. Ничего не
// сохраняем: расписание берём с сайта приложения и собираем файл на лету.

const APP_URL = globalThis.SCHEDULE_APP_URL || "https://bodryash.github.io/schedule-miniapp/";

// Те же правила, что в приложении (docs/app.js, matchesPrefs): календарь
// должен показывать ровно те пары, что и расписание.
const MAIN_LANGS = [
  "Английский язык",
  "Профессиональный английский язык",
  "Русский язык как иностранный",
  "Профессиональный русский язык",
];
const LANG2 = /^2-ой\s/;
const LANG3 = /^3-ий\s/;
const MILITARY = /^Военная подготовка/;
const RKI = /^Иностранный язык \(русский язык\)$/;
const MFK_SLOT = /^межфакультетск|^мфк(?![а-яё])|факул[а-яё]*\.?\s*мфк/i;
const ELECTIVE = "по выбору";

// Большие расписания весят мегабайты — держим в памяти несколько последних.
const CACHE_LIMIT = 8;
const CACHE_TTL = 30 * 60 * 1000;
const cache = new Map();

async function cached(path) {
  const hit = cache.get(path);
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.value;
  const res = await fetch(new URL(path, APP_URL), { headers: { "User-Agent": "schedule-ics" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${path}`);
  const value = await res.json();
  cache.delete(path);
  cache.set(path, { at: Date.now(), value });
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
  return value;
}

function readPrefs(raw) {
  if (!raw || raw.length > 4000) return {};
  try {
    const text = atob(raw.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = Uint8Array.from(text, (c) => c.charCodeAt(0));
    const prefs = JSON.parse(new TextDecoder().decode(bytes));
    return prefs && typeof prefs === "object" ? prefs : {};
  } catch {
    return {};
  }
}

function matches(lesson, prefs, tenantId) {
  const subject = lesson.subject || "";
  if (prefs.military === "no" && MILITARY.test(subject)) return false;
  if (prefs.rki !== "yes" && RKI.test(subject)) return false;
  if (prefs.mfkSlot === "no" && tenantId !== "msu-fgp" && MFK_SLOT.test(subject)) return false;
  if (lesson.elective === ELECTIVE && Array.isArray(prefs.electives) && prefs.electives.length) {
    if (!prefs.electives.includes(subject)) return false;
  }
  if (MAIN_LANGS.includes(subject)) {
    if (!prefs.main) return true;
    if (subject !== prefs.main) return false;
    return !lesson.subgroup || prefs.mainGroup == null ? true : lesson.subgroup === prefs.mainGroup;
  }
  if (LANG2.test(subject)) {
    if (!prefs.lang2) return true;
    if (subject !== prefs.lang2) return false;
    return !lesson.subgroup || prefs.lang2Group == null ? true : lesson.subgroup === prefs.lang2Group;
  }
  if (LANG3.test(subject)) return subject === prefs.lang3;
  return true;
}

const iso = (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;

/** Даты занятия: явные (расписание по датам) или по чётности недель семестра. */
function datesOf(lesson, weeks) {
  if (Array.isArray(lesson.dates)) return lesson.dates;
  const out = [];
  for (const week of weeks || []) {
    if (lesson.week !== "all" && lesson.week && week.parity !== lesson.week) continue;
    const from = new Date(`${week.from}T00:00:00Z`);
    const monday = new Date(from);
    monday.setUTCDate(from.getUTCDate() - ((from.getUTCDay() + 6) % 7));
    const day = new Date(monday);
    day.setUTCDate(monday.getUTCDate() + lesson.day - 1);
    const value = iso(day);
    if (value >= week.from && value <= week.to) out.push(value);
  }
  return out;
}

// Строки iCalendar: экранируем спецсимволы и режем длинные строки по 75 байт.
const esc = (text) => String(text || "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");

function fold(line) {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 75) return line;
  const parts = [];
  let current = "";
  let size = 0;
  for (const char of line) {
    const n = new TextEncoder().encode(char).length;
    if (size + n > (parts.length ? 74 : 75)) {
      parts.push(current);
      current = "";
      size = 0;
    }
    current += char;
    size += n;
  }
  parts.push(current);
  return parts.join("\r\n ");
}

// Короткий устойчивый номер занятия: календарь по нему узнаёт, что событие то же.
function hash(text) {
  let h = 0x811c9dc5;
  for (const char of text) h = Math.imul(h ^ char.codePointAt(0), 0x01000193) >>> 0;
  return h.toString(36);
}

/** «Europe/Samara» → «+0400». */
function tzOffset(tz) {
  try {
    const text = new Date().toLocaleString("en-US", { timeZone: tz, timeZoneName: "longOffset" });
    const m = text.match(/GMT([+-]\d{2}):?(\d{2})?/);
    if (m) return `${m[1]}${m[2] || "00"}`;
  } catch {
    // Неизвестный пояс — считаем московским.
  }
  return "+0300";
}

const stamp = (date, time) => `${date.replace(/-/g, "")}T${time.replace(":", "")}00`;

// Ключ преподавателя «Фамилия И.О.» — те же правила, что teachersOf в
// приложении: «Гена Евгений Иванович», «доц. Е.И.Гена» и «Гена Е.И.» — один человек.
const SURNAME = "[А-ЯЁ][а-яё]+(?:-[А-ЯЁ][а-яё]+)?";
const NAME_SHORT = new RegExp(`^(${SURNAME})\\s*(?:([А-ЯЁ])\\.?\\s*(?:([А-ЯЁ])\\.?)?)?$`);
const NAME_FULL = new RegExp(`^(${SURNAME})\\s+([А-ЯЁ])[а-яё]+(?:\\s+([А-ЯЁ])[а-яё]+)?$`);
const NAME_FIRST = new RegExp(`^([А-ЯЁ])\\.\\s*(?:([А-ЯЁ])\\.\\s*)?(${SURNAME})$`);
const NOT_A_PERSON = /^(преподавател|вакансия|кафедра|сотрудник)/i;

function teacherKeys(field) {
  const keys = [];
  for (let part of String(field || "").split(/,\s*/)) {
    part = part.replace(/^\d{3}[А-ЯЁ]?\b\s*/, "").trim();
    const titled = part.match(/^((?:[а-яё]{1,6}\.*\s*)+)(?=[А-ЯЁA-Z])/);
    const rest = (titled ? part.slice(titled[0].length) : part).replace(/\s+\d+\S*$/, "");
    if (NOT_A_PERSON.test(rest)) continue;
    let surname = "";
    let initials = [];
    let m = rest.match(NAME_SHORT) || rest.match(NAME_FULL);
    if (m) [surname, initials] = [m[1], [m[2], m[3]]];
    else if ((m = rest.match(NAME_FIRST))) [surname, initials] = [m[3], [m[1], m[2]]];
    else continue;
    const tail = initials.filter(Boolean).map((c) => `${c}.`).join("");
    keys.push(tail ? `${surname} ${tail}` : surname);
  }
  return keys;
}

/** Отмена задевает занятие в этот день — те же правила, что в приложении. */
function cancelOf(cancels, lesson, date) {
  return cancels.find(
    (c) =>
      c.day === date &&
      (!c.slots.length || c.slots.includes(lesson.slot)) &&
      (!c.subject || c.subject === lesson.subject) &&
      (!c.subgroup || c.subgroup === lesson.subgroup)
  );
}

function changeOf(changes, lesson, date) {
  return changes.find(
    (c) =>
      c.day === date &&
      c.slots.includes(lesson.slot) &&
      (!c.from_teacher || String(lesson.teacher || "").includes(c.from_teacher))
  );
}

const minutesOf = (time) => {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
};
const clockOf = (value) => `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;

function calendarHead(name, tz) {
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//bodryash//schedule//RU",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${esc(name)}`,
    `X-WR-TIMEZONE:${tz}`,
    "REFRESH-INTERVAL;VALUE=DURATION:PT6H",
    "X-PUBLISHED-TTL:PT6H",
    // Описание пояса: без него часть календарей отказывается от подписки.
    // В России перехода на летнее время нет — одного смещения хватает.
    "BEGIN:VTIMEZONE",
    `TZID:${tz}`,
    "BEGIN:STANDARD",
    "DTSTART:19700101T000000",
    `TZOFFSETFROM:${tzOffset(tz)}`,
    `TZOFFSETTO:${tzOffset(tz)}`,
    "END:STANDARD",
    "END:VTIMEZONE",
  ];
}

function calendarResponse(lines) {
  lines.push("END:VCALENDAR");
  return new Response(lines.map(fold).join("\r\n") + "\r\n", {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      // Отмены и замены должны доходить быстро — кэш короткий.
      "Cache-Control": "public, max-age=600",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

/**
 * Событие календаря для одного занятия в один день: с отменой (событие
 * остаётся, но помечено отменённым — так видно, что пары не будет) и с
 * заменой (другое время, аудитория или преподаватель).
 */
function eventLines({ uid, date, start, end, title, place, details, tz, short, cancel, change, bells, lesson }) {
  let from = start;
  let to = end;
  let room = place;
  const notes = [];
  if (change) {
    if (change.room) room = change.room;
    if (change.teacher) notes.push(`Ведёт: ${change.teacher}`);
    const first = bells.get(Math.min(...change.slots));
    if (change.start && first) {
      const shift = minutesOf(change.start) - minutesOf(first.start);
      from = clockOf(minutesOf(start) + shift);
      to = clockOf(minutesOf(end) + shift);
    }
    notes.push(`Изменение: ${change.reason || "замена"}`);
  }
  if (cancel) notes.unshift(`Пара отменена${cancel.reason ? `: ${cancel.reason}` : ""}`);
  const description = [...notes, details].filter(Boolean).join("\n");
  return [
    "BEGIN:VEVENT",
    `UID:${date.replace(/-/g, "")}-${hash(uid)}@schedule.bodryash.ru`,
    `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "")}`,
    `DTSTART;TZID=${tz}:${stamp(date, from)}`,
    `DTEND;TZID=${tz}:${stamp(date, to)}`,
    `SUMMARY:${esc(cancel ? `❌ ${title}` : change ? `🔁 ${title}` : title)}`,
    ...(cancel ? ["STATUS:CANCELLED"] : []),
    ...(room ? [`LOCATION:${esc(room)}`] : []),
    ...(description ? [`DESCRIPTION:${esc(description)}`] : []),
    `CATEGORIES:${esc(short)}`,
    "END:VEVENT",
  ];
}

/**
 * extras — то, что знает только бот: действующие отмены и замены (all —
 * все сразу, таблицы маленькие) и ключ курса группы для отмен «на весь курс».
 */
export async function handleIcs(url, request, extras = {}) {
  const match = url.pathname.match(/^\/ics\/([a-z0-9-]+)\/(.+)\.ics$/);
  if (!match) return new Response("Not found", { status: 404 });
  const tenantId = match[1];
  const rest = decodeURIComponent(match[2]);
  const prefs = readPrefs(url.searchParams.get("f"));
  // Из Telegram открываются только http(s): браузер отсюда отправляем на
  // webcals:// — та же подписка, но сразу по https (по webcal:// iPhone идёт
  // на http, а перенаправление на https календарь не принимает), и iPhone
  // сам предлагает подписаться. Приложение календаря может прийти и по этому
  // же адресу — ему отдаём сам файл.
  const agent = request?.headers.get("user-agent") || "";
  const browser = /Mozilla|Safari|AppleWebKit/.test(agent) && !/dataaccessd|CalendarAgent|calaccessd/i.test(agent);
  if (url.searchParams.has("open") && browser) {
    const target = new URL(url);
    target.searchParams.delete("open");
    target.protocol = "https:";
    return Response.redirect(target.toString().replace(/^https:/, "webcals:"), 302);
  }

  let tenants;
  try {
    tenants = await cached("data/tenants.json");
  } catch (error) {
    console.error("ics", error);
    return new Response("Schedule unavailable", { status: 502 });
  }
  const tenant = tenants.find((t) => t.id === tenantId);
  if (!tenant) return new Response("Unknown faculty", { status: 404 });
  const load = (t) => cached(`data/${t.path ? `${t.path}/` : ""}schedule.json`);
  const scoped = (t, group) => (t.id === "msu-fgp" ? group : `${t.id}/${group}`);
  const [cancels, changes] = await Promise.all([
    extras.cancels ? extras.cancels().catch(() => []) : [],
    extras.changes ? extras.changes().catch(() => []) : [],
  ]);
  const forGroup = (rows, id, course) => rows.filter((r) => r.grp === id || r.grp === course || r.grp === "*");
  // Две недели назад — чтобы вчерашние пары не исчезали из календаря сразу.
  const since = iso(new Date(Date.now() - 14 * 86400000));
  const tz = tenant.tz || "Europe/Moscow";

  if (rest.startsWith("teacher/")) return teacherCalendar(rest.slice(8), tenant, tenants, { load, scoped, cancels, changes, forGroup, since, tz, extras });

  let schedule;
  try {
    schedule = await load(tenant);
  } catch (error) {
    console.error("ics", error);
    return new Response("Schedule unavailable", { status: 502 });
  }
  const group = (schedule.groups || []).find((g) => g.id === rest);
  if (!group) return new Response("Unknown group", { status: 404 });
  const id = scoped(tenant, group.id);
  const course = extras.courseOf ? extras.courseOf(group) : "—";
  const myCancels = forGroup(cancels, id, course);
  const myChanges = forGroup(changes, id, course);
  const bells = new Map((schedule.bells || []).map((b) => [b.n, b]));
  const short = tenant.short || tenant.faculty;
  const lines = calendarHead(`Расписание · ${group.title}`, tz);
  const seen = new Set();
  // Свои МФК (МГУ): вместо безымянной строки «МФК» — выбранные курсы
  // со своим временем, каждую неделю семестра, как в приложении.
  const mfkIds = Array.isArray(prefs.mfk) ? prefs.mfk.map(Number).filter(Boolean).slice(0, 20) : [];
  let mfk = [];
  if (mfkIds.length) {
    try {
      mfk = (await cached("data/mfk.json")).filter((c) => mfkIds.includes(c.id) && c.day && c.start && c.end);
    } catch {
      mfk = [];
    }
  }
  for (const course of mfk) {
    for (const date of datesOf({ day: course.day, week: "all" }, schedule.weeks)) {
      if (date < since) continue;
      lines.push(
        ...eventLines({
          uid: `mfk-${course.id}-${date}`, date, start: course.start, end: course.end,
          title: `${course.title} · МФК`, place: course.where || "", details: course.faculty || "",
          tz, short, bells, lesson: {}, cancel: null, change: null,
        })
      );
    }
  }
  for (const lesson of schedule.lessons || []) {
    if (lesson.group !== group.id || !matches(lesson, prefs, tenantId)) continue;
    if (mfk.length && (lesson.subject === "Межфакультетские учебные курсы МГУ" || MFK_SLOT.test(lesson.subject))) continue;
    const bell = bells.get(lesson.slot);
    const start = lesson.start || bell?.start;
    const end = lesson.end || bell?.end;
    if (!start || !end) continue;
    const title = [lesson.subject, lesson.type].filter(Boolean).join(" · ");
    const details = [lesson.teacher, lesson.subgroup ? `Подгруппа ${lesson.subgroup}` : "", lesson.note].filter(Boolean).join("\n");
    for (const date of datesOf(lesson, schedule.weeks)) {
      if (date < since) continue;
      const uid = `${tenantId}-${group.id}-${date}-${start}-${title}-${lesson.subgroup || ""}`;
      if (seen.has(uid)) continue;
      seen.add(uid);
      lines.push(
        ...eventLines({
          uid, date, start, end, title, place: lesson.room || "", details, tz, short, bells, lesson,
          cancel: cancelOf(myCancels, lesson, date),
          change: changeOf(myChanges, lesson, date),
        })
      );
    }
  }
  return calendarResponse(lines);
}

/**
 * Календарь преподавателя: его пары на всех факультетах вуза. Какие
 * факультеты смотреть, подсказывает data/teacher-map.json — как в приложении.
 */
async function teacherCalendar(key, tenant, tenants, ctx) {
  let map = {};
  try {
    map = await cached("data/teacher-map.json");
  } catch {
    // Без указателя — только свой факультет.
  }
  const ids = new Set([tenant.id, ...(map[tenant.university]?.[key] || [])]);
  const lines = calendarHead(`Расписание · ${key}`, ctx.tz);
  const events = new Map();
  for (const id of ids) {
    const other = tenants.find((t) => t.id === id);
    if (!other) continue;
    let schedule;
    try {
      schedule = await ctx.load(other);
    } catch {
      continue;
    }
    const bells = new Map((schedule.bells || []).map((b) => [b.n, b]));
    const groups = new Map((schedule.groups || []).map((g) => [g.id, g]));
    const short = other.short || other.faculty;
    for (const lesson of schedule.lessons || []) {
      if (!teacherKeys(lesson.teacher).includes(key)) continue;
      const bell = bells.get(lesson.slot);
      const start = lesson.start || bell?.start;
      const end = lesson.end || bell?.end;
      if (!start || !end) continue;
      const group = groups.get(lesson.group);
      const gid = ctx.scoped(other, lesson.group);
      const course = group && ctx.extras.courseOf ? ctx.extras.courseOf(group) : "—";
      const title = [lesson.subject, lesson.type].filter(Boolean).join(" · ");
      for (const date of datesOf(lesson, schedule.weeks)) {
        if (date < ctx.since) continue;
        // Одна пара у нескольких групп сразу — одно событие со списком групп.
        const uid = `${other.id}-${key}-${date}-${start}-${title}-${lesson.room || ""}`;
        if (!events.has(uid)) {
          events.set(uid, { uid, date, start, end, title, place: lesson.room || "", short, bells, lesson, groups: [], cancels: [], changes: [] });
        }
        const event = events.get(uid);
        event.groups.push(group?.title || lesson.group);
        const cancel = cancelOf(ctx.forGroup(ctx.cancels, gid, course), lesson, date);
        if (cancel) event.cancels.push(cancel);
        else event.anyLive = true;
        const change = changeOf(ctx.forGroup(ctx.changes, gid, course), lesson, date);
        if (change) event.changes.push(change);
      }
    }
  }
  for (const event of [...events.values()].sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start))) {
    const groups = [...new Set(event.groups)].sort((a, b) => a.localeCompare(b, "ru", { numeric: true }));
    lines.push(
      ...eventLines({
        ...event,
        tz: ctx.tz,
        details: `${groups.length > 1 ? "Группы" : "Группа"}: ${event.short} · ${groups.join(", ")}`,
        // Пара отменена, только если отменена у всех её групп.
        cancel: event.anyLive ? null : event.cancels[0] || null,
        change: event.changes[0] || null,
      })
    );
  }
  return calendarResponse(lines);
}
