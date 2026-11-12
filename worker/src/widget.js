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
body{margin:0;padding:10px 10px 6px;font:15px/1.3 system-ui,sans-serif}
.h{display:flex;align-items:center;gap:8px}
.h div{flex:1;text-align:center}
.h b{display:block;font-size:20px;letter-spacing:-.3px}
.h small,.g,.q,.t i,.o{color:var(--tg-theme-hint-color)}
.h small{font-size:12px}
.g{text-align:center;font-size:12px;margin-top:2px}
.q{font-size:12px;text-align:center;margin:6px 0}
.bar{height:4px;border-radius:2px;margin:6px 0 8px;background:var(--tg-theme-secondary-bg-color);overflow:hidden}
.bar i{display:block;height:100%;background:var(--tg-theme-button-color)}
.c{padding:10px 12px;border-radius:14px;margin-bottom:8px;background:linear-gradient(135deg,var(--tg-theme-button-color),#8e5cf7);color:#fff}
.c b{display:block;font-size:16px}
.c span{font-size:13px;opacity:.9}
.r{display:flex;gap:10px;align-items:center;margin:6px 0;padding:9px 10px 9px 12px;border-radius:12px;background:var(--tg-theme-secondary-bg-color);border-left:4px solid hsl(var(--h),70%,58%)}
.t{flex:none;min-width:46px;white-space:nowrap;font-weight:700;font-size:15px;font-variant-numeric:tabular-nums}
.t i{display:block;font-style:normal;font-weight:400;font-size:12px}
.s{flex:1;min-width:0;font-weight:500}
.a{flex:none;white-space:nowrap;padding:3px 9px;border-radius:10px;font-size:12px;font-weight:600;background:hsla(var(--h),70%,58%,.18);color:hsl(var(--h),60%,48%)}
.s em{display:block;font-style:normal;font-size:12px;font-weight:400;color:var(--tg-theme-hint-color)}
.x{opacity:.5}.x .s{text-decoration:line-through}
.m .s em{color:hsl(var(--h),60%,48%)}
.p{opacity:.45}
.n{box-shadow:0 0 0 2px hsl(var(--h),70%,58%)}
.o{font-size:12px;text-align:center;margin:-2px 0}
.e{padding:18px 0;text-align:center;color:var(--tg-theme-hint-color)}
</style>
<div class="h"><div id="d"></div></div>
<div class="g" id="g"></div><div id="l"></div>
<script>
const W=window.TelegramWidget,$=i=>document.getElementById(i);
let day,cache={},busy=0,x0=0,fail={};
const iso=t=>{const z=new Date(t);return z.getFullYear()+'-'+String(z.getMonth()+1).padStart(2,'0')+'-'+String(z.getDate()).padStart(2,'0')};
const add=(s,n)=>{const z=new Date(s+'T12:00');z.setDate(z.getDate()+n);return iso(z)};
const min=s=>{const[a,b]=s.split(':');return a*60+ +b};
const dur=n=>n<60?n+' мин':Math.floor(n/60)+' ч'+(n%60?' '+n%60+' мин':'');
const P=s=>{try{return JSON.parse(s)}catch(e){return null}};
const E=(t,c,x)=>{const e=document.createElement(t);if(c)e.className=c;if(x!=null)e.textContent=x;return e};
try{cache=JSON.parse(localStorage.getItem('c')||'{}')}catch(e){}
function keep(v){cache[v.d]=v;const k=Object.keys(cache).sort();while(k.length>5)delete cache[k.shift()];try{localStorage.setItem('c',JSON.stringify(cache))}catch(e){}}
function draw(){const v=cache[day],l=$('l'),now=new Date(),t=iso(now),m=now.getHours()*60+now.getMinutes(),D=new Date(day+'T12:00');
const rel=(day==t?'☀️ Сегодня':day==add(t,1)?'🌙 Завтра':day==add(t,-1)?'Вчера':D.toLocaleDateString('ru-RU',{weekday:'long'}));
$('d').innerHTML='';$('d').append(E('b','',rel),E('small','',D.toLocaleDateString('ru-RU',{weekday:day==t||day==add(t,1)?'long':undefined,day:'numeric',month:'long'})));
$('g').textContent=v&&v.g||'';l.textContent='';
if(!v)return l.append(E('div','e',fail[day]?'Не получилось загрузить — нажми кнопку ещё раз':'Загружаю…'));
if(v.e)return l.append(E('div','e',v.e=='group'?'Выберите группу в приложении':'Нет данных'));
const L=v.l.filter(r=>r[4]!=1);
if(!v.l.length)return l.append(E('div','e',D.getDay()?'Пар нет — свободный день 🎉':'Воскресенье — отдыхаем 🎉'));
const a=L.length?min(L[0][0]):0,b=L.length?min(L[L.length-1][1]):0,n=L.length;
l.append(E('div','q',n?n+' '+(n%10==1&&n!=11?'пара':n%10>1&&n%10<5&&(n<10||n>20)?'пары':'пар')+' · '+L[0][0]+'–'+L[n-1][1]+' · свободен с '+L[n-1][1]:'Все пары отменены'));
if(day==t&&n){const bar=E('div','bar'),i=E('i');i.style.width=Math.max(0,Math.min(100,(m-a)/(b-a)*100))+'%';bar.append(i);l.append(bar);
const cur=L.find(r=>m>=min(r[0])&&m<min(r[1])),nx=L.find(r=>min(r[0])>m),c=E('div','c');
if(cur){c.append(E('b','',cur[2]),E('span','','Идёт · ещё '+dur(min(cur[1])-m)+(cur[3]?' · '+cur[3]:'')))}
else if(nx){c.append(E('b','',nx[2]),E('span','','Через '+dur(min(nx[0])-m)+' · в '+nx[0]+(nx[3]?' · '+nx[3]:'')))}
else c.append(E('b','','Пары закончились'),E('span','','Отдыхай ✨'));l.append(c)}
let prev=null;for(const r of v.l){const[s,f,name,room,k]=r;
if(prev&&k!=1&&min(s)-min(prev)>=40)l.append(E('div','o',(min(s)-min(prev)>=80?'☕ окно ':'перерыв ')+dur(min(s)-min(prev))));
let hh=0;for(const ch of name)hh=(hh*31+ch.charCodeAt(0))%360;const e=E('div','r'+(k==1?' x':k==2?' m':'')+(day==t&&k!=1?(m>=min(f)?' p':m>=min(s)?' n':''):'')),T=E('div','t',s);e.style.setProperty('--h',hh);T.append(E('i','',f));
const S=E('div','s',name);if(k==1)S.append(E('em','','отменена'));else if(k==2)S.append(E('em','','другая аудитория'));
e.append(T,S);if(room)e.append(E('div','a',room));l.append(e);if(k!=1)prev=f}}
function ask(d,tap){if(!W||(busy&&!tap))return;busy=1;fail[d]=0;const to=setTimeout(()=>{fail[d]='нет ответа';busy=0;draw()},6000);W.request('d:'+d).then(x=>{const v=P(x&&x.result);if(v&&v.d){keep(v);if(v.d==day)draw()}else{fail[d]='пустой ответ';draw()}}).catch(e=>{fail[d]=(e&&(e.code||e.name||e.message))||'ошибка';draw()}).finally(()=>{clearTimeout(to);busy=0})}
const c=W&&P(W.chatData);if(c&&c.d)keep(c);day=c&&c.d||iso(Date.now());
draw();ask(day);
if(W){W.onEvent('activated',()=>{draw();ask(day)});W.onEvent('chatDataChanged',()=>{const v=P(W.chatData);if(v&&v.d){keep(v);draw()}});W.ready&&W.ready()}
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
export async function sendDayWidget(env, callTelegram, chatId, tgId, groupTitle, appUrl, forceDay = null) {
  // Вечером виджет открывается на завтра — завтра и кладём, чтобы не ждать запроса.
  const msk = new Date(Date.now() + 3 * 3600000);
  let day = iso(msk);
  let chatData = await dayPayload(env, tgId, day, groupTitle);
  const today = JSON.parse(chatData);
  const live = (today.l || []).filter((r) => r[4] !== 1);
  const lastEnd = live.length ? live[live.length - 1][1] : "17:00";
  const nowHm = msk.toISOString().slice(11, 16);
  if (forceDay) {
    day = forceDay;
    // «o» — открыть именно этот день, а не «сегодня».
    const v = JSON.parse(await dayPayload(env, tgId, day, groupTitle));
    chatData = JSON.stringify({ ...v, o: 1 });
  } else if (!today.e && nowHm >= "15:00" && nowHm >= lastEnd) {
    day = iso(new Date(msk.getTime() + 86400000));
    chatData = await dayPayload(env, tgId, day, groupTitle);
  }
  const res = await callTelegram(env.BOT_TOKEN, "sendWidget", {
    chat_id: chatId,
    html: WIDGET_HTML,
    chat_data: chatData,
    allow_queries: true,
    caption: "📅 Мои пары",
    // Открыть приложение — обычной кнопкой под виджетом: ссылки t.me на
    // мини-приложение у бота может не быть, а web_app-кнопка работает всегда.
    // Кнопки «Сегодня / Завтра» над клавиатурой приходят вместе с виджетом —
    // отдельного текстового сообщения не нужно. Приложение — кнопкой меню.
    reply_markup: { keyboard: [[{ text: "☀️ Сегодня" }, { text: "🌙 Завтра" }]], resize_keyboard: true, is_persistent: true },
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
