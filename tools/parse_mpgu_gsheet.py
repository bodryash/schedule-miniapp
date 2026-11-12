"""МПГУ, ИСГО: расписание из Google-таблицы (вид htmlview) → docs/data/<id>/.

Таблица: «день недели и дата | время | группа1 | группа2 …». В клетке одна
или несколько пар: «Предмет (ЛК 16) доц. И.О. Фамилия (ауд. 846) 07.09; 21.09».
Даты обычно перечислены явно; «с 7.10» — каждую неделю с этой даты, «только
7.10» — один раз; без дат — каждую неделю семестра.

Запуск: python tools/parse_mpgu_gsheet.py <id> "<факультет>" sheet1.html [sheet2.html …]
Листы скачиваются так (gid — из ссылки на лист):
  https://docs.google.com/spreadsheets/d/<ключ>/htmlview/sheet?headers=false&gid=<gid>
"""

import html
import json
import re
import sys
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
YEAR = 2026
SEM_FROM, SEM_TO = date(YEAR, 9, 1), date(YEAR, 12, 30)
DAYS = {"понедельник": 1, "вторник": 2, "среда": 3, "четверг": 4, "пятница": 5, "суббота": 6}
KIND = {"ЛК": "лекция", "ПЗ": "практика", "ЛБ": "лабораторная", "СЕМ": "семинар"}
RE_LESSON = re.compile(r"([А-ЯЁA-Z][^()\n]{2,160}?)\s*\((ЛК|ПЗ|ЛБ|СЕМ)\s*\d*\)")
RE_TEACHER = re.compile(r"((?:проф|доц|ст\.\s*преп|преп|асс|ст\.преп)\.?\s*[А-ЯЁ]\.\s*[А-ЯЁ]\.\s*[А-ЯЁ][а-яё\-]+)")
RE_ROOM = re.compile(r"\(\s*ауд\.?\s*([^)]*?)\s*\)")
RE_DATE = re.compile(r"(?<![\d.])(\d{1,2})\.(\d{2})(?:\.(?:\d{2,4})?)?(?![\d])")


def grid(path):
    s = Path(path).read_text(encoding="utf-8")
    cells, r = {}, 0
    for tr in re.findall(r"<tr[^>]*>(.*?)</tr>", s, re.S):
        c = 0
        for m in re.finditer(r"<t[dh]([^>]*)>(.*?)</t[dh]>", tr, re.S):
            attrs, body = m.groups()
            while (r, c) in cells:
                c += 1
            text = html.unescape(re.sub(r"<br\s*/?>", "\n", body))
            text = re.sub(r"<[^>]+>", "", text).strip()
            cs = int((re.search(r'colspan="(\d+)"', attrs) or [0, 1])[1])
            rs = int((re.search(r'rowspan="(\d+)"', attrs) or [0, 1])[1])
            for dr in range(rs):
                for dc in range(cs):
                    cells[(r + dr, c + dc)] = (text, (r, c))
            c += cs
        r += 1
    return cells, r


def dates_of(text, weekday):
    """Даты пары из хвоста описания."""
    def on(d, m):
        try:
            return date(YEAR, m, d)
        except ValueError:
            return None
    m = re.search(r"\bс\s+(\d{1,2})\.(\d{2})", text)
    if m:
        start = on(int(m.group(1)), int(m.group(2)))
        out, d = [], start
        while d and d <= SEM_TO:
            out.append(d)
            d += timedelta(days=7)
        return out
    found = [on(int(d), int(mo)) for d, mo, *_ in [(x.group(1), x.group(2)) for x in RE_DATE.finditer(text)]]
    found = [d for d in found if d and SEM_FROM <= d <= SEM_TO and d.isoweekday() == weekday]
    if found:
        return sorted(set(found))
    # Дат нет — каждую неделю семестра.
    d = SEM_FROM + timedelta(days=(weekday - SEM_FROM.isoweekday()) % 7)
    out = []
    while d <= SEM_TO:
        out.append(d)
        d += timedelta(days=7)
    return out


