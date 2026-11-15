"""МПГУ, ИЖКМ: PDF «РАСПИСАНИЕ УЧЕБНЫХ ЗАНЯТИЙ» с двумя группами и датами у каждой пары → docs/data/<tenant>/.

Блок пары: «ПРЕДМЕТ (ЛК|ПЗ)», ниже даты «14.09, 28.09», должность и ФИО, «Аудитория N».
Столбец по горизонтали: левее середины — первая группа, правее — вторая, по центру
(растянут на обе) — общая. День — по меткам слева, время — по ближайшей метке времени.

    python tools/parse_mpgu_izhkm_pdf.py <tenant> "<факультет>" file.pdf
"""
import json, re, sys
from datetime import date, timedelta
from pathlib import Path
import pdfplumber

ROOT = Path(__file__).resolve().parent.parent
YEAR = 2026
KIND = {"ЛК": "лекция", "ПЗ": "практика", "ЛБ": "лабораторная", "СЕМ": "семинар"}
DAYS = ["ПОНЕДЕЛЬНИК", "ВТОРНИК", "СРЕДА", "ЧЕТВЕРГ", "ПЯТНИЦА", "СУББОТА"]
RT = re.compile(r"(\d{1,2})[:.](\d{2})\s*[-–]\s*(\d{1,2})[:.](\d{2})")


def segments(page):
    """Строки страницы, разбитые на куски по большим промежуткам между словами."""
    words = sorted(page.extract_words(keep_blank_chars=False, x_tolerance=2), key=lambda w: (round(w["top"] / 3), w["x0"]))
    lines = []
    for w in words:
        if lines and abs(lines[-1][-1]["top"] - w["top"]) < 3 and -1 <= w["x0"] - lines[-1][-1]["x1"] < 25:
            lines[-1].append(w)
        else:
            lines.append([w])
    return [{"top": l[0]["top"], "x0": l[0]["x0"], "x1": l[-1]["x1"], "text": " ".join(w["text"] for w in l)} for l in lines]


