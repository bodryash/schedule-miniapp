"""Указатель преподавателей для отмены пар по фамилии (/cancel преп …).

    python tools/teachers_index.py           — пересобрать по всем факультетам

Вызывается из parse_pdf.py (ФГП) и из ночного обновления. Боту незачем ради
одной фамилии разбирать мегабайты расписаний: здесь только кто, когда и у
какой группы ведёт. Факультеты все: у каждого своя чётность недель, а у
расписаний по датам (РУЗ) вместо чётности — список дат.

Имя приводится к «Фамилия И.О.» — то же написание, что в приложении:
«Гена Евгений Иванович», «доц. Е.И.Гена» и «Гена Е.И.» — один человек.
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from teacher_map import RE_ROOM, RE_TITLE, parse  # noqa: E402

import re  # noqa: E402
from datetime import date, timedelta  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "docs" / "data"
OUT = DATA / "teachers.json"
DEFAULT_TENANT = "msu-fgp"

WEEK_CODES = {"all": 0, "odd": 1, "even": 2}
DATES = 3


def people(teacher):
    """«зав.каф. Гвозданный В.А., проф. Агафонова Н.В.» → два человека без должностей."""
    result = []
    for part in re.split(r",\s*", str(teacher or "")):
        part = RE_ROOM.sub("", part, count=1).strip()
        titled = RE_TITLE.match(part)
        rest = re.sub(r"\s+\d+\S*$", "", part[titled.end():] if titled else part).strip(" ,")
        person = parse(rest)
        if not person:
            continue
        surname, initials = person
        result.append(f"{surname} {''.join(f'{c}.' for c in initials)}".strip())
    return result


def build(schedules):
    """schedules — [(id факультета, расписание)]. Имена, группы, предметы и
    факультеты — словарями, в строках только их номера."""
    teachers, groups, subjects, tenants = [], [], [], []
    lookup = {}

    def index(table, value):
        key = (id(table), value)
        if key not in lookup:
            lookup[key] = len(table)
            table.append(value)
        return lookup[key]

    # Прошедшие пары отменять незачем, а ночное обновление пересобирает файл:
    # хватает дат на три месяца вперёд. Иначе указатель весил бы 11 МБ.
    first = (date.today() - timedelta(days=1)).isoformat()
    last = (date.today() + timedelta(days=90)).isoformat()
    # Даты — номером дня от 1 января: «2026-10-19» → 291. Одинаковые занятия
    # на разные даты склеиваем в одну строку.
    epoch = date(date.today().year, 1, 1)
    rows = {}
    for tenant_id, data in schedules:
        t = len(tenants)
        tenants.append({"id": tenant_id, "weeks": data.get("weeks", [])})
        scoped = (lambda g: g) if tenant_id == DEFAULT_TENANT else (lambda g, p=tenant_id: f"{p}/{g}")
        for lesson in data.get("lessons", []):
            dates = lesson.get("dates")
            if dates:
                dates = [d for d in dates if first <= d <= last]
                if not dates:
                    continue
            for person in people(lesson.get("teacher")):
                key = (
                    index(teachers, person),
                    index(groups, scoped(lesson["group"])),
                    lesson["day"],
                    lesson["slot"],
                    DATES if dates else WEEK_CODES.get(lesson.get("week"), 0),
                    index(subjects, lesson["subject"]),
                    lesson.get("subgroup") or 0,
                    t,
                )
                days = rows.setdefault(key, set())
                for d in dates or []:
                    days.add((date.fromisoformat(d) - epoch).days)
    return {
        # Чётность ФГП — для старых версий бота, читавших одно поле.
        "weeks": next((data.get("weeks", []) for tid, data in schedules if tid == DEFAULT_TENANT), []),
        "tenants": tenants,
        "teachers": teachers,
        "groups": groups,
        "subjects": subjects,
        # teacher, group, day, slot, week (0 все, 1 нечётная, 2 чётная, 3 по датам),
        # subject, subgroup, tenant, [дни от 1 января] (для 3)
        "epoch": epoch.isoformat(),
        "lessons": [list(key) + ([sorted(days)] if days else []) for key, days in sorted(rows.items())],
    }


def load_all(fgp=None):
    schedules = []
    for tenant in json.loads((DATA / "tenants.json").read_text(encoding="utf-8")):
        if tenant["id"] == DEFAULT_TENANT and fgp is not None:
            schedules.append((tenant["id"], fgp))
            continue
        path = DATA / (tenant.get("path") or "") / "schedule.json"
        if path.exists():
            schedules.append((tenant["id"], json.loads(path.read_text(encoding="utf-8"))))
    return schedules


def write(fgp=None):
    """fgp — свежее расписание ФГП из parse_pdf, ещё не прочитанное с диска."""
    OUT.write_text(json.dumps(build(load_all(fgp)), ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


if __name__ == "__main__":
    write()
    index = json.loads(OUT.read_text(encoding="utf-8"))
    print(f"teachers.json: {len(index['teachers'])} преподавателей, {len(index['lessons'])} строк, {OUT.stat().st_size // 1024} КБ")
