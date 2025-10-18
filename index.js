// index.js — SmartScout NHL autobot (Render)

import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

// === ENV ===
const NHL_HOOK = process.env.DISCORD_WEBHOOK_NHL; // ➜ réglé dans Render

// === UTIL ===
function nowParisDate() {
  // Date "réelle" et string lisible en Europe/Paris
  const now = new Date();
  const pretty = now.toLocaleString("fr-FR", { timeZone: "Europe/Paris" });
  return { now, pretty };
}
function pad(n) { return n < 10 ? `0${n}` : `${n}`; }

// Renvoie la date du jour au format YYYY-MM-DD en Europe/Paris
function parisYYYYMMDD(d = new Date()) {
  const parts = new Intl.DateTimeFormat("fr-FR", {
    timeZone: "Europe/Paris",
    year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(d);
  const y = parts.find(p => p.type === "year").value;
  const m = parts.find(p => p.type === "month").value;
  const da = parts.find(p => p.type === "day").value;
  return `${y}-${m}-${da}`;
}

// Appel API NHL du planning du jour (heure Paris)
async function getScheduleParisDay(d = new Date()) {
  const day = parisYYYYMMDD(d);
  const url = `https://api-web.nhle.com/v1/schedule/${day}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`NHL schedule ${res.status}`);

  const json = await res.json();
  // Normalise quelques champs utiles
  const games = (json?.gameWeek?.[0]?.games || []).map(g => ({
    id: g.id,
    home: g.homeTeam?.abbrev,
    away: g.awayTeam?.abbrev,
    startUTC: g.startTimeUTC,   // ex: 2025-10-18T17:00:00Z
    state: g.gameState
  }));
  return { day, url, games };
}

// Min vers premier engagement
function minutesTo(firstStartUTC) {
  const now = Date.now();
  const t = Date.parse(firstStartUTC); // UTC
  return Math.round((t - now) / 60000);
}

// Envoi Discord
async function postToDiscord(payload) {
  try {
    const r = await fetch(NHL_HOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!r.ok) throw new Error(`Discord ${r.status}`);
    return true;
  } catch (e) {
    console.error("Discord error:", e.message);
    return false;
  }
}

// ====== LOGIQUE PRÉ-MATCH ======
async function buildPrematchText() {
  // Version "light" mais propre, tu enrichiras ensuite
  const { pretty } = nowParisDate();
  const { day, games } = await getScheduleParisDay();

  if (!games.length) {
    return `[DISCORD:NHL] 📅 Aucun match NHL aujourd’hui (${day}).\n(Paris ${pretty})`;
  }

  // matches dans ~6h
  const sixHoursFromNow = Date.now() + 6 * 3600 * 1000;
  const soon = games.filter(g => Date.parse(g.startUTC) <= sixHoursFromNow);

  const lines = soon.map(g => {
    const startParis = new Date(g.startUTC).toLocaleTimeString("fr-FR", {
      timeZone: "Europe/Paris", hour: "2-digit", minute: "2-digit"
    });
    return `• ${g.away} @ ${g.home} — ${startParis} (Paris)`;
  });

  const header = `[DISCORD:NHL] 🧠 SmartScout — Pré-match NHL (auto)\nFenêtre ~6h (Paris ${pretty})`;
  return `${header}\n${lines.join("\n")}`;
}

// Décide d’envoyer ou pas selon la fenêtre (≤ 90 min avant 1er puck)
async function maybeSendPrematch(force = false) {
  const diag = await prematchWindowDiag();
  if (force || (diag.windowOk && !sentTodayOnce(diag.firstParis))) {
    const text = await buildPrematchText();
    await postToDiscord({ content: text });
    return { ok: true, reason: force ? "forced" : "windowOk", diag };
  }
  return { ok: false, reason: "windowClosedOrAlreadySent", diag };
}

// Garde-fou pour éviter les doublons multiples le même jour
let lastSentKey = ""; // ex: YYYY-MM-DD
function sentTodayOnce(firstStartParisDateStr) {
  // firstStartParisDateStr = "YYYY-MM-DD"
  if (lastSentKey === firstStartParisDateStr) return true;
  lastSentKey = firstStartParisDateStr;
  return false;
}

// Diagnostic fenêtre (pour /prematch/why)
async function prematchWindowDiag() {
  const { pretty } = nowParisDate();
  const data = await getScheduleParisDay();
  const games = data.games.slice().sort((a,b) => Date.parse(a.startUTC) - Date.parse(b.startUTC));

  if (!games.length) {
    return { ok: true, nowParis: pretty, count: 0, windowOk: false, reason: "noGames", source: data.url };
  }

  const first = games[0];
  const minToFirst = minutesTo(first.startUTC);
  const windowOk = minToFirst <= 90; // ta règle
  const firstParisStr = new Date(first.startUTC).toLocaleString("fr-FR", { timeZone: "Europe/Paris" });
  const firstParisKey = parisYYYYMMDD(new Date(first.startUTC));

  return {
    ok: true,
    source: data.url,
    nowParis: pretty,
    games: games.map(g => ({
      id: g.id, away: g.away, home: g.home,
      startUTC: g.startUTC,
      startParis: new Date(g.startUTC).toLocaleString("fr-FR", { timeZone: "Europe/Paris" }),
      state: g.state
    })),
    count: games.length,
    firstParis: firstParisStr,
    firstParisKey,
    minToFirst,
    windowOk
  };
}

// ====== ROUTES ======

// Santé
app.get("/ping", (_req, res) => res.send("pong"));

// Test envoi Discord brut
app.post("/post", async (req, res) => {
  const ok = await postToDiscord(req.body || { content: "[DISCORD:NHL] test" });
  res.json({ ok });
});

// Diagnostic fenêtre
app.get("/prematch/why", async (_req, res) => {
  try {
    const diag = await prematchWindowDiag();
    res.json(diag);
  } catch (e) {
    res.status(500).json({ ok:false, error: e.message });
  }
});

// Forcer envoi
app.get("/prematch/force", async (_req, res) => {
  try {
    const result = await maybeSendPrematch(true);
    res.json({ ok:true, forced:true, result });
  } catch (e) {
    res.status(500).json({ ok:false, error: e.message });
  }
});

// Simuler un tick cron (utile quand Render était endormi)
app.get("/cron/manual", async (_req, res) => {
  try {
    const result = await maybeSendPrematch(false);
    res.json({ ok:true, cron:true, result });
  } catch (e) {
    res.status(500).json({ ok:false, error: e.message });
  }
});

// Tick minute (quand instance éveillée)
setInterval(() => {
  maybeSendPrematch(false).catch(() => {});
}, 60 * 1000);

// Start server
app.listen(3000, () => console.log("SmartScout NHL autobot up on 3000"));