"""Список межфакультетских курсов (МФК) с сайта lk.msu.ru.

В расписании ФГП МФК стоит одной строкой «Межфакультетский учебный курс»:
какой именно курс выбрал студент, в PDF не написано. Поэтому список курсов
со временем и аудиторией берём из личного кабинета МГУ — эта часть сайта
открыта и логина не требует.

Запуск: python tools/fetch_mfk.py → docs/data/mfk.json
"""

import json
import re
import sys
import time
import urllib.request
from html.parser import HTMLParser
from pathlib import Path

SITE = "https://lk.msu.ru"
OUT = Path(__file__).resolve().parent.parent / "docs" / "data" / "mfk.json"
PAGES = 40
DAYS = ["понедельник", "вторник", "среда", "четверг", "пятница", "суббота"]


# Сайт закрывает соединение, если представляться скриптом, и изредка рвёт
# его просто так — поэтому обычные заголовки браузера и пара попыток.
HEADERS = {
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    "accept": "text/html,application/xhtml+xml",
    "accept-language": "ru,en;q=0.8",
}


def load(url, tries=3):
    for attempt in range(tries):
        try:
            request = urllib.request.Request(url, headers=HEADERS)
            with urllib.request.urlopen(request, timeout=30) as response:
                return response.read().decode("utf-8", "replace")
        except Exception:
            if attempt == tries - 1:
                raise
            time.sleep(2 * (attempt + 1))


class Text(HTMLParser):
    """Текст страницы без разметки — с разделителями на месте тегов."""

    def __init__(self):
        super().__init__()
        self.parts = []

    def handle_data(self, data):
        self.parts.append(data)

    def handle_starttag(self, tag, attrs):
        self.parts.append("\n")

    def handle_endtag(self, tag):
        self.parts.append("\n")

    @property
    def text(self):
        return re.sub(r"[ \t]+", " ", "".join(self.parts))


def plain(html):
    parser = Text()
    parser.feed(html)
    return parser.text


def field(text, name):
    """«Где», «Когда», «Семестр» — подпись и значение идут подряд."""
    match = re.search(rf"\n\s*{name}\s*\n\s*([^\n]+)", text)
    return match.group(1).strip() if match else ""


def course_ids():
    ids = {}
    for page in range(1, PAGES + 1):
        html = load(f"{SITE}/course?page={page}")
        found = re.findall(r'href="/course/view\?id=(\d+)"[^>]*>([^<]+)<', html)
        if not found:
            break
        fresh = False
        for id_, title in found:
            if int(id_) not in ids:
                ids[int(id_)] = re.sub(r"\s+", " ", title).strip()
                fresh = True
        # Сайт на последней странице повторяет её содержимое — так и ловим конец.
        if not fresh:
            break
    return ids


def when_parts(when):
    """«Среда 17:00–18:30» → день недели (1–6), начало и конец."""
    match = re.match(r"\s*([А-Яа-яЁё]+)\s+(\d{1,2}:\d{2})\s*[–-]\s*(\d{1,2}:\d{2})", when)
    if not match:
        return None, "", ""
    day = match.group(1).lower()
    number = DAYS.index(day) + 1 if day in DAYS else None
    return number, match.group(2), match.group(3)


def main():
    ids = course_ids()
    courses = []
    for number, (id_, title) in enumerate(sorted(ids.items()), 1):
        try:
            text = plain(load(f"{SITE}/course/view?id={id_}"))
        except Exception as error:
            print(f"пропускаю {id_}: {error}", file=sys.stderr)
            continue
        day, start, end = when_parts(field(text, "Когда"))
        courses.append(
            {
                "id": id_,
                "title": title,
                "faculty": field(text, "Факультет") or "",
                "where": field(text, "Где"),
                "day": day,
                "start": start,
                "end": end,
                "semester": field(text, "Семестр"),
            }
        )
        if number % 25 == 0:
            print(f"…{number} из {len(ids)}", file=sys.stderr)

    courses.sort(key=lambda c: c["title"].lower())
    OUT.write_text(json.dumps(courses, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"курсов: {len(courses)} → {OUT}")


if __name__ == "__main__":
    main()
