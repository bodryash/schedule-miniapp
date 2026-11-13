"""МГАВМиБ им. К.И. Скрябина: открытый plan.mgavm.ru/api/v1/schedule (JSON на всю академию) → docs/data/mgavm-*/.

Сайт открывается только из России — файл забирает наш сервер (/admin/fetch).
По одному «вузу-факультету» на факультет академии; занятия — по датам.

    python tools/sync_mgavm.py schedule.json
"""
import json, sys
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SLUG = {"f1": "mgavm-fvm", "f2": "mgavm-fzta", "f3": "mgavm-fbe", "f4": "mgavm-college", "f5": "mgavm-fzvo"}


def main():
    d = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    groups = {g["id"]: g for g in d["groups"] if not g.get("hidden")}
    teachers = {t["id"]: t["short"] or t["name"] for t in d["teachers"]}
    rooms = {r["id"]: f'{r["name"]} ({r["buildingShort"] or r["building"]})' if r.get("building") else r["name"] for r in d["rooms"]}
    kinds = {k["code"]: k["name"].lower().replace("практическое занятие", "практика") for k in d["lessonTypes"]}
    bells = [{"n": s["n"], "start": s["start"], "end": s["end"]} for s in d["bells"][0]["slots"]]
    W1 = date.fromisoformat(d["semester"]["firstWeek"])
    F, T = date.fromisoformat(d["period"]["from"]), date.fromisoformat(d["period"]["to"])
    weeks, x = [], W1
    while x <= T:
        weeks.append({"from": x.isoformat(), "to": (x + timedelta(days=6)).isoformat(), "parity": "odd" if ((x - W1).days // 7) % 2 == 0 else "even"}); x += timedelta(days=7)
    out = {}
    for l in d["lessons"]:
        if l.get("status") == "cancelled":
            continue
        dd = date.fromisoformat(l["date"])
        for gid in l["groups"]:
            g = groups.get(gid)
            if not g or g["facultyId"] not in SLUG:
                continue
            key = (gid, dd.isoweekday(), l["start"], l["discipline"], l["type"], tuple(l["teachers"]), tuple(l["rooms"]), l.get("subgroup") or "")
            b = out.setdefault(SLUG[g["facultyId"]], {})
            row = b.setdefault(key, dict(group=g["name"], day=dd.isoweekday(), slot=l["slot"], start=l["start"], end=l["end"], subject=l["discipline"],
                                         type=kinds.get(l["type"], l["type"]), teacher=", ".join(teachers.get(t, "") for t in l["teachers"]),
                                         room=", ".join(rooms.get(r, "") for r in l["rooms"]), dates=[], subgroup=None, elective=None, week="all",
                                         note=(f'подгруппа {l["subgroup"]}' if l.get("subgroup") else "") + ((" · " if l.get("subgroup") else "") + l["note"] if l.get("note") else ""), link=""))
            row["dates"].append(l["date"])
    fac = {f["id"]: f for f in d["faculties"]}
    reg = json.loads((ROOT / "docs/data/tenants.json").read_text(encoding="utf-8"))
    for fid, slug in SLUG.items():
        L = list(out.get(slug, {}).values())
        for l in L:
            l["dates"] = sorted(set(l["dates"]))
        gl = sorted(({"id": g["name"], "title": g["name"], "course": g.get("course") or 1, "level": (g.get("level") or "").lower() or "бакалавриат"}
                     for g in groups.values() if g["facultyId"] == fid), key=lambda g: (g["course"], g["id"]))
        o = ROOT / "docs" / "data" / slug; o.mkdir(parents=True, exist_ok=True)
        data = {"meta": {"updated": d["generated"][:10], "semester": d["semester"]["name"], "faculty": f'МГАВМиБ, {fac[fid]["name"]}', "dated": True,
                         "period": {"from": F.strftime("%d.%m.%Y"), "to": T.strftime("%d.%m.%Y")}},
                "weeks": weeks, "bells": bells, "groups": gl, "lessons": L}
        (o / "schedule.json").write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        (o / "groups.json").write_text(json.dumps(gl, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        entry = {"id": slug, "university": "МГАВМиБ им. К.И. Скрябина", "faculty": fac[fid]["name"], "path": slug, "features": [], "short": fac[fid]["short"],
                 "source": {"kind": "mgavm", "base": "https://plan.mgavm.ru/api/v1/schedule", "faculty": fid}}
        reg = [t for t in reg if t["id"] != slug] + [entry]
        print(slug, len(gl), "групп,", len(L), "строк,", sum(len(l["dates"]) for l in L), "занятий,", (o / "schedule.json").stat().st_size // 1024, "КБ")
    (ROOT / "docs/data/tenants.json").write_text(json.dumps(reg, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
