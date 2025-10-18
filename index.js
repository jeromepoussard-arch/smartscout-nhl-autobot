// index.js
import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

// ---------- CONFIG ----------
const NHL_HOOK = process.env.DISCORD_WEBHOOK_NHL;     // Webhook Discord
const FIRST_WINDOW_MIN = 90;                          // fenêtre déclenchement auto
const LOOKAHEAD_HOURS = 6;                            // envoi pour matchs dans ~6h
const SCHED_HOURS = { start: 16, end: 23 };           // boucle auto (heures Paris)

// ---------- TEMPS ----------
function nowParis() {
  // Date “naïve” suffit pour diff -> on formate juste en Europe/Paris à l’affichage
  return new Date();
}
function toParisString(d) {
  return d.toLocaleString("fr-FR", { timeZone: "Europe/Paris" });
}
function diffMin(a, b) {
  return Math.round((a.getTime() - b.getTime()) / 60000);
}

// ---------- NHL API ----------
async function fetchNhlSchedule(dateStr) {
  const url = `https://api.nhle.com/stats/rest/en/schedule?cayenneExp=gameDate%3E=%22${dateStr}%22%20and%20gameDate%3C=%22${dateStr}%22`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`NHL schedule HTTP ${res.status}`);
  const json = await res.json();
  const games = json?.data || [];
  return games.map((g) => ({
    id: g.gameId,
    away: g.awayTeamAbbrev,
    home: g.homeTeamAbbrev,
    startUTC: g.gameDate,
    startDate: new Date(g.gameDate),
    state: "FUT",
  }));
}

// -> IMPORTANT: on joint “aujourd’hui Paris” + “veille (UTC-6h)” pour ne rien rater
async function getScheduleParisDay(dateObj) {
  const y = dateObj.getFullYear();
  const m = String(dateObj.getMonth() + 1).padStart(2, "0");
  const d = String(dateObj.getDate()).padStart(2, "0");

  // veille “large” (-6h) pour couvrir les premiers matchs du soir côté UTC
  const prev = new Date(dateObj.getTime() - 6 * 60 * 60 * 1000);
  const y2 = prev.getFullYear();
  const m2 = String(prev.getMonth() + 1).padStart(2, "0");
  const d2 = String(prev.getDate()).padStart(2, "0");

  const [prevGames, todayGames] = await Promise.all([
    fetchNhlSchedule(`${y2}-${m2}-${d2}`),
    fetchNhlSchedule(`${y}-${m}-${d}`),
  ]);

  // on merge puis on déduplique par id
  const merged = [...prevGames, ...todayGames];
  const byId = new Map();
  for (const g of merged) byId.set(g.id, g);
  return [...byId.values()];
}

// ---------- DISCORD ----------
async function postToDiscord(payload) {
  if (!NHL_HOOK) throw new Error("Missing env DISCORD_WEBHOOK_NHL");
  const res = await fetch(NHL_HOOK, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Discord ${res.status}`);
  return true;
}

// ---------- LOGIQUE ----------
function selectWindow(games, now) {
  if (!games.length) return { ok: false, reason: "pas de jeux" };

  const sorted = games.slice().sort((a, b) => a.startDate - b.startDate);
  const first = sorted[0];
  const minToFirst = diffMin(first.startDate, now);
  const windowOk = minToFirst <= FIRST_WINDOW_MIN;

  const within = sorted.filter(
    (g) => diffMin(g.startDate, now) <= LOOKAHEAD_HOURS * 60
  );

  return { ok: true, windowOk, minToFirst, first, within, count: within.length };
}

function buildPrematchMessage(within) {
  const header = `[DISCORD:NHL] 🧠 SmartScout — Pré-match NHL (auto)\n` +
    `Fenêtre ~6h (Paris ${toParisString(nowParis())})\n`;
  const lines = within.map(
    (g) => `• ${g.away} @ ${g.home} — ${toParisString(g.startDate)} (Paris)`
  );
  return header + (lines.length ? lines.join("\n") : "_Aucun match dans la fenêtre._");
}

async function generatePrematchDiscord() {
  try {
    const now = nowParis();
    const games = await getScheduleParisDay(now);
    const diag = selectWindow(games, now);

    if (!diag.ok) return { ok: true, sent: false, reason: "pas de jeux", diag };

    if (!diag.windowOk) {
      return {
        ok: true,
        sent: false,
        reason: `fenêtre fermée (premier match dans ${diag.minToFirst} min)`,
        diag,
      };
    }

    if (!diag.within.length) {
      return { ok: true, sent: false, reason: "rien dans ~6h", diag };
    }

    const msg = buildPrematchMessage(diag.within);
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
    const diag = selectWindow(games, now);
    res.json({ ok: true, diag, sample: games.slice(0, 3) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/prematch/force", async (_req, res) => {
  const r = await generatePrematchDiscord();
  res.json(r);
});

app.get("/cron/manual", async (_req, res) => {
  const r = await generatePrematchDiscord();
  res.json(r);
});

// petit endpoint de test webhook
app.get("/debug/webhook", async (_req, res) => {
  try {
    await postToDiscord({ content: "[DISCORD:NHL] ✅ Test webhook via /debug/webhook" });
    res.send("ok");
  } catch (e) {
    res.status(500).send(e.message);
  }
});

// ---------- BOUCLE AUTO ----------
setInterval(async () => {
  const now = nowParis();
  const hParis = parseInt(
    now.toLocaleString("fr-FR", { hour: "2-digit", hour12: false, timeZone: "Europe/Paris" }),
    10
  );
  // Cron “léger” uniquement entre 16h et 23h Paris
  if (hParis >= SCHED_HOURS.start && hParis <= SCHED_HOURS.end) {
    const r = await generatePrematchDiscord();
    console.log(`[${toParisString(now)}] cron tick => sent=${r.sent ? "true" : "false"} reason=${r.reason ?? "ok"}`);
  }
}, 60 * 1000);

// ---------- START ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`SmartScout NHL autobot running on ${PORT}`);
});