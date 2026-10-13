"""Добавляет группы из простой таблицы к уже подключённому факультету.

Бывает, что факультет берётся с сайта целиком, а у нескольких групп там
пусто — их расписание присылают студенты. Такие группы вписываются сюда
вручную и помечаются «manual»: ночная выгрузка с сайта (sync_hist.py) их
сохраняет, а не стирает вместе с остальным.

Таблица (CSV): группы (через пробел — пара общая), день (пн…сб), пара,
предмет, тип, преподаватель, аудитория. Пары идут каждую неделю.

    python tools/add_manual_groups.py tools/data/msu_hist_art_1course.csv \\
        --id msu-hist --course 1
"""

import argparse
import csv
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "docs" / "data"
DAYS = {"пн": 1, "вт": 2, "ср": 3, "чт": 4, "пт": 5, "сб": 6}


def main():
    parser = argparse.ArgumentParser(description="Группы из таблицы — к подключённому факультету")
    parser.add_argument("table", type=Path)
    parser.add_argument("--id", required=True)
    parser.add_argument("--course", type=int, required=True)
    parser.add_argument("--level", default="бакалавриат")
    args = parser.parse_args()
    if args.id == "msu-fgp":
        sys.exit("msu-fgp не трогаем")
    target = DATA / args.id / "schedule.json"
    if not target.exists():
        sys.exit(f"Факультет {args.id} ещё не подключён.")
    schedule = json.loads(target.read_text(encoding="utf-8"))
    bells = {b["n"] for b in schedule["bells"]}

    lessons, names = [], []
    with args.table.open(encoding="utf-8", newline="") as source:
        for row in csv.DictReader(source):
            day, slot = DAYS.get(row["день"].strip().lower()), int(row["пара"])
            if not day or slot not in bells or not row["предмет"].strip():
                sys.exit(f"Не понял строку: {row}")
            for group in row["группы"].split():
                if group not in names:
                    names.append(group)
                lessons.append({
                    "group": group, "day": day, "slot": slot, "subgroup": None, "elective": None, "week": "all",
                    "note": "", "link": "", "start": "", "end": "", "type": row["тип"].strip(),
                    "subject": row["предмет"].strip(), "room": row["аудитория"].strip(), "teacher": row["преподаватель"].strip(),
                })
    taken = {g["id"] for g in schedule["groups"] if not g.get("manual")}
    clash = [name for name in names if name in taken]
    if clash:
        sys.exit("Такие группы уже есть на сайте факультета: " + ", ".join(clash))

    groups = [{"id": name, "title": name, "course": args.course, "level": args.level, "manual": True} for name in names]
    schedule["groups"] = sorted([g for g in schedule["groups"] if g["id"] not in names] + groups, key=lambda g: g["id"])
    schedule["lessons"] = [l for l in schedule["lessons"] if l["group"] not in names] + lessons
    schedule["lessons"].sort(key=lambda l: (l["group"], l["day"], l["slot"], (l.get("dates") or [""])[0]))
    dump = lambda value: json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    target.write_text(dump(schedule), encoding="utf-8")
    (DATA / args.id / "groups.json").write_text(dump(schedule["groups"]), encoding="utf-8")
    print(f"{args.id}: добавлено групп {len(names)}, пар {len(lessons)}")


if __name__ == "__main__":
    main()
