"""Расписание журфака МГУ (.xlsx) — в таблицу для import_table.py.

Формат журфака: лист на курс/направление, день — отдельной строкой
(«ПОНЕДЕЛЬНИК»), под ним строка с номерами групп, дальше строки
«8.45- 10.15 | ячейки по группам». Лекция на поток — объединённая ячейка.
В одной ячейке бывает две пары по чётности, записанные подряд без
разделителя: «История России Гривастова неч.н. а. 321 Теория литературы
чет.н. Купцова а.322». Границу ищем по словарю предметов факультета:
новая пара начинается там, где начинается известное название.

    python tools/parse_journ_xlsx.py БАК.xlsx out.csv [непонятное.txt]

Листы практикума, спецкурсов и профмодулей устроены иначе — пропускаем
(их имена печатаются). Куски, где предмет не нашёлся в словаре,
выписываются в третий файл — их надо проверить глазами.
"""

import csv
import re
import sys

from openpyxl import load_workbook

DAYS = {"понедельник": "пн", "вторник": "вт", "среда": "ср", "четверг": "чт", "пятница": "пт", "суббота": "сб"}
RANGE = re.compile(r"(\d{1,2})[.:](\d{2})\s*[-–—]\s*(\d{1,2})[.:](\d{2})")
# Номер пары по началу: у 1 и 3 курсов звонки 8:45…, у 2 и 4 — 9:00…
SLOT_STARTS = [
    (1, ["08:45", "09:00"]),
    (2, ["10:40", "10:55"]),
    (3, ["12:20", "12:35", "12:50"]),
    (4, ["14:55", "15:00", "15:10"]),
    (5, ["16:30", "16:50", "17:05"]),
    (6, ["18:30", "18:35", "18:45"]),
]
PARITY = re.compile(r"(?<![а-яё])(неч(?:ет|ёт)?\.?\s*н\.?|ч[её]т\.?\s*н\.?)(?![а-яё])\s*,?", re.I)
ROOM = re.compile(r"(?:(?<![а-яё])а\.|ауд\.)\s*([A-Za-zА-Яа-яЁё]?-?\s?\d+[а-яa-z]?)", re.I)
# Слова, разорванные переносом в ячейке: «государствен ности», «Мультимедий ные».
JOINS = [
    (r"государствен\s+ности", "государственности"),
    (r"Мульти\s*медий\s*ные", "Мультимедийные"),
    (r"Мульти\s*ме\s*дийные", "Мультимедийные"),
    (r"журналис\s+тики", "журналистики"),
    (r"журналисти\s+ки", "журналистики"),
    (r"журна\s+листики", "журналистики"),
    (r"журна\s+листика", "журналистика"),
    (r"журналисти\s+ка", "журналистика"),
    (r"радиожурна\s+листики", "радиожурналистики"),
    (r"тележурна\s+листики", "тележурналистики"),
    (r"Радиожурна\s+листика", "Радиожурналистика"),
    (r"Фотожурна\s+листика", "Фотожурналистика"),
    (r"Телевизион\s+ная", "Телевизионная"),
    (r"ПРАВОВЕДЕ\s+НИЕ", "ПРАВОВЕДЕНИЕ"),
    (r"Редактирова\s+ние", "Редактирование"),
    (r"регулирова\s+ние", "регулирование"),
    (r"Международ\s+ная", "Международная"),
    (r"обществен\s+ностью", "общественностью"),
    (r"Выразитель\s+ные", "Выразительные"),
    (r"иллюстриро\s+вание", "иллюстрирование"),
    (r"Фотокомпо\s+зиция", "Фотокомпозиция"),
    (r"бильдредак\s+тирование", "бильдредактирование"),
    (r"Толоконнико\s+ва", "Толоконникова"),
    (r"Швыченко\s+ва", "Швыченкова"),
    (r"Крашенин\s+никова", "Крашенинникова"),
    (r"Шахиджа\s+нян", "Шахиджанян"),
    (r"Левандов\s+ский", "Левандовский"),
    (r"Мартемьяноваауд\.", "Мартемьянова ауд."),
    (r"интернет-\s+", "интернет-"),
    (r"онлайн\s*-\s*СМИ", "онлайн-СМИ"),
]
SKIP_SHEETS = re.compile(r"практикум|ск$|ПМ|стилистика", re.I)

