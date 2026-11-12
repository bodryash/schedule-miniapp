"""Тульский филиал Финуниверситета: PDF «по датам» → docs/data/fa-tula/.

Таблица без линий, по строкам: «02-сен-2026 СР 10:40 - 12:10 Предмет ВИД
Группа Должность ФИО ауд». Длинные названия переносятся на следующую строку
(в колонке предмета). Колонки берём по координатам заголовка.

Запуск: python tools/parse_fa_tula.py файл.pdf [ещё.pdf …]
Группы из всех файлов складываются; занятия группы заменяются целиком.
"""

import json
import re
import sys
from pathlib import Path

import pdfplumber

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "docs" / "data" / "fa-tula"
MONTHS = {"янв": 1, "фев": 2, "мар": 3, "апр": 4, "май": 5, "мая": 5, "июн": 6, "июл": 7, "авг": 8, "сен": 9, "окт": 10, "ноя": 11, "дек": 12}
RE_DATE = re.compile(r"^(\d{2})-([а-я]{3})-(\d{4})$")
RE_GROUP = re.compile(r"^\d{2}-\d[А-Яа-яA-Za-z]*-[А-Яа-яA-Za-z]+\d*$")
KINDS = {"ЛЕКЦИЯ": "лекция", "СЕМИНАР": "семинар", "ЛАБОРАТОРНАЯ": "лабораторная", "ПРАКТИКА": "практика", "ЗАЧЕТ": "зачёт", "ЗАЧЁТ": "зачёт", "ЭКЗАМЕН": "экзамен", "КОНСУЛЬТАЦИЯ": "консультация"}
WEEKDAY = {"ПН": 1, "ВТ": 2, "СР": 3, "ЧТ": 4, "ПТ": 5, "СБ": 6, "ВС": 7}


def rows_of(page):
    words = page.extract_words(keep_blank_chars=False, use_text_flow=False, x_tolerance=1.5)
    lines = []
    for w in sorted(words, key=lambda w: (round(w["top"]), w["x0"])):
        if lines and abs(lines[-1][0] - w["top"]) < 4:
            lines[-1][1].append(w)
        else:
            lines.append([w["top"], [w]])
    return [ws for _, ws in lines]


def parse(paths):
    lessons, groups, course = [], {}, 1
    for path in paths:
        with pdfplumber.open(path) as pdf:
            head = pdf.pages[0].extract_text() or ""
            m = re.search(r"СТУДЕНТОВ\s+(\d)\s+КУРСА", head)
            if m:
                course = int(m.group(1))
            cols = None
            last = None
            for page in pdf.pages:
                for ws in rows_of(page):
                    texts = [w["text"] for w in ws]
                    if "Предмет" in texts and "Специальность" in texts:
                        x = {w["text"]: w["x0"] for w in ws}
                        cols = {"subject": x["Предмет"] - 45, "kind": x["Вид"] - 5, "group": x["Специальность"] - 20, "teacher": x["ФИО"] - 40, "room": x["№"] - 15}
                        continue
                    if not cols:
                        continue
                    first = RE_DATE.match(ws[0]["text"])
                    if not first:
                        # Продолжение длинного названия предмета.
                        extra = [w["text"] for w in ws if cols["subject"] <= w["x0"] < cols["kind"]]
                        if last is not None and extra and len(ws) == len(extra):
                            last["subject"] = f'{last["subject"]} {" ".join(extra)}'.strip()
                        continue
                    d, mon, y = first.groups()
                    day = f"{y}-{MONTHS[mon]:02d}-{int(d):02d}"
                    rest = ws[1:]
                    wd = __import__("datetime").date(int(y), MONTHS[mon], int(d)).isoweekday()
                    times = [w["text"] for w in rest if re.match(r"^\d{1,2}:\d{2}$", w["text"])]
                    if len(times) < 2:
                        continue
                    part = lambda a, b: " ".join(w["text"] for w in rest if cols[a] <= w["x0"] < (cols[b] if b else 10**6)).strip()
                    subject = part("subject", "kind")
                    kind_raw = part("kind", "group").upper()
                    group = part("group", "teacher")
                    teacher = part("teacher", "room")
                    room = part("room", None)
                    if not RE_GROUP.match(group):
                        continue
                    # Должность в PDF чуть ниже строки и попадает в конец — ставим вперёд, строчными.
                    m_title = re.search(r"\s*\b(СТ\.ПР\.|ДОЦ\.|ПРОФ\.|ПР\.|АСС\.|ЗАВ\.КАФ\.)\s*", teacher)
                    if m_title:
                        teacher = f"{m_title.group(1).lower().replace('ст.пр.', 'ст. пр.')} {teacher.replace(m_title.group(0), ' ').strip()}"
                    start, end = (f"{int(t.split(':')[0]):02d}:{t.split(':')[1]}" for t in times[:2])
                    last = {
                        "group": group, "day": wd, "slot": 0, "start": start, "end": end, "subject": subject,
                        "type": KINDS.get(kind_raw, kind_raw.lower()), "teacher": teacher,
                        "room": "" if room in ("-", "—") else room, "dates": [day],
                        "subgroup": None, "elective": None, "week": "all", "note": "", "link": "",
                    }
                    lessons.append(last)
                    groups.setdefault(group, {"id": group, "title": group, "course": course, "level": "бакалавриат"})
    # Одинаковые пары (день недели, время, предмет, вид, преподаватель, ауд.) — одной строкой с датами.
    merged = {}
    for l in lessons:
        key = (l["group"], l["day"], l["start"], l["end"], l["subject"], l["type"], l["teacher"], l["room"])
        if key in merged:
            merged[key]["dates"].append(l["dates"][0])
        else:
            merged[key] = l
    out = list(merged.values())
    # Номер пары — по сетке филиала; точное время у каждой пары своё
    # (start/end): в разные дни пары сдвинуты на 10–30 минут.
    def slot_of(start):
        m = int(start[:2]) * 60 + int(start[3:])
        for n, upto in enumerate((10 * 60 + 15, 12 * 60 + 20, 14 * 60 + 20, 16 * 60 + 15, 18 * 60), 1):
            if m < upto:
                return n
        return 6
    bells = [{"n": 1, "start": "09:00", "end": "10:30"}, {"n": 2, "start": "10:40", "end": "12:10"}, {"n": 3, "start": "12:40", "end": "14:10"}, {"n": 4, "start": "14:40", "end": "16:10"}, {"n": 5, "start": "16:20", "end": "17:50"}, {"n": 6, "start": "18:00", "end": "19:30"}]
    for l in out:
        l["slot"] = slot_of(l["start"])
        l["dates"] = sorted(set(l["dates"]))
    return groups, out, bells


