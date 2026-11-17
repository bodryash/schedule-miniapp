"""БФУ им. И. Канта: schedule.kantiana.ru/v1/api/lessons/group (JSON помесячно) → docs/data/<tenant>/.

Сайт отдаёт данные только с cookie сессии — забираем через наш сервер:
  /admin/fetch?url=…/v1/api/lessons/group?group=G&date_from=…&date_to=…&warm=/?__schedule_session=refresh
Не больше 31 дня за запрос — по одному файлу на месяц.

    python tools/sync_kantiana.py <tenant> "<факультет>" month1.json [month2.json …]
"""
import json, re, sys
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
KIND = {"лекции": "лекция", "практические занятия": "практика", "лабораторные занятия": "лабораторная", "семинарские занятия": "семинар"}


def main():
    tid, faculty, *files = sys.argv[1:]
    rows, groups = {}, {}
    for f in files:
        for it in json.loads(Path(f).read_text()).get("items", []):
            d = date.fromisoformat(it["date"])
            g = it["group"]["name"]
            groups[g] = it["group"]
            st, en = it["start_time"][:5], it["end_time"][:5]
            kind = KIND.get((it.get("load") or "").lower(), (it.get("load") or "").lower())
            if it.get("is_exam"):
                kind = (it.get("load") or "экзамен").lower()
            room = it.get("short_room") or it.get("room") or it.get("beautiful_room") or ""
            sg = re.search(r"\d", it.get("subgroup") or "")
            key = (g, d.isoweekday(), st, en, it["discipline"], kind, (it.get("teacher") or {}).get("short", ""), room, sg.group(0) if sg else "")
            rows.setdefault(key, set()).add(d.isoformat())
    lessons = []
    for (g, wd, st, en, subj, kind, teacher, room, sg), ds in rows.items():
        lessons.append(dict(group=g, day=wd, slot=0, start=st, end=en, subject=subj, type=kind, teacher=teacher, room=room,
                            dates=sorted(ds), subgroup=int(sg) if sg else None, elective=None, week="all", note="", link=""))
    st = sorted({(l["start"], l["end"]) for l in lessons})
    bells = [{"n": i + 1, "start": a, "end": b} for i, (a, b) in enumerate(st)]
    for l in lessons:
        l["slot"] = next(b["n"] for b in bells if b["start"] == l["start"] and b["end"] == l["end"])
    o = ROOT / "docs" / "data" / tid
    old = json.loads((o / "schedule.json").read_text()) if (o / "schedule.json").exists() else {}
    keep = [l for l in old.get("lessons", []) if l["group"] not in groups]
    gl = {g["id"]: g for g in old.get("groups", [])}
    for name, info in groups.items():
        gl[name] = {"id": name, "title": f"{name} · {info['direction']['title']}", "course": info.get("course") or 1, "level": "бакалавриат"}
    lessons = keep + lessons
    alld = sorted(x for l in lessons for x in l["dates"])
    first, last = date.fromisoformat(alld[0]), date.fromisoformat(alld[-1])
    w, odd, weeks = first - timedelta(days=first.weekday()), True, []
    while w <= last:
        weeks.append({"from": w.isoformat(), "to": (w + timedelta(days=6)).isoformat(), "parity": "odd" if odd else "even"}); w += timedelta(days=7); odd = not odd
    allb = sorted({(l["start"], l["end"]) for l in lessons})
    bells = [{"n": i + 1, "start": a, "end": b} for i, (a, b) in enumerate(allb)]
    for l in lessons:
        l["slot"] = next(b["n"] for b in bells if b["start"] == l["start"] and b["end"] == l["end"])
    o.mkdir(parents=True, exist_ok=True)
    gls = sorted(gl.values(), key=lambda g: (g["course"], g["id"]))
    data = {"meta": {"updated": date.today().isoformat(), "semester": "1 семестр 2026/2027", "faculty": faculty, "dated": True,
                     "period": {"from": first.strftime("%d.%m.%Y"), "to": last.strftime("%d.%m.%Y")}}, "weeks": weeks, "bells": bells, "groups": gls, "lessons": lessons}
    (o / "schedule.json").write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")))
    (o / "groups.json").write_text(json.dumps(gls, ensure_ascii=False, separators=(",", ":")))
    print([g["id"] for g in gls], len(lessons), "строк,", len(alld), "занятий")


if __name__ == "__main__":
    main()
