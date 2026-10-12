"""Расписание филологического факультета МГУ из Excel (.xls) — в папку факультета.

Лист на курс: строки — день и пара («1 пара 09.00 10.30»), столбцы — группы,
шапка с группами повторяется перед каждым днём. Ячейка — одной строкой:
«ФрЯ Сем, ауд.1048,  доц. Олевская М.И.»; сокращения предметов расшифрованы
списком под таблицей. Общая для нескольких групп пара — объединённая ячейка.

Пара раз в две недели записана половиной ячейки: вторая половина — строка
из дефисов. Какая половина на какую неделю, в файле не сказано, поэтому
такие пары идут каждую неделю с пометкой «через неделю».

    python tools/parse_philol_xls.py таблица.xls --id msu-philol \\
        --from 2026-09-01 --to 2026-12-26
"""

import argparse
import json
import re
import sys
from datetime import date, timedelta
from pathlib import Path

import xlrd

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "docs" / "data"

DAYS = {"понедельник": 1, "вторник": 2, "среда": 3, "четверг": 4, "пятница": 5, "суббота": 6}
SLOT = re.compile(r"(\d)\s*пара\s+(\d{1,2})[.:](\d{2})\s+(\d{1,2})[.:](\d{2})")
KINDS = {"Лк": "лекция", "Сем": "семинар", "Пз": "практика", "Лаб": "лабораторная"}
CELL = re.compile(r"^(.*?)\s+(Лк|Сем|Пз|Лаб)\s*,\s*ауд\.\s*([^,]*),\s*(.*)$")
DASHES = re.compile(r"^-{5,}$")


def parse_part(text, legend):
    text = re.sub(r"\s+", " ", text).strip()
    found = CELL.match(text)
    if not found:
        return None
    subject = legend.get(found[1].strip(), found[1].strip())
    room = re.sub(r"^П\s+(\d+)$", r"П-\1", found[3].strip())
    teacher = re.sub(r"\s+", " ", found[4]).strip(" ,")
    return {"subject": subject, "type": KINDS[found[2]], "room": room, "teacher": teacher}


def read_sheet(sheet):
    header = next((r for r in range(min(sheet.nrows, 12)) if str(sheet.cell_value(r, 0)).strip() == "Время"), None)
    if header is None:
        return None
    columns = {}
    for c in range(2, sheet.ncols):
        name = str(sheet.cell_value(header, c)).strip()
        if re.match(r"\d{3}", name):
            columns[c] = name
        elif columns:
            break
    last_col = max(columns)

    # Расшифровка сокращений под таблицей: «ФрЯ -» | «Французский язык».
    legend = {}
    for r in range(header + 1, sheet.nrows):
        short = re.match(r"^(.+?)\s+-$", str(sheet.cell_value(r, 0)).strip())
        full = str(sheet.cell_value(r, 2)).strip()
        if short and full:
            legend[short[1]] = full

    merged, covered = {}, set()
    for r1, r2, c1, c2 in sheet.merged_cells:
        merged[(r1, c1)] = (r2, c2)
        for r in range(r1, r2):
            for c in range(c1, c2):
                if (r, c) != (r1, c1):
                    covered.add((r, c))

    lessons, bells, unread, day = [], {}, [], 0
    for r in range(header + 1, sheet.nrows):
        label = str(sheet.cell_value(r, 0)).strip().lower()
        if label in DAYS:
            day = DAYS[label]
        elif label and label != "время" and (r, 0) not in covered:
            break  # дальше — расшифровка сокращений
        slot = SLOT.search(str(sheet.cell_value(r, 1)))
        if not day or not slot:
            continue
        n = int(slot[1])
        start, end = f"{int(slot[2]):02d}:{slot[3]}", f"{int(slot[4]):02d}:{slot[5]}"
        bells[n] = (start, end)
        for c in columns:
            if (r, c) in covered:
                continue
            raw = str(sheet.cell_value(r, c)).strip()
            if not raw:
                continue
            c2 = merged.get((r, c), (r + 1, c + 1))[1]
            groups = [columns[col] for col in range(c, min(c2, last_col + 1)) if col in columns]
            lines = [line.strip() for line in raw.split("\n") if line.strip()]
            halved = any(DASHES.match(line) for line in lines)
            for line in lines:
                if DASHES.match(line):
                    continue
                part = parse_part(line, legend)
                if not part:
                    unread.append((r, c, line))
                    continue
                for group in groups:
                    lessons.append({
                        "group": group, "day": day, "slot": n, "subgroup": None, "elective": None, "week": "all",
                        "note": "через неделю" if halved else "", "link": "", "start": start, "end": end, **part,
                    })
    return list(columns.values()), bells, lessons, unread


def main():
    parser = argparse.ArgumentParser(description="Расписание филфака МГУ из .xls")
    parser.add_argument("table", type=Path)
    parser.add_argument("--id", required=True)
    parser.add_argument("--university", default="МГУ")
    parser.add_argument("--faculty", default="Филологический факультет")
    parser.add_argument("--short", default="Филфак")
    parser.add_argument("--course", type=int, default=1)
    parser.add_argument("--level", default="бакалавриат")
    parser.add_argument("--from", dest="start", required=True)
    parser.add_argument("--to", dest="end", required=True)
    parser.add_argument("--first-week", choices=["odd", "even"], default="odd")
    args = parser.parse_args()
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{1,30}", args.id) or args.id == "msu-fgp":
        sys.exit("--id: латиница, цифры и дефис; msu-fgp занят")

    book = xlrd.open_workbook(args.table, formatting_info=True)
    names, bells, lessons, unread = [], {}, [], []
    for sheet in book.sheets():
        found = read_sheet(sheet)
        if not found:
            print(f"лист «{sheet.name}»: шапки не нашёл, пропускаю", file=sys.stderr)
            continue
        names += found[0]
        bells.update(found[1])
        lessons += found[2]
        unread += found[3]
    for r, c, line in unread:
        print(f"не разобрал ячейку (строка {r + 1}, столбец {c + 1}): {line}", file=sys.stderr)
    if unread or not lessons:
        sys.exit("Разобрано не всё — ничего не записываю.")

    groups = [{"id": name, "title": name, "course": args.course, "level": args.level} for name in names]
    start, end = date.fromisoformat(args.start), date.fromisoformat(args.end)
    weeks, cursor, parity = [], start, args.first_week
    while cursor <= end:
        sunday = cursor + timedelta(days=6 - cursor.weekday())
        weeks.append({"from": cursor.isoformat(), "to": min(sunday, end).isoformat(), "parity": parity})
        cursor, parity = sunday + timedelta(days=1), ("even" if parity == "odd" else "odd")

    schedule = {
        "meta": {"updated": date.today().isoformat(), "semester": "", "faculty": f"{args.faculty} {args.university}",
                 "period": {"from": start.strftime("%d.%m.%Y"), "to": end.strftime("%d.%m.%Y")}},
        "weeks": weeks,
        "bells": [{"n": n, "start": bells[n][0], "end": bells[n][1]} for n in sorted(bells)],
        "groups": groups,
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
    entry = {**keep, "id": args.id, "university": args.university, "faculty": args.faculty, "path": args.id,
             "features": keep.get("features", []), "short": keep.get("short", args.short)}
    registry.write_text(json.dumps([t for t in tenants if t["id"] != args.id] + [entry], ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Итого: групп {len(groups)}, пар {len(lessons)}, записано в docs/data/{args.id}/")


if __name__ == "__main__":
    main()
