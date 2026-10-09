"""Расписание-сетка из Excel (.xls) — в папку факультета.

Формат, в котором расписание ведут многие факультеты МГУ: лист на курс,
строки — день и время, столбцы — группы. Лекция на поток — объединённая
ячейка на несколько групп. В самой ячейке текстом: предмет, вид занятия,
преподаватель, аудитория; иногда впереди своё время («11:00-13:15 Физиология»).

    python tools/parse_grid_xls.py таблица.xls --id msu-ffm \\
        --university "МГУ" --faculty "Факультет фундаментальной медицины" \\
        --from 2026-09-01 --to 2026-12-26 --level специалитет

Время пар у таких факультетов своё на каждый день, поэтому каждая пара
несёт собственные начало и конец, а «звонки» — только порядок пар в дне.
"""

import argparse
import json
import re
import sys
from collections import Counter, defaultdict
from datetime import date, timedelta
from pathlib import Path

import xlrd

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "docs" / "data"

DAYS = {"понедельник": 1, "вторник": 2, "среда": 3, "четверг": 4, "пятница": 5, "суббота": 6}
TIME = r"(\d{1,2})[:.](\d{2})"
RANGE = re.compile(rf"{TIME}\s*[-–—]\s*{TIME}")
TITLES = r"(?:проф|доц|ст\.\s*преп|преп|асс|акад|д\.м\.н|к\.м\.н)\.?"
# «проф. В.Н. Николенко» и «проф. Баранов А.П.» — инициалы бывают с обеих сторон.
TEACHER = re.compile(
    rf"({TITLES})\s*((?:[А-ЯЁ]\.\s*[А-ЯЁ]\.\s*[А-ЯЁ][а-яё-]+)|(?:[А-ЯЁ][а-яё-]+\s+[А-ЯЁ]\.\s*[А-ЯЁ]\.?))",
    re.I,
)
BARE_TEACHER = re.compile(r"\b([А-ЯЁ][а-яё-]{2,})\s+([А-ЯЁ])\.\s*([А-ЯЁ])\.")
ROOM = re.compile(r"ауд\.?\s*([A-Za-zА-Яа-яЁё]?\s?\d+[A-Za-zА-Яа-яЁё]?)", re.I)
TYPES = [
    (re.compile(r"лекци", re.I), "лекция"),
    (re.compile(r"семинар", re.I), "семинар"),
    (re.compile(r"практикум", re.I), "практикум"),
    (re.compile(r"практ|пр\.\s*зан|\bПЗ\b", re.I), "практика"),
    (re.compile(r"лаб", re.I), "лабораторная"),
]


def clock(hours, minutes):
    return f"{int(hours):02d}:{minutes}"


def parse_range(text):
    match = RANGE.search(text or "")
    return (clock(match[1], match[2]), clock(match[3], match[4])) if match else None


def sentence(text):
    """«ФИЗИЧЕСКАЯ КУЛЬТУРА» → «Физическая культура»; обычный текст не трогаем."""
    text = re.sub(r"\s+", " ", text).strip(" ,.;:-–")
    letters = [ch for ch in text if ch.isalpha()]
    if letters and sum(ch.isupper() for ch in letters) / len(letters) > 0.7:
        text = text.lower()
        text = text[:1].upper() + text[1:]
        text = re.sub(r"\bмгу\b", "МГУ", text)
    text = re.sub(r"\bроссии\b", "России", text)
    return "НИР" if text.lower() == "нир" else text