# Предметы факультета. Порядок не важен: ищем самое длинное совпадение.
SUBJECTS = [
    "Анализ медиатекста", "Английский как язык глобальных медиакоммуникаций",
    "Архитектура и урбанистика", "Введение в мультимедийную журналистику",
    "Введение в связи с общественностью", "Веб-дизайн", "Веб-мастеринг",
    "Виды и регулирование рекламной деятельности", "Внутренние коммуникации компании",
    "Выпуск учебных медиа", "Выразительные средства современного радио",
    "Дизайн СМИ", "Дизайн и мода", "Драматургия телевидения", "Журналистика и общество",
    "Зарубежная литература", "Зарубежные медиасистемы", "Индустрия моды",
    "Индустрия книгоиздания", "Иностранный (русский) язык", "Иностранный язык",
    "Иностранный второй", "История ХХ века", "История России", "История",
    "История зарубежной журналистики", "История международной журналистики",
    "История российской журналистики", "История фотожурналистики",
    "История цифровых технологий", "Интернет-журналистика", "Информатика",
    "Компьютерная верстка", "Компьютерный дизайн и иллюстрирование СМИ",
    "Концепция и технологии современной редакции", "Креатив в рекламе",
    "Кризисные связи с общественностью", "Культура и международные отношения",
    "Культура речи", "Логика", "Медиабизнес", "Медиадизайн", "Медиаменеджмент",
    "Медиарилейшнз", "Медиасистема России", "Международная журналистика",
    "Международные отношения в многополярном мире", "Межфакультетские курсы МГУ",
    "Межфакультетские учебные курсы МГУ", "Менеджмент связей с общественностью",
    "Методика радиожурналистики", "Методика тележурналистики",
    "Методы работы журналиста-международника", "Мировая литература",
    "Музейно-галерейная индустрия", "Мультимедийная журналистика",
    "Мультимедийные технологии", "Организация, хранение и поиск информации в Интернете",
    "Основы высшей математики", "Основы дизайна", "Основы журналистики",
    "Основы информационного поиска", "Основы медиакоммуникаций", "Основы медиапланирования",
    "Основы подготовки текстов для печатных и интернет-изданий и журналов",
    "Основы подготовки текстов для печатных и интернет-изданий",
    "Основы программирования", "Основы радиожурналистики",
    "Основы российской государственности", "Основы тележурналистики",
    "Особенности создания текстов для онлайн-СМИ", "Политология", "Правоведение",
    "Правовое и этическое регулирование медиа", "Правовое регулирование СМИ", "Практикум",
    "Профмодуль-2", "Психология", "Работа журналиста в цифровой периодике",
    "Радиожурналистика", "Редактирование медиатекстов", "Реклама и связи с общественностью",
    "Реклама в медиабизнесе", "Рекламная деятельность", "Реклама",
    "Речевая культура журналиста-международника", "Русская литература",
    "Русский язык в профессиональной коммуникации", "Русский язык и культура речи",
    "Русский язык", "Связи с общественностью", "Современная цифровая периодика России",
    "Современное естествознание", "Современные государственные медиакоммуникации",
    "Современные медиаиндустрии", "Современный общественный процесс и журналистика",
    "Современный общественный процесс в журналистике",
    "Создание медиапроекта", "Создание текстов для интернет-СМИ",
    "Социальная и политическая реклама", "Социальные сети в работе журналиста",
    "Социология интернет-СМИ", "Социология медиакоммуникаций", "Социология",
    "Спецкурсы", "Спецкурс", "Статистика и анализ данных", "Стилистика русского языка",
    "Страноведение и медиаландшафт", "Страноведение", "Сценическое искусство",
    "Съемка и монтаж видео", "Творческие мастерские студенческих СМИ",
    "Телевизионная журналистика", "Теория литературы",
    "Техника и технология цифровой фотографии", "Технологии производства аудиоконтента",
    "Технология создания экранного произведения", "Физическая культура", "Философия",
    "Фотография в СМИ", "Фотожурналистика", "Фотокомпозиция и бильдредактирование",
    "Цифровая периодика", "Цифровой медиапроект", "Экология", "Экономика",
    "Экранное искусство", "Военная кафедра",
]


def pattern(name):
    words = [re.escape(w).replace("е", "[её]") for w in name.split()]
    return r"\s*".join(words) if len(words) == 1 else r"\s+".join(words)


SUBJECT_RE = re.compile(
    r"(?<![А-Яа-яЁё-])(" + "|".join(pattern(s) for s in sorted(SUBJECTS, key=len, reverse=True)) + r")(?![а-яё])",
    re.I,
)
CANON = {re.sub(r"\s+", " ", s.lower().replace("ё", "е")): s for s in SUBJECTS}


