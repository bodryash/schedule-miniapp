"""ЧелГУ, химфак: xlsx «РАСПИСАНИЕ УЧЕБНЫХ ЗАНЯТИЙ» (лист на курс) → docs/data/chelgu-chem/.

Лист: C — день, D — номер пары, дальше по две колонки на группу (подгруппы
1 и 2; объединённые — вся группа). На пару 4 строки: «1н предмет / преподаватель
ауд.» (нечётная неделя) и «2н …» (чётная); без пометки — каждую неделю.

    python tools/parse_chelgu_xlsx.py файл.xlsx "Х401, Хб401, Хб402" "Х 401=Х-401" …
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


def main():
    path, sheet, *pairs = sys.argv[1:]
    wb = openpyxl.load_workbook(path)
    ws = wb[sheet]
    merged = {}
    for m in ws.merged_cells.ranges:
        for r in range(m.min_row, m.max_row + 1):
            for c in range(m.min_col, m.max_col + 1):
                merged[(r, c)] = m
    val = lambda r, c: ws.cell(r, c).value
    head = next(r for r in range(1, 40) if any(str(val(r, c) or "").strip().replace(" ", "") in [p.split("=")[0].replace(" ", "") for p in pairs] for c in range(1, 25)))
    groups = {}
    for p in pairs:
        key, name = p.split("=")
        col = next(c for c in range(1, 25) if str(val(head, c) or "").replace(" ", "") == key.replace(" ", ""))
        groups[name] = col
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
            for sub, c in ((1, col), (2, col + 1)):
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
                    both = m and m.min_col <= col and m.max_col >= col + 1
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
    out = ROOT / "docs" / "data" / "chelgu-chem"; out.mkdir(parents=True, exist_ok=True)
    old = json.loads((out / "schedule.json").read_text()) if (out / "schedule.json").exists() else {}
    keepL = [l for l in old.get("lessons", []) if l["group"] not in groups]
    keepG = [g for g in old.get("groups", []) if g["id"] not in groups]
    gl = keepG + [{"id": g, "title": g, "course": int(re.search(r"\d", g).group()), "level": "бакалавриат"} for g in groups]
    wk, x = [], W1
    while x <= T:
        wk.append({"from": x.isoformat(), "to": (x + timedelta(days=6)).isoformat(), "parity": "odd" if ((x - W1).days // 7) % 2 == 0 else "even"}); x += timedelta(days=7)
    data = {"meta": {"updated": date.today().isoformat(), "semester": "1 семестр 2026/2027", "faculty": "ЧелГУ, химический факультет", "dated": True, "period": {"from": "01.09.2026", "to": "30.12.2026"}},
            "weeks": wk, "bells": [{"n": i + 1, "start": a, "end": b} for i, (a, b) in enumerate(BELLS)], "groups": gl, "lessons": keepL + L}
    (out / "schedule.json").write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    (out / "groups.json").write_text(json.dumps(gl, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(len(L))
    for l in sorted(L, key=lambda l: (l["day"], l["slot"])): print(l["day"], l["slot"], l["subgroup"], len(l["dates"]), l["subject"][:40], "|", l["type"], "|", l["teacher"], "|", l["room"])


if __name__ == "__main__":
    main()
