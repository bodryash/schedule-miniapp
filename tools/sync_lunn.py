"""НГЛУ им. Добролюбова: ucheb.lunn.ru/api/Rasp?idGroup=<id>&sdate=<понедельник> (JSON по неделям) → docs/data/<tenant>/.

Сайт открывается только из России — недели забирает наш сервер (/admin/fetch).
id группы — из ucheb.lunn.ru/api/raspGrouplist?year=2026-2027.

    python tools/sync_lunn.py <tenant> "<факультет>" week1.json [week2.json …]
"""
import json, re, sys
from datetime import date, datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
KIND = {"лек": "лекция", "пр": "практика", "лаб": "лабораторная", "сем": "семинар", "зач": "зачёт", "экз": "экзамен"}


def main():
    tid, faculty, *files = sys.argv[1:]
    rows, groups = {}, {}
    for f in files:
        for r in json.loads(Path(f).read_text())["data"]["rasp"]:
            d = datetime.fromisoformat(r["дата"]).date()
            m = re.match(r"(лек|пр|лаб|сем|зач|экз)\.?\s+(.*)", r["дисциплина"].strip())
            kind, subj = (KIND.get(m[1].lower(), m[1]), m[2]) if m else ("", r["дисциплина"])
            subj = subj.strip()
            if subj.count("(") > subj.count(")"):
                subj += ")"
            g = r["группа"]
            groups[g] = r
            key = (g, d.isoweekday(), r["начало"], subj, kind, r["преподаватель"], r["аудитория"], r["номерПодгруппы"])
            row = rows.setdefault(key, dict(group=g, day=d.isoweekday(), slot=r["номерЗанятия"], start=r["начало"], end=r["конец"], subject=subj, type=kind,
                                            teacher=r.get("фиоПреподавателя") or r["преподаватель"], room=r["аудитория"] or "", dates=[],
                                            subgroup=r["номерПодгруппы"] or None, elective=None, week="all", note="замена" if r["замена"] else "", link=r.get("ссылка") or ""))
            row["dates"].append(d.isoformat())
    lessons = list(rows.values())
    for l in lessons:
        l["dates"] = sorted(set(l["dates"]))
    alld = sorted(x for l in lessons for x in l["dates"])
    first, last = date.fromisoformat(alld[0]), date.fromisoformat(alld[-1])
    bells = sorted({(l["slot"], l["start"], l["end"]) for l in lessons})
    w, odd, weeks = first - timedelta(days=first.weekday()), True, []
    while w <= last:
        weeks.append({"from": w.isoformat(), "to": (w + timedelta(days=6)).isoformat(), "parity": "odd" if odd else "even"}); w += timedelta(days=7); odd = not odd
    gl = [{"id": g, "title": g, "course": max(1, 26 - int(g[:2]) + 1), "level": "СПО"} for g in sorted(groups)]
    o = ROOT / "docs" / "data" / tid
    o.mkdir(parents=True, exist_ok=True)
    data = {"meta": {"updated": date.today().isoformat(), "semester": "1 семестр 2026/2027", "faculty": faculty, "dated": True,
                     "period": {"from": first.strftime("%d.%m.%Y"), "to": last.strftime("%d.%m.%Y")}}, "weeks": weeks,
            "bells": [{"n": n, "start": s, "end": e} for n, s, e in dict((b[0], b) for b in bells).values()], "groups": gl, "lessons": lessons}
    (o / "schedule.json").write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")))
    (o / "groups.json").write_text(json.dumps(gl, ensure_ascii=False, separators=(",", ":")))
    print(len(gl), "групп,", len(lessons), "строк,", len(alld), "занятий", data["bells"])


if __name__ == "__main__":
    main()
