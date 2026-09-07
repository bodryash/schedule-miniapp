"""Рассылает сообщение всем, кто писал боту.

    python tools/broadcast.py message.txt          # показать, кому уйдёт
    python tools/broadcast.py message.txt --send   # отправить

Список получателей лежит в базе воркера: Telegram его не отдаёт, и кроме
собственной записи взять его неоткуда. Без `--send` скрипт ничего не
отправляет — только показывает текст и число адресатов.

Заблокировавшие бота удаляются из списка: Telegram отвечает на них 403, и
хранить их дальше незачем.
"""

import asyncio
import json
import os
import subprocess
import sys
from pathlib import Path

from dotenv import load_dotenv
from telegram import Bot
from telegram.constants import ParseMode
from telegram.error import Forbidden, RetryAfter, TelegramError

ROOT = Path(__file__).resolve().parent.parent
WORKER = ROOT / "worker"

# Telegram разрешает около 30 сообщений в секунду на всех получателей.
PAUSE = 0.05


def d1(command, as_json=False):
    args = ["npx", "--yes", "wrangler@4", "d1", "execute", "schedule-stats",
            "--remote", "--yes", "--command", command]
    if as_json:
        args.append("--json")
    raw = subprocess.run(
        args, cwd=WORKER, capture_output=True, text=True,
        encoding="utf-8", shell=os.name == "nt",
    )
    if raw.returncode != 0:
        sys.exit(f"Не удалось обратиться к базе: {raw.stderr.strip()[:400]}")
    return raw.stdout


def recipients():
    """Идентификаторы чатов из базы воркера."""
    out = d1("SELECT id FROM users ORDER BY id", as_json=True)
    start = out.find("[")
    if start < 0:
        return []
    return [row["id"] for row in json.loads(out[start:])[0]["results"]]


def forget(chat_id):
    d1(f"DELETE FROM users WHERE id = {int(chat_id)}")


async def main():
    if len(sys.argv) < 2:
        sys.exit("Укажите файл с текстом: python tools/broadcast.py message.txt")

    text = Path(sys.argv[1]).read_text(encoding="utf-8").strip()
    send = "--send" in sys.argv
    chats = recipients()

    print(f"Получателей: {len(chats)}")
    print("-" * 60)
    print(text)
    print("-" * 60)

    if not send:
        print("Это черновой прогон. Для отправки добавьте --send")
        return
    if not chats:
        print("Отправлять некому.")
        return

    load_dotenv(ROOT / ".env")
    bot = Bot(os.environ["BOT_TOKEN"])

    sent = blocked = failed = 0
    for chat_id in chats:
        try:
            await bot.send_message(chat_id, text, parse_mode=ParseMode.HTML)
            sent += 1
        except Forbidden:
            # Пользователь заблокировал бота — вычёркиваем.
            forget(chat_id)
            blocked += 1
        except RetryAfter as wait:
            await asyncio.sleep(wait.retry_after + 1)
            try:
                await bot.send_message(chat_id, text, parse_mode=ParseMode.HTML)
                sent += 1
            except TelegramError:
                failed += 1
        except TelegramError as error:
            print(f"  {chat_id}: {error}")
            failed += 1
        await asyncio.sleep(PAUSE)

    print(f"Отправлено {sent}, заблокировали {blocked}, ошибок {failed}")


asyncio.run(main())
