/**
 * Виджет «Мои пары» (Bot API 10.4): живая карточка дня прямо в чате с ботом.
 *
 * HTML отправляется один раз и не меняется. Пары дня виджет получает двумя
 * путями: при отправке — в chat_data (первая отрисовка без ожидания), а при
 * листании и при каждом появлении на экране — запросом к боту «d:2026-11-11».
 * Бот отвечает тем же форматом. В проде виджеты работают только в личке с
 * ботом: там запросы разрешены и без нажатия, раз в 5 секунд.
 *
 * Формат дня (до 1024 байт): {"d":"2026-11-11","l":[[начало, конец,
 * предмет, аудитория, флаг], …],"g":"группа"}; флаг 1 — отменена, 2 —
 * другая аудитория. "e":"group" — группа не выбрана.
 */

import { loadJson, DEFAULT_TENANT } from "./inline.js";
import { shownSubject } from "./subjects.js";

// Без комментариев и лишних пробелов: лимит — 4096 байт после сжатия.
export const WIDGET_HTML = `<style>
body{margin:0;padding:10px 12px 6px}
.h{display:flex;align-items:center;gap:6px;margin-bottom:6px}
.h b{flex:1;font-size:16px;text-align:center}
.h button{width:36px;min-width:36px;height:30px;padding:0;border-radius:15px;font-size:18px}
.g{text-align:center;font-size:12px;color:var(--tg-theme-hint-color);margin:-4px 0 6px}
.r{display:flex;gap:10px;padding:7px 0;border-top:1px solid var(--tg-theme-section-separator-color)}
.r:first-child{border-top:0}
.t{width:44px;flex:none;font-weight:600;font-variant-numeric:tabular-nums}
.t i{display:block;font-style:normal;font-weight:400;font-size:12px;color:var(--tg-theme-hint-color)}
.s{flex:1;min-width:0}
.a{flex:none;align-self:center;padding:2px 8px;border-radius:9px;font-size:13px;font-weight:600;background:var(--tg-theme-secondary-bg-color)}
.x .s,.x .t{text-decoration:line-through;color:var(--tg-theme-hint-color)}
.m .a{background:var(--tg-theme-button-color);color:var(--tg-theme-button-text-color)}
.n{margin:0 -12px;padding:7px 12px;background:var(--tg-theme-secondary-bg-color)}
.n .t{color:var(--tg-theme-link-color)}
.k{font-size:12px;color:var(--tg-theme-link-color)}
.e{padding:14px 0;text-align:center;color:var(--tg-theme-hint-color)}
</style>
<div class="h"><button id="p">‹</button><b id="d"></b><button id="f">›</button></div>
<div class="g" id="g"></div><div id="l"></div>
<script>
const W=window.TelegramWidget,$=i=>document.getElementById(i);
let day=null,cache={},busy=0;
const iso=t=>{const z=new Date(t);return z.getFullYear()+'-'+String(z.getMonth()+1).padStart(2,'0')+'-'+String(z.getDate()).padStart(2,'0')};
const add=(s,n)=>{const z=new Date(s+'T12:00');z.setDate(z.getDate()+n);return iso(z)};
const min=s=>{const[a,b]=s.split(':');return a*60+ +b};
function parse(s){try{return JSON.parse(s)}catch(e){return null}}
function load(){try{cache=JSON.parse(localStorage.getItem('c')||'{}')}catch(e){}}
function keep(v){cache[v.d]=v;const k=Object.keys(cache).sort();while(k.length>4)delete cache[k.shift()];try{localStorage.setItem('c',JSON.stringify(cache))}catch(e){}}
function draw(){const v=cache[day],l=$('l');
$('d').textContent=new Date(day+'T12:00').toLocaleDateString('ru-RU',{weekday:'short',day:'numeric',month:'long'});
$('g').textContent=v&&v.g?v.g:'';l.textContent='';
if(!v){l.innerHTML='<div class="e">Загружаю…</div>';return}
if(v.e){l.innerHTML='<div class="e">'+(v.e=='group'?'Выберите группу в приложении':'Нет данных')+'</div>';return}
if(!v.l.length){l.innerHTML='<div class="e">Пар нет 🎉</div>';return}
const now=new Date(),today=iso(now)==day,m=now.getHours()*60+now.getMinutes();
for(const[a,b,s,r,f]of v.l){const e=document.createElement('div');e.className='r'+(f==1?' x':f==2?' m':'');
const live=today&&f!=1&&m>=min(a)&&m<min(b);if(live)e.className+=' n';
e.innerHTML='<div class="t"></div><div class="s"></div>'+(r?'<div class="a"></div>':'');
e.firstChild.textContent=a;const i=document.createElement('i');i.textContent=b;e.firstChild.append(i);
e.children[1].textContent=s;
if(live){const k=document.createElement('div');k.className='k';k.textContent='идёт · ещё '+(min(b)-m)+' мин';e.children[1].append(k)}
else if(f==1){const k=document.createElement('div');k.className='k';k.textContent='отменена';e.children[1].append(k)}
if(r)e.lastChild.textContent=r;l.append(e)}}
function ask(d){if(!W||busy)return;busy=1;W.request('d:'+d).then(x=>{const v=parse(x&&x.result);if(v&&v.d){keep(v);if(v.d==day)draw()}}).catch(()=>{}).finally(()=>busy=0)}
function go(n){day=add(day,n);draw();ask(day)}
load();day=iso(Date.now());
const c=W&&parse(W.chatData);if(c&&c.d&&!cache[c.d])keep(c);
draw();ask(day);
$('p').onclick=()=>go(-1);$('f').onclick=()=>go(1);
if(W){W.onEvent('activated',()=>{draw();ask(day)});W.onEvent('chatDataChanged',()=>{const v=parse(W.chatData);if(v&&v.d){keep(v);draw()}});W.ready&&W.ready()}
setInterval(draw,30000);
</script>`;

