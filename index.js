// ================================
// SMARTSCOUT NHL AUTOBOT (Render)
// Version stable + correctifs 502
// ================================

import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

// ========= CONFIG =========
const NHL_HOOK = process.env.DISCORD_WEBHOOK_NHL;
const FIRST_WINDOW_MIN = 360; // fenêtre 6h avant premier match
const PREMATCH_TRIGGER_MIN = 90; // envoi auto si premier match <90 min

// ========= UTILITAIRES =========
function nowParis() {
  return new Date().toLocaleString("fr-FR", { timeZone: "Europe/Paris" });
}

function diffMin(a, b) {
  return Math.round((new Date(a) - new Date(b)) / 60000);
}

// ========= FETCH NHL =========
async function getScheduleParisDay(dateNow) {
  const iso = new Date(dateNow).toISOString().split("T")[0];
  const url = `https://api-web.nhle.com/v1/schedule/${iso}`;
  try {
    const r = await fetch(url);
    const data = await r.json();
    const games = (data.games || []).map(g => ({
      id: g.id,
      away: g.awayTeam.abbrev,
      home: g.homeTeam.abbrev,
      startUTC: g.startTimeUTC,
      state: g.gameState,
    }));
    return games;
  } catch (err) {
    console.error("Erreur API NHL:", err.message);
    return [];
  }
}

// ========= DISCORD =========
async function postToDiscord(payload) {
  if (!NHL_HOOK) {
    console.error("⚠️ Aucun webhook Discord défini !");
    return;
  }
  try {
    const res = await fetch(NHL_HOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`Discord ${res.status}`);
  } catch (err) {
    console.error("Erreur Discord:", err.message);
  }
}

// ========= GÉNÉRATION PRÉMATCH =========
async function generatePrematchDiscord() {
  const now = nowParis();
  const games = await getScheduleParisDay(now);
  if (!games.length) return { ok: false, reason: "No games today" };

  // calculs heures Paris
  const withParis = games.map(g => ({
    ...g,
    startParis: new Date(g.startUTC).toLocaleString("en-US", {
      timeZone: "Europe/Paris",
    }),
  }));
  withParis.sort((a, b) => new Date(a.startParis) - new Date(b.startParis));

  const first = withParis[0];
  const minToFirst = diffMin(first.startParis, now);
  const windowOk = minToFirst <= FIRST_WINDOW_MIN;

  console.log(`[${now}] Premier puck ${first.away}@${first.home} dans ${minToFirst} min`);

  if (!windowOk)
    return { ok: true, sent: false, reason: `first puck in ${minToFirst} min` };

  // Fenêtre <90 min -> Envoi
  if (minToFirst <= PREMATCH_TRIGGER_MIN) {
    const nextGames = withParis.filter(
      g => diffMin(g.startParis, now) <= FIRST_WINDOW_MIN
    );
    const list = nextGames
      .map(
        g =>
          `• ${g.away} @ ${g.home} — ${new Date(g.startParis)
            .toLocaleTimeString("fr-FR", {
              timeZone: "Europe/Paris",
              hour: "2-digit",
              minute: "2-digit",
            })
            .replace(":", "h")} (Paris)`
      )
      .join("\n");

    const msg = {
      content: `[DISCORD:NHL] 🕓 SmartScout — Pré-match NHL (auto)\nFenêtre ~6h à partir de ${new Date(
        first.startParis
      ).toLocaleTimeString("fr-FR", {
        timeZone: "Europe/Paris",
        hour: "2-digit",
        minute: "2-digit",
      })} (Paris)\n\n${list}`,
    };

    await postToDiscord(msg);
    console.log(`[${now}] Pré-match envoyé (${nextGames.length} matchs).`);
    return { ok: true, sent: true, count: nextGames.length };
  } else {
    console.log(`[${now}] Fenêtre pas encore ouverte (${minToFirst} min).`);
    return { ok: true, sent: false, reason: `Too early (${minToFirst}min)` };
  }
}

// ========= ROUTES =========

// route ping simple
app.get("/ping", (_req, res) => res.send("pong"));

// route manuelle de test
app.get("/test/prematch", async (_req, res) => {
  await postToDiscord({
    content:
      "[DISCORD:NHL] 🔵 SmartScout — Simulation pré-match NHL TEST\nMatch test : Maple Leafs @ Canadiens\nHeure : 01h00 (Europe/Paris)\nAnalyse : Toronto domine en xG et PP, Montréal peine en PK.\nTendance : Victoire Leafs ♦ Over 6.5 ♦ Matthews buteur.\nConfiance globale SmartScout : 81/100",
  });
  res.send("Pré-match envoyé sur Discord ✅");
});

// route auto/force
app.get("/prematch/force", async (_req, res) => {
  const result = await generatePrematchDiscord();
  res.json(result);
});

// ========= BOUCLE AUTO =========
setInterval(() => {
  generatePrematchDiscord().catch(err =>
    console.error("Erreur auto-check:", err.message)
  );
}, 60 * 60 * 1000); // chaque heure

// ========= KEEPALIVE + WARM-UP =========
app.get("/", (_req, res) => res.send("SmartScout NHL autobot OK"));

// ping interne pour éviter le 502 au réveil
setTimeout(
  () =>
    fetch(`http://localhost:${process.env.PORT || 3000}/ping`).catch(() => {}),
  2000
);
setTimeout(
  () =>
    fetch(`http://localhost:${process.env.PORT || 3000}/ping`).catch(() => {}),
  8000
);

// ========= LISTEN PORT =========
const PORT = parseInt(process.env.PORT || "3000", 10);
app.listen(PORT, () => {
  console.log(`SmartScout NHL autobot up on ${PORT}`);
});