import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

// ---------- CONFIG ----------
const NHL_HOOK = process.env.DISCORD_WEBHOOK_NHL;  // sur Render: Settings → Environment → DISCORD_WEBHOOK_NHL
const FIRST_WINDOW_MIN = 90;        // déclenche si premier match FUTUR ≤ 90 min
const LOOKAHEAD_HOURS = 6;          // matches à inclure dans le message
const SCHED_HOURS = { start: 16, end: 23 }; // plage Paris où le cron peut parler

// ---------- TEMPS ----------
function nowParis() { return new Date(); } // Render est en UTC, on manipule des Date UTC
function toParisString(d) { return d.toLocaleString("fr-FR", { timeZone: "Europe/Paris" }); }
function diffMin(a, b) { return Math.round((a.getTime() - b.getTime()) / 60000); }

// ---------- NHL SCHEDULE ----------
async function fetchNhlSchedule(dateStr) {
  const url = `https://api.nhle.com/stats/rest/en/schedule?cayenneExp=gameDate%3E=%22${dateStr}%22%20and%20gameDate%3C=%22${dateStr}%22`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`NHL schedule HTTP ${res.status}`);
  const json = await res.json();
  const games = json?.data || [];
  return games.map(g => ({
    id: g.gameId,
    away: g.awayTeamAbbrev,
    home: g.homeTeamAbbrev,
    startUTC: g.gameDate,                // ISO UTC
    startDate: new Date(g.gameDate),     // Date() en UTC
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

  // 1) ne garder que les matchs FUTURS
  const upcoming = games.filter(g => g.startDate.getTime() > now.getTime());
  if (!upcoming.length) return { ok: false, reason: "tous les matchs ont commencé" };

  // 2) premier match futur + fenêtre
  upcoming.sort((a, b) => a.startDate - b.startDate);
  const first = upcoming[0];
  const minToFirst = diffMin(first.startDate, now);
  const windowOk = minToFirst <= FIRST_WINDOW_MIN;

  // 3) matches dans les 6h
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

    // fenêtre si pas "force"
    if (!force && !diag.windowOk) {
      return { ok: true, sent: false, reason: `fenêtre fermée (premier match futur dans ${diag.minToFirst} min)`, diag };
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

app.get("/prematch/why", async (_req, res) => {
  try {
    const now = nowParis();
    const games = await getScheduleParisDay(now);
    const diag = diagnostic(games, now);
    res.json({ ok: true, diag });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// force = vrai -> envoie même si fenêtre fermée
app.get("/prematch/force", async (_req, res) => {
  const out = await generatePrematchDiscord({ force: true });
  res.json(out);
});

// Cron manuel (respecte la fenêtre)
app.get("/cron/manual", async (_req, res) => {
  const now = nowParis();
  const hourParis = Number(now.toLocaleString("en-CA", { hour: "2-digit", hour12: false, timeZone: "Europe/Paris" }));
  if (hourParis < SCHED_HOURS.start || hourParis > SCHED_HOURS.end) {
    return res.json({ ok: true, cron: true, sent: false, reason: "hors plage horaire Paris" });
  }
  const out = await generatePrematchDiscord({ force: false });
  res.json({ ok: true, cron: true, ...out });
});

// Boucle minute (silencieuse)
setInterval(() => { generatePrematchDiscord({ force: false }); }, 60 * 1000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`SmartScout NHL autobot running on ${PORT}`));