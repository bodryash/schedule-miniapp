"""РГУП им. В.М. Лебедева: расписание курса из Word (.docx) → таблица для import_table.py.

В таблице: слева время пары, дальше дни. Внутри пары — строка на каждую группу
(«6 гр. Предмет / Преподаватель Ауд. 1013»), а общая лекция — ячейка,
объединённая на все группы («лекция / Предмет / Преподаватель / Ауд. 1»).
Если в одной ячейке две лекции, первая — нечётная неделя, вторая — чётная
(так подписана шапка файла).

    python tools/parse_rgup_docx.py файл.docx --course 3 --suffix ЮБ > таблица.csv
"""

import argparse
import csv
import html
import re
import sys
import zipfile

DAYS = {"Понедельник": "пн", "Вторник": "вт", "Среда": "ср", "Четверг": "чт", "Пятница": "пт", "Суббота": "сб"}
BELLS = ["10.00", "12.00", "13.50", "15.45", "17.15"]
TITLES = r"(?:[ДК]\.\s?ю\.\s?н\.|[дк]\.\s?п\.\s?н\.|доц\.|проф\.|ст\.\s?пр\.|преп\.)"


def text_of(tc):
    paras = [html.unescape("".join(re.findall(r"<w:t[^>]*>([^<]*)</w:t>", p))) for p in re.findall(r"<w:p[ >].*?</w:p>", tc, re.S)]
    return " / ".join(re.sub(r"\s+", " ", p).strip() for p in paras if p.strip())


def person(text):
    text = re.sub(TITLES, " ", text)
    text = re.sub(r"\s+", " ", text)
    return re.sub(r"(?:\s*,)+\s*,", ",", text).strip(" ,/")


def split_room(text):
    found = re.search(r"Ауд\.?\s*([\w-]+)", text)
    room = found[1] if found else ""
    return (text[:found.start()] if found else text).strip(" /"), room


def lectures(cell):
    """«лекция / Предмет / Преподаватель / Ауд. 1 [/ лекция / …]» → [(предмет, преподаватель, ауд.)]."""
    out = []
    for chunk in re.split(r"(?:^| / )лекция / ", cell)[1:]:
        parts = [p.strip() for p in chunk.split(" / ") if p.strip()]
        subject = parts[0] if parts else ""
        rest, room = split_room(" / ".join(parts[1:]))
        out.append((subject, person(rest), room))
    return out


def group_lesson(cell):
    """«6 гр. Предмет / Преподаватель Ауд. 1013» → (предмет, преподаватель, ауд.)."""
    body = re.sub(r"^\d\s*гр\.\s*\+?", "", cell).strip()
    if not body:
        return None
    subject, _, rest = body.partition(" / ")
    rest, room = split_room(rest)
    subject = re.sub(r"^ражданск", "Гражданск", subject.strip())  # опечатка в файле
    return subject, person(rest), room


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("docx")
    parser.add_argument("--course", type=int, required=True)
    parser.add_argument("--suffix", default="", help="как называть группы: «6» + «ЮБ»")
    args = parser.parse_args()
    x = zipfile.ZipFile(args.docx).read("word/document.xml").decode("utf8")

    rows = []
    for table in re.findall(r"<w:tbl>.*?</w:tbl>", x, re.S):
        carry, days, time = {}, [], ""
        for tr in re.findall(r"<w:tr[ >].*?</w:tr>", table, re.S):
            cells, col = [], 0
            for tc in re.findall(r"<w:tc>.*?</w:tc>", tr, re.S):
                span = int((re.search(r'gridSpan w:val="(\d+)"', tc) or [0, 1])[1])
                merge = re.search(r'<w:vMerge(?: w:val="(\w+)")?\s*/>', tc)
                own = carry.get(col, "") if merge and merge[1] != "restart" else text_of(tc)
                carry[col] = own
                cells.append(own)
                col += span
            if any(c in DAYS for c in cells):
                days = cells
                continue
            if not days:
                continue
            if re.match(r"^\d{1,2}\.\d{2}", cells[0]):
                time = cells[0][:5].strip()
            number = next((m[1] for c in cells[1:] if (m := re.match(r"^(\d)\s*гр\.", c))), None)
            if not number or time not in BELLS:
                continue
            slot = BELLS.index(time) + 1
            group = f"{number}{args.suffix}"
            for day, cell in zip(days[1:], cells[1:]):
                if day not in DAYS or not cell:
                    continue
                if re.match(r"^\d{1,2}\.\d{2}\s*/", cell):  # своё время: «10.00 / Физкультура …»
                    start = cell[:5].replace(".", ":")
                    title, _, who = cell[8:].partition(" / ")
                    rows.append([group, args.course, "бакалавриат", DAYS[day], 1, "все", title.capitalize(), "", person(who.replace(" / ", " ")), "", start, "13:20", ""])
                    continue
                if cell.startswith("лекция"):
                    found = lectures(cell)
                    weeks = ["все"] if len(found) == 1 else ["нечёт", "чёт"]
                    for (subject, teacher, room), week in zip(found, weeks):
                        rows.append([group, args.course, "бакалавриат", DAYS[day], slot, week, subject, "лекция", teacher, room, "", "", ""])
                    continue
                if re.match(rf"^{number}\s*гр\.", cell):
                    lesson = group_lesson(cell)
                    if lesson:
                        subject, teacher, room = lesson
                        rows.append([group, args.course, "бакалавриат", DAYS[day], slot, "все", subject, "семинар", teacher, room, "", "", ""])
    # Физкультура растянута на две пары — оставляем одну строку на группу.
    seen, unique = set(), []
    for row in rows:
        key = tuple(row)
        if key not in seen:
            seen.add(key)
            unique.append(row)
    sys.stdout.reconfigure(encoding="utf-8")
    out = csv.writer(sys.stdout, lineterminator="\n")
    out.writerow(["группа", "курс", "уровень", "день", "пара", "неделя", "предмет", "тип", "преподаватель", "аудитория", "начало", "конец", "примечание"])
    out.writerows(unique)


if __name__ == "__main__":
    main()
