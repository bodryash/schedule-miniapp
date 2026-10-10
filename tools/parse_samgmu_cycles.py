"""СамГМУ, старшие курсы: цикловое расписание из PDF — в папку факультета.

У старших курсов нет недельной сетки. Есть лента учебных дней семестра
(вторник–пятница и понедельник), и по ней для каждой связки групп
нарисованы циклы: несколько дней подряд — один предмет. Потоков два, у них
одни и те же циклы, но разное время. Отдельными таблицами — лекции по
понедельникам, вечерние лекции в ЭИОС и спортивные игры раз в неделю.

Группы этого курса добавляются к уже записанному расписанию факультета
(первый курс разбирает parse_samgmu_pdf.py), остальные курсы не трогаются.

    python tools/parse_samgmu_cycles.py файл.pdf --page 2 --id samgmu-ikm-lech \\
        --course 3 --year 2026 --to 2026-12-30
"""

import argparse
import json
import re
import sys
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path

import pdfplumber

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "docs" / "data"

NAMES = {
    "Ф": "Фармакология", "П": "Патология", "ОХ": "Общая хирургия",
    "ТП": "Технологическое предпринимательство в медицине", "МИ": "Медицинская информатика",
    "МА": "Медицинская антропология", "ТА": "Топографическая анатомия и оперативная хирургия",
    "ПВ": "Пропедевтика внутренних болезней", "ЛД": "Лучевая диагностика", "О": "Офтальмология",
    "МДТ": "Методы диагностики терапевтического пациента",
    "ТА1": "Классические и инновационные методы хирургической практики (дополненная и виртуальная реальность)",
    "ОМП": "Основы методологии проектирования", "ДХП": "Диагностический хирургический практикум",
}
MONTHS = {"сентябрь": 9, "октябрь": 10, "ноябрь": 11, "декабрь": 12, "январь": 1}
ENGLISH = {"Sep": 9, "Oct": 10, "Nov": 11, "Dec": 12, "Jan": 1}
# Время потоков — подтверждено студентом курса: первый поток на циклах утром.
CYCLE = {1: ("08:00", "12:05"), 2: ("13:00", "17:05")}
MONDAY = {1: [("14:40", "16:15"), ("16:20", "17:55")], 2: [("08:00", "09:35"), ("09:40", "11:15")]}
SPORT = {1: ("13:00", "14:35"), 2: ("08:00", "09:35")}
BLOCKS = ["08:00", "10:30", "13:00", "15:30", "18:00", "19:40"]


def code(text):
    """«ОМ П», «Л Д», «МА *», «ТА 1» → ОМП, ЛД, МА, ТА1."""
    return re.sub(r"[\s*]", "", text).upper()


