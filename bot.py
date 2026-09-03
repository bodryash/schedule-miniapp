import os

from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup, WebAppInfo
from telegram.ext import ApplicationBuilder, CommandHandler, ContextTypes

BOT_TOKEN = os.environ["BOT_TOKEN"]

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
