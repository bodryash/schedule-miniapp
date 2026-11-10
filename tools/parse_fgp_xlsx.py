"""Разбирает Excel-расписание ФГП МГУ (листы «1 курс» … «4 курс») в docs/data/schedule.json.

Запуск:
    python tools/parse_fgp_xlsx.py "путь/к/расписанию.xlsx"

Сетка та же, что в PDF: блоки «Время | | 101 | 102 …», в первой колонке день,
во второй — «1 пара 09.00 10.30». Пара на несколько групп — объединённая
ячейка: текст лежит в левой верхней клетке, остальные пустые. Текст ячеек
разбираем теми же функциями, что и PDF (parse_pdf.py), — названия, виды
занятий, аудитории и пометки недель получаются в том же виде.

Листы: «1 курс» … «4 курс» — бакалавриат, «1_им», «1_мм», «2_им», «2_мм» —
магистратура. Курс и уровень берём из заголовка листа («1 курса магистратуры»),
а если его нет — из названия листа. Группы, которых в файле нет вовсе, берём
из текущего schedule.json как есть.
"""

import json
import re
import sys
from datetime import date

import openpyxl

import parse_pdf as P

RE_SLOT_XLSX = re.compile(r"(\d+)\s*пара\s+([\d.:]+)\s+([\d.:]+)")
RE_COURSE_SHEET = re.compile(r"(\d)\s*курс")


def merged_map(ws):
    """Клетка → (текст левой верхней клетки, сколько колонок накрывает)."""
    out = {}
    for rng in ws.merged_cells.ranges:
        top = ws.cell(rng.min_row, rng.min_col).value
        for r in range(rng.min_row, rng.max_row + 1):
            for c in range(rng.min_col, rng.max_col + 1):
                out[(r, c)] = (top, rng.min_col, rng.max_col)
    return out


def parse(path, old):
    wb = openpyxl.load_workbook(path, data_only=True)
    groups, lessons, bells = {}, [], {}
    weeks, period = [], None
    for ws in wb.worksheets:
        merged = merged_map(ws)
        text_all = "\n".join(str(c) for row in ws.iter_rows(values_only=True) for c in row if c)
        head = P.RE_COURSE.search(text_all)
        if head:
            course, level = int(head.group(1)), P.LEVELS[head.group(2)]
        else:
            m = re.match(r"^(\d)_", ws.title) or RE_COURSE_SHEET.search(ws.title)
            if not m:
                continue
            course = int(m.group(1))
            level = "магистратура" if "_" in ws.title else "бакалавриат"
        if period is None:
            found = P.RE_PERIOD.search(text_all)
            if found:
                period = found.groups()
        weeks.extend(P.parse_weeks(text_all, period))

        columns = {}
        day = None
        last_lesson = {}
        for r in range(1, ws.max_row + 1):
            first = P.norm(str(ws.cell(r, 1).value or ""))
            second = str(ws.cell(r, 2).value or "")
            if first == "Время":
                columns = {}
                for c in range(3, ws.max_column + 1):
                    name = P.norm(str(ws.cell(r, c).value or ""))
                    if name:
                        columns[c] = name
                        groups.setdefault(name, {"id": name, "title": name, "course": course, "level": level})
                continue
            if first.lower() in P.DAYS:
                day = P.DAYS[first.lower()]
            slot_m = RE_SLOT_XLSX.search(second.replace("\n", " "))
            if not slot_m or not day or not columns:
                continue
            slot = int(slot_m.group(1))
            bells.setdefault(slot, {"n": slot, "start": slot_m.group(2).replace(".", ":"), "end": slot_m.group(3).replace(".", ":")})
            per_group = {}
            for c, gid in columns.items():
                if (r, c) in merged:
                    value, c0, c1 = merged[(r, c)]
                else:
                    value = ws.cell(r, c).value
                if value is None or not str(value).strip():
                    continue
                per_group[gid] = str(value)
            for gid, cell in per_group.items():
                lead = P.RE_LEADING_WEEK.match(cell)
                if lead:
                    cell = cell[lead.end():]
                    above = last_lesson.get((gid, day))
                    if above and above["slot"] == slot - 1 and above["week"] == "all":
                        above["week"] = "odd" if lead.group(1) else "even"
                for chunk in P.split_lessons(cell):
                    lesson = P.parse_lesson(chunk)
                    if lesson:
                        entry = {"group": gid, "day": day, "slot": slot, **lesson}
                        lessons.append(entry)
                        last_lesson[(gid, day)] = entry

    P.repair_truncated(lessons)
    lessons = P.drop_duplicates(lessons)

    # Магистратура и всё, чего нет в файле, — из текущих данных без изменений.
    fresh = set(groups)
    kept_groups = [g for g in old.get("groups", []) if g["id"] not in fresh]
    kept_lessons = [l for l in old.get("lessons", []) if l["group"] not in fresh]
    for b in old.get("bells", []):
        bells.setdefault(b["n"], b)

    all_weeks = {(w["from"], w["to"], w["parity"]) for w in weeks} or {(w["from"], w["to"], w["parity"]) for w in old.get("weeks", [])}
    data = {
        "meta": {
            **old.get("meta", {}),
            "updated": date.today().isoformat(),
            "period": {"from": period[0], "to": period[1]} if period else old.get("meta", {}).get("period"),
        },
        "weeks": [{"from": f, "to": t, "parity": p} for f, t, p in sorted(all_weeks)],
        "bells": [bells[n] for n in sorted(bells)],
        "groups": sorted(list(groups.values()) + kept_groups, key=lambda g: (g["level"] != "бакалавриат", g["course"] or 0, g["id"])),
        "lessons": lessons + kept_lessons,
    }
    return data


def main():
    if len(sys.argv) < 2:
        sys.exit('Укажите путь к XLSX: python tools/parse_fgp_xlsx.py "расписание.xlsx"')
    old = json.loads(P.OUT.read_text(encoding="utf-8")) if P.OUT.exists() else {}
    data = parse(sys.argv[1], old)
    P.dated_notes(data)
    # Запись — как у PDF: общий файл, список групп, файлы по группам, указатель преподавателей.
    P.OUT.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    P.GROUPS.write_text(json.dumps(data["groups"], ensure_ascii=False, indent=1), encoding="utf-8")
    P.shutil.rmtree(P.BY_GROUP, ignore_errors=True)
    P.BY_GROUP.mkdir(parents=True)
    for group in data["groups"]:
        part = {
            "meta": data["meta"],
            "weeks": data["weeks"],
            "bells": data["bells"],
            "group": group,
            "lessons": [l for l in data["lessons"] if l["group"] == group["id"]],
        }
        (P.BY_GROUP / f"{group['id']}.json").write_text(json.dumps(part, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    P.teachers_index.write(data)
    print(f"групп: {len(data['groups'])}, пар: {len(data['lessons'])} → {P.OUT}")


if __name__ == "__main__":
    main()
