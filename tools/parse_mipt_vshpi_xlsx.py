"""МФТИ, ВШПИ: недельная сетка xlsx («Дни | Часы | группа1 | группа2 …») → docs/data/<tenant>/.

Пара занимает две строки: верхняя — нечётная неделя, нижняя — чётная;
ячейка на обе строки — каждую неделю. Объединение по столбцам — общая пара
нескольких групп. Своё время в начале ячейки («11:30 -12:50») важнее звонка.

    python tools/parse_mipt_vshpi_xlsx.py <tenant> "<факультет>" file.xlsx
"""
import json, re, sys
from datetime import date
from pathlib import Path
import openpyxl

ROOT = Path(__file__).resolve().parent.parent
DAYS = {"понедельник": 1, "вторник": 2, "среда": 3, "четверг": 4, "пятница": 5, "суббота": 6}
RT = r"(\d{1,2})[:.](\d{2})\s*-\s*(\d{1,2})[:.](\d{2})"


def main():
    tid, faculty, path = sys.argv[1:]
    ws = openpyxl.load_workbook(path).active
    owner = {}
    for m in ws.merged_cells.ranges:
        for r in range(m.min_row, m.max_row + 1):
            for c in range(m.min_col, m.max_col + 1):
                owner[(r, c)] = (m.min_row, m.min_col, m.max_row)
    val = lambda r, c: ws.cell(*owner.get((r, c), (r, c))[:2]).value
    head = next(r for r in range(1, 10) if str(ws.cell(r, 1).value or "").strip() == "Дни")
    gcols = {c: re.sub(r"\s+", " ", str(ws.cell(head, c).value)).strip() for c in range(3, ws.max_column + 1) if ws.cell(head, c).value}
    # Строки пар: где в столбце B стоит время.
    slots, day = [], 0
    for r in range(head + 1, ws.max_row + 1):
        a = str(val(r, 1) or "").strip().lower()
        if a in DAYS and owner.get((r, 1), (r,))[0] == r:
            day = DAYS[a]
        b = ws.cell(r, 2).value
        m = re.match(RT, str(b or ""))
        if m and day:
            slots.append([day, r, f"{int(m[1]):02d}:{m[2]}", f"{int(m[3]):02d}:{m[4]}"])
    for i, s in enumerate(slots):
        nxt = slots[i + 1][1] if i + 1 < len(slots) and slots[i + 1][0] == s[0] else s[1] + 2
        s.append(min(nxt, s[1] + 2))  # конец (не включая)
    lessons, seen = [], set()
    for day, r0, st, en, r1 in slots:
        rows = list(range(r0, r1))
        for c, g in gcols.items():
            for r in rows:
                o = owner.get((r, c), (r, c, r))
                v = ws.cell(o[0], o[1]).value
                if not v or (o[0], o[1], g) in seen:
                    continue
                text = str(v).replace("\xa0", " ").strip()
                if text.startswith("Занятия в") or "возможны изменения" in text:
                    continue
                seen.add((o[0], o[1], g))
                top, bottom = o[0] <= r0, (o[2] if len(o) > 2 else o[0]) >= r0 + 1 or len(rows) == 1
                week = "all" if (top and bottom) or len(rows) == 1 else "odd" if top else "even"
                s, e = st, en
                tm = re.match(RT + r"\s*", text)
                if tm:
                    s, e, text = f"{int(tm[1]):02d}:{tm[2]}", f"{int(tm[3]):02d}:{tm[4]}", text[tm.end():]
                text = re.sub(r"\s+", " ", text).strip()
                note = ""
                ak = re.match(r"А\.К\.№\s*\d+\s*\d+ из \d+:\s*", text)
                if ak:
                    text, note = text[ak.end():], "альтернативный курс"
                kind = ""
                km = re.search(r"\((лекция|семинар)\)", text)
                if km:
                    kind, subject, rest = km[1], text[: km.start()], text[km.end():]
                else:
                    subject, _, rest = text.partition(",")
                room = ""
                # Аудитория — хвост после последнего «-» или «,», если в нём есть цифра или «зал»/«Цифра».
                rm = re.search(r"[-–,]\s*([^-–,]*(?:\d|зал|Цифра)[^-–,]*)$", rest)
                if rm and not re.search(r"[А-ЯЁ]\.\s*[А-ЯЁ]?\.?$", rm[1].strip()):
                    room, rest = rm[1].strip(), rest[: rm.start()]
                else:
                    rm = re.search(r"\s((?:Цифра|Поточка)[\w .]*|\d+\s?(?:ГК|УПМ|КПМ))$", rest.strip())
                    if rm:
                        room, rest = rm[1], rest.strip()[: rm.start()]
                lessons.append(dict(group=g, day=day, slot=0, start=s, end=e, subject=subject.strip(" ,"), type=kind,
                                    teacher=rest.strip(" ,-"), room=room.strip(" ,"), subgroup=None, elective=None, week=week, note=note, link=""))
    starts = sorted({(l["start"], l["end"]) for l in lessons})
    bells = [{"n": i + 1, "start": a, "end": b} for i, (a, b) in enumerate(starts)]
    for l in lessons:
        l["slot"] = next(b["n"] for b in bells if b["start"] == l["start"] and b["end"] == l["end"])
    gl = [{"id": g, "title": g, "course": 1, "level": "бакалавриат"} for g in gcols.values()]
    o = ROOT / "docs" / "data" / tid
    o.mkdir(parents=True, exist_ok=True)
    data = {"meta": {"updated": date.today().isoformat(), "semester": "Осень 2026/2027", "faculty": faculty, "period": {"from": "01.09.2026", "to": "31.12.2026"}},
            "weeks": [], "bells": bells, "groups": gl, "lessons": lessons}
    from datetime import timedelta
    w, odd = date(2026, 8, 31), True
    while w <= date(2026, 12, 31):
        data["weeks"].append({"from": max(w, date(2026, 9, 1)).isoformat(), "to": (w + timedelta(days=6)).isoformat(), "parity": "odd" if odd else "even"}); w += timedelta(days=7); odd = not odd
    (o / "schedule.json").write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")))
    (o / "groups.json").write_text(json.dumps(gl, ensure_ascii=False, separators=(",", ":")))
    print(len(gl), "групп,", len(lessons), "пар")


if __name__ == "__main__":
    main()
