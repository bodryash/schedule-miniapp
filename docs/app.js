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

const HOMEWORK_URL = "https://fgp-schedule-bot.bodryash.workers.dev/homework";

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

/* ---------- Очереди ---------- */

const QUEUES_URL = "https://fgp-schedule-bot.bodryash.workers.dev/queues";

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

  const nodes = queues.list.map((queue) => {
    const spots = queues.spots.filter((s) => s.queue === queue.id);
    const mine = spots.findIndex((s) => s.tg_id === queues.me);
    const card = el("article", queue.closed ? "q-card q-card--closed" : "q-card");

    const head = el("div", "q-head");
    head.append(el("div", "q-title", queue.title));
    const facts = [
      queue.subject ? tr(queue.subject) : null,
      queue.number ? t("Семинар {n}", { n: queue.number }) : null,
      queue.day ? SHORT_DATE.format(new Date(`${queue.day}T00:00:00`)) : null,
      t("записалось {n}", { n: spots.length }),
      queue.closed ? t("запись закрыта") : null,
    ].filter(Boolean);
    head.append(el("div", "q-meta", facts.join(" · ")));
    card.append(head);

    const list = el("ol", "q-list");
    for (const [i, spot] of spots.entries()) {
      const row = el("li", spot.tg_id === queues.me ? "q-spot q-spot--me" : "q-spot");
      row.append(el("span", "q-num", String(spot.position || i + 1)));
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
    } else if (!queue.closed) {
      const join = el("button", "primary q-join", t("Записаться"));
      join.type = "button";
      join.addEventListener("click", () => joinQueue(queue));
      actions.append(join);
    }
    if (queues.manager || queue.author === queues.me) {
      const close = el("button", "ghost", queue.closed ? t("Открыть запись") : t("Закрыть запись"));
      close.type = "button";
      close.addEventListener("click", () => queueAction({ action: "close", queue: queue.id }));
      actions.append(close);
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
  const body = await queuesCall(payload);
  if (body && !body.ok) {
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
    const has = data.lessons.some(
      (l) =>
        l.group === group.id &&
        l.subject === subject &&
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
      button.addEventListener("click", () => {
        const back = week < selectedWeek;
        selectedWeek = week;
        showWeek();
        els.weekBody.style.setProperty("--slide-from", back ? "-18px" : "18px");
        els.weekBody.classList.remove("screen-slide");
        void els.weekBody.offsetWidth;
        els.weekBody.classList.add("screen-slide");
      });
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

/* ---------- Отмена пар владельцем ---------- */

const CANCEL_URL = "https://fgp-schedule-bot.bodryash.workers.dev/cancel";

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

const COMMENTS_URL = "https://fgp-schedule-bot.bodryash.workers.dev/comments";
const COMMENT_MAX = 300;

const commentKey = (day, subject) => `${day}|${subject}`;

/** Открыто ли окно снизу. Окон может не быть в закэшированном index.html. */
function sheetOpen() {
  return [els.hwSheet, els.cmSheet].some((sheet) => sheet && !sheet.hidden);
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
  tabs: document.getElementById("tabs"),
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
}

/* ---------- Разделы ---------- */

// Какой раздел открыт: today | schedule | week | search. Разделы
// переключает полоса снизу, свободные аудитории остаются внутри расписания.
let tab = "schedule";

const TAB_ORDER = ["schedule", "week", "queues", "search"];

function openTab(name) {
  // Раздел въезжает с той стороны, где он стоит в полосе снизу: так видно,
  // что переключение — это шаг вбок, а не новый экран поверх старого.
  const from = TAB_ORDER.indexOf(name) - TAB_ORDER.indexOf(tab);
  tab = name;
  for (const button of els.tabs?.querySelectorAll(".tab") || []) {
    button.classList.toggle("tab--on", button.dataset.tab === name);
  }
  els.free.hidden = true;
  els.picker.hidden = true;
  els.week.hidden = name !== "week";
  if (els.queues) els.queues.hidden = name !== "queues";
  els.schedule.hidden = name !== "schedule";
  els.search.hidden = name !== "search";
  if (els.tabs) els.tabs.hidden = false;
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

function showSchedule() {
  const group = activeGroup();
  if (!group) return showPicker();

  els.picker.hidden = true;
  els.schedule.hidden = false;
  els.currentGroup.textContent = group.teacher ? group.title : t("Группа {g}", { g: group.title });

  const label = FULL_DATE.format(dateOfDay(selectedDay));
  els.dateLabel.textContent = label[0].toUpperCase() + label.slice(1);
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
  renderLessons(group, parity);
  loadNotices(group);
  ensureHomeworkWeek(selectedWeek);
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
      const signature = lessonSignature(entries);
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
        if (run.slots[0] === slot) nodes.push(renderCard(run.entries, bells, run.slots));
      }
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
  applyHomework();
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
    // Окно домашки лежит поверх расписания: печать в нём не должна листать дни.
    if (event.target.closest?.(".days, button, .sheet")) return;
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
function refreshNow() {
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
  if (bell) {
    const end = range && lastBell ? lastBell.end : bell.end;
    head.append(el("span", null, `${bell.start} – ${end}`));
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

  card.append(body);
  if (single && first.room) card.append(roomBadge(first.room));
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

/* ---------- Запуск ---------- */

async function init() {
  tg?.ready();
  tg?.expand();
  translatePage();

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
  els.group.addEventListener("change", fillLanguages);
  els.main.addEventListener("change", fillMainSubgroups);
  els.lang2.addEventListener("change", fillLang2Subgroups);
  els.save.addEventListener("click", () => {
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
  els.queueAdd?.addEventListener("click", openQueueSheet);
  els.qSave?.addEventListener("click", createQueue);
  els.qCancel?.addEventListener("click", () => (els.qSheet.hidden = true));
  els.qSheet?.addEventListener("click", (event) => {
    if (event.target === els.qSheet) els.qSheet.hidden = true;
  });
  els.qFind?.addEventListener("input", renderQueuePicker);
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
    }

  }, 30_000);

  const group = activeGroup();
  if (group?.teacher) {
    loadTeacherNames();
    openTab("schedule");
  } else if (group) {
    openTab("schedule");
    countOpen({ id: group.id, course: group.course, level: group.level });
  } else {
    showPicker();
  }
}

init();
