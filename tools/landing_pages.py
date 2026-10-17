"""Открытые страницы факультетов — чтобы приложение находили в поиске.

    python tools/landing_pages.py   → docs/f/<факультет>/index.html, docs/f/index.html, docs/sitemap.xml

Само расписание живёт в Telegram, и поисковик его не видит. Для каждого
факультета — маленькая страница: какой вуз, какие группы, что умеет
приложение, кнопка «Открыть в Telegram». Перестраивается ночным обновлением.
"""

import html
import json
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DOCS = ROOT / "docs"
DATA = DOCS / "data"
SITE = "https://bodryash.github.io/schedule-miniapp/"
BOT = "https://t.me/FGPshedulebot"

STYLE = """
:root { --bg: #f6f7fb; --card: #fff; --text: #14161f; --muted: #626879; --accent: #2f6bff; --line: #e3e6ef; }
@media (prefers-color-scheme: dark) { :root { --bg: #0f1117; --card: #181b24; --text: #eef0f6; --muted: #9aa1b2; --accent: #6d98ff; --line: #2a2f3c; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
main { max-width: 720px; margin: 0 auto; padding: 32px 16px 48px; }
.uni { color: var(--muted); font-size: 14px; margin: 0 0 4px; }
h1 { font-size: 28px; line-height: 1.2; margin: 0 0 12px; }
p { margin: 0 0 14px; }
.open { display: inline-block; margin: 8px 0 24px; padding: 14px 22px; border-radius: 14px; background: var(--accent); color: #fff; font-weight: 700; text-decoration: none; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 16px; padding: 18px; margin: 0 0 16px; }
h2 { font-size: 18px; margin: 0 0 10px; }
ul.features { margin: 0; padding-left: 20px; }
ul.features li { margin: 4px 0; }
.groups { display: flex; flex-wrap: wrap; gap: 6px; }
.groups span { padding: 3px 9px; border-radius: 8px; background: var(--bg); border: 1px solid var(--line); font-size: 14px; }
.list a { display: block; padding: 8px 0; border-bottom: 1px solid var(--line); color: var(--text); text-decoration: none; }
.list a:last-child { border-bottom: 0; }
.list small { color: var(--muted); }
footer { color: var(--muted); font-size: 13px; margin-top: 24px; }
footer a { color: var(--muted); }
"""

FEATURES = [
    "расписание вашей группы на день и неделю, с чётными и нечётными неделями",
    "отмены и замены пар — сразу в расписании и сообщением от бота",
    "напоминания утром и за 15 минут до пары",
    "пары в календаре телефона",
    "свободные аудитории, очереди на сдачу, домашние задания",
    "режим преподавателя — все пары на всех факультетах вуза",
]


def page(title, description, canonical, body):
    return f"""<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{html.escape(title)}</title>
<meta name="description" content="{html.escape(description)}">
<link rel="canonical" href="{canonical}">
<meta property="og:title" content="{html.escape(title)}">
<meta property="og:description" content="{html.escape(description)}">
<meta property="og:type" content="website">
<style>{STYLE}</style>
</head>
<body>
<main>
{body}
<footer>Студенческий проект, не официальный ресурс вуза. Расписание берётся из открытых источников. <a href="../../privacy.html">Конфиденциальность</a></footer>
</main>
</body>
</html>
"""


def groups_of(tenant):
    path = DATA / (tenant.get("path") or "") / "groups.json"
    if not path.exists():
        return []
    raw = json.loads(path.read_text(encoding="utf-8"))
    items = raw.get("groups", raw) if isinstance(raw, dict) else raw
    return [str(g.get("title") or g.get("id")) for g in items if isinstance(g, dict)]


def main():
    tenants = json.loads((DATA / "tenants.json").read_text(encoding="utf-8"))
    out_dir = DOCS / "f"
    out_dir.mkdir(exist_ok=True)
    urls = []
    rows = []
    for tenant in tenants:
        slug = tenant["id"]
        uni, faculty = tenant["university"], tenant["faculty"]
        groups = groups_of(tenant)
        title = f"Расписание: {faculty} — {uni}"
        description = f"Расписание занятий {faculty} ({uni}) в Telegram: пары группы на день и неделю, отмены и замены, напоминания и календарь телефона."
        chips = "".join(f"<span>{html.escape(g)}</span>" for g in groups[:300])
        features = "".join(f"<li>{html.escape(f)}</li>" for f in FEATURES)
        body = f"""<p class="uni">{html.escape(uni)}</p>
<h1>Расписание — {html.escape(faculty)}</h1>
<p>Расписание факультета уже есть в Telegram-приложении: откройте бота, выберите факультет и группу — и пары всегда под рукой.</p>
<a class="open" href="{BOT}">Открыть в Telegram</a>
<div class="card"><h2>Что умеет</h2><ul class="features">{features}</ul></div>
{f'<div class="card"><h2>Группы ({len(groups)})</h2><div class="groups">{chips}</div></div>' if groups else ''}
<p><a href="../">Все вузы и факультеты</a></p>"""
        target = out_dir / slug
        target.mkdir(exist_ok=True)
        url = f"{SITE}f/{slug}/"
        (target / "index.html").write_text(page(title, description, url, body), encoding="utf-8")
        urls.append(url)
        rows.append((uni, faculty, slug, len(groups)))

    rows.sort(key=lambda r: (r[0], r[1]))
    blocks = []
    current = None
    for uni, faculty, slug, n in rows:
        if uni != current:
            if current is not None:
                blocks.append("</div>")
            blocks.append(f'<div class="card list"><h2>{html.escape(uni)}</h2>')
            current = uni
        blocks.append(f'<a href="{slug}/">{html.escape(faculty)} <small>· групп: {n}</small></a>')
    blocks.append("</div>")
    hub = f"""<h1>Расписание вузов в Telegram</h1>
<p>Пары вашей группы, отмены и замены, напоминания и календарь телефона. Выберите свой факультет:</p>
<a class="open" href="{BOT}">Открыть в Telegram</a>
{''.join(blocks)}
<p>Вашего факультета нет? Пришлите расписание боту — файлом или ссылкой, добавим.</p>"""
    hub_html = page("Расписание вузов и факультетов в Telegram", "Расписание занятий МГУ, МГИМО, Финансового университета и других вузов в Telegram: группы, отмены, напоминания.", f"{SITE}f/", hub)
    (out_dir / "index.html").write_text(hub_html.replace('href="../../privacy.html"', 'href="../privacy.html"'), encoding="utf-8")

    today = date.today().isoformat()
    sitemap = ['<?xml version="1.0" encoding="UTF-8"?>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">']
    for url in [f"{SITE}f/", *urls]:
        sitemap.append(f"  <url><loc>{url}</loc><lastmod>{today}</lastmod></url>")
    sitemap.append("</urlset>")
    (DOCS / "sitemap.xml").write_text("\n".join(sitemap) + "\n", encoding="utf-8")
    print(f"страниц факультетов: {len(urls)}")


if __name__ == "__main__":
    main()
