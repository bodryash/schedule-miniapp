"""Расписание по датам из текстовой таблицы — в папку факультета.

Для вузов, где у каждой пары свои числа («28.09-19.10», «09.11, 23.11»), а
расписание существует только сканом. Скан переносится руками в текстовый
файл (образец — tools/data/oren_msal_1course.txt), этот скрипт разворачивает
диапазоны в даты и проверяет, что каждая дата приходится на свой день
недели: так ловятся ошибки чтения скана.

    python tools/import_dated.py tools/data/файл.txt --id oimsal-nb \\
        --university "…" --faculty "…" --groups "1=ОИ26-О-СПЕЦ-1,2=…" \\
        --from 2026-09-14 --to 2027-02-02 --bells "09:00-10:20,…" --skip 2026-11-04
"""

import argparse
import json
import re
import sys
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "docs" / "data"
DAYS = {"пн": 1, "вт": 2, "ср": 3, "чт": 4, "пт": 5, "сб": 6}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("table", type=Path)
    parser.add_argument("--id", required=True)
    parser.add_argument("--university", required=True)
    parser.add_argument("--faculty", required=True)
    parser.add_argument("--groups", required=True, help="1=ИМЯ,2=ИМЯ — что значат номера в первом столбце")
    parser.add_argument("--course", type=int, default=1)
    parser.add_argument("--level", default="специалитет")
    parser.add_argument("--from", dest="start", required=True)
    parser.add_argument("--to", dest="end", required=True)
    parser.add_argument("--bells", required=True)
    parser.add_argument("--skip", default="", help="праздничные дни через запятую: в диапазонах их пропускаем")
    args = parser.parse_args()

    start, end = date.fromisoformat(args.start), date.fromisoformat(args.end)
    names = dict(pair.split("=") for pair in args.groups.split(","))
    skip = {date.fromisoformat(d) for d in args.skip.split(",") if d}
    bells = []
    for n, pair in enumerate(args.bells.split(","), 1):
        begin, finish = pair.split("-")
        bells.append({"n": n, "start": begin, "end": finish})

    def day_of(text):
        d, m = map(int, text.split("."))
        # Семестр переходит через Новый год: январь–июль — уже следующий год.
        return date(start.year + (1 if m < start.month else 0), m, d)

    lessons, problems = [], []
    for number, line in enumerate(args.table.read_text(encoding="utf-8").splitlines(), 1):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        parts = [p.strip() for p in line.split("|")]
        if len(parts) != 7:
            problems.append(f"строка {number}: столбцов {len(parts)}, нужно 7")
            continue
        who, day_name, slot, subject, teacher, room, spec = parts
        day, slot = DAYS.get(day_name), int(slot)
        dates = []
        for piece in [p.strip() for p in spec.split(",") if p.strip()]:
            if "-" in piece:
                first, last = map(day_of, piece.split("-"))
                if last < first or (last - first).days % 7:
                    problems.append(f"строка {number}: диапазон {piece} не кратен неделе")
                    continue
                cursor = first
                while cursor <= last:
                    if cursor not in skip:
                        dates.append(cursor)
                    cursor += timedelta(days=7)
            else:
                dates.append(day_of(piece))
        for value in dates:
            if value.isoweekday() != day:
                problems.append(f"строка {number}: {value:%d.%m.%Y} — не {day_name} ({subject})")
            if not start <= value <= end:
                problems.append(f"строка {number}: {value:%d.%m.%Y} вне семестра")
        if not 1 <= slot <= len(bells) or not day or not dates:
            problems.append(f"строка {number}: нет пары, дня или дат")
            continue
        for key in (names if who == "*" else [who]):
            if key not in names:
                problems.append(f"строка {number}: неизвестная группа {key}")
                continue
            lessons.append({
                "group": names[key], "day": day, "slot": slot, "subgroup": None, "elective": None, "week": "all",
                "note": "поток" if who == "*" else "", "link": "", "start": "", "end": "", "type": "",
                "subject": subject, "room": room, "teacher": teacher, "dates": sorted({d.isoformat() for d in dates}),
            })
    if problems:
        print("\n".join(problems), file=sys.stderr)
        sys.exit(f"Ошибок: {len(problems)} — расписание не записано.")

    groups = [{"id": name, "title": name, "course": args.course, "level": args.level} for name in names.values()]
    weeks, cursor, parity = [], start, "odd"
    while cursor <= end:
        sunday = cursor + timedelta(days=6 - cursor.weekday())
        weeks.append({"from": cursor.isoformat(), "to": min(sunday, end).isoformat(), "parity": parity})
        cursor, parity = sunday + timedelta(days=1), ("even" if parity == "odd" else "odd")
    schedule = {
        "meta": {"updated": date.today().isoformat(), "semester": "", "faculty": f"{args.faculty} {args.university}", "dated": True,
                 "period": {"from": start.strftime("%d.%m.%Y"), "to": end.strftime("%d.%m.%Y")}},
        "weeks": weeks, "bells": bells, "groups": groups,
        "lessons": sorted(lessons, key=lambda l: (l["group"], l["day"], l["slot"], l["dates"][0])),
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
    total = sum(len(l["dates"]) for l in lessons)
    print(f"{args.university}, {args.faculty}: групп {len(groups)}, строк расписания {len(lessons)}, занятий по датам {total}")


if __name__ == "__main__":
    main()
