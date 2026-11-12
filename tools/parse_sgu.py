"""СГУ им. Чернышевского: страница группы www.sgu.ru/schedule/<фак>/do/<группа> → docs/data/<id>/.
Сайт открывается только из России — страницу забирает наш сервер (/admin/fetch).
Ч — числитель (нечётная неделя, 1-я — с 31.08), З — знаменатель, без пометки — каждую неделю.

    python tools/parse_sgu.py страница.html --id sgu-ff --group 1031 --faculty "Институт физики" --course 1
"""
import argparse, html, json, re
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
KIND = {"practice": "практика", "lecture": "лекция", "laboratory": "лабораторная", "seminar": "семинар"}
txt = lambda s: re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", s))).strip()


def main():
    a = argparse.ArgumentParser()
    a.add_argument("page"); a.add_argument("--id", required=True); a.add_argument("--group", required=True)
    a.add_argument("--faculty", required=True); a.add_argument("--course", type=int, default=1)
    a.add_argument("--from", dest="start", default="2026-09-01"); a.add_argument("--to", dest="end", default="2026-12-27")
    o = a.parse_args()
    s = Path(o.page).read_text(encoding="utf-8")
    t = s[s.find("<table"): s.find("</table>")]
    F, T, W1 = date.fromisoformat(o.start), date.fromisoformat(o.end), date(2026, 8, 31)
    L, bells = [], []
    for row in re.findall(r"<tr>\s*<th>(.*?)</tr>", t, re.S):
        m = re.match(r"\s*<div[^>]*>\s*(\d\d:\d\d)\s*<br>\s*(\d\d:\d\d)\s*</div>\s*</th>(.*)", row, re.S)
        if not m:
            continue
        start, end, rest = m.groups()
        bells.append((start, end))
        for day, td in enumerate(re.findall(r"<td[^>]*>(.*?)</td>", rest, re.S), 1):
            for les in re.split(r'<div class="schedule-table__lesson">', td)[1:]:
                name = re.search(r"schedule-table__lesson-name'>(.*?)</div>", les, re.S)
                if not name:
                    continue
                kinds = re.findall(r'lesson-prop__([a-z]+)"', les)
                kind = next((KIND[k] for k in kinds if k in KIND), "")
                week = "o" if "num" in kinds else "e" if "denom" in kinds else "a"
                sg = re.search(r"lesson-uncertain\">(.*?)</div>", les, re.S)
                sgt = txt(sg.group(1)) if sg else ""
                sgn = re.match(r"(\d+)\s*подгр", sgt)
                te = re.search(r"lesson-teacher'>(.*?)</div>", les, re.S)
                room = re.search(r"lesson-room'>(.*?)</div>", les, re.S)
                ds, x = [], W1 + timedelta(days=day - 1)
                while x <= T:
                    odd = ((x - W1).days // 7) % 2 == 0
                    if x >= F and x != date(2026, 11, 4) and (week == "a" or (week == "o") == odd):
                        ds.append(x.isoformat())
                    x += timedelta(days=7)
                L.append(dict(group=o.group, day=day, slot=len(bells), start=start, end=end, subject=txt(name.group(1)), type=kind,
                              teacher=txt(te.group(1)) if te else "", room=txt(room.group(1)) if room else "", dates=ds,
                              subgroup=int(sgn.group(1)) if sgn else None, elective=None, week="all",
                              note="" if sgn else sgt, link=""))
    wk, x = [], W1
    while x <= T:
        wk.append({"from": x.isoformat(), "to": (x + timedelta(days=6)).isoformat(), "parity": "odd" if ((x - W1).days // 7) % 2 == 0 else "even"}); x += timedelta(days=7)
    gl = [{"id": o.group, "title": o.group, "course": o.course, "level": "бакалавриат"}]
    out = ROOT / "docs" / "data" / o.id; out.mkdir(parents=True, exist_ok=True)
    data = {"meta": {"updated": date.today().isoformat(), "semester": "1 семестр 2026/2027", "faculty": f"СГУ им. Чернышевского, {o.faculty}", "dated": True,
                     "period": {"from": F.strftime("%d.%m.%Y"), "to": T.strftime("%d.%m.%Y")}},
            "weeks": wk, "bells": [{"n": i + 1, "start": a_, "end": b_} for i, (a_, b_) in enumerate(bells)], "groups": gl, "lessons": L}
    (out / "schedule.json").write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    (out / "groups.json").write_text(json.dumps(gl, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"пар {len(L)}, звонков {len(bells)}, подгрупп {sorted({l['subgroup'] for l in L if l['subgroup']})}")


if __name__ == "__main__":
    main()
