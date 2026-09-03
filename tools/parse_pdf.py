"""Разбирает PDF расписания ФГП МГУ в docs/data/schedule.json.

Запуск:
    python tools/parse_pdf.py "путь/к/расписанию.pdf"

Структура исходника: на каждой странице одна таблица. Внутри неё повторяются
блоки «шапка с номерами групп → строки пар». Первая колонка несёт название дня,
повёрнутое на 90° (pdfplumber отдаёт его задом наперёд: «киньледеноП»).

Пара, общая для нескольких групп, свёрстана как объединённая ячейка. pdfplumber
отдаёт текст в первой колонке диапазона, а в остальных — None, тогда как
по-настоящему пустая ячейка приходит как ''. На этом различии и держится
разворачивание пар по группам.
"""

import json
import re
import sys
from datetime import date
from pathlib import Path

import pdfplumber

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "docs" / "data" / "schedule.json"

DAYS = {
    "понедельник": 1,
    "вторник": 2,
    "среда": 3,
    "четверг": 4,
    "пятница": 5,
    "суббота": 6,
}

# Лк — лекция, Сем — семинар, Лб — лабораторная, Пз/Пр — практическое занятие.
KINDS = {
    "Лк": "лекция",
    "Сем": "семинар",
    "Лб": "лабораторная",
    "Пз": "практика",
    "Пр": "практика",
}

RE_SLOT = re.compile(r"^(\d+)\s*пара\s*\n([\d.]+)\s*\n([\d.]+)", re.MULTILINE)
RE_COURSE = re.compile(r"(\d)\s*курса")
RE_PERIOD = re.compile(r"\((\d{2}\.\d{2}\.\d{4})\s*-\s*(\d{2}\.\d{2}\.\d{4})\)")

# Вид занятия иногда набран капсом («ЛК»), поэтому регистр игнорируем.
RE_KIND = re.compile(r",?\s*\b(лк|сем|лб|пз|пр)\b\s*,", re.IGNORECASE)
RE_KIND_MARK = re.compile(r"\b(?:лк|сем|лб|пз|пр)\b\s*,", re.IGNORECASE)

# Пара заканчивается инициалами преподавателя и необязательной пометкой
# в скобках. Инициалов может быть два или один («пр. Дзанолетти И.»), а
# точка в конце иногда потеряна («доц. Билюга С.Э»). Занятие без
# преподавателя обрывается на аудитории.
# Проверка на строчную букву следом отсекает сокращения вроде «ауд.В.каф.».
RE_TEACHER_END = re.compile(
    r"[А-ЯЁ]\.\s*(?:[А-ЯЁ]\.?)?(?![а-яё])(?:\s*\([^)]*\))?"
)
RE_ROOM_SEGMENT = re.compile(r"ауд\.?[^,]*,")

# Не у всех преподавателей есть инициалы («пр. Хуа Цзя»), поэтому запасной
# признак конца пары — должность и следом слова с заглавной буквы.
RE_TEACHER_PLAIN = re.compile(
    r"(?:проф|доц|ст\.?\s?пр|пр|зав\.каф|асс)\.\s*"
    r"(?:[А-ЯЁ][а-яё]+|[А-ЯЁ]\.)(?:\s+(?:[А-ЯЁ][а-яё]+|[А-ЯЁ]\.))*"
)

# В исходнике пометка иногда обрезана шириной ячейки: «(четная» без скобки.
RE_PAREN_OPEN = re.compile(r"\s*\(([^)]*)$")

# Приставки к названию пишутся слитно: дв — дисциплина по выбору,
# ф — факультатив. Стоят либо в начале, либо после номера языка
# («3-ий фНемецкий язык»), а дальше сразу заглавная буква.
PREFIXES = {"дв": "по выбору", "ф": "факультатив"}
RE_PREFIX = re.compile(r"(?:^|(?<=\s))(дв|ф)(?=[А-ЯЁ])")
RE_ROOM = re.compile(r"ауд\.?\s*")
RE_SUBGROUP = re.compile(r",?\s*гр\.\s*(\d+)\s*,")
RE_PAREN = re.compile(r"\s*\(([^)]*)\)")

# Вёрстка рисует разделитель между парами внутри одной ячейки.
RE_DASHES = re.compile(r"^[\s\-–—]{3,}$", re.MULTILINE)

RE_WEEKS = re.compile(r"(нечетные|четные)\s+недели:\s*([^\n]+)")
RE_RANGE = re.compile(r"(\d{2})\.(\d{2})\s*-\s*(\d{2})\.(\d{2})")