def canon(found):
    key = re.sub(r"\s+", " ", found.lower().replace("ё", "е"))
    return CANON.get(key, found)


def clean(text):
    text = str(text).replace("\xa0", " ")
    for a, b in JOINS:
        text = re.sub(a, b, text, flags=re.I)
    text = re.sub(r"\bвоенн\.\s*каф\.?", "Военная кафедра", text, flags=re.I)
    # «ПМ-2: СОВРЕМЕННЫЙ ОБЩЕСТВЕННЫЙ ПРОЦЕСС…» — приставка мешает делить ячейку.
    text = re.sub(r"\bПМ-2:\s*", "", text, flags=re.I)
    return re.sub(r"\s+", " ", text).strip()


def slot_of(start):
    """Номер пары — по ближайшему стандартному началу: время у курсов своё,
    а у отдельных пар бывает и вовсе особое (14:00, 14:40)."""
    h, m = map(int, start.split(":"))
    minutes = h * 60 + m
    best = min(SLOT_STARTS, key=lambda item: min(abs(minutes - int(x[:2]) * 60 - int(x[3:])) for x in item[1]))
    return best[0]


def name_case(word):
    return "-".join(part[:1].upper() + part[1:].lower() for part in word.split("-"))


def sentence(text):
    """«СОЦИАЛЬНО-ЭКОНОМИЧЕСКАЯ ГЕОГРАФИЯ» → «социально-экономическая география»."""
    letters = [ch for ch in text if ch.isalpha()]
    if letters and sum(ch.isupper() for ch in letters) > 0.7 * len(letters):
        return text.lower()
    return text


def split_items(text):
    """Ячейка → куски по одной паре: каждый начинается с названия предмета."""
    starts = [m.start() for m in SUBJECT_RE.finditer(text)]
    if not starts:
        return [text]
    # Хвост до первого предмета (редко: «в», пробелы) приклеиваем к первому куску.
    starts[0] = 0
    bounds = starts + [len(text)]
    return [text[a:b].strip(" ,;/") for a, b in zip(bounds, bounds[1:]) if text[a:b].strip(" ,;/")]


def parse_item(text):
    """Кусок с одной парой → предмет, преподаватели, аудитория, чётность."""
    m = SUBJECT_RE.search(text)
    known = bool(m)
    if m:
        subject = canon(m.group(1))
        lead = text[: m.start()].strip()
        rest = text[m.end():]
    else:
        subject, lead, rest = "", "", text
    note = []
    if lead:
        note.append(lead)
    # «Страноведение и медиаландшафт: Испания — Грачев а.327, Германия — …»:
    # по странам свои преподаватели и аудитории — оставляем текстом.
    if subject == "Страноведение и медиаландшафт" and re.search(r"\s[-–]\s", rest):
        return {"subject": subject, "teacher": "", "room": "", "week": "все", "type": "",
                "note": rest.strip(" :.,"), "known": True, "raw": text}
    # «СОВРЕМЕННОЕ ЕСТЕСТВОЗНАНИЕ: ЭТНОГРАФИЯ. Лекция» — уточнение после двоеточия.
    detail = re.match(r"\s*:\s*([^.,]+)", rest)
    if detail:
        subject = f"{subject}: {detail.group(1).strip().lower()}"
        rest = rest[detail.end():]
    week = "все"
    p = PARITY.search(rest)
    if p:
        week = "нечёт" if p.group(1).lower().startswith("неч") else "чёт"
        rest = rest[: p.start()] + " " + rest[p.end():]
    room = ""
    r = ROOM.search(rest)
    if r:
        room = r.group(1).replace(" ", "")
        rest = rest[: r.start()] + " " + rest[r.end():]
    for paren in re.findall(r"\(([^)]*)\)", rest):
        low = paren.lower()
        if "главное здание" in low:
            room = f"ГЗ {room}".strip()
        elif "ленгор" in low:
            room = "Ленинские горы"
        elif "корпус" in low:
            room = f"{room} ({paren})".strip() if room else paren
        else:
            note.append(sentence(paren))
        rest = rest.replace(f"({paren})", " ")
    if re.search(r"шуваловский\s+корп", rest, re.I):
        room = f"{room} (Шуваловский корпус)".strip()
        rest = re.sub(r"шуваловский\s+корп\.?", " ", rest, flags=re.I)
    if re.search(r"библиотека", rest, re.I):
        room = (room + " " if room else "") + "библиотека, читальный зал"
        rest = re.sub(r"библиотека,?\s*\(?чит\.?\s*зал\)?\.?\s*-?\s*!?", " ", rest, flags=re.I)
    dates = re.search(r"Лекции\s+((?:\d+,?\s*)+[а-я]+(?:,\s*(?:\d+,?\s*)+[а-я]+)*)", rest)
    if dates:
        note.append("лекции " + dates.group(1).strip(" ,"))
        rest = rest.replace(dates.group(0), " Лекция ")
    for d in re.findall(r"(?<!\d)\d{2}\.\d{2}(?!\d)", rest):
        note.append(d)
        rest = rest.replace(d, " ", 1)
    kind = ""
    if re.search(r"Лекци[яи]", rest, re.I):
        kind = "лекция"
        rest = re.sub(r"Лекци[яи]", " ", rest, flags=re.I)
    # Что осталось — фамилии (иногда с инициалами), «:», двоеточия от подзаголовков.
    teachers = []
    for t in re.finditer(r"([А-ЯЁ][А-ЯЁа-яё]+(?:-[А-ЯЁ][А-ЯЁа-яё]+)?)(\s+[А-ЯЁ]\.(?:\s*[А-ЯЁ]\.?)?)?", rest):
        word = t.group(1)
        if word.lower() in ("лекция", "лекции", "главное", "здание", "мгу", "мк", "мж", "рф"):
            continue
        teachers.append(name_case(word))
    rest_words = re.sub(r"[\s,.;:/!+-]+", " ", rest).strip()
    if not known:
        subject = rest_words
        teachers = []
    return {
        "subject": subject,
        "teacher": ", ".join(dict.fromkeys(teachers)),
        "room": room,
        "week": week,
        "type": kind,
        "note": "; ".join(n for n in note if n),
        "known": known,
        "raw": text,
    }