const iso = (date) => date.toISOString().slice(0, 10);
const bytes = (s) => new TextEncoder().encode(s).length;

/** Сжать день до 1024 байт: укорачиваем самые длинные названия. */
function pack(payload) {
  let text = JSON.stringify(payload);
  for (let guard = 0; bytes(text) > 1000 && guard < 200; guard++) {
    const longest = payload.l.reduce((a, b) => (b[2].length > a[2].length ? b : a), payload.l[0]);
    if (!longest || longest[2].length <= 12) {
      payload.l.pop();
    } else {
      longest[2] = `${longest[2].slice(0, Math.max(12, longest[2].length - 8)).trimEnd()}…`;
    }
    text = JSON.stringify(payload);
  }
  return text;
}

async function scheduleOf(grp) {
  const slash = grp.indexOf("/");
  const tenantId = slash > 0 ? grp.slice(0, slash) : DEFAULT_TENANT;
  const raw = tenantId === DEFAULT_TENANT ? grp : grp.slice(tenantId.length + 1);
  const tenants = await loadJson("tenants.json").catch(() => []);
  const tenant = tenants.find((t) => t.id === tenantId) || (tenantId === DEFAULT_TENANT ? { path: "" } : null);
  if (!tenant) return null;
  const schedule = await loadJson(`${tenant.path ? `${tenant.path}/` : ""}schedule.json`).catch(() => null);
  return schedule ? { schedule, raw, tenantId } : null;
}

