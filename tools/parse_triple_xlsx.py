"""Расписание «три строки на пару» (.xlsx) — в папку факультета.

Так ведёт расписание мехмат МГУ: лист на курс, столбцы — группы, а каждая
пара занимает три строки: предмет, преподаватель, аудитория. Во втором
столбце — начало, «--», конец. Лекция на поток — объединённая ячейка.
Если средняя строка — «~~~~», ячейка поделена пополам: сверху пара одной
недели, снизу — другой («числитель» и «знаменатель»), и каждая записана в
одну строку: «Алгебра, доц. Скутин, 1205».

    python tools/parse_triple_xlsx.py файл.xlsx --id msu-mm --university "МГУ" \\
        --faculty "Механико-математический факультет" --from 2026-09-01 --to 2026-12-26
"""

import argparse
import datetime as dt
import json
import re
import sys
from collections import Counter
from pathlib import Path

from openpyxl import load_workbook

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "docs" / "data"
TITLE = re.compile(r"(?:проф|доц|ст\.\s*преп|преп|асс|н\.\s*с|в\.\s*н\.\s*с|с\.\s*н\.\s*с|акад|м\.\s*н\.\s*с)\.?\s", re.I)


def text(value):
    if value is None:
        return ""
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return re.sub(r"\s+", " ", str(value)).strip()


def clock(value):
    if isinstance(value, dt.time):
        return value.strftime("%H:%M")
    if isinstance(value, dt.datetime):
        return value.strftime("%H:%M")
    found = re.match(r"(\d{1,2}):(\d{2})", text(value))
    return f"{int(found[1]):02d}:{found[2]}" if found else ""


def inline(line):
    """«Алгебра, доц. Скутин А.А., 1205» → предмет, преподаватель, аудитория."""
    parts = [part.strip() for part in line.split(",") if part.strip()]
    subject = parts[0] if parts else ""
    # Бывает и без запятых: «Алгебра доц. Тимашев Д.А.» — режем по должности.
    cut = TITLE.search(subject + " ")
    if cut and cut.start() > 0:
        parts = [subject[: cut.start()].strip(), subject[cut.start():].strip(), *parts[1:]]
        subject = parts[0]
    teacher = next((p for p in parts[1:] if TITLE.search(p + " ") or re.search(r"[А-ЯЁ]\.\s*[А-ЯЁ]\.", p)), "")
    room = next((p for p in parts[1:] if re.fullmatch(r"(?:ауд\.?\s*)?\d{2,4}[а-яА-Я]?(?:\s+\d{2,4})?", p)), "")
    return subject, teacher, re.sub(r"ауд\.?\s*", "", room)


# Не пары, а пометки в сетке — в расписание не идут.
SKIP = re.compile(r"день самостоятельной работы|военная подготовка\s*$^", re.I)
# Общие занятия без вида: физкультура и межфакультетские курсы.
PLAIN = re.compile(r"физическ|межфакультетск|физра", re.I)


def lesson(group, day, slot, start, end, subject, teacher, room, week, wide, note=""):
    kind = "лекция" if re.search(r"\(л\)|лекци", subject, re.I) or wide else "семинар"
    if PLAIN.search(subject):
        kind = ""
    subject = re.sub(r"\s*\((?:л|с|сем)\)\s*", " ", subject).strip(" ,")
    return {"group": group, "day": day, "slot": slot, "subgroup": None, "elective": None, "week": week, "note": note,
            "link": "", "start": start, "end": end, "type": kind, "subject": subject, "room": room, "teacher": teacher}


