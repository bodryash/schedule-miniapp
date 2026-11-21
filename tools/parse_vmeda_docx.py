"""ВМедА им. Кирова: docx «Расписание контрольных мероприятий» (взводы × даты).

Строки — взвод и часы (1-2, 3-4, 5-6), столбцы — даты. Строчные буквы —
практика, заглавные — лекция; цифра после кода — аудитория, «к» — класс
кафедры, «д» — дистанционно. Жирным — контрольное мероприятие. Легенда
кодов — последняя таблица документа.

    python3 tools/parse_vmeda_docx.py файл.docx <tenant> "<факультет>" <курс>
"""
import datetime as dt
import json
import os
import re
import sys

import docx

HOURS = {"1-2": (1, "09:00", "10:40"), "3-4": (2, "11:05", "12:45"), "5-6": (3, "13:50", "15:30"), "7-8": (4, "15:50", "17:30")}
MONTHS = {"сентябрь": 9, "октябрь": 10, "ноябрь": 11, "декабрь": 12, "январь": 1, "февраль": 2, "март": 3}


def main(path, tenant, faculty, course):
    d = docx.Document(path)
    legend = {}
    for r in d.tables[-1].rows[1:]:
        code, name = r.cells[0].text.strip().lower(), r.cells[1].text.strip()
        if code and name:
            legend.setdefault(code, name[0].upper() + name[1:])
    legend.setdefault("пр(мп)", legend.get("пр(мл)", "Помощник младшего медицинского персонала"))
    lessons, groups = {}, set()
    year, month, prev = 2026, 9, 0
    for t in d.tables[:-1]:
        if t.rows[0].cells[1].text.strip().lower() != "час занятий":
            continue
        cols = []
        for i, c in enumerate(t.rows[1].cells[2:], 2):
            day = c.text.strip()
            if not day.isdigit():
                continue
            day = int(day)
            if day < prev:
                month += 1
                if month == 13:
                    month, year = 1, year + 1
            prev = day
            cols.append((i, dt.date(year, month, day).isoformat()))
        for r in t.rows[2:]:
            grp, hours = r.cells[0].text.strip(), r.cells[1].text.strip()
            if not re.match(r"\d+-[А-Я]+-\d+", grp) or hours not in HOURS:
                continue
            groups.add(grp)
            slot, start, end = HOURS[hours]
            for i, iso in cols:
                cell = r.cells[i]
                raw = cell.text.strip()
                if not raw:
                    continue
                m = re.match(r"^(пр\([а-я]+\)|[а-яА-ЯёЁ]+)\s*(.*)$", raw)
                if not m:
                    continue
                code, rest = m.group(1), m.group(2).strip()
                lecture = code != code.lower()
                name = legend.get(code.lower())
                if code.lower() == "от":
                    name = "Тактика воздушно-космических сил" if grp.endswith(("-06", "-07")) else "Общая тактика"
                if not name:
                    name = code
                room = ""
                if rest == "к":
                    room = "класс кафедры"
                elif rest == "д":
                    room = "дистанционно"
                elif rest:
                    room = rest
                bold = any(run.bold for p in cell.paragraphs for run in p.runs if run.text.strip())
                key = (grp, slot, name, room, lecture, bold)
                item = lessons.setdefault(key, {
                    "group": grp, "slot": slot, "start": start, "end": end, "subject": name,
                    "type": "лекция" if lecture else "практика", "teacher": "", "room": room,
                    "dates": [], "subgroup": None, "elective": None, "week": "all",
                    "note": "контрольное мероприятие" if bold else "", "link": "",
                })
                item["dates"].append(iso)
    out = []
    for item in lessons.values():
        # День недели — по первой дате; одинаковая пара в разные дни недели
        # разбивается, чтобы day совпадал с датами.
        by_day = {}
        for iso in item["dates"]:
            by_day.setdefault(dt.date.fromisoformat(iso).isoweekday(), []).append(iso)
        for wd, dates in by_day.items():
            out.append({**item, "day": wd, "dates": sorted(dates)})
    all_dates = sorted(x for l in out for x in l["dates"])
    first, last = dt.date.fromisoformat(all_dates[0]), dt.date.fromisoformat(all_dates[-1])
    weeks, w, par = [], first - dt.timedelta(days=first.weekday()), "odd"
    while w <= last:
        weeks.append({"from": w.isoformat(), "to": (w + dt.timedelta(days=6)).isoformat(), "parity": par})
        par = "even" if par == "odd" else "odd"
        w += dt.timedelta(days=7)
    gl = [{"id": g, "title": g, "course": int(course), "level": "специалитет"} for g in sorted(groups)]
    sched = {
        "meta": {"updated": dt.date.today().isoformat(), "semester": "", "faculty": faculty, "dated": True,
                 "period": {"from": first.strftime("%d.%m.%Y"), "to": last.strftime("%d.%m.%Y")}},
        "weeks": weeks,
        "bells": [{"n": n, "start": s, "end": e} for n, s, e in HOURS.values()],
        "groups": gl,
        "lessons": sorted(out, key=lambda l: (l["group"], l["day"], l["slot"])),
    }
    os.makedirs(f"docs/data/{tenant}", exist_ok=True)
    json.dump(sched, open(f"docs/data/{tenant}/schedule.json", "w"), ensure_ascii=False, indent=1)
    json.dump(gl, open(f"docs/data/{tenant}/groups.json", "w"), ensure_ascii=False, indent=1)
    print(len(gl), "групп,", len(out), "пар,", first, "—", last)


if __name__ == "__main__":
    main(*sys.argv[1:5])
