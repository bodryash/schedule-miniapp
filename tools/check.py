"""Сверяет разобранное расписание с исходным PDF по всем группам.

    python tools/check.py "путь/к/расписанию.pdf"

Проверяется самое хрупкое место разбора — привязка пары к группе. Пара,
общая для нескольких групп, свёрстана объединённой ячейкой, и pdfplumber
отдаёт её текст только в первой колонке диапазона, а в остальных — None.
Парсер разворачивает такие ячейки по этому признаку, и если признак
подведёт, пары молча уедут к чужой группе.

Сверка идёт по прямоугольникам ячеек: их границы заданы линиями таблицы и от
эвристики не зависят. Объединённая ячейка — один прямоугольник во всю ширину
диапазона, и какие колонки он накрывает, видно прямо из координат. Текст
внутри выровнен по центру всего прямоугольника, поэтому по координатам слов
покрытие определить нельзя — только по границам.

День определяется здесь заново, независимо от парсера: это тоже предмет
проверки.

Выход: список расхождений. Пустой — привязка верна.
"""

import json
import re
import sys
from collections import defaultdict
from pathlib import Path

import pdfplumber

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))

import parse_pdf as P  # noqa: E402

DATA = ROOT / "docs" / "data" / "schedule.json"
OVERLAP = 0.6  # какую долю колонки накрывает ячейка, чтобы считаться её


# В ячейке приставка стоит слитно («фНемецкий»), в данных она уже срезана.
RE_PREFIX = re.compile(r"(?:^|(?<=\s))(дв|ф)(?=[А-ЯЁA-Z])")


def flat(text):
    return re.sub(r"\s+", "", RE_PREFIX.sub("", text or "").lower())


def cells_by_group(row, values, columns):
    """Текст ячеек, накрывающих каждую колонку группы."""
    result = defaultdict(str)
    for col, box in enumerate(row.cells):
        if col < 2 or box is None:
            continue
        text = values[col] if col < len(values) else ""
        if not (text or "").strip():
            continue
        for gid, (left, right) in columns.items():
            width = right - left
            covered = min(box[2], right) - max(box[0], left)
            if width > 0 and covered / width >= OVERLAP:
                result[gid] += " " + text
    return result


def collect(pdf):
    """Строки таблиц с координатами колонок и проставленным днём."""
    entries = []
    marks = []
    columns = {}

    for page in pdf.pages:
        for table in page.find_tables():
            values_of = table.extract()
            for index, row in enumerate(table.rows):
                values = values_of[index]
                first = (values[0] or "").strip()

                if first == "Время":
                    columns = {}
                    for col, box in enumerate(row.cells):
                        name = (values[col] or "").strip()
                        if col >= 2 and name and box:
                            columns[name] = (box[0], box[2])
                    marks.append((len(entries), None))
                    continue

                day = P.DAYS.get(first[::-1].lower())
                if day:
                    marks.append((len(entries), day))

                match = P.RE_SLOT.search(values[1] or "")
                if match and columns:
                    entries.append(
                        {
                            "slot": int(match.group(1)),
                            "seen": cells_by_group(row, values, columns),
                            "day": None,
                        }
                    )

    # Метка дня действует до следующей. Новая шапка сбрасывает день: строки
    # после неё ждут ближайшую метку справа, потому что день мог начаться в
    # конце страницы, а подпись оказаться на следующей.
    pending = []
    current = None
    cursor = 0
    for index, entry in enumerate(entries):
        while cursor < len(marks) and marks[cursor][0] <= index:
            _, day = marks[cursor]
            if day is None:
                current = None
            else:
                current = day
                for waiting in pending:
                    waiting["day"] = day
                pending = []
            cursor += 1

        if current:
            entry["day"] = current
        else:
            pending.append(entry)

    return entries


def main():
    if len(sys.argv) < 2:
        sys.exit('Укажите PDF: python tools/check.py "расписание.pdf"')

    data = json.loads(DATA.read_text(encoding="utf-8"))
    slots = {b["n"] for b in data["bells"]}

    assigned = defaultdict(set)
    for lesson in data["lessons"]:
        assigned[(lesson["group"], lesson["day"], lesson["slot"])].add(lesson["subject"])

    with pdfplumber.open(sys.argv[1]) as pdf:
        entries = collect(pdf)

    problems = []

    # Один и тот же слот может встретиться в нескольких строках — например,
    # когда день разорван между страницами. Поэтому текст копим по слоту, а
    # не требуем полноты от каждой строки по отдельности.
    seen = defaultdict(str)
    for entry in entries:
        day, slot = entry["day"], entry["slot"]
        if not day:
            problems.append(f"пара {slot}: не удалось определить день")
            continue
        if slot not in slots:
            problems.append(f"пара {slot} вне таблицы звонков")
            continue
        for gid, text in entry["seen"].items():
            seen[(gid, day, slot)] += " " + text

    checked = len(seen)

    for (gid, day, slot), text in seen.items():
        haystack = flat(text)
        expected = assigned.get((gid, day, slot), set())

        for subject in expected:
            # Первых слов достаточно: длинные названия PDF переносит.
            if flat(subject)[:20] not in haystack:
                problems.append(
                    f"{gid}: день {day}, пара {slot} — «{subject}» "
                    f"нет в накрывающей ячейке"
                )

        # Ячейка, начинающаяся со строчной буквы, — перелив длинного
        # названия из соседней клетки. Парсер такие выбрасывает намеренно.
        spill = text.strip()[:1].islower()
        if not expected and not spill and len(haystack) > 20:
            problems.append(
                f"{gid}: день {day}, пара {slot} — ячейка не пуста, "
                f"но пар не назначено"
            )

    print(f"групп {len(data['groups'])}, пар {len(data['lessons'])}")
    print(f"проверено привязок: {checked}")

    if not problems:
        print("расхождений нет")
        return

    unique = sorted(set(problems))
    print(f"расхождений: {len(unique)}")
    for line in unique[:40]:
        print("  ", line)
    if len(unique) > 40:
        print(f"   … ещё {len(unique) - 40}")


main()