def parse_cell(raw):
    text = re.sub(r"\s+", " ", str(raw)).strip()
    own = None
    lead = re.match(rf"\s*{TIME}\s*[-–—]\s*{TIME}\s*", text)
    if lead:
        own = (clock(lead[1], lead[2]), clock(lead[3], lead[4]))
        text = text[lead.end():]

    kind = next((name for pattern, name in TYPES if pattern.search(text)), "")

    teacher = ""
    found = TEACHER.search(text)
    if found:
        name = re.sub(r"\s+", " ", found[2]).strip()
        flipped = re.match(r"([А-ЯЁ])\.\s*([А-ЯЁ])\.\s*([А-ЯЁ][а-яё-]+)", name)
        if flipped:
            name = f"{flipped[3]} {flipped[1]}.{flipped[2]}."
        else:
            name = re.sub(r"([А-ЯЁ])\.\s*([А-ЯЁ])\.?$", r"\1.\2.", name)
        teacher = f"{found[1].rstrip('.').lower()}. {name}"
        text = text[: found.start()] + text[found.end():]
    else:
        bare = None
        for bare in BARE_TEACHER.finditer(text):
            pass
        if bare:
            teacher = f"{bare[1]} {bare[2]}.{bare[3]}."
            text = text[: bare.start()] + text[bare.end():]

    room = ""
    found = ROOM.search(text)
    if found:
        room = re.sub(r"\s+", "", found[1])
        text = text[: found.start()] + text[found.end():]

    # Предмет — до первой скобки или запятой; остальное — пометка (корпус,
    # «по 2 группы ч/нед»).
    cut = re.search(r"[,(]", text)
    subject = text[: cut.start()] if cut else text
    rest = text[cut.start():] if cut else ""
    # «Мединформатика 1 группа ч/нед» — про чередование, а не название.
    tail = re.search(r"\s+(?:по\s+)?\d+\s+групп\w*\s+ч/нед.*$", subject)
    if tail:
        rest = f", {tail[0].strip()}{rest}"
        subject = subject[: tail.start()]
    subject = sentence(subject)
    rest = re.sub(r"\((?:[^)]*(?:лекци|практ|семинар|пр\.\s*зан|ПЗ)[^)]*)\)", " ", rest, flags=re.I)
    note = sentence(re.sub(r"\s*,\s*(?=,|$)", "", re.sub(r"\s+", " ", rest)))
    note = re.sub(r"^[\s,.;]+|[\s,.;]+$", "", re.sub(r"\s*,\s*,+", ",", note))
    return {"subject": subject, "type": kind, "teacher": teacher, "room": room, "note": note, "own": own}


def read_sheet(sheet, course, level):
    header = next(
        (r for r in range(min(sheet.nrows, 12)) if sum("гр" in str(sheet.cell_value(r, c)) for c in range(min(sheet.ncols, 30))) >= 2),
        None,
    )
    if header is None:
        return [], []
    columns = {}
    for c in range(2, min(sheet.ncols, 40)):
        name = re.search(r"\d{2,4}\w*", str(sheet.cell_value(header, c)))
        if name:
            columns[c] = name[0]
        elif columns:
            break
    last_col = max(columns)

    merged = {}
    for r1, r2, c1, c2 in sheet.merged_cells:
        merged[(r1, c1)] = (r2, c2)
    covered = set()
    for (r1, c1), (r2, c2) in merged.items():
        for r in range(r1, r2):
            for c in range(c1, c2):
                if (r, c) != (r1, c1):
                    covered.add((r, c))

    # Строки занятий: день тянется вниз объединённой ячейкой, время — в каждой.
    rows = []
    day = 0
    for r in range(header + 1, sheet.nrows):
        label = str(sheet.cell_value(r, 0)).strip().lower()
        if label in DAYS:
            day = DAYS[label]
        elif label and (r, 0) not in covered:
            day = 0  # «ЗАЧЕТЫ:», «ЭКЗАМЕНЫ:» — расписание кончилось
        span = parse_range(str(sheet.cell_value(r, 1)))
        if day and span:
            rows.append((r, day, span))
    slots = {}
    counter = defaultdict(int)
    for r, day, span in rows:
        counter[day] += 1
        slots[r] = (day, counter[day], span)

    lessons = []
    for r, (day, slot, span) in slots.items():
        for c in columns:
            if (r, c) in covered:
                continue
            raw = str(sheet.cell_value(r, c)).strip()
            if not raw:
                continue
            r2, c2 = merged.get((r, c), (r + 1, c + 1))
            groups = [columns[col] for col in range(c, min(c2, last_col + 1)) if col in columns]
            cell = parse_cell(raw)
            if not cell["subject"] or not groups:
                continue
            start, end = cell["own"] or span
            # Ячейка на несколько строк вниз — пара длится до конца последней.
            if not cell["own"] and r2 - 1 in slots and r2 - 1 != r:
                end = slots[r2 - 1][2][1]
            for group in groups:
                lessons.append({
                    "group": group, "day": day, "slot": slot, "subgroup": None, "elective": None, "week": "all",
                    "note": cell["note"], "link": "", "start": start, "end": end, "type": cell["type"],
                    "subject": cell["subject"], "room": cell["room"], "teacher": cell["teacher"],
                })
    groups = [{"id": name, "title": name, "course": course, "level": level} for name in columns.values()]
    return groups, [(slot, span) for (_, slot, span) in slots.values()], lessons


