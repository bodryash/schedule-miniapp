"""Похож ли присланный PDF на расписание.

В чат курса кладут не только расписание: методички, списки, объявления.
Бот не должен дёргать владельца кнопкой «обновить» на каждый файл, поэтому
перед этим файл прогоняется тем же парсером — но ничего не публикует.

Печатает JSON: {"schedule": true/false, "groups": N, "lessons": N, "why": "…"}.
"""

import json
import sys

import parse_pdf

# Расписание факультета — это десятки групп и сотни пар. Методичка или
# список литературы такого не дадут, даже если парсер что-то в них найдёт.
MIN_GROUPS = 5
MIN_LESSONS = 50


def probe(path):
    try:
        data = parse_pdf.parse(path)
    except Exception as error:  # разобрать не вышло — значит, не расписание
        return {"schedule": False, "groups": 0, "lessons": 0, "why": f"не разобрался: {error}"}

    groups = len(data.get("groups", []))
    lessons = len(data.get("lessons", []))
    if groups < MIN_GROUPS or lessons < MIN_LESSONS:
        return {
            "schedule": False,
            "groups": groups,
            "lessons": lessons,
            "why": f"слишком мало данных: групп {groups}, пар {lessons}",
        }
    return {"schedule": True, "groups": groups, "lessons": lessons, "why": ""}


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit("Укажите путь к PDF: python tools/probe_pdf.py file.pdf")
    print(json.dumps(probe(sys.argv[1]), ensure_ascii=False))
