// index.js — SmartScout NHL autobot (Render)
// ------------------------------------------
// - /ping                    -> "pong" (santé)
// - /test/prematch          -> envoi manuel d'un message de test
// - /cron/prematch          -> cron manuel (respecte la fenêtre ≤ 90 min)
// - /cron/prematch?force=1  -> cron manuel FORCÉ (bypass 90 min)
// - /debug/schedule         -> montre ce que l’API NHL renvoie réellement (heure Paris, t-min…)
//
// Variables d’env. nécessaires sur Render :
//   DISCORD_WEBHOOK_NHL = <votre URL de webhook Discord>

import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const PARIS_TZ = "Europe/Paris";
const NHL_HOOK = process.env.DISCORD_WEBHOOK_NHL;

// ----- Utils heure/date (sans dépendance externe) -------------------------

function formatParis(d) {
  // d : Date
  return d.toLocaleString("fr-FR", {
    timeZone: PARIS_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatParisHM(d) {
  return d.toLocaleString("fr-FR", {
    timeZone: PARIS_TZ,
    hour: "2-digit",
    minute: "2-digit",
  });
}

function nowParisDate() {
  // Date "maintenant" (objet Date) – la conversion Paris n'est utile que pour l'affichage
  return new Date();
}

function minutesUntil(fromDate, toDate) {
  // fromDate & toDate : Date (UTC sous le capot)
  const ms = toDate.getTime() - fromDate.getTime();
  return Math.round(ms / 60000);
}

// ----- Discord -------------------------------------------------------------

async function postToDiscord(payload) {
  if (!NHL_HOOK) {
    console.error("DISCORD_WEBHOOK_NHL manquant.");
    return;
  }
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

// ----- NHL schedule : fallback /YYYY-MM-DD puis /now ----------------------

async function fetchNHLScheduleForTodayOrNow(dateYMD) {
  // 1) Essai date du jour
  let url = `https://api-web.nhle.com/v1/schedule/${dateYMD}`;
  let res = await fetch(url);
  if (res.ok) {
    const js = await res.json();
    const mapped = mapScheduleToGames(js);
    if (mapped.length > 0) return { source: url, games: mapped };
  }

  // 2) Fallback "now"
  url = `https://api-web.nhle.com/v1/schedule/now`;
  res = await fetch(url);
  if (!res.ok) throw new Error(`NHL schedule fallback ${res.status}`);
  const js2 = await res.json();
  return { source: url, games: mapScheduleToGames(js2) };
}

// Normalise le JSON en une liste de matchs avec heures parsables
function mapScheduleToGames(json) {
  const out = [];
  if (!json) return out;

  const candidates = [];
  if (Array.isArray(json.gameWeek)) {
    for (const w of json.gameWeek) {
      if (Array.isArray(w.games)) candidates.push(...w.games);
    }
  }
  if (Array.isArray(json.games)) candidates.push(...json.games);

  for (const g of candidates) {
    const startUTC = g.startTimeUTC || g.startTime; // certains dumps n'ont que startTime
    const home = g.homeTeam?.abbrev || g.homeTeamAbbrev || g.homeAbbrev;
    const away = g.awayTeam?.abbrev || g.awayTeamAbbrev || g.awayAbbrev;
    const state = g.gameState || g.gameStatus || "FUT";

    if (!startUTC || !home || !away) continue;

    const startDate = new Date(startUTC); // UTC natif
    if (isNaN(startDate.getTime())) continue;

    out.push({
      id: g.id,
      home,
      away,
      startUTC,
      startDate, // Date
      state,
    });
  }

  return out
    .filter((g) => g.state !== "OFF")
    .sort((a, b) => a.startDate.getTime() - b.startDate.getTime());
}

// ----- Construction du message pré-match ----------------------------------

function buildPrematchMessage(games, firstStartDate) {
  const lines = games.map((g) => {
    return `• ${g.away} @ ${g.home} — ${formatParisHM(g.startDate)} (Paris)`;
  });

  const header =
    "[DISCORD:NHL] 🧭 SmartScout — Pré-match NHL (auto)\n" +
    `Fenêtre ~6h à partir de ${formatParisHM(firstStartDate)} (Paris)\n\n`;

  // Ici on pourrait ajouter : tendances, PP/PK, etc. (source fetch externes)
  // Pour l’instant on vérifie la chaîne complète avec une liste claire.
  const body = lines.join("\n");

  return `${header}${body}`;
}

// ----- Mécanique du cron manuel -------------------------------------------

async function maybeSendPrematch({ force = false } = {}) {
  try {
    const now = nowParisDate();
    const dateParisYMD = now
      .toLocaleString("sv-SE", { timeZone: PARIS_TZ, year: "numeric", month: "2-digit", day: "2-digit" })
      .slice(0, 10); // "YYYY-MM-DD"

    const { source, games: all } = await fetchNHLScheduleForTodayOrNow(
      dateParisYMD
    );

    if (all.length === 0) {
      console.log(`[${formatParis(now)}] Aucun match NHL (source: ${source}).`);
      return { sent: false, reason: "no-games", source };
    }

    const firstStart = all[0].startDate;
    const tmin = minutesUntil(now, firstStart);

    console.log(
      `[${formatParis(now)}] Source=${source} First puck: ${formatParisHM(
        firstStart
      )} Paris (dans ${tmin} min) — total=${all.length}`
    );

    if (!force && tmin > 90) {
      return { sent: false, reason: "outside-90", tmin, source };
    }

    // Matchs qui démarrent dans les ~6h
    const windowed = all.filter((g) => {
      const m = minutesUntil(now, g.startDate);
      return m >= 0 && m <= 360;
    });

    if (windowed.length === 0) {
      return { sent: false, reason: "no-games-in-6h", source };
    }

    const content = buildPrematchMessage(windowed, firstStart);
    await postToDiscord({ content });
    console.log(
      `[${formatParis(now)}] Pré-match envoyé (${windowed.length} matchs).`
    );

    return { sent: true, count: windowed.length, source, tmin };
  } catch (e) {
    console.error("maybeSendPrematch error:", e.message);
    return { sent: false, reason: "error", error: e.message };
  }
}

// ----- Routes HTTP ---------------------------------------------------------

app.get("/ping", (_req, res) => res.send("pong"));

// Test manuel simple (message statique) — pour valider le webhook
app.get("/test/prematch", async (_req, res) => {
  await postToDiscord({
    content:
      "[DISCORD:NHL] 🔵 SmartScout — Simulation pré-match NHL TEST\nMatch test : Maple Leafs @ Canadiens\nHeure : 01h00 (Europe/Paris)\nAnalyse : Toronto domine en xG et PP, Montréal peine en PK.\nTendance : Victoire Leafs 🔹 Over 6.5 🔹 Matthews buteur.\nConfiance globale SmartScout : 81/100",
  });
  res.send("Pré-match envoyé sur Discord ✅");
});

// Debug : ce que le bot "voit" aujourd’hui (ou fallback now)
app.get("/debug/schedule", async (_req, res) => {
  try {
    const now = nowParisDate();
    const dateParisYMD = now
      .toLocaleString("sv-SE", { timeZone: PARIS_TZ, year: "numeric", month: "2-digit", day: "2-digit" })
      .slice(0, 10);

    const { source, games } = await fetchNHLScheduleForTodayOrNow(
      dateParisYMD
    );

    const out = games.map((g) => ({
      id: g.id,
      away: g.away,
      home: g.home,
      startUTC: g.startUTC,
      startParis: formatParis(g.startDate),
      inMin: minutesUntil(now, g.startDate),
      state: g.state,
    }));

    res.json({
      nowParis: formatParis(now),
      source,
      count: out.length,
      firstInMin: out.length ? out[0].inMin : null,
      games: out,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Cron manuel : /cron/prematch (respecte 90 min) ou /cron/prematch?force=1
app.get("/cron/prematch", async (req, res) => {
  const force = req.query.force === "1";
  const result = await maybeSendPrematch({ force });
  res.json({ ok: true, force, ...result });
});

// ----- (Optionnel) Scheduler local toutes les minutes ---------------------
// Si tu veux garder un mode "horloge" local (en plus des pings UptimeRobot),
// tu peux réactiver ce petit scheduler "au top de l’heure".
//
// setInterval(async () => {
//   const now = new Date();
//   const minutes = now.getMinutes();
//   if (minutes === 0) {
//     await maybeSendPrematch({ force: false });
//   }
// }, 60 * 1000);

// ----- Boot ----------------------------------------------------------------

app.listen(3000, () => {
  console.log("SmartScout NHL autobot up on 3000");
});