"""НИЯУ МИФИ: PDF группы с home.mephi.ru/study_groups/<id>/schedule.pdf → docs/data/<tenant>/.

Строка: «■ ЛЕК Предмет (01.09.2026 — 17.11.2026)  Преподаватель  Ауд.»; ■ — каждую
неделю, ◩ — нечётные, ◪ — чётные (первая неделя семестра нечётная). Без
диапазона — весь семестр. Добавляет группу к уже существующим в тенанте.

    python tools/parse_mephi_pdf.py <tenant> "<факультет>" file.pdf [file2.pdf …]
"""
import json, re, subprocess, sys
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SEM_FROM, SEM_TO = date(2026, 9, 1), date(2026, 12, 30)
W1 = SEM_FROM - timedelta(days=SEM_FROM.weekday())
DAYS = {"ПОНЕДЕЛЬНИК": 1, "ВТОРНИК": 2, "СРЕДА": 3, "ЧЕТВЕРГ": 4, "ПЯТНИЦА": 5, "СУББОТА": 6}
KIND = {"ЛЕК": "лекция", "ПР": "практика", "ЛАБ": "лабораторная"}
RD = r"(\d{2})\.(\d{2})\.(\d{4})"


def dmy(m, i=1):
    return date(int(m.group(i + 2)), int(m.group(i + 1)), int(m.group(i)))


def parse(path):
    text = subprocess.run(["pdftotext", "-layout", path, "-"], capture_output=True, text=True).stdout
    group = re.search(r"группы\s+(\S+)", text).group(1)
    items, day, time = [], 0, None
    for line in text.splitlines():
        s = line.strip()
        if s in DAYS:
            day = DAYS[s]; continue
        m = re.match(r"(\d{1,2}:\d{2})\s*—\s*(\d{1,2}:\d{2})\s*(.*)", s)
        if m:
            time = (m.group(1).zfill(5), m.group(2).zfill(5)); s = m.group(3)
        if s and s[0] in "■◩◪" and day and time:
            items.append([day, time, s])
        elif items and s and not m:
            items[-1][2] += "  " + s
    out = []
    for day, (st, en), s in items:
        mark, s = s[0], s[1:].strip()
        first = SEM_FROM + timedelta(days=(day - 1 - SEM_FROM.weekday()) % 7)
        rng = re.search(r"\(" + RD + r"\s*—\s*" + RD + r"\)", s)
        one = re.search(r"\(" + RD + r"\)", s)
        a, b = (dmy(rng), dmy(rng, 4)) if rng else (dmy(one), dmy(one)) if one else (first, SEM_TO)
        dates, d = [], first
        while d <= SEM_TO:
            odd = ((d - W1).days // 7) % 2 == 0
            if a <= d <= b and (mark == "■" or (mark == "◩") == odd):
                dates.append(d.isoformat())
            d += timedelta(days=7)
        if not dates:
            continue
        s = re.sub(r"\(" + RD + r"(\s*—\s*" + RD + r")?\)", "", s)
        # Поля помечены значками шрифта: \uf06a подгруппа, \uf19d преподаватель, \uf041 аудитория.
        head = re.split("[\uf06a\uf19d\uf041]", s)[0].strip()
        field = lambda ch: " ".join(x.strip() for x in re.findall(ch + "([^\uf06a\uf19d\uf041]*)", s))
        km = re.match(r"(ЛЕК|ПР|ЛАБ)(?:\s+\d+)?\s+(.*)", head)
        kind, subject = (KIND[km.group(1)], km.group(2).strip()) if km else ("", head)
        moved = re.match(r"Перенос занятий по дисциплине «(.+?)»(.*)", subject)
        note = ""
        if moved:
            subject, note = moved.group(1).split("/")[-1], "перенос" + moved.group(2)
        sgm = re.search(r"\d", field("\uf06a"))
        sg = int(sgm.group(0)) if sgm else None
        teacher = re.sub(r"\s+", " ", field("\uf19d"))
        room = re.sub(r"\s*Каф\..*", "", re.sub(r"\s+", " ", field("\uf041")))
        out.append(dict(group=group, day=day, slot=0, start=st, end=en, subject=subject.strip(), type=kind, teacher=teacher,
                        room=room, dates=dates, subgroup=sg, elective=None, week="all", note=note.strip(), link=""))
    return group, out


def main():
    tid, faculty, *paths = sys.argv[1:]
    o = ROOT / "docs" / "data" / tid
    old = json.loads((o / "schedule.json").read_text()) if (o / "schedule.json").exists() else None
    groups = {g["id"]: g for g in (old or {}).get("groups", [])}
    lessons = [l for l in (old or {}).get("lessons", []) if l.get("dates")]
    for p in paths:
        g, ls = parse(p)
        lessons = [l for l in lessons if l["group"] != g] + ls
        ym = re.search(r"(\d{2})-", g)
        groups[g] = {"id": g, "title": g, "course": 26 - int(ym.group(1)) + 1 if ym else 1, "level": "магистратура" if g.startswith("М") else "бакалавриат"}
        print(g, len(ls), "строк")
    starts = sorted({(l["start"], l["end"]) for l in lessons})
    bells = [{"n": i + 1, "start": s, "end": e} for i, (s, e) in enumerate(starts)]
    for l in lessons:
        l["slot"] = next(b["n"] for b in bells if b["start"] == l["start"])
    weeks, d, odd = [], W1, True
    while d <= SEM_TO:
        weeks.append({"from": d.isoformat(), "to": (d + timedelta(days=6)).isoformat(), "parity": "odd" if odd else "even"}); d += timedelta(days=7); odd = not odd
    gl = sorted(groups.values(), key=lambda g: (g["course"], g["id"]))
    o.mkdir(parents=True, exist_ok=True)
    data = {"meta": {"updated": date.today().isoformat(), "semester": "Осенний семестр 2026/2027", "faculty": faculty, "dated": True,
                     "period": {"from": "01.09.2026", "to": "30.12.2026"}}, "weeks": weeks, "bells": bells, "groups": gl, "lessons": lessons}
    (o / "schedule.json").write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")))
    (o / "groups.json").write_text(json.dumps(gl, ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    main()
