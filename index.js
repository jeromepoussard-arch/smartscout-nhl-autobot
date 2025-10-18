import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

// ---------- CONFIG ----------
const NHL_HOOK = process.env.DISCORD_WEBHOOK_NHL;         // Webhook Discord (Render → Environment)
const FIRST_WINDOW_MIN = 90;                              // fenêtre d’envoi automatique
const LOOKAHEAD_HOURS = 6;                                // matchs dans ~6h
const SCHED_HOURS = { start: 16, end: 23 };               // (réservé si tu veux limiter le cron)

// ---------- OUTILS TEMPS ----------
function nowParis() {
  // On laisse l'objet Date "UTC interne", mais on calcule les différences sur l'epoch (ok)
  return new Date();
}
function toParisString(d) {
  return d.toLocaleString("fr-FR", { timeZone: "Europe/Paris" });
}
function diffMin(a, b) {
  return Math.round((a.getTime() - b.getTime()) / 60000);
}

// ---------- FETCH NHL ----------
async function fetchNhlSchedule(dateStr) {
  // Ex: 2025-10-18
  const url =
    `https://api.nhle.com/stats/rest/en/schedule?` +
    `cayenneExp=gameDate%3E=%22${dateStr}%22%20and%20gameDate%3C=%22${dateStr}%22`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`NHL schedule HTTP ${res.status}`);

  const json = await res.json();
  const games = json?.data || [];

  // Normalisation
  return games.map((g) => ({
    id: g.gameId,
    away: g.awayTeamAbbrev,
    home: g.homeTeamAbbrev,
    startUTC: g.gameDate,
    startDate: new Date(g.gameDate), // base UTC
    state: "FUT",
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
  if (!NHL_HOOK) throw new Error("Missing env DISCORD_WEBHOOK_NHL");
  const res = await fetch(NHL_HOOK, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
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

  const within = sorted.filter(
    (g) => diffMin(g.startDate, now) <= LOOKAHEAD_HOURS * 60
  );

  return { ok: true, windowOk, minToFirst, first, within };
}

function buildPrematchMessage(within) {
  const header = "[DISCORD:NHL] 🏒 Pré-match NHL (auto)\n";
  const lines = within.map(
    (g) => `• ${g.away} @ ${g.home} — ${toParisString(g.startDate)} (Paris)`
  );
  return header + (lines.length ? lines.join("\n") : "Aucun match dans ~6h.");
}

// Générateur avec option "force"
async function generatePrematchDiscord(opts = {}) {
  const { force = false } = opts;
  try {
    const now = nowParis();
    const games = await getScheduleParisDay(now);
    const diag = windowAndGames(games, now);

    if (!diag.ok) return { ok: true, sent: false, reason: "no games", diag };

    if (!force && !diag.windowOk) {
      return { ok: true, sent: false, reason: "no window", diag };
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
  const r = await generatePrematchDiscord({ force: false });
  res.json(r);
});

app.get("/prematch/force", async (_req, res) => {
  const r = await generatePrematchDiscord({ force: true });
  res.json(r);
});

// Diagnostic clair
app.get("/diag", async (_req, res) => {
  try {
    const now = nowParis();
    const games = await getScheduleParisDay(now);
    const diag = windowAndGames(games, now);
    res.json({
      nowParis: toParisString(now),
      count: games.length,
      firstParis: diag.first ? toParisString(diag.first.startDate) : null,
      minToFirst: diag.minToFirst ?? null,
      windowOk: diag.windowOk ?? false,
      withinCount: diag.within?.length ?? 0,
      sample: (diag.within || []).slice(0, 5).map((g) => ({
        away: g.away,
        home: g.home,
        startParis: toParisString(g.startDate),
      })),
    });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ---------- CRON SIMPLE (réveil + check chaque minute) ----------
setInterval(() => {
  generatePrematchDiscord({ force: false }).catch(() => {});
}, 60 * 1000);

// ---------- BOOT ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`SmartScout NHL autobot running on ${PORT}`);
});