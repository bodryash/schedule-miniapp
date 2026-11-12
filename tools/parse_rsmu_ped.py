"""РНИМУ, Институт материнства и детства: PDF «поток × группы» → docs/data/rsmu-imd/.
В клетке пары подряд: «8.30-11.00 Биология (2-16, 20 н)», «н» — недели семестра
(1-я — с 31.08). Лекции потока — через «/». Пока берём первый блок групп
(колонка 1 — 2.1.27…2.1.33): у них одна клетка на всех.

    python tools/parse_rsmu_ped.py файл.pdf
"""
import json, re, sys
from datetime import date, timedelta
from pathlib import Path
import pdfplumber

ROOT = Path(__file__).resolve().parent.parent
W1 = date(2026, 8, 31)
SKIP = {date(2026, 11, 4), date(2026, 12, 31)}
DAYS = {"Понедельник": 1, "Вторник": 2, "Среда": 3, "Четверг": 4, "Пятница": 5, "Суббота": 6}
RE = re.compile(r"(\d{1,2})\.(\d{2})-(\d{1,2})\.(\d{2})\s+(.+?)\((\d[\d,\s\-]*)н\)")


def weeks(spec):
    out = set()
    for part in spec.split(","):
        part = part.strip()
        if "-" in part:
            a, b = map(int, part.split("-")); out.update(range(a, b + 1))
        elif part:
            out.add(int(part))
    return sorted(out)


def main():
    with pdfplumber.open(sys.argv[1]) as f:
        t = f.pages[0].extract_tables()[0]
    groups = [h[::-1] for h in t[0][1:8]]
    lessons, day = [], 0
    for row in t[1:]:
        if row[0]:
            day = DAYS.get(row[0][::-1].strip(), day)
        cell = (row[1] or "").replace("\n", " ")
        if not cell or not day:
            continue
        cell = re.sub(r"\s+", " ", cell)
        for m in re.finditer(r"(\d{1,2}\.\d{2}-\d{1,2}\.\d{2})\s+(.*?)(?=\s\d{1,2}\.\d{2}-\d{1,2}\.\d{2}\s|$)", cell):
            time, body = m.groups()
            s, e = time.split("-")
            start, end = f"{int(s.split('.')[0]):02d}:{s.split('.')[1]}", f"{int(e.split('.')[0]):02d}:{e.split('.')[1]}"
            for item in body.split(" / "):
                im = re.match(r"(Лекция:\s*)?(.+?)\s*\(([\d,\s\-]+)н\)", item.strip())
                if not im:
                    continue
                lec, subj, spec = im.groups()
                ds = [W1 + timedelta(days=(n - 1) * 7 + day - 1) for n in weeks(spec)]
                ds = [d.isoformat() for d in ds if d not in SKIP]
                for g in groups:
                    lessons.append({"group": g, "day": day, "slot": 0, "start": start, "end": end, "subject": subj.strip(),
                                    "type": "лекция" if lec else ("практика" if subj.startswith("Практика") else "семинар"),
                                    "teacher": "", "room": "", "dates": ds, "subgroup": None, "elective": None, "week": "all",
                                    "note": "дистанционно" if lec else "", "link": ""})
    starts = sorted({l["start"] for l in lessons})
    bells = [{"n": i + 1, "start": s, "end": next(l["end"] for l in lessons if l["start"] == s)} for i, s in enumerate(starts)]
    for l in lessons:
        l["slot"] = starts.index(l["start"]) + 1
    wk, x = [], W1
    while x <= date(2027, 1, 17):
        n = (x - W1).days // 7 + 1
        wk.append({"from": x.isoformat(), "to": (x + timedelta(days=6)).isoformat(), "parity": "odd" if n % 2 else "even"}); x += timedelta(days=7)
    gl = [{"id": g, "title": g, "course": 1, "level": "специалитет"} for g in groups]
    out = ROOT / "docs" / "data" / "rsmu-imd"; out.mkdir(parents=True, exist_ok=True)
    data = {"meta": {"updated": date.today().isoformat(), "semester": "Осенний семестр 2026/2027", "faculty": "РНИМУ им. Пирогова, Институт материнства и детства, педиатрия", "dated": True,
                     "period": {"from": "01.09.2026", "to": "15.01.2027"}}, "weeks": wk, "bells": bells, "groups": gl, "lessons": lessons}
    (out / "schedule.json").write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    (out / "groups.json").write_text(json.dumps(gl, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(groups, len(lessons) // len(groups))


if __name__ == "__main__":
    main()
