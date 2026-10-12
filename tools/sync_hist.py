"""Расписание исторического факультета МГУ с его сайта — в папку приложения.

Сайт (ccs2.hist.msu.ru) — старая система учебной части. Программного доступа
нет, а страница помнит выбор в сессии: сперва надо войти в раздел «Академ.
группы», выбрать подразделение, направление и год набора — тогда появится
список групп; у выбранной группы расписание показано сеткой на месяц.
Проходим всё это так же, как браузер, и читаем сетки месяц за месяцем.

    python tools/sync_hist.py --base http://ccs2.hist.msu.ru --faculty all \\
        --id msu-hist --university "МГУ" --name "Исторический факультет" \\
        --from 2026-09-01 --to 2026-12-31

Запускать можно сколько угодно раз: папка факультета переписывается целиком.
"""

import argparse
import html
import http.cookiejar
import json
import re
import sys
import time
import urllib.request
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "docs" / "data"
KINDS = {"лк": "лекция", "сем": "семинар", "пз": "практическое занятие", "лб": "лабораторная", "лаб": "лабораторная"}
# Номер подразделения в ссылках сайта → уровень.
LEVELS = {1: "бакалавриат", 3: "специалитет", 2: "магистратура", 4: "магистратура"}


class Site:
    def __init__(self, base):
        self.url = f"{base}/index.php"
        jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
        self.opener.addheaders = [("User-Agent", "schedule-miniapp sync (bodryash.ru)")]

    def get(self, query):
        # Сайт старый и небыстрый — не торопим его.
        time.sleep(0.2)
        for attempt in range(3):
            try:
                with self.opener.open(f"{self.url}?{query}", timeout=40) as response:
                    return response.read().decode("cp1251", "replace")
            except Exception:
                if attempt == 2:
                    raise
                time.sleep(2 + attempt * 3)


def clean(text):
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", text))).strip()


def groups_on(page):
    return [(gid, html.unescape(title).strip()) for gid, title in re.findall(r"<a href=\"\?gr=(\d+)\" title='([^']*)'", page)]


