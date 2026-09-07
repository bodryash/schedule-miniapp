"""Разовый перенос списка пользователей бота из KV в базу.

    python tools/migrate_users.py

KV отдаёт всего тысячу записей в сутки, и в день массовой раздачи ссылки
лишние молча не попали бы в список рассылки. В базе лимит стократно выше.

Идентификатор чата — это сам ключ KV, поэтому значения по одному забирать
не нужно: имена и даты подтянутся сами, когда человек напишет боту.
"""

import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WORKER = ROOT / "worker"
BATCH = 200


def wrangler(*args):
    result = subprocess.run(
        ["npx", "--yes", "wrangler@4", *args],
        cwd=WORKER,
        capture_output=True,
        text=True,
        encoding="utf-8",
        shell=os.name == "nt",
    )
    if result.returncode != 0:
        sys.exit(f"Команда не прошла: {result.stderr.strip()[:400]}")
    return result.stdout


def main():
    listing = wrangler("kv", "key", "list", "--binding", "USERS", "--remote")
    start = listing.find("[")
    if start < 0:
        sys.exit("Не удалось прочитать список KV.")

    ids = [int(item["name"]) for item in json.loads(listing[start:])]
    print(f"в KV найдено: {len(ids)}")
    if not ids:
        return

    for offset in range(0, len(ids), BATCH):
        chunk = ids[offset : offset + BATCH]
        values = ", ".join(f"({chat_id})" for chat_id in chunk)
        wrangler(
            "d1",
            "execute",
            "schedule-stats",
            "--remote",
            "--yes",
            "--command",
            f"INSERT OR IGNORE INTO users (id) VALUES {values}",
        )
        print(f"перенесено {min(offset + BATCH, len(ids))} из {len(ids)}")

    check = wrangler(
        "d1", "execute", "schedule-stats", "--remote", "--json",
        "--command", "SELECT COUNT(*) AS n FROM users",
    )
    data = json.loads(check[check.find("[") :])
    print(f"в базе теперь: {data[0]['results'][0]['n']}")


main()
