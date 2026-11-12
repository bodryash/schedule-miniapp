"""СПбГУ: выгрузка timetable.spbu.ru «Расписание студенческой группы» (xlsx) → docs/data/<id>/.
Даты: «14.09–21.09 (2)» — каждую неделю с по (столько раз), «05.10» — разово, через « / ».

    python tools/parse_spbu_xlsx.py файл.xlsx --id spbu-law --faculty "Юридический факультет"
"""
import argparse, json, re
from datetime import date, timedelta
from pathlib import Path
import openpyxl

ROOT = Path(__file__).resolve().parent.parent
DAYS = {"Понедельник": 1, "Вторник": 2, "Среда": 3, "Четверг": 4, "Пятница": 5, "Суббота": 6}
KIND = {"лекция": "лекция", "семинар": "семинар", "практическое занятие": "практика", "лабораторная работа": "лабораторная",
        "консультация": "консультация", "экзамен": "экзамен", "зачёт": "зачёт", "зачет": "зачёт"}


def d(s, y0):
    dd, mm = map(int, s.split("."))
    return date(y0 + (1 if mm < 8 else 0), mm, dd)


def dates(spec, y0):
    out = []
    for part in spec.split("/"):
        part = part.strip()
        m = re.match(r"(\d\d\.\d\d)\s*[–-]\s*(\d\d\.\d\d)", part)
        if m:
            x, e = d(m.group(1), y0), d(m.group(2), y0)
            while x <= e:
                out.append(x.isoformat()); x += timedelta(days=7)
        elif re.match(r"\d\d\.\d\d", part):
            out.append(d(part[:5], y0).isoformat())
    return out


def main():
    a = argparse.ArgumentParser(); a.add_argument("xlsx"); a.add_argument("--id", required=True); a.add_argument("--faculty", required=True)
    a.add_argument("--course", type=int, default=1); o = a.parse_args()
    out = ROOT / "docs" / "data" / o.id
    old = json.loads((out / "schedule.json").read_text()) if (out / "schedule.json").exists() else {}
    wb = openpyxl.load_workbook(o.xlsx)
    allL, allG = [], []
    for ws in wb:
        group = str(ws.cell(1, 1).value).strip()
        y0 = int(re.search(r"(20\d\d)", str(ws.cell(2, 1).value)).group(1))
        day, merged = 0, {}
        for r in ws.iter_rows(min_row=5, values_only=True):
            if r[0] in DAYS: day = DAYS[r[0]]
            if not r[1] or not r[2] or not day: continue
            s, e = [x.strip() for x in re.split(r"[–-]", r[1])]
            name = str(r[3]).strip()
            subj, _, kind = name.rpartition(", ")
            if kind.lower() not in KIND: subj, kind = name, ""
            room, te = str(r[4] or "").strip(), str(r[5] or "").strip()
            key = (day, s, subj, kind, room, te)
            l = merged.setdefault(key, dict(group=group, day=day, slot=0, start=s, end=e, subject=subj, type=KIND.get(kind.lower(), kind),
                                            teacher=te, room=room, dates=[], subgroup=None, elective=None, week="all", note="", link=""))
            l["dates"] += dates(str(r[2]), y0)
        allL += list(merged.values())
        allG.append({"id": group, "title": group, "course": o.course, "level": "бакалавриат"})
    names = {g["id"] for g in allG}
    L = [l for l in old.get("lessons", []) if l["group"] not in names] + allL
    G = [g for g in old.get("groups", []) if g["id"] not in names] + allG
    starts = sorted({l["start"] for l in L})
    for l in L: l["slot"] = starts.index(l["start"]) + 1; l["dates"] = sorted(set(l["dates"]))
    bells = [{"n": i + 1, "start": s, "end": max(l["end"] for l in L if l["start"] == s)} for i, s in enumerate(starts)]
    ds = sorted(x for l in L for x in l["dates"]); W1 = date(2026, 8, 31); x = date.fromisoformat(ds[0]); x -= timedelta(days=x.weekday()); wk = []
    while x.isoformat() <= ds[-1]:
        wk.append({"from": x.isoformat(), "to": (x + timedelta(days=6)).isoformat(), "parity": "odd" if ((x - W1).days // 7) % 2 == 0 else "even"}); x += timedelta(days=7)
    out.mkdir(parents=True, exist_ok=True)
    f = lambda s: f"{s[8:]}.{s[5:7]}.{s[:4]}"
    data = {"meta": {"updated": date.today().isoformat(), "semester": "Осенний семестр 2026/2027", "faculty": f"СПбГУ, {o.faculty}", "dated": True, "period": {"from": f(ds[0]), "to": f(ds[-1])}},
            "weeks": wk, "bells": bells, "groups": G, "lessons": L}
    (out / "schedule.json").write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    (out / "groups.json").write_text(json.dumps(G, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(len(allL), sum(len(l["dates"]) for l in allL), ds[0], ds[-1])


if __name__ == "__main__":
    main()
