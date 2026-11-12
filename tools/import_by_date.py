"""Расписание «по строкам с датой» (дата|время|предмет|вид|ауд|преподаватель) → docs/data/<id>/.
Одна группа; одинаковые пары в один день недели склеиваются в одну строку с датами.

    python tools/import_by_date.py tools/data/файл.txt --id X --group ИМЯ --course 1 --bells "08:30-10:00,…"
"""
import argparse, json
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
KIND = {"с": "семинар", "л": "лекция", "пр": "практика", "лаб": "лабораторная", "зач": "зачёт", "экз": "экзамен"}


def main():
    a = argparse.ArgumentParser()
    a.add_argument("table", type=Path); a.add_argument("--id", required=True); a.add_argument("--group", required=True)
    a.add_argument("--course", type=int, default=1); a.add_argument("--level", default="специалитет")
    a.add_argument("--faculty", required=True); a.add_argument("--year", type=int, default=2026)
    a.add_argument("--bells", required=True)
    o = a.parse_args()
    bells = [dict(n=i + 1, start=b.split("-")[0], end=b.split("-")[1]) for i, b in enumerate(o.bells.split(","))]
    by_start = {b["start"]: b for b in bells}
    merged = {}
    for line in o.table.read_text(encoding="utf-8").splitlines():
        if not line.strip() or line.startswith("#"):
            continue
        d, t, subj, kind, room, teacher = [x.strip() for x in line.split("|")]
        dd = date(o.year, int(d[3:5]), int(d[:2]))
        b = by_start[t]
        typ = KIND.get(kind, kind)
        key = (dd.isoweekday(), t, subj, typ, room, teacher)
        l = merged.setdefault(key, {"group": o.group, "day": dd.isoweekday(), "slot": b["n"], "start": b["start"], "end": b["end"], "subject": subj, "type": typ,
                                    "teacher": teacher, "room": room, "dates": [], "subgroup": None, "elective": None, "week": "all", "note": "", "link": ""})
        l["dates"].append(dd.isoformat())
    lessons = list(merged.values())
    ds = sorted(d for l in lessons for d in l["dates"])
    w, end, weeks, odd = date.fromisoformat(ds[0]), date.fromisoformat(ds[-1]), [], True
    w -= timedelta(days=w.weekday())
    while w <= end:
        weeks.append({"from": w.isoformat(), "to": (w + timedelta(days=6)).isoformat(), "parity": "odd" if odd else "even"}); w += timedelta(days=7); odd = not odd
    groups = [{"id": o.group, "title": o.group, "course": o.course, "level": o.level}]
    fmt = lambda s: f"{s[8:]}.{s[5:7]}.{s[:4]}"
    out = ROOT / "docs" / "data" / o.id; out.mkdir(parents=True, exist_ok=True)
    data = {"meta": {"updated": date.today().isoformat(), "semester": "1 семестр 2026/2027", "faculty": o.faculty, "dated": True, "period": {"from": fmt(ds[0]), "to": fmt(ds[-1])}},
            "weeks": weeks, "bells": bells, "groups": groups, "lessons": lessons}
    (out / "schedule.json").write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    (out / "groups.json").write_text(json.dumps(groups, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"строк {len(lessons)}, занятий {len(ds)}")


if __name__ == "__main__":
    main()
