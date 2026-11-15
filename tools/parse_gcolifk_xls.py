"""ГЦОЛИФК (РУС «ГЦОЛИФК»): xls «по неделям» — лист на неделю (01.09, 07.09 …),
строки — дисциплина × группа (1, 2), столбцы — день × пара; «л»/«п» — лекция/практика.
Аудитория и преподаватель бывают «по дням» («пн - 512 гл.к.  пт - 508») и «по виду»
(«л - Иванов  п - Петров»).

    python tools/parse_gcolifk_xls.py <tenant> "<факультет>" file.xls
"""
import json, re, sys
from datetime import date, timedelta
from pathlib import Path
import xlrd

ROOT = Path(__file__).resolve().parent.parent
DAYS = {"пн": 1, "вт": 2, "ср": 3, "чт": 4, "пт": 5, "сб": 6}


def split_by(text, keys):
    """«пн - 512  пт - 508» → {пн: 512, пт: 508}; без меток → {None: текст}."""
    t = re.sub(r"\s+", " ", str(text or "")).strip()
    parts = re.split(r"\b(" + "|".join(keys) + r")\s*-\s*", t)
    if len(parts) < 3:
        return {None: t}
    return {parts[i]: parts[i + 1].strip() for i in range(1, len(parts) - 1, 2)}


def main():
    tid, faculty, path = sys.argv[1:]
    wb = xlrd.open_workbook(path)
    head = ""
    bells = {}
    rows = {}
    groups = []
    for sh in wb.sheets():
        if not re.match(r"\d\d\.\d\d$", sh.name):
            continue
        head = head or str(sh.cell_value(4, 0))
        for r in range(sh.nrows):
            line = " ".join(str(x) for x in sh.row_values(r))
            if "Время начала" in line:
                for n, a, b in re.findall(r"(\d) пара (\d\d[:.]\d\d)-(\d\d[:.]\d\d)", line):
                    bells[int(n)] = (a.replace(".", ":"), b.replace(".", ":"))
        dates = {}
        for c in range(7, 37, 5):
            v = sh.cell_value(6, c)
            if isinstance(v, float) and v:
                dates[(c - 7) // 5 + 1] = date(1899, 12, 30) + timedelta(days=int(v))
        subj = room = teach = None
        for r in range(9, sh.nrows):
            row = sh.row_values(r)
            if str(row[0]).startswith("Условные"):
                break
            if str(row[1]).strip():
                subj = re.sub(r"\s+", " ", str(row[1])).strip()
                room = row[4]
                teach = row[5]
            elif str(row[5]).strip():
                teach = row[5]
            g = str(row[6]).strip()
            if not g or not subj:
                continue
            for c in range(7, 37):
                mark = str(row[c]).strip()
                if mark not in ("л", "п"):
                    continue
                wd = (c - 7) // 5 + 1
                n = (c - 7) % 5 + 1
                d = dates.get(wd)
                if not d:
                    continue
                dn = [k for k, v in DAYS.items() if v == wd][0]
                rm = split_by(room, DAYS.keys())
                tc = split_by(teach, ["л", "п"])
                key = (g, wd, n, subj, mark)
                r0 = rm.get(dn) or rm.get(None) or ""
                rk = split_by(r0, ["л", "п"])
                rows.setdefault(key, {"dates": set(), "room": rk.get(mark) or rk.get(None) or "", "teacher": tc.get(mark) or tc.get(None) or ""})["dates"].add(d.isoformat())
    gm = re.search(r"группы\s+(.+)$", head)
    names = [x.strip() for x in gm.group(1).split(",")] if gm else []
    gname = lambda g: next((x for x in names if x.endswith("/" + g)), f"группа {g}")
    lessons = []
    for (g, wd, n, subj, mark), v in rows.items():
        st, en = bells.get(n, ("", ""))
        lessons.append(dict(group=gname(g), day=wd, slot=n, start=st, end=en, subject=subj, type="лекция" if mark == "л" else "практика",
                            teacher=v["teacher"], room=v["room"], dates=sorted(v["dates"]), subgroup=None, elective=None, week="all", note="", link=""))
    gl = [{"id": x, "title": x, "course": 1, "level": "бакалавриат"} for x in sorted({l["group"] for l in lessons})]
    alld = sorted(x for l in lessons for x in l["dates"])
    first, last = date.fromisoformat(alld[0]), date.fromisoformat(alld[-1])
    w, odd, weeks = first - timedelta(days=first.weekday()), True, []
    while w <= last:
        weeks.append({"from": w.isoformat(), "to": (w + timedelta(days=6)).isoformat(), "parity": "odd" if odd else "even"}); w += timedelta(days=7); odd = not odd
    o = ROOT / "docs" / "data" / tid
    o.mkdir(parents=True, exist_ok=True)
    data = {"meta": {"updated": date.today().isoformat(), "semester": "1 семестр 2026/2027", "faculty": faculty, "dated": True,
                     "period": {"from": first.strftime("%d.%m.%Y"), "to": last.strftime("%d.%m.%Y")}}, "weeks": weeks,
            "bells": [{"n": n, "start": a, "end": b} for n, (a, b) in sorted(bells.items())], "groups": gl, "lessons": lessons}
    (o / "schedule.json").write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")))
    (o / "groups.json").write_text(json.dumps(gl, ensure_ascii=False, separators=(",", ":")))
    print([g["id"] for g in gl], len(lessons), "строк,", len(alld), "занятий", data["bells"])


if __name__ == "__main__":
    main()