def main():
    tid, faculty, path = sys.argv[1:]
    pdf = pdfplumber.open(path)
    segs = []
    for pi, page in enumerate(pdf.pages):
        for s in segments(page):
            s["y"] = pi * 10000 + s["top"]
            segs.append(s)
    segs.sort(key=lambda s: (s["y"], s["x0"]))
    # Границы ячеек времени: горизонтальные линии во всю ширину столбца времени.
    cuts = []
    for pi, page in enumerate(pdf.pages):
        tops = sorted({round(e["top"]) for e in page.edges if e["orientation"] == "h" and 110 < e["x0"] < 118 and 194 < e["x1"] < 202})
        cuts += [pi * 10000 + t for t in tops] + [pi * 10000, pi * 10000 + 9999]
    cuts = sorted(set(cuts))
    cell_of = lambda y: max([c for c in cuts if c <= y], default=0)
    names = {}
    for s in segs:
        m = re.search(r"(ВОЖ\S+)", s["text"])
        if m:
            names[round((s["x0"] + s["x1"]) / 2)] = m.group(1)
    cols = sorted(names.items())
    if len(cols) < 2:
        raise SystemExit("не нашёл группы")
    (xa, ga), (xb, gb) = cols[0], cols[-1]
    mid = (xa + xb) / 2
    # Метки дня: вертикальные куски «ПОНЕ / ДЕЛЬ / НИК» — склеиваем по x<110.
    marks = []
    buf = ""
    for s in segs:
        if s["x1"] < 115 and re.fullmatch(r"[А-ЯЁ]+", s["text"]):
            buf += s["text"]
            for i, dname in enumerate(DAYS):
                if buf.endswith(dname) or dname.startswith(buf) and len(buf) >= 4 and buf == dname:
                    pass
            hit = next((i for i, dname in enumerate(DAYS) if dname in buf), None)
            if hit is not None:
                marks.append((s["y"], hit + 1))
                buf = ""
    times = [(s["y"], RT.search(s["text"])) for s in segs if s["x0"] < 200 and RT.search(s["text"])]
    # День меняется, когда время «откатывается» назад.
    timeline, day, prev = [], 1, None
    for y, m in times:
        st = f"{int(m[1]):02d}:{m[2]}"
        if prev and st < prev:
            day += 1
        prev = st
        timeline.append((y, day, st, f"{int(m[3]):02d}:{m[4]}"))
    lessons = {}
    for i, s in enumerate(segs):
        m = re.match(r"(.+?)\s*\((ЛК|ПЗ|ЛБ|СЕМ)\)$", s["text"])
        if not m or s["x0"] < 200:
            continue
        # Название в две строки: верхняя — заглавными, прямо над этой.
        cx0 = (s["x0"] + s["x1"]) / 2
        above = [t for t in segs[max(0, i - 6) : i] if 0 < s["y"] - t["y"] < 16 and abs((t["x0"] + t["x1"]) / 2 - cx0) < 80 and re.fullmatch(r"[А-ЯЁ ,\-()]+", t["text"]) and not re.search(r"\((ЛК|ПЗ)\)", t["text"])]
        if above:
            m = re.match(r"(.+?)\s*\((ЛК|ПЗ|ЛБ|СЕМ)\)$", above[-1]["text"] + " " + s["text"])
        cx = (s["x0"] + s["x1"]) / 2
        below = [t for t in segs[i + 1 : i + 12] if 0 < t["y"] - s["y"] < 60 and abs((t["x0"] + t["x1"]) / 2 - cx) < 90]
        dates_t = " ".join(t["text"] for t in below if re.search(r"\d{1,2}[.,]\s?\d{2}", t["text"]) and "Аудитория" not in t["text"])
        teacher = next((t["text"] for t in below if re.search(r"[А-ЯЁ]\.\s?[А-ЯЁ]\.", t["text"])), "")
        room = next((re.sub(r"^Аудитория\s*", "", t["text"]) for t in below if t["text"].startswith("Аудитория")), "")
        # Время — из той же ячейки; ячейка без подписи (продолжение на новой
        # странице) — время последней подписи выше.
        cell = cell_of(s["y"])
        inside = [t for t in timeline if cell_of(t[0]) == cell]
        slot = min(inside, key=lambda t: abs(t[0] - s["y"])) if inside else max([t for t in timeline if t[0] < s["y"]], key=lambda t: t[0], default=timeline[0])
        _, wd, st, en = slot
        dates = []
        for dd, mm in re.findall(r"(\d{1,2})[.,]\s?(\d{2})", dates_t):
            try:
                d = date(YEAR, int(mm), int(dd))
            except ValueError:
                continue
            if d.isoweekday() == wd:
                dates.append(d.isoformat())
        if not dates:
            continue
        who = [ga, gb] if abs(cx - mid) < 60 and (s["x1"] - s["x0"]) < 400 and s["x0"] < mid < s["x1"] else [ga] if cx < mid else [gb]
        for g in who:
            key = (g, wd, st, m[1].strip(), m[2], teacher, room)
            lessons.setdefault(key, set()).update(dates)
    out = []
    for (g, wd, st, subj, kind, teacher, room), ds in lessons.items():
        en = next(t[3] for t in timeline if t[2] == st)
        out.append(dict(group=g, day=wd, slot=0, start=st, end=en, subject=subj.capitalize(), type=KIND[kind], teacher=teacher,
                        room=room, dates=sorted(ds), subgroup=None, elective=None, week="all", note="", link=""))
    starts = sorted({(l["start"], l["end"]) for l in out})
    bells = [{"n": i + 1, "start": a, "end": b} for i, (a, b) in enumerate(starts)]
    for l in out:
        l["slot"] = next(b["n"] for b in bells if b["start"] == l["start"])
    gl = [{"id": g, "title": f"{g} (гр. {'101' if g == ga else '102'})", "course": 1, "level": "бакалавриат"} for g in (ga, gb)]
    alld = sorted(x for l in out for x in l["dates"])
    first, last = date.fromisoformat(alld[0]), date.fromisoformat(alld[-1])
    w, odd, weeks = first - timedelta(days=first.weekday()), True, []
    while w <= last:
        weeks.append({"from": w.isoformat(), "to": (w + timedelta(days=6)).isoformat(), "parity": "odd" if odd else "even"}); w += timedelta(days=7); odd = not odd
    o = ROOT / "docs" / "data" / tid
    o.mkdir(parents=True, exist_ok=True)
    data = {"meta": {"updated": date.today().isoformat(), "semester": "1 семестр 2026/2027", "faculty": faculty, "dated": True,
                     "period": {"from": first.strftime("%d.%m.%Y"), "to": last.strftime("%d.%m.%Y")}}, "weeks": weeks, "bells": bells, "groups": gl, "lessons": out}
    (o / "schedule.json").write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")))
    (o / "groups.json").write_text(json.dumps(gl, ensure_ascii=False, separators=(",", ":")))
    print(gl, len(out), "строк,", len(alld), "занятий", bells)


if __name__ == "__main__":
    main()
