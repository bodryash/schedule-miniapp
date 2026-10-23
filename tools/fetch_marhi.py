"""Расписание МАРХИ с сайта skaud.marhi.ru — в таблицу для import_table.py.

Сайт показывает неделю группы формой: курс (30:2 — «Б, 2 курс») и группа.
Строка «row-one» — половинка пары: верхняя — нечётная неделя, нижняя —
чётная. Дисциплины со звёздочкой — по выбору: идут списком, аудитории
в том же порядке. Преподавателей сайт не показывает.

    python tools/fetch_marhi.py out.csv
"""

import csv
import html
import re
import sys
import time
import urllib.parse
import urllib.request

URL = "https://skaud.marhi.ru/scripts/marhi.xwb?rasp"
DAYS = {"понедельник": "пн", "вторник": "вт", "среда": "ср", "четверг": "чт", "пятница": "пт", "суббота": "сб"}
LEVELS = {"30": ("бакалавриат", ""), "32": ("бакалавриат", "вечер"), "40": ("магистратура", ""), "42": ("магистратура", "вечер")}


def post(fields):
    data = urllib.parse.urlencode(fields).encode()
    req = urllib.request.Request(URL, data=data, headers={"content-type": "application/x-www-form-urlencoded", "user-agent": "Mozilla/5.0"})
    for attempt in range(3):
        try:
            return urllib.request.urlopen(req, timeout=40).read().decode("utf-8", "ignore")
        except Exception:
            time.sleep(2 + attempt * 3)
    raise RuntimeError("сайт не отвечает")


def text(cell):
    cell = re.sub(r"<br\s*/?>", "\n", cell)
    return [html.unescape(re.sub(r"<[^>]+>", "", line)).strip() for line in cell.split("\n") if re.sub(r"<[^>]+>", "", line).strip()]


def parse(page):
    i = page.find('<div class="rasp-accord">')
    j = page.find("</table>", i)
    table = page[i:j]
    day = None
    out = []
    slots = {}
    half = {}
    for row in re.findall(r"<tr[^>]*>.*?</tr>", table, re.S):
        head = re.search(r'wday-head">([^<]+)<', row)
        if head:
            day = DAYS.get(head.group(1).strip().lower())
            slots, half = {}, {}
            continue
        if not day:
            continue
        cells = re.findall(r'<td class="cell-(time|disc|auds)"[^>]*>(.*?)</td>', row, re.S)
        if not cells:
            continue
        cell = {k: v for k, v in cells}
        time_text = text(cell.get("time", ""))
        if time_text:
            current = time_text[0]
        else:
            current = list(slots)[-1] if slots else None
        if not current:
            continue
        if current not in slots:
            slots[current] = len(slots) + 1
        one = 'class="row-one"' in row
        week = "все"
        if one:
            half[current] = half.get(current, 0) + 1
            week = "нечёт" if half[current] == 1 else "чёт"
        subjects = text(cell.get("disc", ""))
        rooms = text(cell.get("auds", ""))
        if not subjects:
            continue
        start, end = [s.strip() for s in current.split("-")]
        elective = any(s.startswith("*") for s in subjects)
        if elective and len(rooms) == len(subjects):
            pairs = list(zip(subjects, rooms))
        else:
            pairs = [(s, ", ".join(rooms)) for s in subjects]
        for subject, room in pairs:
            out.append({"day": day, "slot": slots[current], "week": week, "start": start, "end": end,
                        "subject": subject.lstrip("* ").strip(), "room": room, "elective": "да" if subject.startswith("*") else ""})
    return out


def main():
    first = post({"rasp-sess": "0", "rasp-curs": "none", "rasp-grup": "none", "rasp-date": ""})
    courses = re.findall(r'<option value="(\d+:\d+)"[^>]*>([^<]+)</option>', first)
    rows = []
    for value, label in courses:
        kind, course = value.split(":")
        level, mode = LEVELS.get(kind, ("бакалавриат", ""))
        page = post({"rasp-sess": "0", "rasp-curs": value, "rasp-grup": "none", "rasp-date": ""})
        box = re.search(r'<select id="rasp-grup".*?</select>', page, re.S)
        groups = re.findall(r"<option>([^<]+)</option>", box.group(0)) if box else []
        for name in groups:
            got = parse(post({"rasp-sess": "0", "rasp-curs": value, "rasp-grup": name, "rasp-date": ""}))
            time.sleep(0.3)
            if not got:
                continue
            gid = f"{name}{' (веч.)' if mode else ''}" if kind in ("30", "32") else f"{name} маг.{' (веч.)' if mode else ''}"
            gid = f"{course} курс · {gid}"
            for l in got:
                rows.append([gid, course, level, l["day"], l["slot"], l["week"], l["subject"], "", "", l["room"], l["start"], l["end"], "", l["elective"]])
            print(f"{label} {name}: {len(got)}", file=sys.stderr)
    with open(sys.argv[1], "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(["группа", "курс", "уровень", "день", "пара", "неделя", "предмет", "тип", "преподаватель", "аудитория", "начало", "конец", "примечание", "выбор"])
        w.writerows(rows)
    print(f"строк: {len(rows)}", file=sys.stderr)


if __name__ == "__main__":
    main()
