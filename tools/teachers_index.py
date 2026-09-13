"""Указатель преподавателей для отмены пар по фамилии (/cancel преп …).

    python tools/teachers_index.py           — пересобрать из docs/data/schedule.json

Вызывается и из parse_pdf.py. Боту незачем ради одной фамилии разбирать
мегабайт расписания: здесь только кто, когда и у какой группы ведёт.
"""

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCHEDULE = ROOT / "docs" / "data" / "schedule.json"
OUT = ROOT / "docs" / "data" / "teachers.json"

# Должность перед фамилией: «проф.», «ст.пр.», «ст. пр.», «зав. каф.»,
# «с.н.с», слитное «акад.Акаев». Строчными, с точками или без.
RE_TITLE = re.compile(r"^(?:[а-яё]{1,6}\.*\s*)+(?=[А-ЯЁA-Z])")
# Аудитория, съехавшая в колонку преподавателя: «113Б, пр. Панюта С.И.».
RE_ROOM = re.compile(r"^\d{3}[А-ЯЁ]?\b")
# Фамилия и инициалы в любом написании: «Бойко А. А», «КорчагинаТ.И.».
RE_NAME = re.compile(
    r"^([А-ЯЁ][а-яё]+(?:-[А-ЯЁ][а-яё]+)?)\s*(?:([А-ЯЁ])\.?\s*(?:([А-ЯЁ])\.?)?)?$"
)


def canonical(name):
    """Одно написание на человека — иначе «Бойко А. А» и «Бойко А.А.» стали бы двумя."""
    match = RE_NAME.match(name)
    if not match:
        return name  # «Хуа Цзя» и прочее без инициалов — как есть
    surname, first, middle = match.groups()
    initials = "".join(f"{letter}." for letter in (first, middle) if letter)
    return f"{surname} {initials}".strip()


def people(teacher):
    """«зав.каф. Гвозданный В.А., проф. Агафонова Н.В.» → два человека без должностей."""
    result = []
    for part in re.split(r",\s*", teacher or ""):
        part = RE_ROOM.sub("", part.strip()).strip(" ,")
        name = RE_TITLE.sub("", part).strip(" ,")
        if name and re.match(r"[А-ЯЁA-Z]", name):
            result.append(canonical(name))
    return result


WEEK_CODES = {"all": 0, "odd": 1, "even": 2}


def build(data):
    """Имена, группы и предметы — словарями, в строках только их номера: так
    файл в разы меньше, а воркер разбирает его быстрее."""
    teachers, groups, subjects = [], [], []

    def index(table, value):
        if value not in table:
            table.append(value)
        return table.index(value)

    rows = set()
    for lesson in data["lessons"]:
        for person in people(lesson.get("teacher")):
            rows.add(
                (
                    index(teachers, person),
                    index(groups, lesson["group"]),
                    lesson["day"],
                    lesson["slot"],
                    WEEK_CODES[lesson["week"]],
                    index(subjects, lesson["subject"]),
                    lesson.get("subgroup") or 0,
                )
            )
    return {
        "weeks": data["weeks"],
        "teachers": teachers,
        "groups": groups,
        "subjects": subjects,
        # teacher, group, day, slot, week (0 все, 1 нечётная, 2 чётная), subject, subgroup
        "lessons": sorted(rows),
    }


def write(data):
    OUT.write_text(
        json.dumps(build(data), ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
    )


if __name__ == "__main__":
    write(json.loads(SCHEDULE.read_text(encoding="utf-8")))
    if "--check" in sys.argv:
        index = json.loads(OUT.read_text(encoding="utf-8"))
        print(len(index["teachers"]), "преподавателей,", len(index["lessons"]), "строк")
        for name in sorted(index["teachers"]):
            print(" ", name)
