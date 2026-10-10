"""Расписание факультета из системы «РУЗ» — в папку приложения.

«РУЗ» — веб-расписание, на котором работают МГИМО и ряд других вузов. У него
открытый программный доступ: справочники факультетов и групп и расписание
группы на любой отрезок дат. Расписание там составлено по датам, а не по
чётным и нечётным неделям, поэтому каждая пара получает список своих дат.

    python tools/sync_ruz.py --base https://ruz.mgimo.ru --faculty 55 \\
        --id mgimo-mo-dip --university "МГИМО" \\
        --name "Факультет Международные отношения (Дип)" \\
        --from 2026-09-01 --to 2026-12-31

Запускать можно сколько угодно раз: папка факультета переписывается целиком.
"""

import argparse
import json
import re
import sys
import time
import urllib.request
from collections import Counter, defaultdict
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "docs" / "data"


def get(url):
    request = urllib.request.Request(url, headers={"User-Agent": "schedule-miniapp sync (bodryash.ru)"})
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.load(response)


def clean(value):
    return re.sub(r"\s+", " ", str(value or "")).strip()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", required=True)
    parser.add_argument("--faculty", type=int, required=True, help="facultyOid из /api/dictionary/faculties")
    parser.add_argument("--id", required=True)
    parser.add_argument("--university", required=True)
    parser.add_argument("--name", required=True)
    parser.add_argument("--from", dest="start", required=True)
    parser.add_argument("--to", dest="end", required=True)
    args = parser.parse_args()
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{1,30}", args.id) or args.id == "msu-fgp":
        sys.exit("--id: латиница, цифры и дефис; msu-fgp занят")
    start, end = date.fromisoformat(args.start), date.fromisoformat(args.end)

    listed = [g for g in get(f"{args.base}/api/dictionary/groups") if g.get("facultyOid") == args.faculty]
    # Кроме учебных групп в справочнике лежат «группы» под зачёты и потоки
    # по выбору — у них в названии семестр или вид контроля. Их не берём.
    # Учебная группа начинается с номера курса: «1МПКС (Дип)-03», «4МО(Дип)-01».
    study = [g for g in listed if re.match(r"\s*\d", g["number"]) and not re.search(r"сем\.|\((?:Зач|Экз|Диф)", g["number"])]
    print(f"групп на факультете: {len(listed)}, учебных: {len(study)}")

    groups, lessons, bells = [], [], defaultdict(Counter)
    for group in sorted(study, key=lambda g: g["number"]):
        name = clean(group["number"])
        if any(g["id"] == name for g in groups):  # в справочнике бывают двойники
            continue
        url = f"{args.base}/api/schedule/group/{group['groupOid']}?start={start:%Y.%m.%d}&finish={end:%Y.%m.%d}&lng=1"
        try:
            rows = get(url)
        except Exception as error:  # один сбойный запрос не должен ронять весь факультет
            print(f"  {name}: не загрузилось ({error})", file=sys.stderr)
            continue
        time.sleep(0.3)  # не торопим чужой сервер
        if not rows:
            continue
        merged = defaultdict(list)
        for row in rows:
            slot = int(row.get("lessonNumberStart") or 0)
            begin, finish = clean(row.get("beginLesson")), clean(row.get("endLesson"))
            if not slot or not begin:
                continue
            bells[slot][(begin, finish)] += 1
            room = clean(row.get("auditorium"))
            key = (int(row["dayOfWeek"]), slot, begin, finish, clean(row.get("discipline")), clean(row.get("kindOfWork")).lower(),
                   clean(row.get("lecturer_title") or row.get("lecturer")), room, clean(row.get("subGroup")))
            merged[key].append(row["date"].replace(".", "-"))
        for (day, slot, begin, finish, subject, kind, teacher, room, sub), dates in merged.items():
            if day > 6 or not subject:
                continue
            lessons.append({
                "group": name, "day": day, "slot": slot, "subgroup": None, "elective": None, "week": "all",
                "note": sub if sub and sub != name else "", "link": "", "start": begin, "end": finish, "type": kind,
                "subject": subject, "room": room, "teacher": teacher, "dates": sorted(set(dates)),
            })
        # В справочнике РУЗ: 0 — бакалавриат, 1 — магистратура.
        level = "магистратура" if group.get("kindEducation") == 1 else "бакалавриат"
        groups.append({"id": name, "title": name, "course": int(group.get("course") or 1), "level": level})
        print(f"  {name}: занятий {len(rows)}")

    if not lessons:
        sys.exit("Ни одной пары не получено.")
    bell_list = [{"n": n, "start": bells[n].most_common(1)[0][0][0], "end": bells[n].most_common(1)[0][0][1]} for n in sorted(bells)]
    # Недели нужны приложению для полосы дней и счёта семестра; чётность
    # здесь ничего не решает — у каждой пары свои даты.
    from datetime import timedelta
    weeks, cursor, parity = [], start, "odd"
    while cursor <= end:
        sunday = cursor + timedelta(days=6 - cursor.weekday())
        weeks.append({"from": cursor.isoformat(), "to": min(sunday, end).isoformat(), "parity": parity})
        cursor, parity = sunday + timedelta(days=1), ("even" if parity == "odd" else "odd")

    schedule = {
        "meta": {"updated": date.today().isoformat(), "semester": "", "faculty": f"{args.name} {args.university}", "dated": True,
                 "period": {"from": start.strftime("%d.%m.%Y"), "to": end.strftime("%d.%m.%Y")}},
        "weeks": weeks, "bells": bell_list, "groups": groups,
        "lessons": sorted(lessons, key=lambda l: (l["group"], l["day"], l["slot"], l["dates"][0])),
    }
    folder = DATA / args.id
    folder.mkdir(parents=True, exist_ok=True)
    dump = lambda value: json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    # Пары не изменились — файл не трогаем: иначе из-за одной даты
    # обновления расписание публиковалось бы каждую ночь.
    target = folder / "schedule.json"
    if target.exists():
        old = json.loads(target.read_text(encoding="utf-8"))
        if old.get("lessons") == schedule["lessons"] and old.get("groups") == groups:
            print(f"{args.id}: без изменений")
            return
    target.write_text(dump(schedule), encoding="utf-8")
    (folder / "groups.json").write_text(dump(groups), encoding="utf-8")
    registry = DATA / "tenants.json"
    tenants = json.loads(registry.read_text(encoding="utf-8"))
    keep = next((t for t in tenants if t["id"] == args.id), {})
    entry = {**keep, "id": args.id, "university": args.university, "faculty": args.name, "path": args.id, "features": keep.get("features", []),
             "source": {"kind": "ruz", "base": args.base, "faculty": args.faculty}}
    registry.write_text(json.dumps([t for t in tenants if t["id"] != args.id] + [entry], ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Итого: групп {len(groups)}, пар {len(lessons)}, записано в docs/data/{args.id}/")


if __name__ == "__main__":
    main()
