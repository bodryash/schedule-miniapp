"""Перенастраивает вебхук бота и обновляет его секрет.

    python tools/set_webhook.py

Секрет Telegram присылает в заголовке; воркер отвергает всё, что пришло без
него. Новый секрет сначала кладётся воркеру, потом сообщается Telegram: в
короткий промежуток обновления приходят со старым и получают отказ, но
Telegram повторит их позже, так что ничего не теряется.
"""

import asyncio
import os
import secrets
import subprocess
import sys
from pathlib import Path

from dotenv import load_dotenv
from telegram import Bot

ROOT = Path(__file__).resolve().parent.parent
WORKER = ROOT / "worker"
URL = "https://fgp-schedule-bot.bodryash.workers.dev"

# Нажатия кнопок приходят отдельным типом обновления: без него
# подтверждение рассылки просто не дойдёт до воркера. Так же и с запросами
# «@FGPshedulebot 311гэу» из чатов.
UPDATES = ["message", "callback_query", "inline_query"]


async def main():
    load_dotenv(ROOT / ".env")
    value = secrets.token_hex(32)

    saved = subprocess.run(
        ["npx", "--yes", "wrangler@4", "secret", "put", "WEBHOOK_SECRET"],
        cwd=WORKER,
        input=value,
        capture_output=True,
        text=True,
        encoding="utf-8",
        shell=os.name == "nt",
    )
    if saved.returncode != 0:
        sys.exit(f"Не удалось записать секрет: {saved.stderr.strip()[:400]}")
    print("секрет записан воркеру")

    bot = Bot(os.environ["BOT_TOKEN"])
    await bot.set_webhook(url=URL, secret_token=value, allowed_updates=UPDATES)

    info = await bot.get_webhook_info()
    print("адрес:", info.url)
    print("типы обновлений:", info.allowed_updates)
    print("в очереди:", info.pending_update_count)
    print("последняя ошибка:", info.last_error_message or "нет")


asyncio.run(main())
