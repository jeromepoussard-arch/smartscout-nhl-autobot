import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

// ---------- CONFIG ----------
const NHL_HOOK = process.env.DISCORD_WEBHOOK_NHL;
const FIRST_WINDOW_MIN = 90;
const LOOKAHEAD_HOURS = 6;
const SCHED_HOURS = { start: 16, end: 23 };

// ---------- TEMPS ----------
function nowParis() { return new Date(); }
function toParisString(d) { return d.toLocaleString("fr-FR", { timeZone: "Europe/Paris" }); }
function diffMin(a, b) { return Math.round((a.getTime() - b.getTime()) / 60000); }

// ---------- NHL SCHEDULE ----------
async function fetchNhlSchedule(dateStr) {
  const url = `https://statsapi.web.nhl.com/api/v1/schedule?date=${dateStr}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`NHL schedule HTTP ${res.status}`);
  const json = await res.json();
  const games = json?.dates?.[0]?.games || [];

  return games.map(g => ({
    id: g.gamePk,
    away: g.teams.away.team.abbreviation || g.teams.away.team.name,
    home: g.teams.home.team.abbreviation || g.teams.home.team.name,
    startUTC: g.gameDate,
    startDate: new Date(g.gameDate),
  }));
}

async function getScheduleParisDay(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return await fetchNhlSchedule(`${y}-${m}-${day}`);
}

// ---------- DISCORD ----------
async function postToDiscord(payload) {
  if (!NHL_HOOK) throw new Error("DISCORD_WEBHOOK_NHL missing");
  const res = await fetch(NHL_HOOK, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Discord ${res.status}`);
}

// ---------- LOGIQUE ----------
function diagnostic(games, now) {
  if (!games.length) return { ok: false, reason: "pas de jeux" };

  const upcoming = games.filter(g => g.startDate.getTime() > now.getTime());
  if (!upcoming.length) return { ok: false, reason: "tous les matchs ont commencé" };

  upcoming.sort((a, b) => a.startDate - b.startDate);
  const first = upcoming[0];
  const minToFirst = diffMin(first.startDate, now);
  const windowOk = minToFirst <= FIRST_WINDOW_MIN;

  const within = upcoming.filter(g => diffMin(g.startDate, now) <= LOOKAHEAD_HOURS * 60);
  return { ok: true, windowOk, minToFirst, first, within };
}

function buildPrematchMessage(within, now) {
  const header = `[DISCORD:NHL] 🧠 SmartScout — Pré-match NHL (auto)\nFenêtre ~6h (Paris ${toParisString(now)})\n`;
  const lines = within.map(g => `• ${g.away} @ ${g.home} — ${toParisString(g.startDate)} (Paris)`);
  return header + lines.join("\n");
}

async function generatePrematchDiscord({ force = false } = {}) {
  try {
    const now = nowParis();
    const games = await getScheduleParisDay(now);
    const diag = diagnostic(games, now);

    if (!diag.ok) return { ok: true, sent: false, reason: diag.reason, diag };

    if (!force && !diag.windowOk) {
      return { ok: true, sent: false, reason: `fenêtre fermée (${diag.minToFirst} min avant premier match)`, diag };
    }

    const msg = buildPrematchMessage(diag.within, now);
    await postToDiscord({ content: msg });
    return { ok: true, sent: true, diag };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ---------- ROUTES ----------
app.get("/ping", (_req, res) => res.send("pong"));
app.get("/prematch/why", async (_req, res) => res.json(await generatePrematchDiscord({ force: false })));
app.get("/prematch/force", async (_req, res) => res.json(await generatePrematchDiscord({ force: true })));
app.get("/debug/webhook", async (_req, res) => {
  try {
    await postToDiscord({ content: "[DISCORD:NHL] ✅ Test webhook via /debug/webhook" });
    res.send("ok");
  } catch (e) {
    res.status(500).send(e.message);
  }
});

// ---------- CRON ----------
setInterval(() => generatePrematchDiscord({ force: false }), 60 * 1000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`SmartScout NHL autobot running on ${PORT}`));