def names_of(text):
    """«304, 305, Л 301» → [304, 305, Л301]."""
    found = re.findall(r"(Л|ИНО)?\s?(\d{3})", text)
    return [f"{prefix}{number}" for prefix, number in found]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("pdf", type=Path)
    parser.add_argument("--page", type=int, default=1, help="номер страницы с 1")
    parser.add_argument("--id", required=True)
    parser.add_argument("--course", type=int, required=True)
    parser.add_argument("--level", default="специалитет")
    parser.add_argument("--year", type=int, required=True, help="год осенней части семестра")
    parser.add_argument("--to", dest="end", required=True)
    parser.add_argument("--fix", default="", help="поправки опечаток в группах: «ряд:поток=группы;…»")
    args = parser.parse_args()
    end = date.fromisoformat(args.end)

    page = pdfplumber.open(args.pdf).pages[args.page - 1]
    table = max(page.find_tables(), key=lambda t: len(t.cells))
    cells = []
    for x0, top, x1, bottom in table.cells:
        text = page.crop((x0 + 0.5, top + 0.5, x1 - 0.5, bottom - 0.5)).extract_text() or ""
        text = re.sub(r"\s+", " ", text).strip()
        if text:
            cells.append((x0, top, x1, bottom, text))

    # Лента дней: месяцы сверху, под ними две строки чисел.
    months = sorted((x0, x1, MONTHS[t.lower()]) for x0, top, x1, bottom, t in cells if t.lower() in MONTHS)
    first_row = min(top for x0, top, x1, bottom, t in cells if t == "1 нед")
    second_row = min(top for x0, top, x1, bottom, t in cells if t == "2 нед")
    days = []
    for x0, top, x1, bottom, t in cells:
        if top in (first_row, second_row) and t.isdigit():
            middle = (x0 + x1) / 2
            month = next(m for a, b, m in months if a <= middle <= b)
            days.append((x0, x1, date(args.year + (1 if month < 8 else 0), month, int(t))))
    days.sort()
    if any(b[2] <= a[2] for a, b in zip(days, days[1:])):
        sys.exit("Дни в ленте идут не по порядку — формат изменился.")
    left, right = days[0][0], days[-1][1]

    # Строки циклов: слева две клетки с группами (первый поток, второй поток).
    # Под циклами лента дней повторена — она и есть нижняя граница.
    tail_row = max(top for x0, top, x1, bottom, t in cells if t == "2 нед")
    legend_row = min(top for x0, top, x1, bottom, t in cells if t.startswith("Клиники") or t.startswith("ЭИОС"))
    labels = sorted((top, x0, bottom, names_of(t)) for x0, top, x1, bottom, t in cells
                    if x1 <= left + 1 and second_row < top < tail_row - 50 and names_of(t) and "нед" not in t and ":" not in t)
    rows = defaultdict(list)
    for top, x0, bottom, names in labels:
        rows[(top, bottom)].append(names)
    rows = sorted(rows.items())
    fixes = {}
    for piece in filter(None, args.fix.split(";")):
        where, names = piece.split("=")
        row, stream = map(int, where.split(":"))
        fixes[(row, stream)] = names.split(",")

    merged = defaultdict(set)
    notes = {}
    streams = {}
    for index, ((top, bottom), sides) in enumerate(rows, 1):
        if len(sides) != 2:
            sys.exit(f"В строке {index} не две клетки с группами: {sides}")
        for stream, names in enumerate(sides, 1):
            names = fixes.get((index, stream), names)
            for name in names:
                streams[name] = stream
        for x0, ctop, x1, cbottom, text in cells:
            if abs(ctop - top) > 1 or x0 < left - 1 or x1 > right + 1:
                continue
            subject = NAMES.get(code(text))
            if not subject:
                sys.exit(f"Неизвестное сокращение «{text}» в строке {index}")
            covered = [d for a, b, d in days if x0 - 1 <= (a + b) / 2 <= x1 + 1]
            for stream, names in enumerate(sides, 1):
                begin, finish = CYCLE[stream]
                for name in fixes.get((index, stream), names):
                    for day in covered:
                        key = (name, day.isoweekday(), begin, finish, subject, "", "")
                        merged[key].add(day.isoformat())
                        if "*" in text:
                            notes[key] = "первое занятие в ЭИОС, второе — аудиторное"

    # Лекции по понедельникам и вечерние в ЭИОС: «7-Sep | ТА | П».
    dated = sorted((top, x0, t) for x0, top, x1, bottom, t in cells if top > legend_row)
    by_line = defaultdict(list)
    for top, x0, t in dated:
        by_line[top].append((x0, t))
    monday_x = next((x0 for x0, top, x1, bottom, t in cells if t.startswith("Клиники")), None)
    online_x = next((x0 for x0, top, x1, bottom, t in cells if t.startswith("ЭИОС")), None)
    stamp = re.compile(r"(\d{1,2})-([A-Z][a-z]{2})$")
    for top, line in by_line.items():
        line.sort()
        for i, (x0, t) in enumerate(line):
            match = stamp.match(t)
            if not match:
                continue
            month = ENGLISH[match.group(2)]
            day = date(args.year + (1 if month < 8 else 0), month, int(match.group(1)))
            if day > end:
                continue
            after = [(x, v) for x, v in line[i + 1:] if not stamp.match(v)]
            before_next = next((x for x, v in line[i + 1:] if stamp.match(v)), 1e9)
            subjects = [(x, v) for x, v in after if x < before_next and code(v) in NAMES]
            if monday_x is not None and online_x is not None and x0 < online_x - 50:
                # Понедельник: две лекции подряд; какая из них первая — по месту в строке.
                columns = sorted({x for x, _ in subjects})
                for x, v in subjects:
                    order = 0 if x < monday_x + 600 else 1
                    for name, stream in streams.items():
                        begin, finish = MONDAY[stream][order]
                        merged[(name, day.isoweekday(), begin, finish, NAMES[code(v)], "лекция", "Клиники СамГМУ, ауд. 1")].add(day.isoformat())
            else:
                for x, v in subjects[:1]:
                    for name in streams:
                        merged[(name, day.isoweekday(), "18:00", "19:35", NAMES[code(v)], "лекция", "ЭИОС")].add(day.isoformat())

    # Спортивные игры: раз в неделю, день — по столбцу, время — по потоку.
    weekdays = sorted((x0, x1, {"ВТ": 2, "СР": 3, "ЧТ": 4, "ПТ": 5}[t]) for x0, top, x1, bottom, t in cells if t in ("ВТ", "СР", "ЧТ", "ПТ"))
    section = [c for c in cells if tail_row + 50 < c[1] < legend_row - 1]
    sport_labels = [(x0, top, x1, bottom, names_of(t)) for x0, top, x1, bottom, t in section if names_of(t) and "спорт" not in t]
    sport = {}
    for x0, top, x1, bottom, t in section:
        if "спорт" not in t:
            continue
        weekday = next(d for a, b, d in weekdays if a - 1 <= (x0 + x1) / 2 <= b + 1)
        # Чья это строка: ближайшая слева клетка с группами на той же высоте.
        beside = [l for l in sport_labels if l[1] - 1 <= top and bottom <= l[3] + 1 and l[2] <= x0 + 1]
        if not beside:
            continue
        for name in max(beside, key=lambda l: l[2])[4]:
            sport.setdefault(name, []).append(weekday)
    semester_days = [d for _, _, d in days]
    first, last = semester_days[0], min(semester_days[-1], end)
    unclear = []
    for name, stream in streams.items():
        options = sorted(set(sport.get(name, [])))
        if len(options) != 1:
            unclear.append(f"{name}: {options or 'нет'}")
            continue
        begin, finish = SPORT[stream]
        cursor = first
        while cursor <= last:
            if cursor.isoweekday() == options[0]:
                merged[(name, options[0], begin, finish, "Спортивные игры", "", "")].add(cursor.isoformat())
            cursor += timedelta(days=1)

    lessons = []
    for key, dates in merged.items():
        name, weekday, begin, finish, subject, kind, room = key
        dates = sorted(d for d in dates if d <= end.isoformat())
        if not dates:
            continue
        slot = max(i for i, t in enumerate(BLOCKS, 1) if t <= begin)
        lessons.append({
            "group": name, "day": weekday, "slot": slot, "subgroup": None, "elective": None, "week": "all",
            "note": notes.get(key, ""), "link": "", "start": begin, "end": finish, "type": kind,
            "subject": subject, "room": room, "teacher": "", "dates": dates,
        })

    target = DATA / args.id / "schedule.json"
    schedule = json.loads(target.read_text(encoding="utf-8"))
    mine = set(streams)
    stale = {g["id"] for g in schedule["groups"] if g["course"] == args.course}
    schedule["groups"] = [g for g in schedule["groups"] if g["id"] not in stale | mine]
    schedule["lessons"] = [l for l in schedule["lessons"] if l["group"] not in stale | mine]
    order = lambda n: (re.sub(r"\D", "", n), n)
    schedule["groups"] += [{"id": n, "title": n, "course": args.course, "level": args.level} for n in sorted(mine, key=order)]
    schedule["lessons"] = sorted(schedule["lessons"] + lessons, key=lambda l: (l["group"], l["day"], l["start"], l["dates"][0]))
    schedule["meta"]["updated"] = date.today().isoformat()
    dump = lambda value: json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    target.write_text(dump(schedule), encoding="utf-8")
    (target.parent / "groups.json").write_text(dump(schedule["groups"]), encoding="utf-8")
    print(f"курс {args.course}: групп {len(mine)}, строк {len(lessons)}, занятий {sum(len(l['dates']) for l in lessons)}")
    print("потоки:", {s: sorted((n for n, v in streams.items() if v == s), key=order) for s in (1, 2)})
    if unclear:
        print("спортивные игры не записаны (день неясен):", "; ".join(unclear))


if __name__ == "__main__":
    main()
