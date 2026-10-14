"""Высшая школа телевидения МГУ: расписание из общей Google-таблицы.

Таблица ведётся по неделям: на каждую неделю свой лист, внутри — дни
(строка с названием дня и датой) и пары строками «время, группа, аудитория,
предмет, преподаватель, …». Группа записана по-разному: «101 гр.» — одна
группа, «1 бак» — весь курс, «1 бак В» — языковая (актёрская) подгруппа
курса, «1 бак КНР» — студенты из Китая, «201 гр.+КНР», «1,2 бак,1 маг».

В приложении группа бакалавриата — номер и буква подгруппы: «101 · В»
получает пары 101-й группы, всего 1 курса и подгруппы В. Студенты из Китая —
отдельная группа «1 бак КНР». Магистратуру пока не разбираем.

Ссылки на онлайн-встречи из таблицы не публикуем. Отменённые пары
(«отмена») пропускаем.

Запуск (так же зовёт ночная проверка):

    python tools/sync_tv.py --base <id таблицы> --id msu-tv --university МГУ \\
        --name "Высшая школа телевидения" --from 2026-09-01 --to 2026-12-31
"""

import argparse
import io
import json
import re
import sys
import urllib.request
from collections import defaultdict
from datetime import date, datetime, time, timedelta
from pathlib import Path

import openpyxl

DATA = Path(__file__).resolve().parent.parent / "docs" / "data"
BELLS = ["09:00", "10:40", "13:00", "14:40", "16:20", "18:00", "19:40"]
LETTERS = ("А", "Б", "В")


def clock(value):
    """«9.00», «09.00», «16:20:00», time(10, 40) → «09:00»."""
    if isinstance(value, (time, datetime)):
        return f"{value.hour:02d}:{value.minute:02d}"
    found = re.match(r"^\s*(\d{1,2})[.:](\d{2})", str(value or ""))
    if not found or not 7 <= int(found[1]) <= 21:
        return ""
    return f"{int(found[1]):02d}:{found[2]}"


def plus(start, minutes):
    total = int(start[:2]) * 60 + int(start[3:]) + minutes
    return f"{total // 60:02d}:{total % 60:02d}"


def slot_of(start):
    """Номер пары по звонку; время не по звонку — ближайшая пара."""
    minutes = int(start[:2]) * 60 + int(start[3:])
    return min(range(len(BELLS)), key=lambda n: abs(int(BELLS[n][:2]) * 60 + int(BELLS[n][3:]) - minutes)) + 1


def text(value):
    if value is None:
        return ""
    if isinstance(value, float) and value.is_integer():
        value = int(value)
    return re.sub(r"\s+", " ", str(value)).strip()


def audience(label):
    """Кому пара: набор меток — «гр:101», «курс:1», «буква:1:В», «кнр:1»."""
    label = text(label).replace("гр.", "гр").replace(" ", " ")
    marks = set()
    for number in re.findall(r"\b([1-4]0\d)\s*гр\b", label):
        marks.add(f"гр:{number}")
    if re.search(r"\+\s*КНР", label):
        for number in re.findall(r"\b([1-4])0\d\s*гр\b", label):
            marks.add(f"кнр:{number}")
    # «1,2 бак,1 маг» — несколько курсов сразу.
    listed = re.match(r"^([1-4](?:\s*,\s*[1-4])*)\s*бак\b\s*(.*)$", label)
    if listed:
        letter = re.match(r"^(КНР|[АБВ])(?![А-Яа-я])", listed[2].strip())
        for course in re.findall(r"[1-4]", listed[1]):
            if not letter:
                marks.add(f"курс:{course}")
            elif letter[1] == "КНР":
                marks.add(f"кнр:{course}")
            else:
                marks.add(f"буква:{course}:{letter[1]}")
    return marks