def read_sheet(ws):
    course = re.search(r"\d", ws.title)
    course = course.group(0) if course else ""
    merged = {}
    for rng in ws.merged_cells.ranges:
        merged[(rng.min_row, rng.min_col)] = rng.max_col
    day = None
    groups = {}
    span = None
    lessons = []
    media = None  # табличка «Расписание выпусков учебных медиа»: день, время, строки
    for row in ws.iter_rows():
        texts = [clean(c.value) for c in row if c.value is not None and clean(c.value)]
        first = clean(row[0].value or "") if row else ""
        if texts and texts[0].lower().startswith("декан"):
            break
        if texts and texts[0].lower().startswith("расписание выпусков учебных медиа"):
            head = texts[0]
            when = re.search(r"с\s*(\d{1,2})[.:](\d{2})\s*до\s*(\d{1,2})[.:](\d{2})", head)
            media_day = next((short for full, short in DAYS.items() if full[:5] in head.lower()), day)
            media = {"day": media_day, "span": (f"{int(when.group(1)):02d}:{when.group(2)}", f"{int(when.group(3)):02d}:{when.group(4)}") if when else None, "rows": []}
            continue
        if media is not None:
            label = first.lower().strip(" .")
            nums = {c.column: str(c.value).strip() for c in row[1:] if c.value is not None and re.fullmatch(rf"{course}\d{{2}}", str(c.value).strip())}
            if len(nums) >= 2 and not label:
                groups = nums
                continue
            if label == "дата":
                media["dates"] = {c.column: clean(c.value) for c in row[1:] if c.value is not None}
                continue
            if label.startswith("ауд"):
                rooms = {c.column: clean(c.value) for c in row[1:] if c.value is not None}
                teachers = {c.column: clean(c.value) for c in media["rows"][-1][1:] if c.value is not None} if media["rows"] else {}
                for col, group in groups.items():
                    dates = media.get("dates", {}).get(col, "")
                    if not dates or not media["span"]:
                        continue
                    lessons.append({"group": group, "course": course, "day": media["day"], "slot": slot_of(media["span"][0]),
                                    "start": media["span"][0], "end": media["span"][1], "sheet": ws.title, "cell": f"{ws.title}:{col}",
                                    "subject": "Выпуск учебных медиа", "teacher": name_case(teachers.get(col, "").split()[0]) if teachers.get(col) else "",
                                    "room": rooms.get(col, ""), "week": "все", "type": "", "note": "", "dates": dates,
                                    "known": True, "raw": "выпуск учебных медиа"})
                media = None
                continue
            media["rows"].append(row)
            continue
        if len(texts) == 1 and texts[0].lower() in DAYS:
            day, groups, span = DAYS[texts[0].lower()], {}, None
            continue
        nums = {c.column: str(c.value).strip() for c in row[1:] if c.value is not None and re.fullmatch(rf"{course}\d{{2}}", str(c.value).strip())}
        if len(nums) >= 2:
            groups = nums
            continue
        if not day or not groups:
            continue
        t = RANGE.search(first)
        if t:
            span = (f"{int(t.group(1)):02d}:{t.group(2)}", f"{int(t.group(3)):02d}:{t.group(4)}")
        elif first:
            # Подписи направлений под номерами групп и прочие пояснения.
            continue
        if not span:
            continue
        slot = slot_of(span[0])
        for c in row[1:]:
            if c.value is None or c.column > max(groups):
                continue
            text = clean(c.value)
            if not text:
                continue
            last = merged.get((c.row, c.column), c.column)
            covered = [groups[col] for col in range(c.column, last + 1) if col in groups]
            for piece in split_items(text):
                item = parse_item(piece)
                if not item["subject"]:
                    continue
                for g in covered:
                    lessons.append({"group": g, "course": course, "day": day, "slot": slot,
                                    "start": span[0], "end": span[1], "sheet": ws.title,
                                    "cell": c.coordinate, **item})
    return lessons


