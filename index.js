import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

// ---------- CONFIG ----------
const NHL_HOOK = process.env.DISCORD_WEBHOOK_NHL;   // ton webhook Discord
const TZ = process.env.TZ || "Europe/Paris";

// Fenêtre d’envoi auto : si le 1er engagement est dans <=90 min,
// on envoie les matchs qui démarrent dans ~6h.
const FIRST_WINDOW_MIN = 90;
const LOOKAHEAD_HOURS = 6;

// ---------- TEMPS ----------
function nowParis() { return new Date(); }
function toParisString(d) { return d.toLocaleString("fr-FR", { timeZone: TZ }); }
function diffMin(a, b) { return Math.round((a.getTime() - b.getTime()) / 60000); }

// ---------- NHL (api.nhle.com) ----------
async function fetchNhlSchedule(dateStr) {
  // Exemple : https://api.nhle.com/stats/rest/en/schedule?cayenneExp=gameDate%3D%222025-10-18%22
  const url =
    `https://api.nhle.com/stats/rest/en/schedule?cayenneExp=` +
    `gameDate%3D%22${encodeURIComponent(dateStr)}%22`;

  const res = await fetch(url, {
    headers: {
      // certains proxies sont tatillons
      "User-Agent": "Mozilla/5.0",
      "Accept": "application/json",
      "Referer": "https://www.nhl.com/"
    },
    // timeout soft via AbortSignal si besoin (optionnel)
  });

  if (!res.ok) throw new Error(`NHL schedule HTTP ${res.status}`);
  const json = await res.json();

  const games = json?.data || [];
  return games.map(g => ({
    id: g.gameId,
    away: g.awayTeamAbbrev,
    home: g.homeTeamAbbrev,
    startUTC: g.gameDate,             // ISO
    startDate: new Date(g.gameDate),  // Date objet
    state: "FUT"
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
  if (!NHL_HOOK) throw new Error("DISCORD_WEBHOOK_NHL manquant");
  const res = await fetch(NHL_HOOK, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error(`Discord ${res.status}`);
}

// ---------- LOGIQUE PREMATCH ----------
function windowAndGames(games, now) {
  if (!games.length) return { ok: false, reason: "pas de jeux" };
  const sorted = games.sort((a, b) => a.startDate - b.startDate);
  const first = sorted[0];
  const minToFirst = diffMin(first.startDate, now);
  const windowOk = minToFirst <= FIRST_WINDOW_MIN;
  const within = sorted.filter(g => diffMin(g.startDate, now) <= LOOKAHEAD_HOURS * 60);
  return { ok: true, windowOk, minToFirst, first, within };
}

function buildPrematchMessage(within) {
  const header = `[DISCORD:NHL] 🧠 SmartScout — Pré-match NHL (auto)\n` +
                 `Fenêtre ~6h (Paris ${toParisString(nowParis())})\n`;
  const lines = within.map(g => `• ${g.away} @ ${g.home} — ${toParisString(g.startDate)} (Paris)`);
  return header + lines.join("\n");
}

async function generatePrematchDiscord() {
  try {
    const now = nowParis();
    const games = await getScheduleParisDay(now);
    const diag = windowAndGames(games, now);
    if (!diag.ok || !diag.windowOk) {
      return { ok: true, sent: false, reason: diag.reason || "hors fenêtre", diag };
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

// Debug brut : renvoie la date utilisée et ce que l’API retourne (ou l’erreur)
app.get("/debug/schedule", async (_req, res) => {
  try {
    const now = nowParis();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, "0");
    const d = String(now.getDate()).padStart(2, "0");
    const dateStr = `${y}-${m}-${d}`;
    const data = await fetchNhlSchedule(dateStr);
    res.json({ ok: true, dateStr, count: data.length, sample: data.slice(0, 3) });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.get("/prematch/why", async (_req, res) => res.json(await generatePrematchDiscord()));
app.get("/prematch/force", async (_req, res) => res.json(await generatePrematchDiscord()));
app.get("/cron/manual", async (_req, res) => res.json(await generatePrematchDiscord()));

// tick minute
setInterval(() => { generatePrematchDiscord(); }, 60 * 1000);

// ---------- START ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`SmartScout NHL autobot running on ${PORT}`));