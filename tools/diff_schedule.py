"""Показывает, что изменилось между двумя версиями расписания.

    python tools/diff_schedule.py старое.json новое.json

Нужно для отчёта после автоматического обновления: «44 группы, 3570 пар»
ничего не говорит, а «у 311гэу изменился четверг» — говорит.
"""

import json
import sys
from collections import defaultdict
from pathlib import Path

DAYS = ["", "понедельник", "вторник", "среда", "четверг", "пятница", "суббота"]


def load(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def key(lesson):
    return (
        lesson["group"],
        lesson["day"],
        lesson["slot"],
        lesson["subject"],
        lesson.get("subgroup"),
        lesson.get("week"),
        lesson.get("room"),
        lesson.get("teacher"),
    )


def main():
    if len(sys.argv) < 3:
        sys.exit("Укажите два файла: старый и новый")

    old_path, new_path = sys.argv[1], sys.argv[2]
    new = load(new_path)

    if not Path(old_path).exists():
        print(f"Расписание опубликовано впервые: {len(new['groups'])} групп, "
              f"{len(new['lessons'])} пар.")
        return

    old = load(old_path)
    was, now = {key(l) for l in old["lessons"]}, {key(l) for l in new["lessons"]}

    added, removed = now - was, was - now
    if not added and not removed:
        print("Расписание не изменилось.")
        return

    groups_old = {g["id"] for g in old["groups"]}
    groups_new = {g["id"] for g in new["groups"]}

    lines = [f"Пар было {len(was)}, стало {len(now)}."]
    if groups_new - groups_old:
        lines.append(f"Новые группы: {', '.join(sorted(groups_new - groups_old))}")
    if groups_old - groups_new:
        lines.append(f"Пропали группы: {', '.join(sorted(groups_old - groups_new))}")

    # Где именно изменилось: группа и день.
    touched = defaultdict(set)
    for group, day, *_ in added | removed:
        touched[group].add(day)

    lines.append(f"Затронуто групп: {len(touched)}")
    for group in sorted(touched)[:12]:
        days = ", ".join(DAYS[d] for d in sorted(touched[group]))
        lines.append(f"  {group}: {days}")
    if len(touched) > 12:
        lines.append(f"  … и ещё {len(touched) - 12} групп")

    print("\n".join(lines))


main()