def weeks_between(first, last):
    """Недели семестра с понедельника; первая — нечётная. Нужны приложению,
    чтобы понимать, что идёт семестр (иначе пишет «Вне семестра»)."""
    from datetime import date, timedelta
    d = date.fromisoformat(first)
    d -= timedelta(days=d.weekday())
    end = date.fromisoformat(last)
    out, odd = [], True
    while d <= end:
        out.append({"from": d.isoformat(), "to": (d + timedelta(days=6)).isoformat(), "parity": "odd" if odd else "even"})
        d += timedelta(days=7)
        odd = not odd
    return out


def main():
    if len(sys.argv) < 2:
        sys.exit("python tools/parse_fa_tula.py файл.pdf")
    groups, lessons, bells = parse(sys.argv[1:])
    OUT.mkdir(parents=True, exist_ok=True)
    old = {}
    if (OUT / "schedule.json").exists():
        old = json.loads((OUT / "schedule.json").read_text(encoding="utf-8"))
    keep_groups = [g for g in old.get("groups", []) if g["id"] not in groups]
    keep = [l for l in old.get("lessons", []) if l["group"] not in groups]
    all_groups = sorted(keep_groups + list(groups.values()), key=lambda g: (g["course"], g["id"]))
    all_dates = sorted(d for l in lessons + keep for d in l["dates"])
    data = {
        "meta": {"updated": __import__("datetime").date.today().isoformat(), "semester": "1 семестр 2026/2027", "faculty": "Тульский филиал Финуниверситета", "dated": True,
                 "period": {"from": all_dates[0][8:] + "." + all_dates[0][5:7] + "." + all_dates[0][:4], "to": all_dates[-1][8:] + "." + all_dates[-1][5:7] + "." + all_dates[-1][:4]}},
        "weeks": weeks_between(all_dates[0], all_dates[-1]),
        "bells": bells,
        "groups": all_groups,
        "lessons": keep + lessons,
    }
    (OUT / "schedule.json").write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    (OUT / "groups.json").write_text(json.dumps(all_groups, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"групп {len(all_groups)}, строк {len(data['lessons'])}, занятий по датам {sum(len(l['dates']) for l in data['lessons'])}")


if __name__ == "__main__":
    main()
