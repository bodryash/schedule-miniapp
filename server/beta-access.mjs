import { randomBytes } from "node:crypto";

const ttl = 12 * 3600;
const sessions = new Map();
const cookie = "__Host-schedule-beta";
const gate = `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Вход в бету</title><p id="status">Откройте бету кнопкой из команды /beta в боте @FGPshedulebot.</p><script src="https://telegram.org/js/telegram-web-app.js"></script><script>
const data = window.Telegram?.WebApp?.initData;
if (data) fetch("/_beta/login", {method:"POST", body:data}).then(r => {
  if (r.ok) location.reload();
  else document.getElementById("status").textContent = "Бета доступна только владельцу. Откройте её заново через /beta.";
}).catch(() => document.getElementById("status").textContent = "Не удалось войти. Откройте бету заново через /beta.");
</script></html>`;

export async function betaAccess(req, res, env, verify, readBody) {
  res.setHeader("Cache-Control", "private, no-store");
  if (req.url === "/_beta/login" && req.method === "POST") {
    const data = (await readBody(req)).toString("utf8");
    const params = new URLSearchParams(data);
    const age = Date.now()/1000 - Number(params.get("auth_date"));
    const user = !params.has("web") && age >= -30 && age < 300 && await verify(data, env.BOT_TOKEN);
    if (!user || String(user.id) !== String(env.OWNER_ID)) {
      res.writeHead(403).end();
      return;
    }
    for (const [key, expires] of sessions) if (expires <= Date.now()) sessions.delete(key);
    const key = randomBytes(32).toString("hex");
    sessions.set(key, Date.now() + ttl * 1000);
    res.setHeader("Set-Cookie", cookie + "=" + key + "; Path=/; Secure; HttpOnly; SameSite=None; Max-Age=" + ttl);
    res.writeHead(204).end();
    return;
  }
  const token = (req.headers.cookie || "").split(/;\s*/).find(v => v.startsWith(cookie+"="))?.slice(cookie.length+1);
  if (req.url === "/_beta/check" && sessions.get(token) > Date.now()) {
    res.writeHead(204).end();
    return;
  }
  res.writeHead(401, {"Content-Type":"text/html; charset=utf-8"}).end(gate);
}
