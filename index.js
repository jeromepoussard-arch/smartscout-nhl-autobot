import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

// ---------- CONFIG ----------
const NHL_HOOK = process.env.DISCORD_WEBHOOK_NHL;
const FIRST_WINDOW_MIN = 90;  // délai max avant premier match
const LOOKAHEAD_HOURS = 6;    // fenêtre de matchs à venir

// ---------- OUTILS TEMPS ----------
function nowParis() { return new Date(); }
function toParisString(d) { 
  return d.toLocaleString("fr-FR", { timeZone: "Europe/Paris" }); 
}
function diffMin(a, b) { 
  return Math.round((a.getTime() - b.getTime()) / 60000); 
}

// ---------- FETCH NHL ----------
async function fetchNhlSchedule(dateStr) {
  const url = `https://api-web.nhle.com/v1/schedule/${dateStr}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`NHL schedule HTTP ${res.status}`);
  const json = await res.json();
  const games = json?.games || [];
  return games.map(g => ({
    id: g.id,
    away: g.awayTeam?.abbrev,
    home: g.homeTeam?.abbrev,
    startUTC: g.startTimeUTC,
    startDate: new Date(g.startTimeUTC),
    state: g.gameState
  }));
}

async function getScheduleParisDay(dateObj) {
  const y = dateObj.getFullYear();
  const m = String(dateObj.getMonth() + 1).padStart(2, "0");
  const d = String(dateObj.getDate()).padStart(2, "0");
  return await fetchNhlSchedule(`${y}-${m}-${d}`);
}

// ---------- DISCORD ----------
async function postToDiscord(payload) {
  if (!NHL_HOOK) throw new Error("Webhook manquant");
  const res = await fetch(NHL_HOOK, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error(`Discord ${res.status}`);
}

// ---------- LOGIQUE ----------
function windowAndGames(games, now) {
  if (!games.length) return { ok: false, reason: "no games" };
  const sorted = games.sort((a, b) => a.startDate - b.startDate);
  const first = sorted[0];
  const minToFirst = diffMin(first.startDate, now);
  const windowOk = minToFirst <= FIRST_WINDOW_MIN;
  const within = sorted.filter(g => diffMin(g.startDate, now) <= LOOKAHEAD_HOURS * 60);
  return { ok: true, windowOk, minToFirst, first, within };
}

function buildPrematchMessage(within) {
  const header = "[DISCORD:NHL] 🏒 Pré-match NHL (auto)\n";
  const lines = within.map(g => `• ${g.away} @ ${g.home} — ${toParisString(g.startDate)} (Paris)`);
  return header + lines.join("\n");
}

async function generatePrematchDiscord() {
  try {
    const now = nowParis();
    const games = await getScheduleParisDay(now);
    const diag = windowAndGames(games, now);
    if (!diag.ok || !diag.windowOk) return { ok: true, sent: false, reason: diag.reason || "no window", diag };
    const msg = buildPrematchMessage(diag.within);
    await postToDiscord({ content: msg });
    return { ok: true, sent: true, diag };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ---------- ROUTES ----------
app.get("/ping", (_req, res) => res.send("pong"));

// Forçage de pré-match manuel
app.get("/prematch/force", async (_req, res) => res.json(await generatePrematchDiscord()));

// Cron manuel
app.get("/cron/manual", async (_req, res) => res.json(await generatePrematchDiscord()));

// Diagnostic rapide
app.get("/diag", async (_req, res) => {
  try {
    const now = nowParis();
    const games = await getScheduleParisDay(now);
    const diag = windowAndGames(games, now);
    res.json({ ok: true, diag });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ---------- DEBUG WEBHOOK ----------
app.get("/debug/webhook", async (_req, res) => {
  const hasHook = Boolean(NHL_HOOK && NHL_HOOK.startsWith("https://discord.com/api/webhooks/"));
  if (!hasHook) {
    return res.status(500).json({ ok: false, reason: "DISCORD_WEBHOOK_NHL manquant ou invalide" });
  }
  try {
    const r = await fetch(NHL_HOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "[DISCORD:NHL] ✅ Test webhook via /debug/webhook" })
    });
    const text = await r.text().catch(() => null);
    res.json({ ok: r.ok, status: r.status, body: text?.slice(0, 200) || null });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// ---------- POST MANUEL ----------
app.post("/post", async (req, res) => {
  try {
    const content = (req.body && req.body.content) || "[DISCORD:NHL] test /post";
    const r = await fetch(NHL_HOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content })
    });
    const text = await r.text().catch(() => null);
    res.json({ ok: r.ok, status: r.status, body: text?.slice(0, 200) || null });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// ---------- CRON SIMPLE ----------
setInterval(() => generatePrematchDiscord(), 60 * 1000);

// ---------- LANCEMENT ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`SmartScout NHL autobot running on ${PORT}`));