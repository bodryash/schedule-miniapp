/**
 * «Сессия 2048» — ядро игры. Один и тот же код у приложения (рисует ходы) и
 * у сервера (заново проигрывает партию по записи ходов и сам считает счёт:
 * подделать результат запросом нельзя).
 *
 * Поле 4×4, клетки по строкам: 0…15. Новая плитка после каждого хода берётся
 * из генератора по зерну партии, поэтому одни и те же ходы всегда дают одно
 * и то же поле.
 */

export const SIZE = 4;

/** Генератор случайных чисел по зерну (mulberry32): одинаковый везде. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Клетки линии в порядке, в котором плитки к ней прижимаются. */
function line(dir, k) {
  const cells = [];
  for (let i = 0; i < SIZE; i++) {
    if (dir === "L") cells.push(k * SIZE + i);
    else if (dir === "R") cells.push(k * SIZE + (SIZE - 1 - i));
    else if (dir === "U") cells.push(i * SIZE + k);
    else cells.push((SIZE - 1 - i) * SIZE + k);
  }
  return cells;
}

/** Новая плитка на случайной пустой клетке: 2 (90%) или 4 (10%). */
export function spawn(game) {
  const empty = [];
  for (let i = 0; i < game.board.length; i++) if (!game.board[i]) empty.push(i);
  if (!empty.length) return null;
  const at = empty[Math.floor(game.rand() * empty.length)];
  const value = game.rand() < 0.9 ? 2 : 4;
  game.board[at] = value;
  return { at, value };
}

export function newGame(seed) {
  const game = { board: new Array(SIZE * SIZE).fill(0), rand: rng(seed), score: 0, moves: "" };
  spawn(game);
  spawn(game);
  return game;
}

/**
 * Ход: «L», «R», «U», «D». Возвращает, сдвинулось ли что-то, и откуда куда
 * поехала каждая плитка (для анимации). Новую плитку ставит отдельно spawn().
 */
export function move(game, dir) {
  const next = new Array(SIZE * SIZE).fill(0);
  const steps = [];
  let gained = 0;
  for (let k = 0; k < SIZE; k++) {
    const cells = line(dir, k);
    let pos = 0;
    let last = null;
    for (const from of cells) {
      const value = game.board[from];
      if (!value) continue;
      if (last && last.value === value && !last.merged) {
        next[cells[last.pos]] = value * 2;
        gained += value * 2;
        last.merged = true;
        steps.push({ from, to: cells[last.pos], value, merged: true });
      } else {
        const to = cells[pos];
        next[to] = value;
        last = { value, pos, merged: false };
        pos += 1;
        steps.push({ from, to, value, merged: false });
      }
    }
  }
  const moved = steps.some((s) => s.from !== s.to || s.merged);
  if (moved) {
    game.board = next;
    game.score += gained;
    game.moves += dir;
  }
  return { moved, steps, gained };
}

export function canMove(board) {
  for (let i = 0; i < board.length; i++) {
    if (!board[i]) return true;
    const right = i % SIZE < SIZE - 1 ? board[i + 1] : 0;
    const down = i + SIZE < board.length ? board[i + SIZE] : 0;
    if (board[i] === right || board[i] === down) return true;
  }
  return false;
}

/** Партия целиком по записи ходов: счёт, старшая плитка, кончилась ли. */
export function replay(seed, moves) {
  const game = newGame(seed);
  for (const dir of String(moves)) {
    if (!"LRUD".includes(dir)) return { ok: false, why: "bad move" };
    if (!move(game, dir).moved) return { ok: false, why: "empty move" };
    spawn(game);
  }
  return { ok: true, score: game.score, max: Math.max(...game.board), over: !canMove(game.board), board: game.board };
}

/** Ступени: 2 — пара, … 2048 — аспирантура, дальше без потолка. */
export const LEVELS = [
  ["📝", "Пара"],
  ["📚", "Семинар"],
  ["🧪", "Коллоквиум"],
  ["✅", "Зачёт"],
  ["📖", "Экзамен"],
  ["🗓", "Сессия"],
  ["📑", "Курсовая"],
  ["🎓", "Бакалавр"],
  ["🎓", "Магистр"],
  ["🟥", "Красный диплом"],
  ["🔬", "Аспирантура"],
  ["🧑‍🔬", "Кандидат наук"],
  ["🧠", "Доктор наук"],
  ["🏛", "Профессор"],
  ["🌟", "Академик"],
  ["🏆", "Нобелевка"],
];

export function level(value) {
  const n = Math.max(1, Math.round(Math.log2(value || 2)));
  if (n <= LEVELS.length) return { emoji: LEVELS[n - 1][0], name: LEVELS[n - 1][1], n };
  return { emoji: "👑", name: `Легенда ×${2 ** (n - LEVELS.length)}`, n };
}