def norm(text):
    return re.sub(r"\s+", " ", (text or "").replace("\n", " ")).strip()


def parse_lesson(chunk):
    """Разбирает «Название Лк, ауд.440, проф. Иванов И.И.» на поля."""
    text = norm(chunk)
    if not text:
        return None

    lesson = {"subgroup": None, "elective": None, "week": "all", "note": ""}

    # Пометки в скобках: чётность недели либо произвольное примечание
    # («с 11.09.2026 года», «необходим ноутбук»).
    notes = []
    parens = RE_PAREN.findall(text)
    text = RE_PAREN.sub("", text)
    # Незакрытая пометка в конце — обрезанная шириной ячейки исходника.
    unclosed = RE_PAREN_OPEN.search(text)
    if unclosed:
        parens.append(unclosed.group(1))
        text = text[: unclosed.start()]

    for paren in parens:
        value = norm(paren).lower()
        if value.startswith("нечетная"):
            lesson["week"] = "odd"
        elif value.startswith("четная"):
            lesson["week"] = "even"
        else:
            notes.append(norm(paren))
    lesson["note"] = "; ".join(notes)
    text = text.strip()

    sub = RE_SUBGROUP.search(text)
    if sub:
        lesson["subgroup"] = int(sub.group(1))
        text = RE_SUBGROUP.sub(", ", text, count=1)

    kind = RE_KIND.search(text)
    if kind:
        lesson["type"] = KINDS[kind.group(1).capitalize()]
        subject = text[: kind.start()]
        tail = text[kind.end():]
    else:
        lesson["type"] = None
        subject = text
        tail = ""

    subject = subject.strip().strip(",").strip()
    # Ячейка может начинаться обрывком пометки из склеенной строки выше
    # («неделя) Микроэкономика») — закрывающая скобка без открывающей.
    if ")" in subject and "(" not in subject:
        subject = subject.split(")", 1)[1].strip()
    prefix = RE_PREFIX.search(subject)
    if prefix:
        lesson["elective"] = PREFIXES[prefix.group(1)]
        subject = (subject[: prefix.start(1)] + subject[prefix.end(1):]).strip()
    lesson["subject"] = subject

    room, teacher = "", ""
    if tail:
        parts = [p.strip() for p in tail.split(",")]
        for part in parts:
            if RE_ROOM.match(part):
                room = RE_ROOM.sub("", part).strip()
            elif part:
                teacher = f"{teacher}, {part}" if teacher else part
    lesson["room"] = room
    lesson["teacher"] = teacher.strip().strip(",")

    return lesson if lesson["subject"] else None


def split_lessons(cell):
    """Одна ячейка может содержать несколько пар — режет её на куски.

    Резать по началу следующей пары нельзя: название переносится на
    несколько строк, и граница уезжает — начало следующей пары прилипает к
    предыдущей, а её собственное название теряется. Поэтому ищем конец пары.

    После вида занятия идёт «ауд.X, преподаватель», и пара кончается
    инициалами плюс возможной пометкой в скобках. Если преподавателя нет —
    как у военной подготовки, — кончается на аудитории.
    """
    text = norm(RE_DASHES.sub(" ", cell or ""))
    if not text:
        return []

    marks = list(RE_KIND_MARK.finditer(text))
    if not marks:
        return [text]

    chunks = []
    start = 0
    for i, mark in enumerate(marks):
        tail_from = mark.end()
        tail_to = marks[i + 1].start() if i + 1 < len(marks) else len(text)
        tail = text[tail_from:tail_to]

        ends = list(RE_TEACHER_END.finditer(tail))
        plain = list(RE_TEACHER_PLAIN.finditer(tail))
        if ends:
            end = tail_from + ends[-1].end()
        elif plain:
            end = tail_from + plain[-1].end()
        else:
            room = RE_ROOM_SEGMENT.search(tail)
            end = tail_from + (room.end() if room else len(tail))

        chunks.append(text[start:end].strip())
        start = end

    rest = text[start:].strip()
    if rest:
        # Обрезанная пометка «(четная» относится к предыдущей паре, а не
        # начинает новую.
        if chunks and rest.startswith("(") and ")" not in rest:
            chunks[-1] += " " + rest
        else:
            chunks.append(rest)
    return [chunk for chunk in chunks if chunk]


