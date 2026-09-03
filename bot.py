import os
import sys

from dotenv import load_dotenv
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup, WebAppInfo
from telegram.ext import ApplicationBuilder, CommandHandler, ContextTypes

load_dotenv()

BOT_TOKEN = os.environ.get("BOT_TOKEN")
if not BOT_TOKEN:
    sys.exit(
        "Не найден токен бота.\n"
        "Создайте рядом с bot.py файл .env со строкой:\n"
        "BOT_TOKEN=токен_от_BotFather"
    )

# Обязательно https — Telegram не откроет Mini App по http.
WEB_APP_URL = os.environ.get(
    "WEB_APP_URL", "https://bodryash.github.io/schedule-miniapp/"
)


async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    keyboard = InlineKeyboardMarkup([
        [
            InlineKeyboardButton(
                text="📅 Открыть расписание",
                web_app=WebAppInfo(url=WEB_APP_URL),
            )
        ]
    ])
    await update.message.reply_text(
        "Открывай расписание 👇",
        reply_markup=keyboard,
    )


def main():
    app = ApplicationBuilder().token(BOT_TOKEN).build()
    app.add_handler(CommandHandler("start", start))
    app.run_polling()


if __name__ == "__main__":
    main()
