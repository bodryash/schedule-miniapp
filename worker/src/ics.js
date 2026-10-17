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

const stamp = (date, time) => `${date.replace(/-/g, "")}T${time.replace(":", "")}00`;

export async function handleIcs(url) {
  const match = url.pathname.match(/^\/ics\/([a-z0-9-]+)\/(.+)\.ics$/);
  if (!match) return new Response("Not found", { status: 404 });
  const tenantId = match[1];
  const groupId = decodeURIComponent(match[2]);
  const prefs = readPrefs(url.searchParams.get("f"));
  // Из Telegram открываются только http(s): отсюда отправляем на webcal://,
  // и iPhone сам предлагает подписаться.
  if (url.searchParams.has("open")) {
    const target = new URL(url);
    target.searchParams.delete("open");
    target.protocol = "https:";
    return Response.redirect(target.toString().replace(/^https:/, "webcal:"), 302);
  }

  let tenant, schedule;
  try {
    tenant = (await cached("data/tenants.json")).find((t) => t.id === tenantId);
    if (!tenant) return new Response("Unknown faculty", { status: 404 });
    schedule = await cached(`data/${tenant.path ? `${tenant.path}/` : ""}schedule.json`);
  } catch (error) {
    console.error("ics", error);
    return new Response("Schedule unavailable", { status: 502 });
  }
  const tz = tenant.tz || "Europe/Moscow";
  const short = tenant.short || tenant.faculty;
  const group = (schedule.groups || []).find((g) => g.id === groupId);
  if (!group) return new Response("Unknown group", { status: 404 });

  const bells = new Map((schedule.bells || []).map((b) => [b.n, b]));
  // Две недели назад — чтобы вчерашние пары не исчезали из календаря сразу.
  const since = iso(new Date(Date.now() - 14 * 86400000));
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//bodryash//schedule//RU",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${esc(`Расписание · ${group.title}`)}`,
    `X-WR-TIMEZONE:${tz}`,
    "REFRESH-INTERVAL;VALUE=DURATION:PT6H",
    "X-PUBLISHED-TTL:PT6H",
  ];
  const now = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  const seen = new Set();
  for (const lesson of schedule.lessons || []) {
    if (lesson.group !== groupId || !matches(lesson, prefs, tenantId)) continue;
    const bell = bells.get(lesson.slot);
    const start = lesson.start || bell?.start;
    const end = lesson.end || bell?.end;
    if (!start || !end) continue;
    const title = [lesson.subject, lesson.type].filter(Boolean).join(" · ");
    const place = lesson.room || "";
    const details = [
      lesson.teacher,
      lesson.subgroup ? `Подгруппа ${lesson.subgroup}` : "",
      lesson.note,
    ].filter(Boolean).join("\n");
    for (const date of datesOf(lesson, schedule.weeks)) {
      if (date < since) continue;
      const uid = `${tenantId}-${groupId}-${date}-${start}-${title}-${lesson.subgroup || ""}`;
      if (seen.has(uid)) continue;
      seen.add(uid);
      lines.push(
        "BEGIN:VEVENT",
        `UID:${date.replace(/-/g, "")}-${hash(uid)}@schedule.bodryash.ru`,
        `DTSTAMP:${now}`,
        `DTSTART;TZID=${tz}:${stamp(date, start)}`,
        `DTEND;TZID=${tz}:${stamp(date, end)}`,
        `SUMMARY:${esc(title)}`,
        ...(place ? [`LOCATION:${esc(place)}`] : []),
        ...(details ? [`DESCRIPTION:${esc(details)}`] : []),
        `CATEGORIES:${esc(short)}`,
        "END:VEVENT"
      );
    }
  }
  lines.push("END:VCALENDAR");
  return new Response(lines.map(fold).join("\r\n") + "\r\n", {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Cache-Control": "public, max-age=1800",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
