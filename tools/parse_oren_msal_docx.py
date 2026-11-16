"""Оренбургский институт МГЮА: docx-таблица «день | пара | время | группа1 … группаN» → docs/data/<tenant>/.

В клетке одно или несколько занятий через пустую строку: «Предмет преп. Фамилия И.О.
07.09-28.09, 05.10 ауд. 803». Диапазон дат — каждую неделю в этот день, отдельные даты —
как есть. Объединённая по горизонтали клетка — общее занятие для всех накрытых групп.

    python tools/parse_oren_msal_docx.py <tenant> file.docx
Группы, семестр и звонки берутся из существующего schedule.json тенанта.
"""
import json, re, sys
from datetime import date, timedelta
from pathlib import Path
from docx import Document

ROOT = Path(__file__).resolve().parent.parent
DAYS = {"понедельник": 1, "вторник": 2, "среда": 3, "четверг": 4, "пятница": 5, "суббота": 6}
RD = r"(\d{1,2})\.(\d{2})"


def dates_of(spec, wd, year_from, year_to):
    out = set()
    spec = spec.replace(" ", "")
    for part in re.split(r"[,;]", spec):
        part = part.strip(".")
        m = re.fullmatch(RD + r"-" + RD, part)
        one = re.fullmatch(RD, part)
        mk = lambda d, mo: date(year_from.year if int(mo) >= 8 else year_to.year, int(mo), int(d))
        try:
            if m:
                a, b = mk(m[1], m[2]), mk(m[3], m[4])
                x = a
                while x <= b:
                    if x.isoweekday() == wd:
                        out.add(x)
                    x += timedelta(days=1)
            elif one:
                x = mk(one[1], one[2])
                if x.isoweekday() == wd:
                    out.add(x)
        except ValueError:
            pass
    return out


def lessons_in(text):
    """«Предмет преп. Х 07.09-28.09 ауд. 111» → [(предмет, преподаватель, даты, аудитория)]."""
    out = []
    # Занятия разделены пустой строкой, а иногда просто переносом после
    # аудитории («… ауд. 801\nСудебная …») — режем и там.
    text = re.sub(r"((?:ауд\.?\s*\S+|спорт\.?\s*зал\.?[^\n]*))\n(?=\s*[А-ЯЁ])", r"\1\n\n", text.strip())
    text = re.sub(r"-\s*\.", "-", text)  # опечатка «25.09-.02.10»
    chunks = [c for c in re.split(r"\n\s*\n", text) if c.strip()]
    # Название отдельно от «преп. … даты» (пустая строка между ними) — склеиваем.
    merged = []
    for c in chunks:
        if merged and not re.search(r"\d{1,2}\.\d{2}", merged[-1]) and "преп" not in merged[-1]:
            merged[-1] += " " + c
        else:
            merged.append(c)
    for chunk in merged:
        t = re.sub(r"\s+", " ", chunk).strip()
        if not t:
            continue
        room = ""
        rm = re.search(r"ауд\.?\s*(\S+)", t, re.I)
        if rm:
            room = rm.group(1).strip(".,")
            t = (t[: rm.start()] + " " + t[rm.end():]).strip()
        sm = re.search(r"спорт\.?\s*зал\.?", t, re.I)
        if sm:
            room = "спортзал"
            t = (t[: sm.start()] + " " + t[sm.end():]).strip()
        dm = re.search(r"(" + RD + r"(?:\s*-\s*" + RD + r")?\.?(?:\s*,\s*" + RD + r"(?:\s*-\s*" + RD + r")?\.?)*)", t)
        spec = dm.group(1) if dm else ""
        if dm:
            t = (t[: dm.start()] + " " + t[dm.end():]).strip()
        pm = re.search(r"преп\.?\s*(.+)$", t)
        teacher = pm.group(1).strip(" .") if pm else ""
        subject = t[: pm.start()].strip(" ./") if pm else t.strip(" ./")
        out.append((re.sub(r"\s+", " ", subject), re.sub(r"\s+", " ", teacher), spec, room))
    return out


