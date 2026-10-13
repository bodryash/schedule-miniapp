"""Расписание курса ВМК МГУ из PDF с сайта факультета — в папку факультета.

Факультет выкладывает расписание курсов файлами PDF (cs.msu.ru → Учебный
процесс). Это та же таблица, что и в Excel (см. parse_vmk_xlsx.py), только
на пару приходится одна высокая клетка, а лекция на поток — одна широкая.
Границы клеток берём из самой страницы: так видно, на какие группы
растянута клетка. Внутри клетки строки читаем по порядку: предмет, потом
преподаватели; пара, записанная одной строкой вместе с преподавателем, и
две пары в одной клетке — занятия через неделю.

    python tools/parse_vmk_pdf.py 1_kurs.pdf --id msu-cmc --course 1 \\
        --from 2026-09-01 --to 2026-12-26 [--show]
"""

import argparse
import re
import sys
from pathlib import Path

import pdfplumber

sys.path.insert(0, str(Path(__file__).resolve().parent))
import parse_vmk_xlsx as base  # noqa: E402

LETTER = "А-Яа-яЁё"


def unspace(line):
    """«К у з ь м енкова Е.А.» → «Кузьменкова Е.А.»: PDF разрывает слова при выключке."""
    line = re.sub(r"\s+", " ", line).strip()
    # Инициалы, набранные латиницей («Потапов M.M.»), — в кириллицу.
    line = re.sub(
        r"(?<=[а-яё] )([A-Z])\s*\.\s*([A-Z])\s*\.",
        lambda m: m[0].translate(str.maketrans("ABCEHKMOPTXY", "АВСЕНКМОРТХУ")),
        line,
    )
    # Цепочка отдельных букв через пробел — одно слово.
    line = re.sub(rf"(?<![{LETTER}])((?:[{LETTER}] ){{2,}})(?=[{LETTER}])", lambda m: m[1].replace(" ", ""), line)
    # «М атематический» — оторванная первая буква.
    line = re.sub(rf"(?<![{LETTER}.])([А-ЯЁ]) (?=[а-яё]{{3,}})", r"\1", line)
    # «С . Г .» и «РудневС.Г.» после склейки.
    line = re.sub(r"([А-ЯЁ]) \.", r"\1.", line)
    line = re.sub(r"\.\s+([А-ЯЁ])\.", r".\1.", line)
    line = re.sub(r"([а-яё])([А-ЯЁ]\.[А-ЯЁ]\.)", r"\1 \2", line)
    # «Конс . Объектно - о риентированное» — разорванные точка и дефис.
    line = re.sub(rf"([{LETTER}]) \.", r"\1.", line)
    line = re.sub(rf"([а-яё]) - ([а-яё])", r"\1-\2", line)
    line = re.sub(rf"-([а-яё]) (?=[а-яё]{{3,}})", r"-\1", line)
    # В файле у этой строки срезано начало слова.
    line = line.replace("Конс. актикум", "Конс. Практикум")
    return line


def chunks_of(lines):
    """Строки клетки → [(предмет, преподаватели, через неделю?)] и то, что не понято."""
    done, subject, teacher, odd = [], [], [], []

    def flush():
        if subject:
            done.append([" ".join(subject), " ".join(teacher), False])
        subject.clear()
        teacher.clear()

    for line in lines:
        split = base.whole(line)
        person = base.PERSON.search(line)
        # Одна фамилия или одна аудитория на строке — хвост списка преподавателей.
        # Обрывок фамилии или инициалов, перенесённый на свою строку («Шабловский» / «А.А.. 786»).
        tail = re.fullmatch(
            rf"[А-ЯЁ][а-яё-]+(?:\s*\.?\s*[А-ЯЁ]\s*\.?){{0,2}}\.*,?(?:\s+[\dМЗП, -]+)?|[А-ЯЁ]\s*\.\s*[А-ЯЁ]\s*\.+,?(?:\s*[\dМЗП, -]+)?|[\d\s,МЗП-]+",
            line,
        ) and (teacher or (done and not subject))
        # «Философия Потапов» / «М.М. 505» — фамилия осталась на строке предмета.
        torn = re.fullmatch(r"[А-ЯЁ]\s*\.\s*[А-ЯЁ]\s*\.+,?(?:\s*[\dМЗП, -]+)?", line) and subject and not teacher
        surname = re.search(r"^(.*\S)\s+([А-ЯЁ][а-яё-]+)$", subject[-1]) if torn else None
        # «Колесов 582» — одна фамилия с аудиторией сразу после предмета.
        lone = re.fullmatch(r"[А-ЯЁ][а-яё-]+\s+[\dМЗП, -]+", line) and subject and not teacher
        if surname:
            subject[-1] = surname[1]
            teacher.append(f"{surname[2]} {line}")
        elif lone:
            teacher.append(line)
        elif split and subject and not teacher:
            # «Статистическая» / «физика Чичигина О.А. 607» — конец названия и преподаватель на одной строке.
            subject.append(split[0])
            teacher.append(split[1])
        elif split and not subject:
            flush()
            done.append([split[0], split[1], True])
        elif person and not split or (person and subject):
            if subject:
                teacher.append(line)
            elif done:
                done[-1][1] += " " + line
            else:
                odd.append(line)
        elif tail:
            if teacher:
                teacher.append(line)
            else:
                done[-1][1] += " " + line
        else:
            if teacher:
                flush()
            subject.append(line)
    flush()
    # Две пары в одной клетке делят её пополам — каждая идёт через неделю.
    if len(done) > 1:
        for item in done:
            item[2] = True
    return done, odd


