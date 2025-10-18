import express from "express";
import fetch from "node-fetch";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import tz from "dayjs/plugin/timezone.js";

dayjs.extend(utc);
dayjs.extend(tz);

const app = express();
app.use(express.json());

// --- Secrets/Env
const NHL_HOOK = process.env.DISCORD_WEBHOOK_NHL;   // <- déjà configuré sur Render

// =============== UTIL =================
const PARIS_TZ = "Europe/Paris";

function nowParis() {
  return dayjs().tz(PARIS_TZ);
}

function fmtParis(dtISO) {
  return dayjs(dtISO).tz(PARIS_TZ).format("HH:mm");
}

// Arrondit à la minute près
function minutesUntil(from, to) {
  return Math.round(dayjs(to).diff(dayjs(from), "minute"));
}

async function postToDiscord(payload) {
  try {
    const res = await fetch(NHL_HOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`Discord: ${res.status}`);
  } catch (err) {
    console.error("Erreur Discord:", err.message);
  }
}

// =============== DATA: NHL SCHEDULE (jour) ===============
// API NHL (date au format YYYY-MM-DD, fuseau UTC à la source)
async function fetchNHLSchedule(dateYMD) {
  const url = `https://api-web.nhle.com/v1/schedule/${dateYMD}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`NHL schedule ${res.status}`);
  return res.json();
}

// Extrait une liste de matchs avec heure Paris et ids
function mapScheduleToGames(json) {
  // Structure attendue (API actuelle) :
  // json.gameWeek[0].games[] avec { startTimeUTC, gameState, awayTeam.abbrev, homeTeam.abbrev, id }
  const out = [];
  if (!json || !Array.isArray(json.gameWeek)) return out;

  for (const week of json.gameWeek) {
    if (!Array.isArray(week.games)) continue;
    for (const g of week.games) {
      out.push({
        id: g.id,
        home: g.homeTeam?.abbrev,
        away: g.awayTeam?.abbrev,
        startUTC: g.startTimeUTC,
        startParis: dayjs(g.startTimeUTC).tz(PARIS_TZ),
        state: g.gameState, // "FUT" (à venir), etc.
      });
    }
  }
  return out
    .filter(g => g.state && g.state !== "OFF") // garde les matchs programmés
    .sort((a, b) => a.startParis.valueOf() - b.startParis.valueOf());
}

// =============== BUILDER MESSAGE ===============
function buildPrematchMessage(games, firstPuckParis) {
  const lines = [];

  lines.push(`[DISCORD:NHL] 📊 SmartScout — Pré-match NHL (T-${firstPuckParis.fromNow(true)})`);
  lines.push(`Fenêtre : matchs qui démarrent d’ici ~6h (heure Paris).`);
  lines.push("");

  for (const g of games) {
    const h = g.home;
    const a = g.away;
    const heure = g.startParis.format("HH:mm");

    // Phase 1 (MVP) : infos essentielles
    lines.push(`— **${a} @ ${h}** — *${heure}*`);
    lines.push(`1) Lignes & Gardiens : _à confirmer_ (phase 2)`);
    lines.push(`2) Forme équipes (L5 / saison) : _phase 2_`);
    lines.push(`3) H2H récent : _phase 2_`);
    lines.push(`4) Métriques (GF/GA, xGF/xGA, tempo, PP/PK) : _phase 2_`);
    lines.push(`5) Joueurs clés (L5 SOG, TOI, PP) : _phase 2_`);
    lines.push(`6) Contexte (voyage/B2B, blessures/lines) : _phase 2_`);
    lines.push(`7) Over/Under — meilleurs angles : _phase 2_`);
    lines.push(`8) Tendances joueurs (G/A/PTS) : _phase 2_`);
    lines.push("");
  }

  lines.push(`ℹ️ Sources (à brancher phase 2) : NHL.com, DailyFaceoff, RotoWire, MoneyPuck, ESPN, Reuters.`);
  return lines.join("\n");
}

// =============== LOGIQUE PRINCIPALE ===============
async function maybeSendPrematch() {
  try {
    const now = nowParis();
    const dateYMD = now.format("YYYY-MM-DD");

    const raw = await fetchNHLSchedule(dateYMD);
    const all = mapScheduleToGames(raw);

    if (all.length === 0) {
      console.log(`[${now.format()}] Aucun match NHL programmé aujourd’hui.`);
      return;
    }

    // 1er puck-drop du jour (heure Paris)
    const first = all[0].startParis;
    const tmin = minutesUntil(now, first);

    console.log(`[${now.format()}] First puck-drop : ${first.format("HH:mm")} Paris (dans ${tmin} min)`);

    // Envoi seulement si ≤ 90 min
    if (tmin > 90) {
      return; // sortir silencieusement (conforme à ton cahier des charges)
    }

    // Prendre les matchs qui commencent dans ~6 heures (360 min)
    const windowed = all.filter(g => {
      const m = minutesUntil(now, g.startParis);
      return m >= 0 && m <= 360;
    });

    if (windowed.length === 0) return;

    const content = buildPrematchMessage(windowed, first);
    await postToDiscord({ content });
    console.log(`[${now.format()}] Pré-match envoyé (${windowed.length} matchs).`);
  } catch (e) {
    console.error("maybeSendPrematch error:", e.message);
  }
}

// =============== ROUTES ===============
app.get("/ping", (_req, res) => res.send("pong"));

app.get("/test/prematch", async (_req, res) => {
  await postToDiscord({
    content:
      "[DISCORD:NHL] 🔵 SmartScout — Simulation pré-match NHL TEST\n" +
      "Ce test confirme l’acheminement rendu → Discord."
  });
  res.send("Pré-match TEST envoyé ✅");
});

// Déclencheur manuel (utile pour tests Render)
app.get("/cron/prematch", async (_req, res) => {
  await maybeSendPrematch();
  res.send("cron OK");
});

// =============== SCHEDULER (toutes les 5 min) ===============
setInterval(maybeSendPrematch, 5 * 60 * 1000);

// Boot server (Render garde le process en vie)
app.listen(3000, () => {
  console.log("SmartScout NHL autobot up on 3000");
});