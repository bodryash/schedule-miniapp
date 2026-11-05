/* «Сессия 2048» — экран игры. Загружается, только когда игру открывают
 * (openGame в app.js), вместе с game.css и ядром game-core.mjs (то же ядро
 * проверяет партии на сервере). Пользуется общими именами приложения: tg,
 * t, haptic, API_URL, LOCALE, tenant.
 *
 * Движение: только transform и opacity; плитка едет к новой клетке, при
 * слиянии новая «подпрыгивает», новая плитка проявляется из точки.
 */
(() => {
  "use strict";

  const GAME_URL = `${API_URL}/game`;
  const SAVE_KEY = "schedule.g2048";
  const REDUCED = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const SLIDE_MS = REDUCED ? 0 : 110;
  let core = null;

  const S = {
    root: null,
    open: false,
    game: null,
    run: null, // { id, seed }
    saved: 0, // сколько ходов уже сохранено на сервере
    tiles: new Map(), // клетка → элемент плитки
    busy: false,
    over: false,
    best: 0,
    event: null,
    saveTimer: 0,
    backHandler: null,
  };

  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  };
  const fmt = (n) => Number(n || 0).toLocaleString(LOCALE);

  async function request(action, payload = {}) {
    const res = await fetch(`${GAME_URL}/${action}`, {
      method: "POST",
      body: JSON.stringify({ initData: tg?.initData || "", ...payload }),
      keepalive: action === "save",
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.ok) throw Object.assign(new Error(body.error || String(res.status)), { code: body.error || String(res.status) });
    return body;
  }

  function faculty() {
    const tn = typeof tenant === "function" ? tenant() : null;
    return { tenant: tn?.id || "", fac: [tn?.university, tn?.short].filter(Boolean).join(" · ") || "Без факультета" };
  }

  function remember() {
    try {
      if (S.run && !S.over) localStorage.setItem(SAVE_KEY, JSON.stringify({ id: S.run.id, seed: S.run.seed, moves: S.game.moves, event: S.event?.id }));
      else localStorage.removeItem(SAVE_KEY);
    } catch {
      // Без памяти партия не продолжится после закрытия — счёт всё равно на сервере.
    }
  }

  function recall() {
    try {
      return JSON.parse(localStorage.getItem(SAVE_KEY) || "null");
    } catch {
      return null;
    }
  }

  /* ---------- Каркас ---------- */

  function build() {
    if (S.root) return;
    const root = el("div", "g2");
    root.hidden = true;
    root.setAttribute("role", "region");
    root.setAttribute("aria-label", t("Сессия 2048"));
    for (const type of ["pointerdown", "touchstart"]) root.addEventListener(type, (e) => e.stopPropagation());

    const nav = el("header", "g2-nav");
    const back = el("button", "g2-icon");
    back.type = "button";
    back.setAttribute("aria-label", t("Назад"));
    back.innerHTML = '<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>';
    back.addEventListener("click", () => closeGame());
    const title = el("div", "g2-title");
    title.append(el("b", "", t("Сессия 2048")), (S.timer = el("small", "", "")));
    const help = el("button", "g2-icon");
    help.type = "button";
    help.setAttribute("aria-label", t("Как играть"));
    help.innerHTML = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M9.6 9.3a2.5 2.5 0 1 1 3.4 2.3c-.7.3-1 .8-1 1.5v.6"/><circle cx="12" cy="17" r=".6" fill="currentColor"/></svg>';
    help.addEventListener("click", () => openHelp());
    nav.append(back, title, help);

    const stats = el("div", "g2-stats");
    const card = (label) => {
      const box = el("div", "g2-stat");
      const value = el("b", "", "0");
      box.append(el("span", "", label), value);
      stats.append(box);
      return value;
    };
    S.scoreEl = card(t("Счёт"));
    S.bestEl = card(t("Рекорд"));
    S.facEl = card(t("Факультет"));

    const level = el("div", "g2-level");
    S.levelEl = level;

    const board = el("div", "g2-board");
    for (let i = 0; i < 16; i++) board.append(el("div", "g2-cell"));
    const layer = el("div", "g2-layer");
    board.append(layer);
    S.board = board;
    S.layer = layer;
    wireSwipes(board);

    const actions = el("div", "g2-actions");
    const fresh = el("button", "g2-btn", t("Заново"));
    fresh.type = "button";
    fresh.addEventListener("click", () => restart());
    const rating = el("button", "g2-btn g2-btn--main", t("Рейтинг"));
    rating.type = "button";
    rating.addEventListener("click", () => openBoard());
    const share = el("button", "g2-btn", t("Поделиться"));
    share.type = "button";
    share.addEventListener("click", () => shareResult());
    actions.append(fresh, rating, share);

    const overlay = el("div", "g2-over");
    overlay.hidden = true;
    S.overEl = overlay;

    root.append(nav, stats, level, board, overlay, actions);
    document.body.append(root);
    S.root = root;

    document.addEventListener("keydown", (e) => {
      if (!S.open) return;
      const dir = { ArrowLeft: "L", ArrowRight: "R", ArrowUp: "U", ArrowDown: "D" }[e.key];
      if (dir) {
        e.preventDefault();
        play(dir);
      }
    });
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) flush();
    });
  }

  function wireSwipes(board) {
    let start = null;
    board.addEventListener("pointerdown", (e) => {
      start = { x: e.clientX, y: e.clientY };
      board.setPointerCapture?.(e.pointerId);
    });
    board.addEventListener("pointerup", (e) => {
      if (!start) return;
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      start = null;
      if (Math.max(Math.abs(dx), Math.abs(dy)) < 22) return;
      play(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "R" : "L") : dy > 0 ? "D" : "U");
    });
    board.addEventListener("pointercancel", () => (start = null));
  }

  /* ---------- Плитки ---------- */

  function tileNode(value) {
    const lv = core.level(value);
    const node = el("div", "g2-tile");
    node.style.setProperty("--lv", lv.n);
    node.dataset.lv = Math.min(lv.n, 17);
    node.append(el("i", "", lv.emoji), el("b", "", lv.name), el("small", "", fmt(value)));
    return node;
  }

  function place(node, cell) {
    node.style.setProperty("--c", cell % 4);
    node.style.setProperty("--r", Math.floor(cell / 4));
  }

  function drawAll() {
    S.layer.replaceChildren();
    S.tiles.clear();
    S.game.board.forEach((value, cell) => {
      if (!value) return;
      const node = tileNode(value);
      place(node, cell);
      S.layer.append(node);
      S.tiles.set(cell, node);
    });
    paintStats();
  }

  function appear(cell, value) {
    const node = tileNode(value);
    place(node, cell);
    node.classList.add("is-new");
    S.layer.append(node);
    S.tiles.set(cell, node);
  }

  /* ---------- Ход ---------- */

  function play(dir) {
    if (!S.game || S.busy || S.over) return;
    const result = core.move(S.game, dir);
    if (!result.moved) {
      haptic("light");
      if (!REDUCED) S.board.animate([{ transform: "translateX(0)" }, { transform: `translateX(${dir === "L" ? -4 : dir === "R" ? 4 : 0}px) translateY(${dir === "U" ? -4 : dir === "D" ? 4 : 0}px)` }, { transform: "none" }], { duration: 160 });
      return;
    }
    S.busy = true;
    // Плитки едут на новые клетки; слившиеся пропадают под новой.
    const next = new Map();
    for (const step of result.steps) {
      const node = S.tiles.get(step.from);
      if (!node) continue;
      place(node, step.to);
      if (step.merged) node.classList.add("is-gone");
      else next.set(step.to, node);
    }
    const added = core.spawn(S.game);
    setTimeout(() => {
      for (const node of S.layer.querySelectorAll(".is-gone")) node.remove();
      // Клетки со слиянием — новая плитка с прыжком.
      const merged = new Set(result.steps.filter((s) => s.merged).map((s) => s.to));
      for (const cell of merged) {
        next.get(cell)?.remove();
        const node = tileNode(S.game.board[cell] === undefined ? 0 : S.game.board[cell]);
        place(node, cell);
        node.classList.add("is-merged");
        S.layer.append(node);
        next.set(cell, node);
      }
      S.tiles = next;
      if (added) appear(added.at, added.value);
      S.busy = false;
      if (result.gained) {
        haptic(result.gained >= 512 ? "medium" : "light");
        bump(S.scoreEl);
      }
      paintStats();
      if (!core.canMove(S.game.board)) finish();
      else scheduleSave();
      remember();
    }, SLIDE_MS);
  }

  function bump(node) {
    if (REDUCED || !node.animate) return;
    node.animate([{ transform: "scale(1)" }, { transform: "scale(1.18)" }, { transform: "scale(1)" }], { duration: 220, easing: "ease-out" });
  }

  function paintStats() {
    const score = S.game?.score || 0;
    S.scoreEl.textContent = fmt(score);
    if (score > S.best) S.best = score;
    S.bestEl.textContent = fmt(S.best);
    const top = Math.max(2, ...(S.game?.board || [2]));
    const lv = core.level(top);
    S.levelEl.textContent = `${lv.emoji} ${t("Вы дошли до")}: ${lv.name}`;
  }

  /* ---------- Сохранение на сервере ---------- */

  function scheduleSave() {
    clearTimeout(S.saveTimer);
    // Чекпоинт: раз в 25 ходов или через 4 секунды тишины.
    if (S.game.moves.length - S.saved >= 25) save();
    else S.saveTimer = setTimeout(save, 4000);
  }

  async function save(final = false) {
    clearTimeout(S.saveTimer);
    if (!S.run || !S.game || (S.game.moves.length === S.saved && !final)) return null;
    const moves = S.game.moves;
    try {
      const res = await request("save", { id: S.run.id, moves, final });
      S.saved = moves.length;
      if (res.best) S.best = Math.max(S.best, res.best);
      if (res.place) S.place = res.place;
      return res;
    } catch {
      return null;
    }
  }

  function flush() {
    if (S.run && S.game && S.game.moves.length > S.saved) save();
  }

  /* ---------- Партия ---------- */

  async function startRun() {
    S.over = false;
    S.overEl.hidden = true;
    S.saved = 0;
    let seed;
    try {
      const res = await request("start", faculty());
      S.run = { id: res.id, seed: res.seed };
      S.event = res.event;
      seed = res.seed;
    } catch (error) {
      S.run = null;
      seed = Math.floor(Math.random() * 2 ** 32);
      toastGame(error.code === "soon" ? t("Турнир ещё не начался — можно потренироваться.") : error.code === "over" ? t("Турнир закончился — играйте для себя.") : t("Нет связи — эта партия не пойдёт в зачёт."));
    }
    S.game = core.newGame(seed);
    drawAll();
    remember();
  }

  async function restart() {
    haptic("light");
    if (S.game && S.game.moves.length && !S.over) await save(true);
    startRun();
  }

  async function finish() {
    S.over = true;
    remember();
    haptic("success");
    const res = await save(true);
    const lv = core.level(Math.max(...S.game.board));
    const box = S.overEl;
    box.replaceChildren();
    const card = el("div", "g2-over-card");
    card.append(
      el("div", "g2-over-emoji", lv.emoji),
      el("h2", "", t("Сессия закрыта")),
      el("p", "", `${t("Вы дошли до")}: ${lv.name} · ${fmt(S.game.score)}`),
      el("p", "g2-over-sub", res?.record ? t("Новый рекорд! Он уже в счёте вашего факультета.") : res ? t("Рекорд: {n}", { n: fmt(res.best) }) : t("Партия не сохранилась — нет связи."))
    );
    const again = el("button", "g2-btn g2-btn--main", t("Ещё раз"));
    again.type = "button";
    again.addEventListener("click", () => startRun());
    const share = el("button", "g2-btn", t("Поделиться"));
    share.type = "button";
    share.addEventListener("click", () => shareResult());
    const row = el("div", "g2-over-actions");
    row.append(again, share);
    card.append(row);
    box.append(card);
    box.hidden = false;
    if (!REDUCED) card.animate([{ opacity: 0, transform: "translateY(16px) scale(0.96)" }, { opacity: 1, transform: "none" }], { duration: 320, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" });
    refreshMine();
  }

  async function refreshMine() {
    try {
      const res = await request("board", {});
      S.event = res.event;
      if (res.me) {
        S.best = Math.max(S.best, res.me.best);
        S.facEl.textContent = res.me.facPlace ? `#${res.me.facPlace}` : "—";
      } else S.facEl.textContent = "—";
      paintStats();
      paintTimer();
      return res;
    } catch {
      return null;
    }
  }

  function paintTimer() {
    if (!S.timer) return;
    const ends = S.event?.ends;
    if (!ends) return (S.timer.textContent = t("турнир вузов"));
    const left = ends - Date.now();
    if (left <= 0) return (S.timer.textContent = t("турнир закончился"));
    const d = Math.floor(left / 86400000);
    const h = Math.floor((left % 86400000) / 3600000);
    S.timer.textContent = d ? t("турнир вузов · ещё {d} д {h} ч", { d, h }) : t("турнир вузов · ещё {h} ч", { h });
  }

  /* ---------- Рейтинг ---------- */

  function sheet(cls) {
    const back = el("div", "sheet-backdrop");
    back.hidden = true;
    const sh = el("div", `sheet sheet--g2 ${cls}`);
    back.append(sh);
    back.addEventListener("click", (e) => {
      if (e.target === back) back.hidden = true;
    });
    document.body.append(back);
    return { back, sh, open: () => (back.hidden = false), close: () => (back.hidden = true) };
  }

  async function openBoard() {
    haptic("light");
    const s = (S.boardSheet ||= sheet("g2-rating"));
    s.sh.replaceChildren(el("h2", "", t("Рейтинг")), el("p", "g2-muted", t("Загружаем…")));
    s.open();
    const res = await refreshMine();
    if (!res) {
      s.sh.replaceChildren(el("h2", "", t("Рейтинг")), el("p", "g2-muted", t("Нет связи. Попробуйте позже.")));
      return;
    }
    let tab = "facs";
    const tabs = el("div", "g2-tabs");
    const list = el("div", "g2-list");
    const mk = (key, label) => {
      const b = el("button", "", label);
      b.type = "button";
      b.addEventListener("click", () => {
        tab = key;
        render();
      });
      tabs.append(b);
      return b;
    };
    const tf = mk("facs", t("Факультеты"));
    const tp = mk("players", t("Игроки"));
    const note = el("p", "g2-muted");
    const render = () => {
      tf.classList.toggle("is-on", tab === "facs");
      tp.classList.toggle("is-on", tab === "players");
      list.replaceChildren();
      const medal = (n) => ["🥇", "🥈", "🥉"][n - 1] || String(n);
      if (tab === "facs") {
        note.textContent = t("Счёт факультета — сумма рекордов всех его игроков. Зовите однокурсников!");
        if (!res.facs.length) list.append(el("p", "g2-muted", t("Пока никто не играл — будьте первыми.")));
        const mineTenant = res.me?.tenant || faculty().tenant;
        for (const f of res.facs) {
          const row = el("div", `g2-row${f.tenant === mineTenant ? " is-me" : ""}`);
          row.append(el("span", "g2-place", medal(f.place)), el("span", "g2-name", f.fac), el("small", "", t("игроков: {n}", { n: f.players })), el("b", "", fmt(f.total)));
          list.append(row);
        }
      } else {
        note.textContent = t("В зачёт идёт лучшая партия. Попыток сколько угодно.");
        if (!res.players.length) list.append(el("p", "g2-muted", t("Пока никто не играл — будьте первыми.")));
        for (const p of res.players) {
          const row = el("div", `g2-row${p.me ? " is-me" : ""}`);
          row.append(el("span", "g2-place", medal(p.place)), el("span", "g2-name", p.name), el("small", "", `${p.fac} · ${core.level(p.max).name}`), el("b", "", fmt(p.best)));
          list.append(row);
        }
        if (res.me && !res.players.some((p) => p.me)) {
          const row = el("div", "g2-row is-me");
          row.append(el("span", "g2-place", String(res.me.place)), el("span", "g2-name", t("Вы")), el("small", "", ""), el("b", "", fmt(res.me.best)));
          list.append(row);
        }
      }
    };
    render();
    const close = el("button", "g2-btn g2-btn--main g2-wide", t("Играть"));
    close.type = "button";
    close.addEventListener("click", () => s.close());
    s.sh.replaceChildren(el("h2", "", t("Рейтинг")), tabs, note, list, close);
  }

  function openHelp() {
    haptic("light");
    const s = (S.helpSheet ||= sheet("g2-help"));
    s.sh.replaceChildren();
    s.sh.append(el("h2", "", t("Как играть")));
    s.sh.append(el("p", "", t("Смахивайте поле: одинаковые плитки сливаются в следующую ступень. Пара + Пара = Семинар, и так до Аспирантуры — а дальше без потолка.")));
    const ladder = el("div", "g2-ladder");
    for (let v = 2; v <= 65536; v *= 2) {
      const lv = core.level(v);
      ladder.append(el("span", "", `${lv.emoji} ${lv.name}`));
    }
    s.sh.append(ladder);
    s.sh.append(el("p", "g2-muted", t("Попыток сколько угодно, в зачёт идёт лучшая. Счёт факультета — сумма рекордов всех его игроков. Итоги — каждый вечер в Подслушке, призы — эксклюзивные темы и медаль у имени.")));
    const ok = el("button", "g2-btn g2-btn--main g2-wide", t("Понятно"));
    ok.type = "button";
    ok.addEventListener("click", () => s.close());
    s.sh.append(ok);
    s.open();
  }

  function shareResult() {
    haptic("light");
    const lv = core.level(Math.max(2, ...(S.game?.board || [2])));
    const { fac } = faculty();
    const score = Math.max(S.best, S.game?.score || 0);
    const text = t("Я дошёл до «{lv}» и набрал {n} в «Сессии 2048» — турнире вузов. {fac}, вперёд! Побьёшь?", { lv: lv.name, n: fmt(score), fac });
    const link = "https://t.me/FGPshedulebot?start=g2048";
    const url = `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(text)}`;
    if (tg?.openTelegramLink) tg.openTelegramLink(url);
    else window.open(url, "_blank", "noopener");
  }

  function toastGame(text) {
    if (typeof toast === "function") toast(text);
  }

  /* ---------- Открыть и закрыть ---------- */

  async function showGame() {
    core ||= await import(`./game-core.mjs?v=${window.__v || Date.now()}`);
    build();
    if (S.open) return;
    S.open = true;
    S.root.hidden = false;
    document.body.classList.add("g2-open");
    void S.root.offsetWidth;
    S.root.classList.add("is-open");
    tg?.disableVerticalSwipes?.();
    if (tg?.BackButton) {
      S.backHandler = () => closeGame();
      tg.BackButton.onClick(S.backHandler);
      tg.BackButton.show();
    }
    // Незаконченная партия — продолжаем с того же места.
    const prev = recall();
    if (prev && prev.id && Number.isInteger(prev.seed)) {
      const check = core.replay(prev.seed, prev.moves || "");
      if (check.ok && !check.over) {
        S.run = { id: prev.id, seed: prev.seed };
        S.game = core.newGame(prev.seed);
        for (const d of prev.moves || "") {
          core.move(S.game, d);
          core.spawn(S.game);
        }
        S.saved = 0;
        S.over = false;
        S.overEl.hidden = true;
        drawAll();
        scheduleSave();
      } else await startRun();
    } else if (!S.game || S.over) await startRun();
    else drawAll();
    paintTimer();
    refreshMine();
  }

  function closeGame() {
    if (!S.open) return;
    flush();
    remember();
    S.open = false;
    document.body.classList.remove("g2-open");
    S.root.classList.remove("is-open");
    tg?.enableVerticalSwipes?.();
    if (tg?.BackButton && S.backHandler) {
      tg.BackButton.offClick(S.backHandler);
      tg.BackButton.hide();
    }
    setTimeout(() => {
      if (!S.open) S.root.hidden = true;
    }, REDUCED ? 0 : 320);
  }

  window.showGame = showGame;
})();
