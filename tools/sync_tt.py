"""Расписание с сайта вида tt.audit.msu.ru (ВШГА МГУ) — в папку приложения.

На сайте открытая форма «факультет → курс → группа» и таблица по датам:
у каждой клетки подпись с датой, номером пары, предметом, аудиторией и
преподавателем. Программного доступа нет, поэтому проходим форму так же,
как это делает браузер, и читаем таблицу.

    python tools/sync_tt.py --base https://tt.audit.msu.ru --faculty 3 \\
        --id msu-vshga --university "МГУ" \\
        --name "Высшая школа государственного аудита" \\
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
import urllib.parse
import urllib.request
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "docs" / "data"
KINDS = {"лк": "лекция", "сем": "семинар", "пз": "практическое занятие", "лб": "лабораторная", "лаб": "лабораторная"}


class Site:
    def __init__(self, base):
        self.url = f"{base}/time-table/group?type=0"
        jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
        self.opener.addheaders = [("User-Agent", "schedule-miniapp sync (bodryash.ru)")]
        self.page = self.get()

    def get(self, form=None):
        body = urllib.parse.urlencode(form).encode() if form else None
        with self.opener.open(self.url, body, timeout=60) as response:
            self.page = response.read().decode("utf-8", "replace")
        time.sleep(0.4)  # не торопим чужой сервер
        return self.page

    def post(self, **fields):
        token = re.search(r'name="_csrf-frontend" value="([^"]+)"', self.page).group(1)
        form = {"_csrf-frontend": token}
        form.update({f"TimeTableForm[{key}]": value for key, value in fields.items()})
        return self.get(form)

    def options(self, field):
        block = re.search(rf'id="timetableform-{field}".*?</select>', self.page, re.S)
        if not block:
            return []
        found = re.findall(r'<option value="([^"]*)"[^>]*>([^<]*)</option>', block.group(0))
        return [(value, html.unescape(text).strip()) for value, text in found if value]


def lessons_of(page, group):
    """Клетки таблицы одной группы → пары с датами."""
    bells = {}
    for number, begin, end in re.findall(
        r'<span class="lesson">(\d+) пара</span>\s*<span class="start">([\d:]+)</span>\s*<span class="end">([\d:]+)</span>', page
    ):
        bells[int(number)] = (begin, end)
    merged = defaultdict(list)
    for title, content in re.findall(r'data-toggle="popover" title="([^"]+)" data-content="([^"]*)"', page):
        stamp = re.match(r"(\d{2})\.(\d{2})\.(\d{4}) (\d+) пара", html.unescape(title))
        if not stamp:
            continue
        day = date(int(stamp.group(3)), int(stamp.group(2)), int(stamp.group(1)))
        slot = int(stamp.group(4))
        parts = [p.strip() for p in html.unescape(content).split("<br>")]
        parts = [p for p in parts if p and not p.startswith("Добавлено")]
        begin = end = ""
        if parts and re.fullmatch(r"\d{1,2}:\d{2}-\d{1,2}:\d{2}", parts[0]):
            begin, end = [t.zfill(5) for t in parts.pop(0).split("-")]
        if not parts:
            continue
        head = re.match(r"(.*?)\[([^\]]*)\]\s*$", parts[0])
        subject = (head.group(1) if head else parts[0]).strip()
        kind = (head.group(2) if head else "").strip()
        rest = parts[1:]
        room = ""
        if rest and rest[0].lower().startswith("ауд"):
            room = re.sub(r"^ауд\.?\s*", "", rest.pop(0), flags=re.I)
        # Дальше — кто на паре (группа или поток) и, если указан, преподаватель.
        who = rest.pop(0) if rest else ""
        teacher = rest.pop(0) if rest else ""
        note = "" if who == group else who
        key = (day.isoweekday(), slot, begin, end, subject, KINDS.get(kind.lower(), kind.lower()), teacher, room, note)
        merged[key].append(day.isoformat())
    lessons = []
    for (weekday, slot, begin, end, subject, kind, teacher, room, note), dates in merged.items():
        if weekday > 6 or not subject:
            continue
        lessons.append({
            "group": group, "day": weekday, "slot": slot, "subgroup": None, "elective": None, "week": "all",
            "note": note, "link": "", "start": begin, "end": end, "type": kind,
            "subject": subject, "room": room, "teacher": teacher, "dates": sorted(set(dates)),
        })
    return lessons, bells


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", required=True)
    parser.add_argument("--faculty", required=True, help="номер факультета в форме сайта")
    parser.add_argument("--id", required=True)
    parser.add_argument("--university", required=True)
    parser.add_argument("--name", required=True)
    parser.add_argument("--from", dest="start", required=True)
    parser.add_argument("--to", dest="end", required=True)
    args = parser.parse_args()
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{1,30}", args.id) or args.id == "msu-fgp":
        sys.exit("--id: латиница, цифры и дефис; msu-fgp занят")
    start, end = date.fromisoformat(args.start), date.fromisoformat(args.end)
    span = {"dateStart": start.strftime("%d.%m.%Y"), "dateEnd": end.strftime("%d.%m.%Y")}

    site = Site(args.base)
    site.post(facultyId=args.faculty, course="", groupId="")
    courses = site.options("course")
    if not courses:
        sys.exit("На сайте не нашлось курсов — возможно, форма изменилась.")

    groups, lessons, bells = [], [], {}
    for course_id, course_title in courses:
        site.post(facultyId=args.faculty, course=course_id, groupId="")
        for group_id, name in site.options("groupid"):
            if any(g["id"] == name for g in groups):
                continue
            try:
                site.post(facultyId=args.faculty, course=course_id, groupId="")
                page = site.post(facultyId=args.faculty, course=course_id, groupId=group_id, **span)
            except Exception as error:  # одна сбойная группа не должна ронять весь факультет
                print(f"  {name}: не загрузилось ({error})", file=sys.stderr)
                continue
            found, rings = lessons_of(page, name)
            bells.update(rings)
            if not found:
                continue
            lessons.extend(found)
            course = int(course_title) if course_title.isdigit() else 1
            groups.append({"id": name, "title": name, "course": course, "level": "бакалавриат"})
            print(f"  {name}: строк {len(found)}, занятий {sum(len(l['dates']) for l in found)}")

    if not lessons:
        sys.exit("Ни одной пары не получено.")
    bell_list = [{"n": n, "start": bells[n][0], "end": bells[n][1]} for n in sorted(bells)]
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
    if target.exists():
        old = json.loads(target.read_text(encoding="utf-8"))
        if old.get("lessons") == schedule["lessons"] and old.get("groups") == groups:
            print(f"{args.id}: без изменений")
            return
    target.write_text(dump(schedule), encoding="utf-8")
    (folder / "groups.json").write_text(dump(groups), encoding="utf-8")
    registry = DATA / "tenants.json"
    tenants = json.loads(registry.read_text(encoding="utf-8"))
    keep = next((t for t in tenants if t["id"] == args.id), {})
    entry = {**keep, "id": args.id, "university": args.university, "faculty": args.name, "path": args.id, "features": keep.get("features", []),
             "source": {"kind": "tt", "base": args.base, "faculty": args.faculty}}
    registry.write_text(json.dumps([t for t in tenants if t["id"] != args.id] + [entry], ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Итого: групп {len(groups)}, строк {len(lessons)}, записано в docs/data/{args.id}/")


if __name__ == "__main__":
    main()
