"""Московский Политех: rasp.dmami.ru/site/group?group=<группа>&session=0 (JSON) → docs/data/<tenant>/.

Сайт отвечает только с Referer — забираем через наш сервер (/admin/fetch шлёт
его сам). Каждый файл — одна группа; занятие идёт каждую неделю от df до dt.

    python tools/sync_mospolytech.py <tenant> "<факультет>" группа1.json [группа2.json …]
Имя группы берётся из имени файла (261-631.json).
"""
import json, re, sys
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BELLS = [("09:00", "10:30"), ("10:40", "12:10"), ("12:20", "13:50"), ("14:30", "16:00"), ("16:10", "17:40"), ("17:50", "19:20"), ("19:30", "21:00")]
SEM_FROM, SEM_TO = date(2026, 9, 1), date(2026, 12, 31)
W1 = SEM_FROM - timedelta(days=SEM_FROM.weekday())
KIND = {"Лекция": "лекция", "Практика": "практика", "Лабораторная работа": "лабораторная"}


def short(name):
    p = name.split()
    return f"{p[0]} {p[1][0]}.{p[2][0]}." if len(p) == 3 else name


def main():
    tid, faculty, *files = sys.argv[1:]
    o = ROOT / "docs" / "data" / tid
    old = json.loads((o / "schedule.json").read_text()) if (o / "schedule.json").exists() else {}
    groups = {g["id"]: g for g in old.get("groups", [])}
    lessons = old.get("lessons", [])
    for f in files:
        g = Path(f).stem
        grid = json.loads(Path(f).read_text())["grid"]
        lessons = [l for l in lessons if l["group"] != g]
        for wd, slots in grid.items():
            for n, items in slots.items():
                for it in items:
                    a, b = max(date.fromisoformat(it["df"]), SEM_FROM), min(date.fromisoformat(it["dt"]), SEM_TO)
                    d = W1 + timedelta(days=int(wd) - 1)
                    dates = []
                    while d <= b:
                        if d >= a:
                            dates.append(d.isoformat())
                        d += timedelta(days=7)
                    if not dates:
                        continue
                    rooms = " ".join(re.sub(r"<[^>]+>", "", x["title"]).replace("📷", "").strip() for x in it["auditories"])
                    link = (re.search(r'href="([^"]+)"', " ".join(x["title"] for x in it["auditories"])) or [None, ""])[1]
                    st, en = BELLS[int(n) - 1]
                    lessons.append(dict(group=g, day=int(wd), slot=int(n), start=st, end=en, subject=it["sbj"], type=KIND.get(it["type"], it["type"].lower()),
                                        teacher=", ".join(short(t["name"]) for t in it.get("teachers") or []), room=rooms if not link else "онлайн",
                                        dates=dates, subgroup=None, elective=None, week="all", note="", link=link))
        groups[g] = {"id": g, "title": g, "course": max(1, 26 - int(g[:2]) + 1) if g[:2].isdigit() else 1, "level": "бакалавриат"}
        print(g, sum(1 for l in lessons if l["group"] == g), "строк")
    weeks, d, odd = [], W1, True
    while d <= SEM_TO:
        weeks.append({"from": d.isoformat(), "to": (d + timedelta(days=6)).isoformat(), "parity": "odd" if odd else "even"}); d += timedelta(days=7); odd = not odd
    gl = sorted(groups.values(), key=lambda g: (g["course"], g["id"]))
    o.mkdir(parents=True, exist_ok=True)
    data = {"meta": {"updated": date.today().isoformat(), "semester": "1 семестр 2026/2027", "faculty": faculty, "dated": True,
                     "period": {"from": "01.09.2026", "to": "31.12.2026"}}, "weeks": weeks,
            "bells": [{"n": i + 1, "start": s, "end": e} for i, (s, e) in enumerate(BELLS)], "groups": gl, "lessons": lessons}
    (o / "schedule.json").write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")))
    (o / "groups.json").write_text(json.dumps(gl, ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    main()