def read_page(page):
    tables = page.find_tables()
    if not tables:
        return [], [], []
    table = max(tables, key=lambda t: len(t.cells))
    text_of = lambda box: [unspace(l) for l in (page.crop(box).extract_text() or "").split("\n") if l.strip()]

    # Столбцы групп: границы — из клеток шапки дня, номера — из любой шапки на
    # странице (в одной из них номер может не напечататься).
    edges, names = None, {}
    for row in table.rows:
        cells = row.cells
        if not cells or cells[0] is None:
            continue
        label = " ".join(text_of(cells[0])).lower()
        if label in base.DAYS and all(c is not None for c in cells):
            edges = edges or [(c[0], c[2]) for c in cells[1:]]
            for i, cell in enumerate(cells[1:]):
                name = "".join(text_of(cell))
                if re.fullmatch(r"\d{3}", name):
                    names[i] = name
    if not edges or not names:
        return [], [], []

    # Клетка времени бывает высотой в две строки: тогда пара разделена на
    # верхнюю и нижнюю половины — занятия через неделю. Нижняя строка идёт без
    # своей клетки времени, а клетка на всю высоту — обычная еженедельная пара.
    lessons, odd, day, bell, label, slot_box = [], [], 0, None, "", None
    for row in table.rows:
        cells = row.cells
        if not cells:
            continue
        lower = False
        if cells[0] is not None:
            label = " ".join(text_of(cells[0]))
            if label.lower() in base.DAYS:
                day, bell, slot_box = base.DAYS[label.lower()], None, None
                continue
            time = base.TIME.match(label)
            if not time:
                bell = None
                continue
            bell = (base.clock(time[1], time[2]), base.clock(time[3], time[4]))
            slot_box = cells[0]
        elif bell and slot_box and row.bbox[1] < slot_box[3] - 2:
            lower = True
        else:
            continue
        if not day or not bell:
            continue
        for cell in cells[1:]:
            if cell is None:
                continue
            # Половина клетки времени по высоте — половина пары.
            halved = lower or cell[3] < slot_box[3] - 3
            lines = text_of(cell)
            # Справа у таблицы бывает второй столбец со временем — это не пара.
            if not lines or base.TIME.match(" ".join(lines)):
                continue
            groups = [names[i] for i, (x0, x1) in enumerate(edges) if i in names and cell[0] - 2 <= (x0 + x1) / 2 <= cell[2] + 2]
            parts, strange = chunks_of(lines)
            # В нижней половине только преподаватель — это продолжение предмета из
            # верхней: обычная пара, записанная в две строки, а не занятие через неделю.
            if lower and strange and not parts:
                waiting = [l for l in lessons if l["day"] == day and l["_bell"] == bell and l["group"] in groups and not l["teacher"]]
                if waiting:
                    extra = base.parse_lesson("", " ".join(strange))
                    for lesson in waiting:
                        lesson["teacher"] = extra["teacher"]
                        lesson["room"] = ", ".join(r for r in (lesson["room"], extra["room"]) if r)
                        lesson["note"] = "; ".join(n for n in lesson["note"].split("; ") if n and n != "через неделю")
                    continue
            odd += [(f"стр. {page.page_number}", f"{label}", ",".join(groups), text) for text in strange]
            for subject_text, teacher_text, half in parts:
                half = half or (halved and bool(base.PERSON.search(teacher_text or "")))
                item = base.parse_lesson(subject_text, teacher_text)
                if not item["subject"] or not groups:
                    odd.append((f"стр. {page.page_number}", label, ",".join(groups), subject_text))
                    continue
                start, end = item.pop("start") or bell[0], item.pop("end")
                note = item.pop("note") + (["через неделю"] if half else [])
                for group in groups:
                    lessons.append({
                        "group": group, "day": day, "slot": base.slot_of(bell[0]), "_bell": bell, "subgroup": None, "elective": None, "week": "all",
                        "note": "; ".join(note), "link": "", "start": start, "end": base.fix_end(start, end or bell[1]), "type": "", **item,
                    })
    for lesson in lessons:
        del lesson["_bell"]
    return [names[i] for i in sorted(names)], lessons, odd


def main():
    parser = argparse.ArgumentParser(description="Расписание курса ВМК МГУ из PDF")
    parser.add_argument("table", type=Path)
    parser.add_argument("--id", required=True)
    parser.add_argument("--university", default="МГУ")
    parser.add_argument("--faculty", default="Факультет вычислительной математики и кибернетики")
    parser.add_argument("--short", default="ВМК")
    parser.add_argument("--course", type=int, required=True)
    parser.add_argument("--level", default="бакалавриат")
    parser.add_argument("--from", dest="start", required=True)
    parser.add_argument("--to", dest="end", required=True)
    parser.add_argument("--show", action="store_true", help="только напечатать разобранное, ничего не записывать")
    args = parser.parse_args()
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{1,30}", args.id) or args.id == "msu-fgp":
        sys.exit("--id: латиница, цифры и дефис; msu-fgp занят")

    names, lessons, odd = [], [], []
    with pdfplumber.open(args.table) as pdf:
        for page in pdf.pages:
            found = read_page(page)
            names += [g for g in found[0] if g not in names]
            lessons += found[1]
            odd += found[2]
    base.finish(args, names, lessons, odd)


if __name__ == "__main__":
    main()
