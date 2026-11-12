"""Расписание группы из календаря .ics (например, МАИ — выгрузка «theproudswan») → docs/data/<id>/.
Группы добавляются к уже подключённым в этом же вузе.

    python tools/parse_ics.py файл.ics --id mai --group М6О-110БВ-26 --course 1 --university МАИ --faculty "Институт №6"
"""
import argparse, json, re
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
KIND = {"ЛК": "лекция", "ПЗ": "практика", "ЛР": "лабораторная", "ЭКЗ": "экзамен", "ЗАЧ": "зачёт", "КСР": "консультация"}


def main():
    a = argparse.ArgumentParser()
    a.add_argument("ics", type=Path); a.add_argument("--id", required=True); a.add_argument("--group", required=True)
    a.add_argument("--course", type=int, default=1); a.add_argument("--faculty", required=True)
    o = a.parse_args()
    text = o.ics.read_text(encoding="utf-8").replace("\r\n ", "").replace("\r", "")
    merged = {}
    for ev in re.findall(r"BEGIN:VEVENT\n(.*?)END:VEVENT", text, re.S):
        f = dict(re.findall(r"^([A-Z\-]+)(?:;[^:]*)?:(.*)$", ev, re.M))
        st, en = f["DTSTART"], f["DTEND"]
        d = date(int(st[:4]), int(st[4:6]), int(st[6:8]))
        start, end = f"{st[9:11]}:{st[11:13]}", f"{en[9:11]}:{en[11:13]}"
        kind, _, teacher = f.get("DESCRIPTION", "").partition(":")
        teacher = teacher.replace("\\,", ",").strip()
        room = f.get("LOCATION", "").replace("\\,", ",").strip()
        room = "" if room.startswith("--") else room
        subj = f["SUMMARY"].replace("\\,", ",").strip()
        typ = KIND.get(kind.strip(), kind.strip().lower())
        key = (d.isoweekday(), start, subj, typ, teacher, room)
        l = merged.setdefault(key, {"group": o.group, "day": d.isoweekday(), "slot": 0, "start": start, "end": end, "subject": subj, "type": typ,
                                    "teacher": teacher, "room": room, "dates": [], "subgroup": None, "elective": None, "week": "all", "note": "", "link": ""})
        l["dates"].append(d.isoformat())
    lessons = list(merged.values())
    out = ROOT / "docs" / "data" / o.id
    old = json.loads((out / "schedule.json").read_text(encoding="utf-8")) if (out / "schedule.json").exists() else {}
    keep = [l for l in old.get("lessons", []) if l["group"] != o.group]
    allL = keep + lessons
    starts = sorted({l["start"] for l in allL})
    bells = [{"n": i + 1, "start": s, "end": next(l["end"] for l in allL if l["start"] == s)} for i, s in enumerate(starts)]
    for l in allL:
        l["slot"] = starts.index(l["start"]) + 1
        l["dates"] = sorted(set(l["dates"]))
    groups = [g for g in old.get("groups", []) if g["id"] != o.group] + [{"id": o.group, "title": o.group, "course": o.course, "level": "бакалавриат"}]
    ds = sorted(d for l in allL for d in l["dates"])
    w, end, weeks, odd = date.fromisoformat(ds[0]), date.fromisoformat(ds[-1]), [], True
    w -= timedelta(days=w.weekday())
    while w <= end:
        weeks.append({"from": w.isoformat(), "to": (w + timedelta(days=6)).isoformat(), "parity": "odd" if odd else "even"}); w += timedelta(days=7); odd = not odd
    fmt = lambda s: f"{s[8:]}.{s[5:7]}.{s[:4]}"
    out.mkdir(parents=True, exist_ok=True)
    data = {"meta": {"updated": date.today().isoformat(), "semester": "1 семестр 2026/2027", "faculty": o.faculty, "dated": True, "period": {"from": fmt(ds[0]), "to": fmt(ds[-1])}},
            "weeks": weeks, "bells": bells, "groups": sorted(groups, key=lambda g: (g["course"], g["id"])), "lessons": allL}
    (out / "schedule.json").write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    (out / "groups.json").write_text(json.dumps(data["groups"], ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"строк {len(lessons)}, занятий {sum(len(l['dates']) for l in lessons)}, звонков {len(bells)}")


if __name__ == "__main__":
    main()
