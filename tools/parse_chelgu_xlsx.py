"""ЧелГУ, химфак: xlsx «РАСПИСАНИЕ УЧЕБНЫХ ЗАНЯТИЙ» (лист на курс) → docs/data/chelgu-chem/.

Лист: C — день, D — номер пары, дальше по две колонки на группу (подгруппы
1 и 2; объединённые — вся группа). На пару 4 строки: «1н предмет / преподаватель
ауд.» (нечётная неделя) и «2н …» (чётная); без пометки — каждую неделю.

    python tools/parse_chelgu_xlsx.py файл.xlsx   # все листы и группы
"""
import json, re, sys
from datetime import date, timedelta
from pathlib import Path
import openpyxl

ROOT = Path(__file__).resolve().parent.parent
DAYS = {"ПОНЕДЕЛЬНИК": 1, "ВТОРНИК": 2, "СРЕДА": 3, "ЧЕТВЕРГ": 4, "ПЯТНИЦА": 5, "СУББОТА": 6}
# Звонки ЧелГУ (уточнить у студентов).
BELLS = [("08:00", "09:35"), ("09:45", "11:20"), ("11:30", "13:05"), ("13:35", "15:10"), ("15:20", "16:55"), ("17:05", "18:40"), ("18:50", "20:25"), ("20:35", "22:10")]
KIND = [("лекц", "лекция"), ("практ", "практика"), ("лаб", "лабораторная"), ("науч", "научный семинар")]


def norm(g):
    g = re.sub(r"\s+", "", g)
    m = re.fullmatch(r"(Хм|Хб|Х)(\d{3})", g)
    return f"{m.group(1)}-{m.group(2)}" if m else g


def course_of(g):
    m = re.search(r"(\d)\d\d$", g) or re.search(r"-(\d)\d$", g)
    return int(m.group(1)) if m else 1


def main():
    path = sys.argv[1]
    wb = openpyxl.load_workbook(path)
    allL, allG = [], []
    for ws in wb:
        L, G = sheet(ws)
        allL += L; allG += G
    write(allL, allG)


def sheet(ws):
    merged = {}
    for m in ws.merged_cells.ranges:
        for r in range(m.min_row, m.max_row + 1):
            for c in range(m.min_col, m.max_col + 1):
                merged[(r, c)] = m
    val = lambda r, c: ws.cell(r, c).value
    head = next(r for r in range(1, 40) if str(val(r + 1, 3) or "").strip().upper() in DAYS)
    cols = [c for c in range(5, 25) if str(val(head, c) or "").strip()]
    groups, spans = {}, {}
    for i, c in enumerate(cols):
        name = norm(str(val(head, c)))
        groups[name] = c
        spans[name] = (cols[i + 1] - c) if i + 1 < len(cols) else 2
    # блоки пар
    blocks, day = [], 0
    for r in range(head + 1, ws.max_row + 1):
        d = str(val(r, 3) or "").strip().upper()
        if d in DAYS:
            day = DAYS[d]
        n = val(r, 4)
        if day and isinstance(n, (int, float)) or (isinstance(n, str) and n.strip().isdigit()):
            blocks.append((day, int(n), r))
    F, T, W1 = date(2026, 9, 1), date(2026, 12, 30), date(2026, 8, 31)
    L = []
    for g, col in groups.items():
        for day, n, r0 in blocks:
            seen = set()
            span = spans[g]
            half = max(1, span // 2)
            for c in range(col, col + span):
                sub = (c - col) // half + 1
                for r in range(r0, r0 + 4):
                    m = merged.get((r, c))
                    top = (m.min_row, m.min_col) if m else (r, c)
                    if top in seen:
                        continue
                    v = val(*top)
                    if not isinstance(v, str) or not v.strip() or re.search(r"\(\d\)\s*$", v.strip()) and not re.match(r"\s*[12]н", v):
                        continue
                    text = v.strip()
                    if text.upper() in ("ДЕНЬ", "САМОСТОЯТЕЛЬНЫХ", "ЗАНЯТИЙ"):
                        continue
                    seen.add(top)
                    week = "o" if text.startswith("1н") else "e" if text.startswith("2н") else "a"
                    text = re.sub(r"^[12]н\s*", "", text)
                    both = (m and m.min_col <= col and m.max_col >= col + span - 1) or span == 1
                    # преподаватель и аудитория — строкой ниже (с учётом объединения)
                    below = (m.max_row + 1 if m else r + 1)
                    tv = str(val(below, top[1]) or "").strip()
                    rm = re.search(r"(\d+\(\d\))\s*$", tv)
                    room = rm.group(1) if rm else ""
                    teacher = re.sub(r"\s+", " ", tv[: rm.start()] if rm else tv).strip()
                    kind = next((k for s, k in KIND if s in text.lower()), "")
                    subj = re.sub(r"\s*\((лекц|практ|лаб|науч)[^)]*\)?\.?\s*$", "", text, flags=re.I).strip()
                    subj = subj[:1] + subj[1:].lower() if subj.isupper() else subj
                    ds, x = [], W1 + timedelta(days=day - 1)
                    while x <= T:
                        odd = ((x - W1).days // 7) % 2 == 0
                        if x >= F and x != date(2026, 11, 4) and (week == "a" or (week == "o") == odd):
                            ds.append(x.isoformat())
                        x += timedelta(days=7)
                    L.append(dict(group=g, day=day, slot=n, start=BELLS[n - 1][0], end=BELLS[n - 1][1], subject=subj, type=kind,
                                  teacher=teacher, room=room, dates=ds, subgroup=None if both else sub, elective=None, week="all", note="", link=""))
                    if both:
                        break
    G = [{"id": g, "title": g, "course": course_of(g), "level": "магистратура" if "Хм" in g else "бакалавриат"} for g in groups]
    return L, G


def write(L, gl):
    F, T, W1 = date(2026, 9, 1), date(2026, 12, 30), date(2026, 8, 31)
    out = ROOT / "docs" / "data" / "chelgu-chem"; out.mkdir(parents=True, exist_ok=True)
    gl = sorted(gl, key=lambda g: (g["level"] != "бакалавриат", g["course"], g["id"]))
    wk, x = [], W1
    while x <= T:
        wk.append({"from": x.isoformat(), "to": (x + timedelta(days=6)).isoformat(), "parity": "odd" if ((x - W1).days // 7) % 2 == 0 else "even"}); x += timedelta(days=7)
    data = {"meta": {"updated": date.today().isoformat(), "semester": "1 семестр 2026/2027", "faculty": "ЧелГУ, химический факультет", "dated": True, "period": {"from": "01.09.2026", "to": "30.12.2026"}},
            "weeks": wk, "bells": [{"n": i + 1, "start": a, "end": b} for i, (a, b) in enumerate(BELLS)], "groups": gl, "lessons": L}
    (out / "schedule.json").write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    (out / "groups.json").write_text(json.dumps(gl, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    from collections import Counter
    print(Counter(l["group"] for l in L), [ (g["id"], g["course"]) for g in gl])


if __name__ == "__main__":
    main()