def main():
    tid, path = sys.argv[1:]
    o = ROOT / "docs" / "data" / tid
    old = json.loads((o / "schedule.json").read_text())
    p = old["meta"]["period"]
    d0 = date(*map(int, reversed(p["from"].split("."))))
    d1 = date(*map(int, reversed(p["to"].split("."))))
    bells = {b["start"]: b for b in old["bells"]}
    doc = Document(path)
    t = doc.tables[0]
    head = [c.text.strip() for c in t.rows[0].cells]
    gcols = {i: re.match(r"(\S+)", h).group(1) for i, h in enumerate(head) if re.match(r"ОИ\d", h)}
    rows = {}
    for r in t.rows[1:]:
        cells = r.cells
        day = DAYS.get(cells[0].text.strip().lower())
        tm = re.match(r"(\d{2})\.(\d{2})-(\d{2})\.(\d{2})", cells[2].text.strip())
        if not day or not tm:
            continue
        st, en = f"{tm[1]}:{tm[2]}", f"{tm[3]}:{tm[4]}"
        seen = {}
        for i, c in enumerate(cells):
            if i in gcols:
                seen.setdefault(id(c._tc), (c, []))[1].append(gcols[i])
        for c, groups in seen.values():
            for subj, teacher, spec, room in lessons_in(c.text):
                ds = dates_of(spec, day, d0, d1) if spec else set()
                if not ds:
                    continue
                for g in groups:
                    key = (g, day, st, subj, teacher, room)
                    rows.setdefault(key, set()).update(x for x in ds if d0 <= x <= d1)
    # Клетка с двумя преподавателями иностранного и второй парой без разделителя
    # (вт, 1 пара, гр. 1) разбирается криво — приводим к виду из файла.
    fixed = {}
    for (g, day, st, subj, teacher, room), ds in rows.items():
        if subj == "" and teacher.startswith("Мурадян"):
            subj = "Правовые основы обеспечения конкуренции, надлежащей рекламы и инвестиционного регулирования"
        if "преп. Бергер" in teacher:
            fixed.setdefault((g, day, st, subj, "Андрусенко Т.В. (подгр. 1), Бергер О.В. (подгр. 2)", "801 / 110"), set()).update(ds)
            continue
        # Иностранный по подгруппам: «Жукова Е.Э. преп. Лисогурская А.П. ауд. 102»
        # (первая аудитория уже в room) → два преподавателя и две аудитории.
        if "преп." in teacher:
            parts = [p.strip(" .") for p in re.split(r"\s*преп\.\s*", teacher) if p.strip(" .")]
            names, rooms = [], [room] if room else []
            for p in parts:
                p = re.sub(r"\s*\d{1,2}\.\d{2}(-\d{1,2}\.\d{2})?", "", p)
                m = re.match(r"(.+?)\s*ауд\.?\s*(\S+)", p)
                names.append((m.group(1) if m else p).strip(" ."))
                if m:
                    rooms.append(m.group(2))
            teacher = ", ".join(f"{n} (подгр. {i + 1})" for i, n in enumerate(names[:2])) if len(names) > 1 else names[0]
            room = " / ".join(rooms[:2])
        fixed.setdefault((g, day, st, subj, teacher, room), set()).update(ds)
    rows = fixed
    lessons = []
    for (g, day, st, subj, teacher, room), ds in rows.items():
        b = bells.get(st)
        lessons.append(dict(group=g, day=day, slot=b["n"] if b else 0, start=st, end=b["end"] if b else "", subject=subj, type="",
                            teacher=teacher, room=room, dates=sorted(x.isoformat() for x in ds), subgroup=None, elective=None, week="all", note="", link=""))
    old["lessons"] = lessons
    old["meta"]["updated"] = date.today().isoformat()
    (o / "schedule.json").write_text(json.dumps(old, ensure_ascii=False, separators=(",", ":")))
    print(len(lessons), "строк,", sum(len(l["dates"]) for l in lessons), "занятий; групп", len({l["group"] for l in lessons}))


if __name__ == "__main__":
    main()