def month_lessons(page):
    """Сетка месяца → [(дата, пара, предмет, вид, аудитория, преподаватель)] и звонки."""
    bells = {}
    for h1, m1, h2, m2, number in re.findall(r"title=(\d\d)\.(\d\d)-(\d\d)\.(\d\d)>(\d)</td>", page):
        bells[int(number)] = (f"{h1}:{m1}", f"{h2}:{m2}")
    found = []
    for stamp, block in re.findall(r"align=center>(\d\d\.\d\d\.\d{4})</td></tr>(.*?)</table>", page, flags=re.S):
        day = date(int(stamp[6:]), int(stamp[3:5]), int(stamp[:2]))
        cells = re.findall(r"<td class=TmTblC[^>]*>(.*?)</td></tr>", block, flags=re.S)
        for slot, cell in enumerate(cells, start=1):
            for title, inner in re.findall(r'<div id="LESS" title="([^"]*)">(.*?)</div>', cell, flags=re.S):
                named = re.match(r"^(.*?)\s*'(.*)'\s*$", html.unescape(title))
                short = re.search(r"<b>(.*?)</b>", inner, flags=re.S)
                subject = (named.group(2) if named else clean(short.group(1)) if short else "").strip()
                if not subject:
                    continue
                place = re.search(r"<b>([^<]*)</b>\s*\[(.*?)\]", inner, flags=re.S)
                room = clean(place.group(1)) if place else ""
                kind = clean(place.group(2)).lower() if place else ""
                tail = inner[place.end():] if place else ""
                # Длинный список преподавателей сайт обрезает двумя точками.
                teachers = [re.sub(r"\s*\.\.$", "", clean(part)) for part in re.split(r"<br\s*/?>", tail)]
                teacher = ", ".join(t for t in teachers if t)
                found.append((day, slot, subject, KINDS.get(kind, kind), room, teacher))
    return found, bells


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", required=True)
    parser.add_argument("--faculty", default="all", help="не используется: сайт — одного факультета")
    parser.add_argument("--id", required=True)
    parser.add_argument("--university", required=True)
    parser.add_argument("--name", required=True)
    parser.add_argument("--from", dest="start", required=True)
    parser.add_argument("--to", dest="end", required=True)
    parser.add_argument("--only", default="", help="только эти группы через запятую — для проверки")
    args = parser.parse_args()
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{1,30}", args.id) or args.id == "msu-fgp":
        sys.exit("--id: латиница, цифры и дефис; msu-fgp занят")
    start, end = date.fromisoformat(args.start), date.fromisoformat(args.end)
    only = {name.strip() for name in args.only.split(",") if name.strip()}
    academic = start.year if start.month >= 8 else start.year - 1
    months, cursor = [], date(start.year, start.month, 1)
    while cursor <= end:
        months.append((cursor.month, cursor.year))
        cursor = date(cursor.year + cursor.month // 12, cursor.month % 12 + 1, 1)

    site = Site(args.base)
    site.get("mnu=143")

    # Подразделение → направление → год набора → группы.
    wanted = {}
    for level_id, level in LEVELS.items():
        page = site.get(f"f={level_id}")
        directions = list(dict.fromkeys(re.findall(r"href=\?sp=(\d+)", page))) or [""]
        for direction in directions:
            if direction:
                page = site.get(f"sp={direction}")
            years = re.findall(r"<option value=(\d+)[^>]*>\s*(\d{4})\s*\[([^\]]*)\]", page)
            for year_id, year, form in years:
                course = academic - int(year) + 1
                if course < 1 or course > 6:
                    continue
                page = site.get(f"yr={year_id}")
                for gid, title in groups_on(page):
                    # Точкой на сайте помечены пустые заготовки групп.
                    if len(title) < 2 or gid in wanted or (only and title not in only):
                        continue
                    wanted[gid] = {"title": title, "course": course, "level": level, "form": form.strip()}
    if not wanted:
        sys.exit("На сайте не нашлось групп — возможно, страница изменилась.")
    print(f"групп на сайте: {len(wanted)}", flush=True)

    groups, lessons, bells, names = [], [], {}, set()
    for gid, info in wanted.items():
        title = info["title"]
        try:
            page = site.get(f"gr={gid}")
            shown = re.search(r"Расписание академической группы: \[([^\]]*)\]", clean(page))
            if not shown or shown.group(1).strip() != title:
                raise RuntimeError("сайт показал другую группу")
            merged = defaultdict(list)
            for month, year in months:
                found, rings = month_lessons(site.get(f"pMns={month}.{year}"))
                bells.update(rings)
                for day, slot, subject, kind, room, teacher in found:
                    if start <= day <= end and day.isoweekday() <= 6:
                        merged[(day.isoweekday(), slot, subject, kind, teacher, room)].append(day.isoformat())
        except Exception as error:  # одна сбойная группа не должна ронять весь факультет
            print(f"  {title}: не загрузилось ({error})", file=sys.stderr)
            continue
        if not merged:
            continue
        # Одинаковые названия в разных подразделениях различаем уровнем.
        name = title if title not in names else f"{title} ({info['level'][:3]}.)"
        names.add(name)
        for (weekday, slot, subject, kind, teacher, room), dates in merged.items():
            lessons.append({
                "group": name, "day": weekday, "slot": slot, "subgroup": None, "elective": None, "week": "all",
                "note": "", "link": "", "start": "", "end": "", "type": kind,
                "subject": subject, "room": room, "teacher": teacher, "dates": sorted(set(dates)),
            })
        groups.append({"id": name, "title": name, "course": info["course"], "level": info["level"]})
        print(f"  {name}: строк {len(merged)}, занятий {sum(len(set(d)) for d in merged.values())}", flush=True)

    if not lessons:
        sys.exit("Ни одной пары не получено.")
    # На сайте есть служебная «восьмая пара» длиной в минуту — звонком её не
    # считаем, если на ней нет ни одного занятия.
    used = {lesson["slot"] for lesson in lessons}
    long_enough = lambda n: (int(bells[n][1][:2]) * 60 + int(bells[n][1][3:])) - (int(bells[n][0][:2]) * 60 + int(bells[n][0][3:])) >= 30
    bell_list = [{"n": n, "start": bells[n][0], "end": bells[n][1]} for n in sorted(bells) if n in used or long_enough(n)]
    weeks, cursor, parity = [], start, "odd"
    while cursor <= end:
        sunday = cursor + timedelta(days=6 - cursor.weekday())
        weeks.append({"from": cursor.isoformat(), "to": min(sunday, end).isoformat(), "parity": parity})
        cursor, parity = sunday + timedelta(days=1), ("even" if parity == "odd" else "odd")

    schedule = {
        "meta": {"updated": date.today().isoformat(), "semester": "", "faculty": f"{args.name} {args.university}", "dated": True,
                 "period": {"from": start.strftime("%d.%m.%Y"), "to": end.strftime("%d.%m.%Y")}},
        "weeks": weeks, "bells": bell_list, "groups": groups,
        "lessons": sorted(lessons, key=lambda l: (l["group"], l["day"], l["slot"], l["dates"][0])),
    }
    folder = DATA / args.id
    folder.mkdir(parents=True, exist_ok=True)
    dump = lambda value: json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    target = folder / "schedule.json"
    if only:
        print(json.dumps(schedule["lessons"][:400], ensure_ascii=False, indent=1))
        return
    if target.exists():
        old = json.loads(target.read_text(encoding="utf-8"))
        if old.get("lessons") == schedule["lessons"] and old.get("groups") == groups:
            print(f"{args.id}: без изменений")
            return
        # Сайт отдал заметно меньше, чем было, — похоже на сбой, а не на правку
        # расписания. Старое не затираем.
        if old.get("meta", {}).get("dated") and len(groups) < 0.7 * len(old.get("groups", [])):
            sys.exit(f"{args.id}: групп стало {len(groups)} вместо {len(old['groups'])} — не записываю.")
    target.write_text(dump(schedule), encoding="utf-8")
    (folder / "groups.json").write_text(dump(groups), encoding="utf-8")
    registry = DATA / "tenants.json"
    tenants = json.loads(registry.read_text(encoding="utf-8"))
    keep = next((t for t in tenants if t["id"] == args.id), {})
    entry = {**keep, "id": args.id, "university": args.university, "faculty": args.name, "path": args.id, "features": keep.get("features", []),
             "source": {"kind": "hist", "base": args.base, "faculty": "all"}}
    registry.write_text(json.dumps([t for t in tenants if t["id"] != args.id] + [entry], ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Итого: групп {len(groups)}, строк {len(lessons)}, записано в docs/data/{args.id}/")


if __name__ == "__main__":
    main()
