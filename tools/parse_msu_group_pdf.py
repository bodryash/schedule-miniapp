"""«Расписание группы» из личного кабинета МГУ (PDF) — в папку факультета.

Кабинет отдаёт расписание группы на несколько недель вперёд: строки — день
и пара, столбцы — даты этого дня недели. Ячейка: «УгПр [Сем] / ауд. 231Б /
Степанов В.В.», иногда впереди своё время («12:30-14:00»). Предметы
сокращены, расшифровку даём файлом --names (JSON: {"УгПр": "Уголовное право"}).

Недели в файле почти одинаковые, поэтому расписание сворачивается в
недельное: пара на всех неделях — «каждую неделю», через одну — по чётности,
а то, что не укладывается, остаётся по датам.

    python tools/parse_msu_group_pdf.py группа.pdf --id msu-law \\
        --faculty "Юридический факультет" --short Юрфак --course 2 \\
        --names names.json --from 2026-09-01 --to 2026-12-26
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

DAYS = {"Пн": 1, "Вт": 2, "Ср": 3, "Чт": 4, "Пт": 5, "Сб": 6, "Вс": 7}
KINDS = {"Лк": "лекция", "Сем": "семинар", "Лб": "практика", "Пз": "практика"}
SLOT = re.compile(r"(\d)\s*пара\s+(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})")
OWN = re.compile(r"^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$")
HEAD = re.compile(r"^(.+?)\s*\[(\w+)\]$")


def read_pdf(path):
    """Строки таблиц со всех страниц подряд: таблица рвётся где попало."""
    rows = []
    title = ""
    with pdfplumber.open(path) as pdf:
        for page in pdf.pages:
            if not title:
                found = re.search(r"Расписание группы:\s*(\S+)", page.extract_text() or "")
                title = found[1] if found else ""
            for table in page.extract_tables():
                rows += [[(cell or "").strip() for cell in row] for row in table]
    return title, rows


def parse_cell(text, names, unknown):
    lines = [line.strip() for line in text.split("\n") if line.strip()]
    own = None
    if lines and OWN.match(lines[0]):
        m = OWN.match(lines.pop(0))
        own = (f"{int(m[1]):02d}:{m[2]}", f"{int(m[3]):02d}:{m[4]}")
    if not lines:
        return None
    head = HEAD.match(lines[0])
    if not head or head[2] not in KINDS:
        return None
    short = head[1].strip()
    if short not in names:
        unknown.add(short)
    room, teacher = "", ""
    for line in lines[1:]:
        if line.startswith("ауд."):
            room = line[4:].strip()
        else:
            teacher = line
    return {"subject": names.get(short, short), "type": KINDS[head[2]], "room": room, "teacher": teacher, "own": own}


def main():
    parser = argparse.ArgumentParser(description="Расписание группы из кабинета МГУ (PDF)")
    parser.add_argument("pdf", type=Path)
    parser.add_argument("--id", required=True)
    parser.add_argument("--university", default="МГУ")
    parser.add_argument("--faculty", required=True)
    parser.add_argument("--short", default="")
    parser.add_argument("--course", type=int, default=1)
    parser.add_argument("--level", default="бакалавриат")
    parser.add_argument("--names", type=Path, help="JSON с расшифровкой сокращений предметов")
    parser.add_argument("--subgroups", type=Path, help='JSON: {"Английский язык": {"Мельникова Н.В.": 1}} — подгруппа по преподавателю')
    parser.add_argument("--from", dest="start", required=True)
    parser.add_argument("--to", dest="end", required=True)
    parser.add_argument("--first-week", choices=["odd", "even"], default="odd")
    args = parser.parse_args()
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{1,30}", args.id) or args.id == "msu-fgp":
        sys.exit("--id: латиница, цифры и дефис; msu-fgp занят")
    names = json.loads(args.names.read_text(encoding="utf-8")) if args.names else {}
    subgroups = json.loads(args.subgroups.read_text(encoding="utf-8")) if args.subgroups else {}

    group, rows = read_pdf(args.pdf)
    if not group:
        sys.exit("В PDF нет строки «Расписание группы: …».")

    start, end = date.fromisoformat(args.start), date.fromisoformat(args.end)
    weeks, cursor, parity = [], start, args.first_week
    while cursor <= end:
        sunday = cursor + timedelta(days=6 - cursor.weekday())
        weeks.append({"from": cursor.isoformat(), "to": min(sunday, end).isoformat(), "parity": parity})
        cursor, parity = sunday + timedelta(days=1), ("even" if parity == "odd" else "odd")
    parity_of = lambda iso: next((w["parity"] for w in weeks if w["from"] <= iso <= w["to"]), None)

    bells, unknown, unread = {}, set(), []
    seen = defaultdict(list)  # (день, пара, ячейка) → даты
    taught = defaultdict(set)  # день → даты, когда в этот день вообще были пары
    day, dates = 0, []
    for row in rows:
        if row[0] in DAYS:
            day = DAYS[row[0]]
            dates = [date(int(c[6:10]), int(c[3:5]), int(c[0:2])).isoformat() if re.fullmatch(r"\d\d\.\d\d\.\d{4}", c) else None for c in row[1:]]
            continue
        slot = SLOT.search(row[0].replace("\n", " "))
        if not day or not slot:
            continue
        n = int(slot[1])
        bells[n] = (f"{int(slot[2]):02d}:{slot[3]}", f"{int(slot[4]):02d}:{slot[5]}")
        for when, text in zip(dates, row[1:]):
            if not when or not text:
                continue
            cell = parse_cell(text, names, unknown)
            if not cell:
                unread.append((when, n, text.replace("\n", " / ")))
                continue
            taught[day].add(when)
            seen[(day, n, json.dumps(cell, ensure_ascii=False, sort_keys=True))].append(when)

    for when, n, text in unread:
        print(f"не разобрал ячейку {when}, {n} пара: {text}", file=sys.stderr)
    if unknown:
        print("нет расшифровки для: " + ", ".join(sorted(unknown)), file=sys.stderr)
    if unread or unknown or not seen:
        sys.exit("Разобрано не всё — ничего не записываю.")

    lessons = []
    for (day, n, raw), when in sorted(seen.items()):
        cell = json.loads(raw)
        own = cell.pop("own")
        lesson = {
            "group": group, "day": day, "slot": n,
            "subgroup": subgroups.get(cell["subject"], {}).get(cell["teacher"]), "elective": None,
            "week": "all", "note": "", "link": "",
            "start": own[0] if own else bells[n][0], "end": own[1] if own else bells[n][1], **cell,
        }
        parities = {parity_of(d) for d in when}
        if set(when) == taught[day]:
            pass  # каждую неделю
        elif len(parities) == 1 and set(when) == {d for d in taught[day] if parity_of(d) in parities}:
            lesson["week"] = parities.pop()
        else:
            lesson["dates"] = sorted(when)  # не укладывается в недели — как есть, по датам
        lessons.append(lesson)

    # Занятие со своим временем на две пары («14:45-18:00») записано в обе
    # строки — оставляем одно, в первой из них.
    once, kept = set(), []
    for lesson in sorted(lessons, key=lambda l: (l["day"], l["slot"])):
        key = (lesson["day"], lesson["subject"], lesson["start"], lesson["end"], lesson["teacher"], lesson["room"], lesson["week"])
        if key not in once:
            once.add(key)
            kept.append(lesson)
    lessons = kept

    groups = [{"id": group, "title": group, "course": args.course, "level": args.level}]
    schedule = {
        "meta": {"updated": date.today().isoformat(), "semester": "", "faculty": f"{args.faculty} {args.university}",
                 "period": {"from": start.strftime("%d.%m.%Y"), "to": end.strftime("%d.%m.%Y")}},
        "weeks": weeks,
        "bells": [{"n": n, "start": bells[n][0], "end": bells[n][1]} for n in sorted(bells)],
        "groups": groups,
        "lessons": sorted(lessons, key=lambda l: (l["group"], l["day"], l["start"], l["slot"])),
    }

    # Другие группы факультета, подключённые раньше, остаются на месте.
    folder = DATA / args.id
    folder.mkdir(parents=True, exist_ok=True)
    target = folder / "schedule.json"
    if target.exists():
        old = json.loads(target.read_text(encoding="utf-8"))
        schedule["groups"] = [g for g in old.get("groups", []) if g["id"] != group] + groups
        schedule["lessons"] = sorted(
            [l for l in old.get("lessons", []) if l["group"] != group] + lessons,
            key=lambda l: (l["group"], l["day"], l["start"], l["slot"]),
        )
        known = {b["n"] for b in schedule["bells"]}
        schedule["bells"] = sorted(schedule["bells"] + [b for b in old.get("bells", []) if b["n"] not in known], key=lambda b: b["n"])
    dump = lambda value: json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    target.write_text(dump(schedule), encoding="utf-8")
    (folder / "groups.json").write_text(dump(schedule["groups"]), encoding="utf-8")

    registry = DATA / "tenants.json"
    tenants = json.loads(registry.read_text(encoding="utf-8"))
    keep = next((t for t in tenants if t["id"] == args.id), {})
    entry = {**keep, "id": args.id, "university": args.university, "faculty": args.faculty, "path": args.id,
             "features": keep.get("features", [])}
    if args.short or keep.get("short"):
        entry["short"] = keep.get("short") or args.short
    registry.write_text(json.dumps([t for t in tenants if t["id"] != args.id] + [entry], ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    dated = sum(1 for l in lessons if "dates" in l)
    print(f"Группа {group}: пар {len(lessons)} (по датам {dated}), записано в docs/data/{args.id}/")


if __name__ == "__main__":
    main()
