"""СамГМУ, расписание курса одной таблицей в PDF — в папку приложения.

Таблица устроена так: по горизонтали — пары групп (Л101-Л102, Л103-Л104 …),
по вертикали — дни и 45-минутные строки. Занятие занимает прямоугольник из
нескольких строк и столбцов, а в нём подписано, в какие недели оно идёт:
«ФЖС (1-11 нед) КОПД (12-16 нед.)». Недели у вуза свои — со вторника по
понедельник, первая начинается 1 сентября. Поэтому каждое занятие
разворачиваем в список дат.

    python tools/parse_samgmu_pdf.py файл.pdf --id samgmu-ikm-lech-1 \\
        --university "СамГМУ" --faculty "…" --course 1 \\
        --from 2026-09-01 --to 2026-12-30 --skip 2026-11-04
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

# Сокращения из сноски под таблицей.
NAMES = {
    "УП": "Уход за больными терапевтического и хирургического профиля",
    "ОНК": "Основы научной коммуникации",
    "ФАМ": "Философские аспекты медицины",
    "БИОЭ": "Биоэтика в медицинской и фармацевтической практиках",
    "ОРГ": "Основы российской государственности",
    "ИНО": "Иностранный язык",
    "КОПД": "Коммуникативные основы профессиональной деятельности",
    "БЖД": "Безопасность жизнедеятельности",
    "ФЖС": "Физика живых систем",
    "ООНИ": "Основы организации научных исследований",
    "АНАТ ОДА": "Анатомия опорно-двигательного аппарата",
    "Биоэтика в медицинской и фармацевтической практиках": "Биоэтика в медицинской и фармацевтической практиках",
}
BLOCKS = ["08:00", "10:30", "13:00", "15:30", "18:00", "19:40"]
ITEM = re.compile(r"\s*(.+?)\s*(?:\(\s*(\d+)\s*(?:-\s*(\d+))?\s*нед\.?\s*\)|только\s+(\d+)\s*нед\.?)")


def groups_of(label):
    """«Л101-Л102» → [Л101, Л102]; «Л129- Л 130» → [Л129, Л130]."""
    found = re.findall(r"(Л|ИНО)\s?(\d{3})", label)
    return [f"{prefix}{number}" for prefix, number in found]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("pdf", type=Path)
    parser.add_argument("--id", required=True)
    parser.add_argument("--university", required=True)
    parser.add_argument("--faculty", required=True)
    parser.add_argument("--course", type=int, default=1)
    parser.add_argument("--level", default="специалитет")
    parser.add_argument("--from", dest="start", required=True, help="вторник первой учебной недели")
    parser.add_argument("--to", dest="end", required=True)
    parser.add_argument("--skip", default="", help="праздничные дни через запятую")
    parser.add_argument("--lecture-room", default="")
    args = parser.parse_args()
    start, end = date.fromisoformat(args.start), date.fromisoformat(args.end)
    skip = {date.fromisoformat(d) for d in args.skip.split(",") if d}

    page = pdfplumber.open(args.pdf).pages[0]
    table = max(page.find_tables(), key=lambda t: len(t.cells))
    cells = []
    for x0, top, x1, bottom in table.cells:
        text = page.crop((x0 + 0.5, top + 0.5, x1 - 0.5, bottom - 0.5)).extract_text() or ""
        cells.append((x0, top, x1, bottom, re.sub(r"\s+", " ", text).strip()))

    # Столбцы групп — из шапки.
    columns = []
    header_bottom = 0
    for x0, top, x1, bottom, text in cells:
        names = groups_of(text)
        if names and len(text) < 24 and "(" not in text:
            columns.append((x0, x1, names))
            header_bottom = max(header_bottom, bottom)
    columns.sort()
    left, right = columns[0][0], columns[-1][1]
    # Последний столбец («ИНО 101-ИНО 102») в таблице делится пополам: слева одна группа, справа другая.
    inner = sorted({c[0] for c in cells if columns[-1][0] < c[0] < columns[-1][1]} | {c[2] for c in cells if columns[-1][0] < c[2] < columns[-1][1]})
    if inner and len(columns[-1][2]) == 2:
        x0, x1, (first, second) = columns.pop()
        columns += [(x0, inner[0], [first]), (inner[0], x1, [second])]

    # Строки времени: каждое «08:00» начинает новый день.
    rows, day = [], 0
    for x0, top, x1, bottom, text in sorted(cells, key=lambda c: c[1]):
        time = re.search(r"(\d{1,2}):(\d{1,2})-(\d{1,2}):(\d{2})", text)
        if not time or x1 > left + 1 or top < header_bottom:
            continue
        begin = f"{int(time.group(1)):02d}:{int(time.group(2)):02d}"
        finish = f"{int(time.group(3)):02d}:{time.group(4)}"
        if begin == "08:00":
            day += 1
        rows.append((top, bottom, day, begin, finish))
    if day != 5:
        sys.exit(f"Ожидалось 5 дней в таблице, найдено {day} — формат изменился.")

    def when(weekday, week):
        """Неделя вуза идёт со вторника по понедельник."""
        shift = weekday - 2 if weekday >= 2 else 6
        return start + timedelta(days=(week - 1) * 7 + shift)

    merged = defaultdict(set)
    problems = []
    for x0, top, x1, bottom, text in cells:
        if not text or x0 < left - 1 or x1 > right + 1 or top < header_bottom:
            continue
        # Строка времени считается занятой, если клетка накрывает её хотя бы
        # наполовину: в среду первая строка делит высоту с подписью дня.
        inside = [r for r in rows if min(r[1], bottom) - max(r[0], top) >= 0.45 * min(r[1] - r[0], bottom - top)]
        if not inside or text.startswith("Лекционный день") or text.startswith("ЛЕКЦИИ"):
            continue
        weekday, begin, finish = inside[0][2], inside[0][3], inside[-1][4]
        who = [name for c0, c1, names in columns if c0 >= x0 - 1 and c1 <= x1 + 1 for name in names]
        items = ITEM.findall(text)
        if not items or not who:
            problems.append(f"не разобрано: «{text}» ({begin}, день {weekday})")
            continue
        if ITEM.sub("", text).strip(" .,"):
            problems.append(f"остался хвост «{ITEM.sub('', text).strip()}» в «{text}»")
        # Среда — лекционный день: длинные строки на полкурса, вечером — лекции в ЭИОС.
        lecture = weekday == 3 and len(who) > 4
        online = lecture and begin >= "18:00"
        for raw, first, last, only in items:
            subject = NAMES.get(raw.strip(), raw.strip())
            weeks = [int(only)] if only else range(int(first), int(last or first) + 1)
            dates = [when(weekday, w) for w in weeks]
            dates = [d for d in dates if start <= d <= end and d not in skip]
            room = "ЭИОС" if online else args.lecture_room if lecture else ""
            for name in who:
                key = (name, weekday, begin, finish, subject, "лекция" if lecture else "", room)
                merged[key].update(d.isoformat() for d in dates)
    if problems:
        print("\n".join(problems), file=sys.stderr)
        sys.exit(f"Проблем: {len(problems)} — расписание не записано.")

    lessons = []
    for (name, weekday, begin, finish, subject, kind, room), dates in merged.items():
        if not dates:
            continue
        slot = max(i for i, t in enumerate(BLOCKS, 1) if t <= begin)
        lessons.append({
            "group": name, "day": weekday, "slot": slot, "subgroup": None, "elective": None, "week": "all",
            "note": "", "link": "", "start": begin, "end": finish, "type": kind,
            "subject": subject, "room": room, "teacher": "", "dates": sorted(dates),
        })
    names = [name for _, _, group in columns for name in group]
    groups = [{"id": name, "title": name, "course": args.course, "level": args.level} for name in names]
    bells = [{"n": 1, "start": "08:00", "end": "10:25"}, {"n": 2, "start": "10:30", "end": "12:55"},
             {"n": 3, "start": "13:00", "end": "15:25"}, {"n": 4, "start": "15:30", "end": "17:55"},
             {"n": 5, "start": "18:00", "end": "19:35"}, {"n": 6, "start": "19:40", "end": "21:15"}]
    weeks, cursor, parity = [], start - timedelta(days=start.weekday()), "odd"
    while cursor <= end:
        sunday = cursor + timedelta(days=6)
        weeks.append({"from": max(cursor, start).isoformat(), "to": min(sunday, end).isoformat(), "parity": parity})
        cursor, parity = sunday + timedelta(days=1), ("even" if parity == "odd" else "odd")
    schedule = {
        "meta": {"updated": date.today().isoformat(), "semester": "", "faculty": f"{args.faculty} {args.university}", "dated": True,
                 "period": {"from": start.strftime("%d.%m.%Y"), "to": end.strftime("%d.%m.%Y")}},
        "weeks": weeks, "bells": bells, "groups": groups,
        "lessons": sorted(lessons, key=lambda l: (l["group"], l["day"], l["start"], l["dates"][0])),
    }
    folder = DATA / args.id
    folder.mkdir(parents=True, exist_ok=True)
    dump = lambda value: json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    (folder / "schedule.json").write_text(dump(schedule), encoding="utf-8")
    (folder / "groups.json").write_text(dump(groups), encoding="utf-8")
    registry = DATA / "tenants.json"
    tenants = json.loads(registry.read_text(encoding="utf-8"))
    keep = next((t for t in tenants if t["id"] == args.id), {})
    entry = {**keep, "id": args.id, "university": args.university, "faculty": args.faculty, "path": args.id, "features": keep.get("features", [])}
    registry.write_text(json.dumps([t for t in tenants if t["id"] != args.id] + [entry], ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"{args.university}, {args.faculty}: групп {len(groups)}, строк {len(lessons)}, занятий {sum(len(l['dates']) for l in lessons)}")


if __name__ == "__main__":
    main()