def parse_weeks(text, period):
    """Календарь чётных/нечётных недель из примечания под таблицей."""
    if not period:
        return []
    year = int(period[0].split(".")[-1])
    end_year = int(period[1].split(".")[-1])
    out = []
    for kind, listing in RE_WEEKS.findall(text):
        parity = "odd" if kind == "нечетные" else "even"
        for d1, m1, d2, m2 in RE_RANGE.findall(listing):
            # Семестр может переходить через Новый год — месяц подскажет.
            y1 = year if int(m1) >= int(period[0].split(".")[1]) else end_year
            y2 = year if int(m2) >= int(period[0].split(".")[1]) else end_year
            out.append(
                {
                    "from": f"{y1}-{m1}-{d1}",
                    "to": f"{y2}-{m2}-{d2}",
                    "parity": parity,
                }
            )
    return out


def read_blocks(pdf, groups, weeks, state):
    """Режет страницы на блоки «шапка → строки пар» и проставляет дни.

    Один день — один блок. Подпись дня стоит вертикально в первой колонке
    первой строки блока, но день может начаться в конце страницы, а подпись
    оказаться уже на следующей: тогда блок остаётся без дня и берёт его у
    следующего блока, а не у предыдущего.
    """
    blocks = []
    course = None

    for page in pdf.pages:
        text = page.extract_text() or ""
        found = RE_COURSE.search(text)
        if found:
            course = int(found.group(1))
        if state["period"] is None:
            found = RE_PERIOD.search(text)
            if found:
                state["period"] = found.groups()
        weeks.extend(parse_weeks(text, state["period"]))

        for table in page.extract_tables():
            for row in table:
                first = norm(row[0])

                if first == "Время":
                    for col, name in enumerate(row):
                        if col < 2 or not name:
                            continue
                        gid = norm(name)
                        groups.setdefault(
                            gid, {"id": gid, "title": gid, "course": course}
                        )
                    blocks.append({"header": row, "day": None, "rows": []})
                    continue

                if not blocks:
                    continue

                # Название дня записано вертикально и приходит развёрнутым.
                reversed_first = first[::-1].lower()
                if reversed_first in DAYS:
                    blocks[-1]["day"] = DAYS[reversed_first]

                blocks[-1]["rows"].append(row)

    # Блок без подписи — начало дня в конце страницы. День у следующего блока.
    for i in range(len(blocks) - 2, -1, -1):
        if blocks[i]["day"] is None:
            blocks[i]["day"] = blocks[i + 1]["day"]

    return [b for b in blocks if b["day"]]


def parse(pdf_path):
    groups = {}
    lessons = []
    bells = {}
    weeks = []
    state = {"period": None}

    with pdfplumber.open(pdf_path) as pdf:
        for block in read_blocks(pdf, groups, weeks, state):
            header, day = block["header"], block["day"]

            for row in block["rows"]:
                slot_match = RE_SLOT.search(row[1] or "")
                if not slot_match:
                    continue
                slot = int(slot_match.group(1))
                bells.setdefault(
                    slot,
                    {
                        "n": slot,
                        "start": slot_match.group(2).replace(".", ":"),
                        "end": slot_match.group(3).replace(".", ":"),
                    },
                )

                # Разворачиваем объединённые ячейки: None — продолжение
                # пары слева, '' — действительно пустая клетка.
                owner = None
                for col in range(2, len(header)):
                    gid = norm(header[col]) if header[col] else None
                    if not gid:
                        continue
                    cell = row[col] if col < len(row) else ""

                    if cell is None:
                        if owner is None:
                            continue
                        cell = owner
                    else:
                        owner = cell if cell.strip() else None
                        if not cell.strip():
                            continue

                    for chunk in split_lessons(cell):
                        lesson = parse_lesson(chunk)
                        if lesson:
                            lessons.append(
                                {"group": gid, "day": day, "slot": slot, **lesson}
                            )

    data = {
        "meta": {
            "updated": date.today().isoformat(),
            "semester": "Осенний семестр 2026/2027",
            "faculty": "Факультет глобальных процессов МГУ",
            "period": (
                {"from": state["period"][0], "to": state["period"][1]}
                if state["period"]
                else None
            ),
        },
        # Примечание повторяется на каждой странице — оставляем по одному.
        "weeks": [
            {"from": f, "to": t, "parity": p}
            for f, t, p in sorted({(w["from"], w["to"], w["parity"]) for w in weeks})
        ],
        "bells": [bells[n] for n in sorted(bells)],
        "groups": sorted(groups.values(), key=lambda g: (g["course"] or 0, g["id"])),
        "lessons": lessons,
    }
    return data


def main():
    if len(sys.argv) < 2:
        sys.exit("Укажите путь к PDF: python tools/parse_pdf.py schedule.pdf")
    data = parse(sys.argv[1])
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"групп: {len(data['groups'])}, пар: {len(data['lessons'])} → {OUT}")


if __name__ == "__main__":
    main()
