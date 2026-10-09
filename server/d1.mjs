// База бота на своём сервере. В Cloudflare бот работал с D1 — это SQLite с
// собственным набором методов (prepare → bind → first/all/run, batch).
// Здесь тот же набор поверх обычного файла SQLite, поэтому сам бот не
// меняется ни строчкой: один и тот же код работает и там, и тут.
import { DatabaseSync } from "node:sqlite";

// D1 не принимает undefined и булевы значения — приводим так же, как он.
const clean = (value) => (value === undefined ? null : typeof value === "boolean" ? Number(value) : value);

class Statement {
  constructor(db, sql, args = []) {
    this.db = db;
    this.sql = sql;
    this.args = args;
  }

  bind(...args) {
    return new Statement(this.db, this.sql, args.map(clean));
  }

  #prepared() {
    return this.db.prepare(this.sql);
  }

  async first(column) {
    const row = this.#prepared().get(...this.args);
    if (!row) return null;
    return column ? (row[column] ?? null) : { ...row };
  }

  async all() {
    const statement = this.#prepared();
    // Запрос без строк в ответе (UPDATE без RETURNING) all() тоже выполняет.
    const results = statement.all(...this.args).map((row) => ({ ...row }));
    return { results, success: true, meta: { changes: 0, last_row_id: 0 } };
  }

  async run() {
    const info = this.#prepared().run(...this.args);
    return {
      results: [],
      success: true,
      meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) },
    };
  }

  /** Для batch: выполнить и вернуть то же, что вернул бы all(). */
  execute() {
    const statement = this.#prepared();
    const text = this.sql.trimStart().slice(0, 6).toUpperCase();
    if (text === "SELECT" || /\bRETURNING\b/i.test(this.sql)) {
      return { results: statement.all(...this.args).map((row) => ({ ...row })), success: true, meta: {} };
    }
    const info = statement.run(...this.args);
    return { results: [], success: true, meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } };
  }
}

export function openDatabase(path) {
  const db = new DatabaseSync(path);
  // WAL: читатели не ждут писателя — на сотнях открытий в минуту это и есть
  // разница между «летает» и «подвисает». busy_timeout — на случай, когда
  // в ту же секунду идёт ночная копия.
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
  return {
    raw: db,
    prepare: (sql) => new Statement(db, sql),
    /** Всё или ничего, как в D1: при ошибке в середине откатывается вся пачка. */
    async batch(statements) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const out = statements.map((statement) => statement.execute());
        db.exec("COMMIT");
        return out;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    async exec(sql) {
      db.exec(sql);
      return { count: 1 };
    },
  };
}
