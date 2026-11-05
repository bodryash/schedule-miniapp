/* Материалы приложения: зерно, свет и объём. Грузится после заставки.
 *
 * Три уровня, чтобы красота не стоила плавности:
 *   off — без эффектов (настройка «Выкл» или телефон их не тянет);
 *   css — объём на CSS (блики, края, зерно): почти бесплатно, у всех;
 *   gl  — поверх ещё один небольшой шейдер: мягкий бегущий свет и живое зерно.
 * Уровень выбирается сам («Авто»): шейдер включается на мощных телефонах и
 * только если пробный замер кадров чистый. Начнёт подлагивать — тихо
 * опустится до css и до конца недели не вернётся.
 * Всё, что видно, живёт на атрибутах html: data-fx и data-fx-tone.
 */
(() => {
  "use strict";

  const MODE_KEY = "schedule.fx"; // auto | on | off
  const TIER_KEY = "schedule.fxTier"; // последний уровень — чтобы заставка рисовалась сразу как надо
  const DOWN_KEY = "schedule.fxDown"; // когда шейдер опускали из-за подлагиваний
  const WEEK = 7 * 86400000;
  const html = document.documentElement;
  const calm = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

  const read = (key) => {
    try {
      return localStorage.getItem(key) || "";
    } catch {
      return "";
    }
  };
  const write = (key, value) => {
    try {
      if (value == null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch {
      // Без памяти — просто не запомним.
    }
  };

  const FX = {
    mode: read(MODE_KEY) || "auto",
    tier: "off",
    set(mode) {
      FX.mode = ["auto", "on", "off"].includes(mode) ? mode : "auto";
      write(MODE_KEY, FX.mode === "auto" ? null : FX.mode);
      if (FX.mode === "on") write(DOWN_KEY, null);
      decide();
    },
  };
  window.FX = FX;

  /* ---------- Тон: светлая или тёмная тема ---------- */

  function tone() {
    // Цвет фона берём из переменной --bg: у body он бывает прозрачным.
    const probe = document.createElement("i");
    probe.style.cssText = "position:fixed;width:0;height:0;background:var(--bg)";
    document.body.append(probe);
    const color = getComputedStyle(probe).backgroundColor || "";
    probe.remove();
    const m = /rgba?\((\d+)[ ,]+(\d+)[ ,]+(\d+)/.exec(color);
    if (!m) return;
    const lum = (0.2126 * m[1] + 0.7152 * m[2] + 0.0722 * m[3]) / 255;
    html.dataset.fxTone = lum < 0.5 ? "dark" : "light";
    gl.dark = lum < 0.5 ? 1 : 0;
    gl.kick?.();
  }

  /* ---------- Зерно: маленькая текстура шума, один раз ---------- */

  function grain() {
    if (html.style.getPropertyValue("--fx-grain")) return;
    const size = 112;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext("2d");
    const img = ctx.createImageData(size, size);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = Math.random();
      const light = v > 0.5;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = light ? 255 : 0;
      img.data[i + 3] = Math.round(Math.abs(v - 0.5) * 2 * 26);
    }
    ctx.putImageData(img, 0, 0);
    html.style.setProperty("--fx-grain", `url(${canvas.toDataURL("image/png")})`);
  }

  let grainLayer = null;
  function grainOn(on) {
    if (on && !grainLayer) {
      grain();
      grainLayer = document.createElement("div");
      grainLayer.className = "fx-grain";
      grainLayer.setAttribute("aria-hidden", "true");
      document.body.append(grainLayer);
    }
    if (grainLayer) grainLayer.hidden = !on;
  }

  /* ---------- Шейдер: мягкий свет, виньетка, живое зерно ---------- */

  const VERT = "attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}";
  const FRAG = `
    precision mediump float;
    uniform vec2 uRes; uniform vec2 uLight; uniform float uTime; uniform float uTone;
    float hash(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
    void main(){
      vec2 uv = gl_FragCoord.xy / uRes; uv.y = 1.0 - uv.y;
      vec2 d = (uv - uLight) * vec2(1.0, 0.8);
      float spot = exp(-dot(d, d) * 3.4);
      float along = dot(uv - uLight, normalize(vec2(0.62, -0.78)));
      float band = max(0.0, 1.0 - abs(along) * 2.4); band *= band;
      float sheen = spot * 0.6 + band * 0.4;
      float vig = smoothstep(0.5, 1.2, length(uv - 0.5) * 1.35);
      // Лёгкая дрожь зерна: чтобы градиент не «полосило» на тёмном.
      float g = hash(gl_FragCoord.xy + floor(uTime * 12.0)) - 0.5;
      float hi = sheen * mix(0.13, 0.075, uTone) + max(g, 0.0) * 0.008;
      float lo = vig * mix(0.085, 0.18, uTone) + max(-g, 0.0) * 0.008;
      gl_FragColor = vec4(vec3(hi), hi + lo);
    }`;

  const gl = { canvas: null, ctx: null, prog: null, u: {}, raf: 0, target: [0.5, 0.2], now: [0.5, 0.2], idleAt: 0, dark: 0, slow: 0, frames: 0, last: 0, kick: null };

  function glStart() {
    if (gl.canvas) {
      gl.canvas.hidden = false;
      gl.kick();
      return true;
    }
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("webgl", { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, powerPreference: "low-power" });
    if (!ctx) return false;
    const compile = (type, src) => {
      const s = ctx.createShader(type);
      ctx.shaderSource(s, src);
      ctx.compileShader(s);
      return ctx.getShaderParameter(s, ctx.COMPILE_STATUS) ? s : null;
    };
    const v = compile(ctx.VERTEX_SHADER, VERT);
    const f = compile(ctx.FRAGMENT_SHADER, FRAG);
    if (!v || !f) return false;
    const prog = ctx.createProgram();
    ctx.attachShader(prog, v);
    ctx.attachShader(prog, f);
    ctx.linkProgram(prog);
    if (!ctx.getProgramParameter(prog, ctx.LINK_STATUS)) return false;
    ctx.useProgram(prog);
    const buf = ctx.createBuffer();
    ctx.bindBuffer(ctx.ARRAY_BUFFER, buf);
    ctx.bufferData(ctx.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), ctx.STATIC_DRAW);
    const loc = ctx.getAttribLocation(prog, "p");
    ctx.enableVertexAttribArray(loc);
    ctx.vertexAttribPointer(loc, 2, ctx.FLOAT, false, 0, 0);
    for (const name of ["uRes", "uLight", "uTime", "uTone"]) gl.u[name] = ctx.getUniformLocation(prog, name);
    ctx.enable(ctx.BLEND);
    ctx.blendFunc(ctx.ONE, ctx.ONE_MINUS_SRC_ALPHA);
    canvas.className = "fx-canvas";
    canvas.setAttribute("aria-hidden", "true");
    document.body.append(canvas);
    Object.assign(gl, { canvas, ctx, prog });

    const resize = () => {
      // Свет плавный, поэтому считаем вчетверо меньше пикселей (в половину по
      // каждой стороне) и растягиваем: шейдер почти ничего не стоит.
      const w = Math.max(1, Math.round(innerWidth / 2));
      const h = Math.max(1, Math.round(innerHeight / 2));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        ctx.viewport(0, 0, w, h);
      }
    };
    resize();
    addEventListener("resize", () => {
      resize();
      gl.kick();
    });

    const draw = (time) => {
      ctx.clearColor(0, 0, 0, 0);
      ctx.clear(ctx.COLOR_BUFFER_BIT);
      ctx.uniform2f(gl.u.uRes, canvas.width, canvas.height);
      ctx.uniform2f(gl.u.uLight, gl.now[0], gl.now[1]);
      ctx.uniform1f(gl.u.uTime, time / 1000);
      ctx.uniform1f(gl.u.uTone, gl.dark);
      ctx.drawArrays(ctx.TRIANGLES, 0, 3);
    };

    // Свет догоняет цель плавно; пока он движется — кадры идут, потом покой.
    const frame = (time) => {
      gl.raf = 0;
      if (document.hidden || !gl.canvas || gl.canvas.hidden) return;
      const dt = gl.last ? time - gl.last : 16;
      // Свету хватает 30 кадров в секунду: через кадр не рисуем.
      if (gl.last && dt < 28) {
        gl.raf = requestAnimationFrame(frame);
        return;
      }
      gl.last = time;
      gl.now[0] += (gl.target[0] - gl.now[0]) * 0.2;
      gl.now[1] += (gl.target[1] - gl.now[1]) * 0.2;
      draw(time);
      // Замер: если кадры тянутся долго — шейдер не по силам телефону.
      gl.frames += 1;
      if (dt > 55) gl.slow += 1;
      if (gl.frames >= 30) {
        const share = gl.slow / gl.frames;
        gl.frames = gl.slow = 0;
        if (share > 0.4 && FX.mode !== "on") return downgrade();
      }
      const moving = Math.abs(gl.target[0] - gl.now[0]) + Math.abs(gl.target[1] - gl.now[1]) > 0.002;
      if (moving || time < gl.idleAt) gl.raf = requestAnimationFrame(frame);
      else gl.last = 0;
    };
    gl.kick = () => {
      gl.idleAt = performance.now() + 900;
      if (!gl.raf && !document.hidden && gl.canvas && !gl.canvas.hidden) gl.raf = requestAnimationFrame(frame);
    };

    // Откуда падает свет: от прокрутки, от пальца и (на Android) от наклона.
    let scrollTimer = 0;
    addEventListener(
      "scroll",
      (e) => {
        const node = e.target === document ? document.scrollingElement : e.target;
        const max = Math.max(1, (node?.scrollHeight || 1) - (node?.clientHeight || 1));
        const k = Math.min(1, Math.max(0, (node?.scrollTop || 0) / max));
        gl.target = [0.3 + k * 0.4, 0.12 + k * 0.5];
        gl.kick();
        clearTimeout(scrollTimer);
      },
      { capture: true, passive: true }
    );
    addEventListener(
      "pointermove",
      (e) => {
        gl.target = [0.25 + (e.clientX / innerWidth) * 0.5, 0.1 + (e.clientY / innerHeight) * 0.6];
        gl.kick();
      },
      { passive: true }
    );
    addEventListener(
      "deviceorientation",
      (e) => {
        if (e.gamma == null) return;
        gl.target = [0.5 + Math.max(-30, Math.min(30, e.gamma)) / 80, 0.35 + Math.max(-30, Math.min(30, (e.beta || 45) - 45)) / 120];
        gl.kick();
      },
      { passive: true }
    );
    document.addEventListener("visibilitychange", () => !document.hidden && gl.kick());
    gl.kick();
    return true;
  }

  function glStop() {
    if (gl.canvas) gl.canvas.hidden = true;
    cancelAnimationFrame(gl.raf);
    gl.raf = 0;
  }

  function downgrade() {
    write(DOWN_KEY, String(Date.now()));
    glStop();
    apply("css");
  }

  /* ---------- Выбор уровня ---------- */

  function capable() {
    // Мощный телефон: 6+ ядер, не режим экономии трафика, WebGL на месте.
    if (navigator.connection?.saveData) return false;
    if ((navigator.hardwareConcurrency || 4) < 6) return false;
    if (navigator.deviceMemory && navigator.deviceMemory < 4) return false;
    const down = Number(read(DOWN_KEY)) || 0;
    if (down && Date.now() - down < WEEK) return false;
    return true;
  }

  function apply(tier) {
    FX.tier = tier;
    html.dataset.fx = tier;
    write(TIER_KEY, tier);
    grainOn(tier !== "off");
    if (tier === "gl") {
      if (!glStart()) apply("css");
    } else glStop();
    tone();
  }

  // Пробный замер: 36 кадров в покое. Чистые — можно шейдер.
  function probe() {
    return new Promise((resolve) => {
      let n = 0;
      let slow = 0;
      let last = 0;
      const step = (time) => {
        if (last) {
          n += 1;
          if (time - last > 26) slow += 1;
        }
        last = time;
        if (n < 36) requestAnimationFrame(step);
        else resolve(slow / n < 0.2);
      };
      requestAnimationFrame(step);
    });
  }

  let deciding = 0;
  async function decide() {
    const token = ++deciding;
    if (FX.mode === "off") return apply("off");
    // Спокойное движение или слабый телефон — только CSS (он без анимации).
    if (calm) return apply("css");
    if (FX.mode === "on") return apply(document.createElement("canvas").getContext("webgl") ? "gl" : "css");
    apply("css");
    if (!capable()) return;
    if (!(await probe()) || token !== deciding) return;
    if (FX.mode === "auto") apply("gl");
  }

  /* ---------- Старт ---------- */

  const start = () => {
    new MutationObserver(tone).observe(html, { attributes: true, attributeFilter: ["data-scheme", "style", "class"] });
    new MutationObserver(tone).observe(document.body, { attributes: true, attributeFilter: ["class", "style"] });
    window.matchMedia?.("(prefers-color-scheme: dark)").addEventListener?.("change", tone);
    window.Telegram?.WebApp?.onEvent?.("themeChanged", tone);
    decide();
  };
  if (document.body) start();
  else addEventListener("DOMContentLoaded", start);
})();
