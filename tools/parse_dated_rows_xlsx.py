"""Таблица «Дата | День | Пара | Время | Предмет | Тип | Аудитория | Преподаватель» по листам-месяцам
(АГЗ МЧС, «workload_<группа>_all_months.xlsx») → docs/data/<tenant>/. Добавляет группу к тенанту.

    python tools/parse_dated_rows_xlsx.py <tenant> "<факультет>" <группа> file.xlsx
"""
import json, re, sys
from datetime import date, datetime, timedelta
from pathlib import Path
import openpyxl

ROOT = Path(__file__).resolve().parent.parent
KIND = {"л.": "лекция", "ЗСТ": "семинар", "лаб.": "лабораторная", "зчО.": "зачёт с оценкой", "зч.": "зачёт", "экз.": "экзамен", "Консультация": "консультация", "пр.": "практика", "сем.": "семинар"}


def main():
    tid, faculty, group, path = sys.argv[1:]
    rows = {}
    for ws in openpyxl.load_workbook(path):
        for r in ws.iter_rows(min_row=3, values_only=True):
            if not r[0] or not re.match(r"\d{2}\.\d{2}\.\d{4}", str(r[0])):
                continue
            d = datetime.strptime(r[0], "%d.%m.%Y").date()
            st, en = [t.strip().zfill(5) for t in str(r[3]).split("-")]
            subj = re.sub(r"\s+", " ", str(r[4])).strip()
            key = (d.isoweekday(), st, subj, r[5], str(r[6]).strip(), r[7])
            row = rows.setdefault(key, dict(group=group, day=d.isoweekday(), slot=int(r[2]), start=st, end=en, subject=subj,
                                            type=KIND.get(str(r[5]).strip(), str(r[5]).strip()), teacher=r[7] or "", room=str(r[6] or "").strip(),
                                            dates=[], subgroup=None, elective=None, week="all", note="", link=""))
            row["dates"].append(d.isoformat())
    new = list(rows.values())
    o = ROOT / "docs" / "data" / tid
    old = json.loads((o / "schedule.json").read_text()) if (o / "schedule.json").exists() else {}
    lessons = [l for l in old.get("lessons", []) if l["group"] != group] + new
    groups = {g["id"]: g for g in old.get("groups", [])}
    groups[group] = {"id": group, "title": group, "course": 1, "level": "бакалавриат"}
    alld = sorted(x for l in lessons for x in l["dates"])
    first, last = date.fromisoformat(alld[0]), date.fromisoformat(alld[-1])
    w = first - timedelta(days=first.weekday()); weeks = []; odd = True
    while w <= last:
        weeks.append({"from": w.isoformat(), "to": (w + timedelta(days=6)).isoformat(), "parity": "odd" if odd else "even"}); w += timedelta(days=7); odd = not odd
    bells = sorted({(l["slot"], l["start"], l["end"]) for l in lessons})
    gl = sorted(groups.values(), key=lambda g: g["id"])
    o.mkdir(parents=True, exist_ok=True)
    data = {"meta": {"updated": date.today().isoformat(), "semester": "1 семестр 2026/2027", "faculty": faculty, "dated": True,
                     "period": {"from": first.strftime("%d.%m.%Y"), "to": last.strftime("%d.%m.%Y")}}, "weeks": weeks,
            "bells": [{"n": n, "start": s, "end": e} for n, s, e in dict(((b[0], b) for b in bells)).values()], "groups": gl, "lessons": lessons}
    (o / "schedule.json").write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")))
    (o / "groups.json").write_text(json.dumps(gl, ensure_ascii=False, separators=(",", ":")))
    print(group, len(new), "строк,", sum(len(l["dates"]) for l in new), "занятий", data["bells"])


if __name__ == "__main__":
    main()