def sheets_in(book, start, end):
    """Дни таблицы: дата → строки пар. Если неделя повторяется на нескольких
    листах (копии), верна последняя по порядку."""
    days = {}
    for sheet in reversed(book.worksheets):
        current, rows = None, defaultdict(list)
        for row in sheet.iter_rows(values_only=True):
            cells = list(row) + [None] * 8
            stamp = next((c for c in cells[:6] if isinstance(c, datetime)), None)
            if stamp and not clock(cells[0]):
                current = stamp.date()
                continue
            if current and clock(cells[0]) and cells[1] and cells[3]:
                rows[current].append(cells)
        for day, found in rows.items():
            if start <= day <= end and day not in days:
                days[day] = found
    return days


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", required=True, help="id Google-таблицы")
    parser.add_argument("--faculty", default="all", help="не используется")
    parser.add_argument("--id", required=True)
    parser.add_argument("--university", required=True)
    parser.add_argument("--name", required=True)
    parser.add_argument("--from", dest="start", required=True)
    parser.add_argument("--to", dest="end", required=True)
    parser.add_argument("--file", type=Path, help="готовый .xlsx вместо скачивания — для проверки")
    args = parser.parse_args()
    start, end = date.fromisoformat(args.start), date.fromisoformat(args.end)

    if args.file:
        raw = args.file.read_bytes()
    else:
        url = f"https://docs.google.com/spreadsheets/d/{args.base}/export?format=xlsx"
        with urllib.request.urlopen(url, timeout=120) as answer:
            raw = answer.read()
    book = openpyxl.load_workbook(io.BytesIO(raw), read_only=True, data_only=True)
    days = sheets_in(book, start, end)
    if not days:
        sys.exit("В таблице нет дней этого семестра — возможно, её переделали.")

    # Какие группы и подгруппы бывают на каждом курсе.
    numbers, letters, china = defaultdict(set), defaultdict(set), set()
    for rows in days.values():
        for cells in rows:
            label = text(cells[1])
            for number in re.findall(r"\b([1-4]0\d)\s*гр", label):
                numbers[number[0]].add(number)
            for course, letter in re.findall(r"^([1-4])\s*бак\s+(КНР|[АБВ])\b", label):
                (china.add(course) if letter == "КНР" else letters[course].add(letter))

    groups, members = [], {}
    for course in sorted(numbers):
        for number in sorted(numbers[course]):
            for letter in sorted(letters[course]) or [""]:
                name = f"{number} · {letter}" if letter else number
                members[name] = {f"гр:{number}", f"курс:{course}", f"буква:{course}:{letter}"}
                groups.append({"id": name, "title": name, "course": int(course), "level": "бакалавриат"})
        if course in china:
            name = f"{course} бак КНР"
            members[name] = {f"курс:{course}", f"кнр:{course}"}
            groups.append({"id": name, "title": name, "course": int(course), "level": "бакалавриат"})

    merged = defaultdict(list)
    for day, rows in days.items():
        if day.isoweekday() > 6:
            continue
        for cells in rows:
            if "отмен" in " ".join(text(c).lower() for c in cells[5:9]):
                continue
            begin = clock(cells[0])
            subject = text(cells[3])
            if not begin or not subject:
                continue
            marks = audience(cells[1])
            room = re.sub(r"\.0\b", "", text(cells[2]))
            teacher = text(cells[4])
            for name, wanted in members.items():
                if marks & wanted:
                    merged[(name, day.isoweekday(), begin, subject, teacher, room)].append(day.isoformat())

    lessons = []
    for (name, weekday, begin, subject, teacher, room), dates in merged.items():
        slot = slot_of(begin)
        own = begin != BELLS[slot - 1]
        lessons.append({
            "group": name, "day": weekday, "slot": slot, "subgroup": None, "elective": None, "week": "all",
            "note": "", "link": "", "start": begin if own else "", "end": plus(begin, 90) if own else "", "type": "",
            "subject": subject, "room": room, "teacher": teacher, "dates": sorted(set(dates)),
        })
    if not lessons:
        sys.exit("Ни одной пары не получено.")
    groups = [g for g in groups if any(l["group"] == g["id"] for l in lessons)]
    groups.sort(key=lambda g: g["id"])
    lessons.sort(key=lambda l: (l["group"], l["day"], l["slot"], l["dates"][0]))

    weeks, cursor, parity = [], start, "odd"
    while cursor <= end:
        sunday = cursor + timedelta(days=6 - cursor.weekday())
        weeks.append({"from": cursor.isoformat(), "to": min(sunday, end).isoformat(), "parity": parity})
        cursor, parity = sunday + timedelta(days=1), ("even" if parity == "odd" else "odd")
    schedule = {
        "meta": {"updated": date.today().isoformat(), "semester": "", "faculty": f"{args.name} {args.university}", "dated": True,
                 "period": {"from": start.strftime("%d.%m.%Y"), "to": end.strftime("%d.%m.%Y")}},
        "weeks": weeks, "bells": [{"n": n + 1, "start": b, "end": plus(b, 90)} for n, b in enumerate(BELLS)],
        "groups": groups, "lessons": lessons,
    }

    folder = DATA / args.id
    folder.mkdir(parents=True, exist_ok=True)
    target = folder / "schedule.json"
    if target.exists():
        old = json.loads(target.read_text(encoding="utf-8"))
        if old.get("lessons") == lessons and old.get("groups") == groups:
            print(f"{args.id}: без изменений")
            return
        if len(groups) < 0.7 * len(old.get("groups", [])):
            sys.exit(f"{args.id}: групп стало {len(groups)} вместо {len(old['groups'])} — не записываю.")
    dump = lambda value: json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    target.write_text(dump(schedule), encoding="utf-8")
    (folder / "groups.json").write_text(dump(groups), encoding="utf-8")
    registry = DATA / "tenants.json"
    tenants = json.loads(registry.read_text(encoding="utf-8"))
    keep = next((t for t in tenants if t["id"] == args.id), None)
    entry = {**(keep or {}), "id": args.id, "university": args.university, "faculty": args.name, "path": args.id,
             "features": (keep or {}).get("features", []), "source": {"kind": "tv", "base": args.base, "faculty": "all"}}
    # Место факультета в списке не меняем — иначе каждая ночь двигает файл.
    tenants = [entry if t["id"] == args.id else t for t in tenants] if keep else tenants + [entry]
    registry.write_text(json.dumps(tenants, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Итого: групп {len(groups)}, строк {len(lessons)}, дней {len(days)}, записано в docs/data/{args.id}/")


if __name__ == "__main__":
    main()
