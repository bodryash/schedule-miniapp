"""Расписание НИУ «МЭИ» с открытого сервиса ts.mpei.ru — в таблицу для import_table.py.

У МЭИ расписание по датам: на каждую неделю своё. Берём весь семестр по
каждой группе и складываем одинаковые пары (день, время, предмет, вид,
аудитория, преподаватель, подгруппа) в одну строку со списком дат.

    python tools/fetch_mpei.py groups.json out.csv --from 2026.09.01 --to 2026.12.31

groups.json — {"ИЭ-26-25": 21621, …} (id групп из ts.mpei.ru/api/search).
"""

import argparse
import csv
import json
import re
import sys
import time
import urllib.request
from collections import defaultdict

API = "https://ts.mpei.ru/api/schedule/group/{id}?start={start}&finish={finish}&lng=1"
KINDS = {"лекция": "лекция", "практическое занятие": "семинар", "лабораторная работа": "лабораторная"}
DAYS = {1: "пн", 2: "вт", 3: "ср", 4: "чт", 5: "пт", 6: "сб", 7: "вс"}


def course_level(name):
    """ИЭ-26-25: год набора 2025 → 2 курс (семестр осени 2026). «м» — магистратура."""
    m = re.search(r"-\d+(м?)[а-я]?-(\d{2})$", name)
    if not m:
        return 1, "бакалавриат"
    course = 26 - int(m.group(2)) + 1
    return course, "магистратура" if m.group(1) else "бакалавриат"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("groups")
    parser.add_argument("out")
    parser.add_argument("--from", dest="start", default="2026.09.01")
    parser.add_argument("--to", dest="finish", default="2026.12.31")
    args = parser.parse_args()
    groups = json.load(open(args.groups, encoding="utf-8"))
    rows = defaultdict(list)
    kept = 0
    for name, gid in sorted(groups.items()):
        url = API.format(id=gid, start=args.start, finish=args.finish)
        try:
            lessons = json.load(urllib.request.urlopen(url, timeout=60))
        except Exception as error:
            print(f"{name}: не скачалось ({error})", file=sys.stderr)
            continue
        time.sleep(0.2)
        if not lessons:
            continue
        kept += 1
        course, level = course_level(name)
        for l in lessons:
            sub = re.search(r"\\(\d)п", l.get("subGroup") or "")
            kind = KINDS.get((l.get("kindOfWork") or "").strip().lower(), (l.get("kindOfWork") or "").lower())
            room = (l.get("auditorium") or "").strip()
            if room in ("-", "(-)"):
                room = ""
            if "спортзал" in room.lower() or "спортивн" in room.lower():
                room = "спортзал"
            key = (
                name, course, level, DAYS.get(l["dayOfWeek"], ""), l.get("lessonNumberStart") or 0,
                l["discipline"].strip(), kind, (l.get("lecturer") or "").strip(" -"),
                room, sub.group(1) if sub else "", l["beginLesson"], l["endLesson"],
            )
            d = l["date"].split(".")
            rows[key].append(f"{d[2]}.{d[1]}")
    with open(args.out, "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(["группа", "курс", "уровень", "день", "пара", "неделя", "предмет", "тип", "преподаватель", "аудитория", "подгруппа", "начало", "конец", "примечание", "даты"])
        for key, dates in sorted(rows.items()):
            name, course, level, day, slot, subject, kind, teacher, room, sub, start, end = key
            w.writerow([name, course, level, day, slot, "все", subject, kind, teacher, room, sub, start, end, "", ", ".join(sorted(set(dates), key=lambda s: (s[3:], s[:2])))])
    print(f"групп с парами: {kept}, строк: {len(rows)}", file=sys.stderr)


if __name__ == "__main__":
    main()