def read_practicum(ws):
    """Лист «2 практикум»: у каждой группы свой преподаватель и две даты."""
    head = clean(ws.cell(1, 1).value or "")
    when = RANGE.search(head)
    day = next((short for full, short in DAYS.items() if full[:5] in head.lower()), "вт")
    span = (f"{int(when.group(1)):02d}:{when.group(2)}", f"{int(when.group(3)):02d}:{when.group(4)}") if when else ("10:40", "17:50")
    course = re.search(r"\d", ws.title).group(0)
    lessons = []
    for row in ws.iter_rows(min_row=2, values_only=True):
        if not row or not re.fullmatch(rf"{course}\d{{2}}", str(row[0] or "").strip()):
            continue
        group, teacher = str(row[0]).strip(), clean(row[1] or "")
        for when_cell, room in ((row[2], row[3]), (row[4], row[5]) if len(row) > 5 else (None, None)):
            if not when_cell:
                continue
            day_text = when_cell.strftime("%d.%m") if hasattr(when_cell, "strftime") else clean(when_cell)
            lessons.append({"group": group, "course": course, "day": day, "slot": slot_of(span[0]), "start": span[0], "end": span[1],
                            "sheet": ws.title, "cell": group, "subject": "Практикум", "teacher": re.sub(r"\s+[А-ЯЁ]\.\s*[А-ЯЁ]\.?$", "", teacher),
                            "room": clean(room or ""), "week": "все", "type": "", "note": "", "dates": day_text,
                            "known": True, "raw": "практикум"})
    return lessons


def main():
    book = load_workbook(sys.argv[1])
    lessons = []
    for ws in book.worksheets:
        if re.search(r"практикум", ws.title, re.I):
            got = read_practicum(ws)
            print(f"лист «{ws.title}»: групп {len({l['group'] for l in got})}, занятий {len(got)}", file=sys.stderr)
            lessons.extend(got)
            continue
        if SKIP_SHEETS.search(ws.title.strip()) or not re.search(r"\d", ws.title):
            print(f"лист «{ws.title}»: пропускаю", file=sys.stderr)
            continue
        got = read_sheet(ws)
        print(f"лист «{ws.title}»: групп {len({l['group'] for l in got})}, пар {len(got)}", file=sys.stderr)
        lessons.extend(got)
    with open(sys.argv[2], "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(["группа", "курс", "уровень", "день", "пара", "неделя", "предмет", "тип", "преподаватель", "аудитория", "начало", "конец", "примечание", "даты"])
        for l in lessons:
            w.writerow([l["group"], l["course"], "бакалавриат", l["day"], l["slot"], l["week"], l["subject"], l["type"], l["teacher"], l["room"], l["start"], l["end"], l["note"], l.get("dates", "")])
    if len(sys.argv) > 3:
        seen = set()
        with open(sys.argv[3], "w", encoding="utf-8") as f:
            for l in lessons:
                key = (l["sheet"], l["cell"], l["raw"])
                if key in seen:
                    continue
                seen.add(key)
                if not l["known"] or l["note"]:
                    f.write(f"{l['sheet']} {l['cell']}: {l['raw']}\n   -> {l['subject']} | {l['teacher']} | {l['room']} | {l['week']} | {l['note']}\n")


if __name__ == "__main__":
    main()
