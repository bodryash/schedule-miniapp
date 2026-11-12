"""РГСУ: сохранённые страницы rgsu.net/students/schedule (вид «Месяц», Ctrl+S) → docs/data/rgsu/.

Сайт открывается только из России, поэтому страницу сохраняет человек у себя.
В таблице по строкам — пары, по столбцам — дни месяца; в клетке «Занятий нет»
или 5 строк: вид, предмет, преподаватель, адрес, аудитория.

    python tools/parse_rgsu_html.py --group 18074 --title "…" ноябрь.html декабрь.html
"""
import argparse, html, json, re
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MON = {"янв": 1, "фев": 2, "мар": 3, "апр": 4, "май": 5, "мая": 5, "июн": 6, "июл": 7, "авг": 8, "сен": 9, "окт": 10, "ноя": 11, "дек": 12}
KIND = {"Чтение лекций": "лекция", "Ведение практических занятий": "практика", "Проведение лабораторных занятий": "лабораторная"}


def page(path, year):
    s = Path(path).read_text(encoding="utf-8", errors="ignore")
    t = html.unescape(re.sub(r"<[^>]+>", "\n", re.sub(r"<script.*?</script>|<style.*?</style>", "", s, flags=re.S)))
    L = [x.strip() for x in t.split("\n") if x.strip()]
    i = L.index("Время")
    days = []
    j = i + 1
    while not re.fullmatch(r"\d\d:\d\d", L[j]):
        m = re.fullmatch(r"(\d{1,2}) ([а-я]{3})", L[j])
        if m:
            days.append(date(year, MON[m.group(2)], int(m.group(1))))
        j += 1
    rows = [k for k in range(j, len(L) - 1) if re.fullmatch(r"\d\d:\d\d", L[k]) and re.fullmatch(r"\d\d:\d\d", L[k + 1])]
    out = []
    for n, r in enumerate(rows):
        seg = L[r + 2: rows[n + 1] if n + 1 < len(rows) else len(L)]
        x = 0
        for day in days:
            if seg[x] == "Занятий нет":
                x += 1
                continue
            kind, subj, te, addr, room = seg[x: x + 5]
            x += 5
            out.append((day, L[r], L[r + 1], kind, subj, te, addr, room))
    return out


def main():
    a = argparse.ArgumentParser()
    a.add_argument("pages", nargs="+"); a.add_argument("--group", required=True); a.add_argument("--title", required=True)
    a.add_argument("--year", type=int, default=2026); a.add_argument("--repeat-to", default="", help="повторять последнюю полную неделю до этой даты")
    o = a.parse_args()
    items = [it for p in o.pages for it in page(p, o.year)]
    starts = sorted({it[1] for it in items})
    ends = {it[1]: it[2] for it in items}
    merged = {}
    for day, s, e, kind, subj, te, addr, room in items:
        key = (day.isoweekday(), s, subj, kind, te, room)
        l = merged.setdefault(key, dict(group=o.group, day=day.isoweekday(), slot=starts.index(s) + 1, start=s, end=e, subject=subj,
                                        type=KIND.get(kind, kind.lower()), teacher=te, room=f"{room.replace('ауд. ', '')}, {addr}",
                                        dates=[], subgroup=None, elective=None, week="all", note="", link=""))
        l["dates"].append(day.isoformat())
    L = list(merged.values())
    last = max(it[0] for it in items)
    if o.repeat_to:
        wk_from = last - timedelta(days=last.weekday())
        for l in L:
            for x in [d for d in l["dates"] if d >= wk_from.isoformat()]:
                y = date.fromisoformat(x) + timedelta(days=7)
                while y.isoformat() <= o.repeat_to:
                    l["dates"].append(y.isoformat()); y += timedelta(days=7)
    for l in L:
        l["dates"] = sorted(set(l["dates"]))
    ds = sorted(d for l in L for d in l["dates"])
    W1 = date(o.year, 8, 31); x = date.fromisoformat(ds[0]); x -= timedelta(days=x.weekday()); wk = []
    while x.isoformat() <= ds[-1]:
        wk.append({"from": x.isoformat(), "to": (x + timedelta(days=6)).isoformat(), "parity": "odd" if ((x - W1).days // 7) % 2 == 0 else "even"}); x += timedelta(days=7)
    gl = [{"id": o.group, "title": o.title, "course": 1, "level": "бакалавриат"}]
    fmt = lambda s: f"{s[8:]}.{s[5:7]}.{s[:4]}"
    out = ROOT / "docs" / "data" / "rgsu"; out.mkdir(parents=True, exist_ok=True)
    data = {"meta": {"updated": date.today().isoformat(), "semester": "1 семестр 2026/2027", "faculty": "РГСУ", "dated": True, "period": {"from": fmt(ds[0]), "to": fmt(ds[-1])}},
            "weeks": wk, "bells": [{"n": i + 1, "start": s, "end": ends[s]} for i, s in enumerate(starts)], "groups": gl, "lessons": L}
    (out / "schedule.json").write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    (out / "groups.json").write_text(json.dumps(gl, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"пар {len(items)}, строк {len(L)}, с {ds[0]} по {ds[-1]}")


if __name__ == "__main__":
    main()
