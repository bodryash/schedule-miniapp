"""Указатель для режима преподавателя: на каких факультетах вуза ведёт человек.

    python tools/teacher_map.py      — пересобрать docs/data/teacher-map.json

Многие преподаватели читают на двух-трёх факультетах. Приложение по этому
файлу подгружает расписания только тех факультетов, где встречается фамилия.
В файл попадают только люди с парами на двух и более факультетах одного
вуза — остальным он не нужен. Ключ «Фамилия И.О.» — то же написание, что в
приложении (teachersOf в docs/app.js); фамилии без инициалов не берём:
однофамильцев на разных факультетах слишком много.
"""

import json
import re
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "docs" / "data"
OUT = DATA / "teacher-map.json"

# Те же выражения, что в teachersOf. \b в JS понимает только латиницу и цифры —
# re.ASCII даёт то же поведение.
RE_ROOM = re.compile(r"^\d{3}[А-ЯЁ]?\b\s*", re.ASCII)
RE_TITLE = re.compile(r"^((?:[а-яё]{1,6}\.*\s*)+)(?=[А-ЯЁA-Z])")
SURNAME = r"[А-ЯЁ][а-яё]+(?:-[А-ЯЁ][а-яё]+)?"
NAME_SHORT = re.compile(rf"^({SURNAME})\s*(?:([А-ЯЁ])\.?\s*(?:([А-ЯЁ])\.?)?)?$")
NAME_FULL = re.compile(rf"^({SURNAME})\s+([А-ЯЁ])[а-яё]+(?:\s+([А-ЯЁ])[а-яё]+)?$")
NAME_FIRST = re.compile(rf"^([А-ЯЁ])\.\s*(?:([А-ЯЁ])\.\s*)?({SURNAME})$")
NOT_A_PERSON = re.compile(r"^(преподавател|вакансия|кафедра|сотрудник)", re.I)


def parse(text):
    """«Гена Е.И.», «Гена Евгений Иванович», «Е.И.Гена» → («Гена», [Е, И])."""
    if NOT_A_PERSON.match(text):
        return None
    for pattern, order in ((NAME_SHORT, (1, 2, 3)), (NAME_FULL, (1, 2, 3)), (NAME_FIRST, (3, 1, 2))):
        m = pattern.match(text)
        if m:
            return m.group(order[0]), [c for c in (m.group(order[1]), m.group(order[2])) if c]
    return None


def keys(field):
    for part in re.split(r",\s*", str(field or "")):
        part = RE_ROOM.sub("", part, count=1).strip()
        titled = RE_TITLE.match(part)
        rest = re.sub(r"\s+\d+\S*$", "", part[titled.end():] if titled else part)
        person = parse(rest)
        if not person or not person[1]:
            continue
        yield f"{person[0]} " + "".join(f"{c}." for c in person[1])


def main():
    places = defaultdict(lambda: defaultdict(set))
    for tenant in json.loads((DATA / "tenants.json").read_text(encoding="utf-8")):
        path = DATA / (tenant.get("path") or "") / "schedule.json"
        if not path.exists():
            continue
        schedule = json.loads(path.read_text(encoding="utf-8"))
        for lesson in schedule.get("lessons", []):
            for key in keys(lesson.get("teacher")):
                places[tenant["university"]][key].add(tenant["id"])
    result = {}
    for university, people in sorted(places.items()):
        shared = {key: sorted(ids) for key, ids in sorted(people.items()) if len(ids) > 1}
        if shared:
            result[university] = shared
    OUT.write_text(json.dumps(result, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    total = sum(len(v) for v in result.values())
    print(f"teacher-map: {total} преподавателей на нескольких факультетах, {OUT.stat().st_size // 1024} КБ")


if __name__ == "__main__":
    main()