def main():
    parser = argparse.ArgumentParser(description="Расписание-сетка из .xls")
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

    book = xlrd.open_workbook(args.table, formatting_info=True)
    groups, lessons, spans = [], [], defaultdict(Counter)
    for sheet in book.sheets():
        course = re.search(r"\d", sheet.name)
        found = read_sheet(sheet, int(course[0]) if course else 1, args.level)
        if not found or not found[0]:
            print(f"лист «{sheet.name}»: групп не нашёл, пропускаю", file=sys.stderr)
            continue
        sheet_groups, sheet_slots, sheet_lessons = found
        groups += sheet_groups
        lessons += sheet_lessons
        for slot, span in sheet_slots:
            spans[slot][span] += 1
        print(f"лист «{sheet.name}»: групп {len(sheet_groups)}, пар {len(sheet_lessons)}")
    if not lessons:
        sys.exit("Ни одной пары не разобрано.")

    # «Звонки» — самое частое время для каждой по счёту пары; точное время
    # каждая пара несёт сама.
    bells = [{"n": n, "start": spans[n].most_common(1)[0][0][0], "end": spans[n].most_common(1)[0][0][1]} for n in sorted(spans)]

    start, end = date.fromisoformat(args.start), date.fromisoformat(args.end)
    weeks, cursor, parity = [], start, args.first_week
    while cursor <= end:
        sunday = cursor + timedelta(days=6 - cursor.weekday())
        weeks.append({"from": cursor.isoformat(), "to": min(sunday, end).isoformat(), "parity": parity})
        cursor, parity = sunday + timedelta(days=1), ("even" if parity == "odd" else "odd")

    schedule = {
        "meta": {"updated": date.today().isoformat(), "semester": "", "faculty": f"{args.faculty} {args.university}",
                 "period": {"from": start.strftime("%d.%m.%Y"), "to": end.strftime("%d.%m.%Y")}},
        "weeks": weeks, "bells": bells, "groups": groups,
        "lessons": sorted(lessons, key=lambda l: (l["group"], l["day"], l["start"], l["slot"])),
    }
    folder = DATA / args.id
    folder.mkdir(parents=True, exist_ok=True)
    dump = lambda value: json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    (folder / "schedule.json").write_text(dump(schedule), encoding="utf-8")
    (folder / "groups.json").write_text(dump(groups), encoding="utf-8")

    registry = DATA / "tenants.json"
    tenants = json.loads(registry.read_text(encoding="utf-8"))
    keep = next((t for t in tenants if t["id"] == args.id), {})
    entry = {"id": args.id, "university": args.university, "faculty": args.faculty, "path": args.id, "features": keep.get("features", [])}
    registry.write_text(json.dumps([t for t in tenants if t["id"] != args.id] + [entry], ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Итого: групп {len(groups)}, пар {len(lessons)}, записано в docs/data/{args.id}/")


if __name__ == "__main__":
    main()