def read_sheet(sheet, course, level):
    header = None
    for r in range(1, 12):
        if sum(1 for c in range(3, min(sheet.max_column, 60) + 1) if re.fullmatch(r"\d{3}", text(sheet.cell(r, c).value))) >= 3:
            header = r
            break
    if not header:
        return [], [], []
    columns = {c: text(sheet.cell(header, c).value) for c in range(3, min(sheet.max_column, 60) + 1)
               if re.fullmatch(r"\d{3}", text(sheet.cell(header, c).value))}

    owner = {}
    for box in sheet.merged_cells.ranges:
        for r in range(box.min_row, box.max_row + 1):
            for c in range(box.min_col, box.max_col + 1):
                owner[(r, c)] = box
    def value(r, c):
        box = owner.get((r, c))
        return text(sheet.cell(box.min_row, box.min_col).value if box else sheet.cell(r, c).value)
    def width(r, c):
        box = owner.get((r, c))
        return sum(1 for col in columns if box.min_col <= col <= box.max_col) if box else 1

    lessons, bells = [], []
    day, slot, last_label = 0, 0, None
    r = header + 1
    while r <= sheet.max_row - 2:
        # Новый день — новая подпись в первом столбце (она тянется вниз
        # объединённой ячейкой, текст стоит только в её верхней строке).
        label = text(sheet.cell(r, 1).value)
        if label and (r, label) != last_label:
            day, slot, last_label = day + 1, 0, (r, label)
        start, end = clock(sheet.cell(r, 2).value), clock(sheet.cell(r + 2, 2).value)
        if not (day and start and end and text(sheet.cell(r + 1, 2).value).startswith("--")):
            r += 1
            continue
        slot += 1
        bells.append((slot, (start, end)))
        if day <= 6:
            for c, group in columns.items():
                top, mid, low = value(r, c), value(r + 1, c), value(r + 2, c)
                wide = width(r, c) >= 3
                if mid.startswith("~~"):
                    # Поделённая ячейка: сверху — нечётная неделя, снизу — чётная.
                    for line, week, mark in ((top, "odd", "по числителю"), (low, "even", "по знаменателю")):
                        if line:
                            subject, teacher, room = inline(line)
                            lessons.append(lesson(group, day, slot, start, end, subject, teacher, room, week, False, mark))
                elif top and top == mid == low:
                    subject, teacher, room = inline(top)
                    lessons.append(lesson(group, day, slot, start, end, subject, teacher, room, "all", wide))
                elif top:
                    lessons.append(lesson(group, day, slot, start, end, top, mid, re.sub(r"ауд\.?\s*", "", low), "all", wide))
        r += 3
    lessons = [item for item in lessons if item["subject"] and not SKIP.search(item["subject"])]
    groups = [{"id": name, "title": name, "course": course, "level": level} for name in columns.values()]
    return groups, bells, lessons


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("table", type=Path)
    parser.add_argument("--id", required=True)
    parser.add_argument("--university", required=True)
    parser.add_argument("--faculty", required=True)
    parser.add_argument("--from", dest="start", required=True)
    parser.add_argument("--to", dest="end", required=True)
    parser.add_argument("--level", default="специалитет")
    parser.add_argument("--first-week", choices=["odd", "even"], default="odd")
    args = parser.parse_args()
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{1,30}", args.id) or args.id == "msu-fgp":
        sys.exit("--id: латиница, цифры и дефис; msu-fgp занят")

    book = load_workbook(args.table, data_only=True)
    groups, lessons, spans = [], [], {}
    for sheet in book.worksheets:
        course = re.match(r"\s*(\d)\s*курс", sheet.title)
        if not course:
            continue
        sheet_groups, bells, sheet_lessons = read_sheet(sheet, int(course[1]), args.level)
        groups += sheet_groups
        lessons += sheet_lessons
        for slot, span in bells:
            spans.setdefault(slot, Counter())[span] += 1
        print(f"лист «{sheet.title}»: групп {len(sheet_groups)}, пар {len(sheet_lessons)}")
    if not lessons:
        sys.exit("Ни одной пары не разобрано.")

    bells = [{"n": n, "start": spans[n].most_common(1)[0][0][0], "end": spans[n].most_common(1)[0][0][1]} for n in sorted(spans)]
    start, end = dt.date.fromisoformat(args.start), dt.date.fromisoformat(args.end)
    weeks, cursor, parity = [], start, args.first_week
    while cursor <= end:
        sunday = cursor + dt.timedelta(days=6 - cursor.weekday())
        weeks.append({"from": cursor.isoformat(), "to": min(sunday, end).isoformat(), "parity": parity})
        cursor, parity = sunday + dt.timedelta(days=1), ("even" if parity == "odd" else "odd")

    schedule = {
        "meta": {"updated": dt.date.today().isoformat(), "semester": "", "faculty": f"{args.faculty} {args.university}",
                 "period": {"from": start.strftime("%d.%m.%Y"), "to": end.strftime("%d.%m.%Y")}},
        "weeks": weeks, "bells": bells, "groups": groups,
        "lessons": sorted(lessons, key=lambda l: (l["group"], l["day"], l["slot"])),
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
    print(f"Итого: групп {len(groups)}, пар {len(lessons)}, записано в docs/data/{args.id}/")


if __name__ == "__main__":
    main()