/** Пары человека на день: личный план из приложения или расписание его группы. */
export async function dayPayload(env, tgId, day, groupTitle = (g) => g) {
  const reminder = await env.STATS.prepare("SELECT grp FROM reminders WHERE tg_id = ?").bind(tgId).first().catch(() => null);
  const grp = reminder?.grp || "";
  if (!grp) return pack({ d: day, e: "group", l: [] });
  const found = await scheduleOf(grp);
  const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
  const bells = new Map((found?.schedule.bells || []).map((b) => [b.n, b]));
  const startOf = (slot) => bells.get(slot)?.start || "";

  const [cancels, changes, overrides] = await Promise.all([
    env.STATS.prepare("SELECT slots, subject FROM cancels WHERE grp IN (?, '*') AND day = ? AND removed = 0").bind(grp, day).all().then((r) => r.results || []).catch(() => []),
    env.STATS.prepare("SELECT slots, room FROM changes WHERE grp IN (?, '*') AND day = ? AND removed = 0 AND room != ''").bind(grp, day).all().then((r) => r.results || []).catch(() => []),
    env.STATS.prepare("SELECT slot, subject, room FROM room_overrides WHERE grp = ? AND weekday = ? AND removed = 0").bind(grp, ((weekday + 6) % 7) + 1).all().then((r) => r.results || []).catch(() => []),
  ]);
  const slotsOf = (row) => String(row.slots || "").split(",").map(Number).filter(Boolean);
  const cancelledAt = (start, subject) =>
    cancels.some((c) => (!c.slots || slotsOf(c).some((n) => startOf(n) === start)) && (!c.subject || c.subject === subject));
  const roomAt = (start, subject) => {
    const change = changes.find((c) => slotsOf(c).some((n) => startOf(n) === start));
    if (change) return change.room;
    const fixed = overrides.find((o) => startOf(o.slot) === start && (!o.subject || o.subject === subject));
    return fixed?.room || "";
  };

  // Личный план (языки, курсы по выбору уже учтены приложением).
  const plan = await env.STATS.prepare("SELECT day, start, end, subject, room FROM reminder_plan WHERE tg_id = ? AND day = ? ORDER BY start")
    .bind(tgId, day)
    .all()
    .then((r) => r.results || [])
    .catch(() => []);
  const hasPlan = plan.length
    ? true
    : Boolean(await env.STATS.prepare("SELECT 1 FROM reminder_plan WHERE tg_id = ? AND day >= ? LIMIT 1").bind(tgId, iso(new Date())).first().catch(() => null));

  let rows = [];
  if (hasPlan) {
    rows = plan.map((p) => ({ start: p.start, end: p.end, subject: p.subject, room: p.room }));
  } else if (found) {
    const parity = (found.schedule.weeks || []).find((w) => w.from <= day && day <= w.to)?.parity || null;
    const seen = new Set();
    for (const l of found.schedule.lessons || []) {
      if (l.group !== found.raw) continue;
      const on = l.dates ? l.dates.includes(day) : l.day === weekday && (l.week === "all" || !parity || l.week === parity);
      if (!on) continue;
      const subject = shownSubject(l, found.tenantId);
      const key = `${l.slot}|${subject}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({
        start: l.start || startOf(l.slot),
        end: l.end || bells.get(l.slot)?.end || "",
        subject,
        room: l.roomOn?.[day] || l.room || "",
        once: Boolean(l.roomOn?.[day]),
        off: Boolean(l.cancelOn?.includes(day)),
        raw: l.subject,
      });
    }
  }
  rows.sort((a, b) => a.start.localeCompare(b.start));
  const l = rows.map((r) => {
    const moved = roomAt(r.start, r.raw || r.subject);
    const off = r.off || cancelledAt(r.start, r.raw || r.subject);
    return [r.start, r.end, r.subject, moved || r.room, off ? 1 : moved || r.once ? 2 : 0];
  });
  return pack({ d: day, g: groupTitle(grp), l });
}

/** /today — прислать виджет. */
export async function sendDayWidget(env, callTelegram, chatId, tgId, groupTitle, appUrl) {
  const day = iso(new Date(Date.now() + 3 * 3600000));
  const chatData = await dayPayload(env, tgId, day, groupTitle);
  const res = await callTelegram(env.BOT_TOKEN, "sendWidget", {
    chat_id: chatId,
    html: WIDGET_HTML,
    chat_data: chatData,
    allow_queries: true,
    caption: "📅 Мои пары — листайте стрелками",
    // Открыть приложение — обычной кнопкой под виджетом: ссылки t.me на
    // мини-приложение у бота может не быть, а web_app-кнопка работает всегда.
    reply_markup: { inline_keyboard: [[{ text: "Открыть расписание", web_app: { url: appUrl } }]] },
  });
  const body = await res.json().catch(() => ({}));
  return body;
}

/** Запрос виджета: «d:2026-11-11» → пары этого дня. */
export async function answerWidget(env, callTelegram, query, groupTitle) {
  const m = /^d:(\d{4}-\d{2}-\d{2})$/.exec(String(query.data || ""));
  const data = m && query.from?.id ? await dayPayload(env, query.from.id, m[1], groupTitle).catch(() => "") : "";
  await callTelegram(env.BOT_TOKEN, "answerWidgetQuery", { widget_query_id: query.id, data }).catch(() => {});
}