def lessons_in(text, weekday):
    text = text.replace("\\з", "/з")
    link = (re.search(r"https?://\S+", text) or [""])[0]
    starts = [m.start() for m in RE_LESSON.finditer(text)]
    out = []
    for i, s in enumerate(starts):
        chunk = text[s: starts[i + 1] if i + 1 < len(starts) else len(text)]
        m = RE_LESSON.match(chunk)
        subject = re.sub(r"\s+", " ", m.group(1)).strip(" :")
        rest = chunk[m.end():]
        teacher = (RE_TEACHER.search(rest) or [""])[0]
        teacher = re.sub(r"\s+", " ", teacher).replace("ст.преп", "ст. преп")
        room_m = RE_ROOM.search(rest)
        room = room_m.group(1).strip() if room_m else ""
        if not room and "с/з" in rest:
            room = "спортзал"
        note = "дистанционно" if "дистанц" in rest else ""
        dates = dates_of(RE_ROOM.sub(" ", rest.split("http")[0]), weekday)
        out.append({"subject": subject, "type": KIND[m.group(2)], "teacher": teacher, "room": room, "dates": [d.isoformat() for d in dates], "link": link if "http" in chunk else "", "note": note})
    return out


def parse(paths):
    groups, lessons = {}, []
    for path in paths:
        cells, n = grid(path)
        text = lambda r, c: cells.get((r, c), ("", None))[0]
        head = next(r for r in range(n) if any(text(r, c).startswith("день недели") for c in range(4)))
        dcol = next(c for c in range(4) if text(head, c).startswith("день недели"))
        tcol = dcol + 1
        gcols = {}
        c = tcol + 1
        while (head, c) in cells:
            g = text(head, c)
            if g and (head, c) == cells[(head, c)][1]:
                gcols[c] = g
            c += 1
        title = "\n".join(text(r, dcol + 1) for r in range(head)).lower()
        course = {"i ": 1, "ii ": 2, "iii ": 3, "iv ": 4, "v ": 5}
        cm = re.search(r"\b(i{1,3}|iv|v)\s*курс", title)
        level_course = {"i": 1, "ii": 2, "iii": 3, "iv": 4, "v": 5}.get(cm.group(1) if cm else "", 1)
        form = "очно-заочная" if "очно-заочн" in title else "заочная" if "заочн" in title else ""
        for gc, g in gcols.items():
            groups[g] = {"id": g, "title": g + (f" ({form})" if form else ""), "course": level_course, "level": "магистратура" if "магистр" in title else "бакалавриат"}
        seen = set()
        last_time = ""
        for r in range(head + 1, n):
            day_text = text(r, dcol).lower()
            wd = next((v for k, v in DAYS.items() if day_text.startswith(k)), 0)
            if not wd:
                continue
            t = text(r, tcol).replace(":", ".")
            m = re.match(r"(\d{1,2})\.(\d{2})\s*-\s*(\d{1,2})\.(\d{2})", t)
            if m:
                last_time = f"{int(m.group(1)):02d}:{m.group(2)}-{int(m.group(3)):02d}:{m.group(4)}"
            if not last_time:
                continue
            start, end = last_time.split("-")
            for gc, g in gcols.items():
                txt, origin = cells.get((r, gc), ("", None))
                if not txt or (origin, g) in seen:
                    continue
                seen.add((origin, g))
                for l in lessons_in(txt, wd):
                    lessons.append({"group": g, "day": wd, "slot": 0, "start": start, "end": end, "subgroup": None, "elective": None, "week": "all", **l})
    starts = sorted({l["start"] for l in lessons})
    bells = [{"n": i + 1, "start": s, "end": next(l["end"] for l in lessons if l["start"] == s)} for i, s in enumerate(starts)]
    slot = {b["start"]: b["n"] for b in bells}
    for l in lessons:
        l["slot"] = slot[l["start"]]
    return groups, lessons, bells


def weeks():
    d = SEM_FROM - timedelta(days=SEM_FROM.weekday())
    out, odd = [], True
    while d <= SEM_TO:
        out.append({"from": d.isoformat(), "to": (d + timedelta(days=6)).isoformat(), "parity": "odd" if odd else "even"})
        d += timedelta(days=7)
        odd = not odd
    return out


def main():
    tid, faculty, *paths = sys.argv[1:]
    groups, lessons, bells = parse(paths)
    out = ROOT / "docs" / "data" / tid
    out.mkdir(parents=True, exist_ok=True)
    gl = sorted(groups.values(), key=lambda g: (g["level"] != "бакалавриат", g["course"], g["id"]))
    data = {
        "meta": {"updated": date.today().isoformat(), "semester": "1 семестр 2026/2027", "faculty": faculty, "dated": True, "period": {"from": "01.09.2026", "to": "30.12.2026"}},
        "weeks": weeks(), "bells": bells, "groups": gl, "lessons": lessons,
    }
    (out / "schedule.json").write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    (out / "groups.json").write_text(json.dumps(gl, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"групп {len(gl)}, строк {len(lessons)}, занятий по датам {sum(len(l['dates']) for l in lessons)}")


if __name__ == "__main__":
    main()
