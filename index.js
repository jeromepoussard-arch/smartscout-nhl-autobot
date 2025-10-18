// index.js (ESM) — SmartScout NHL autobot (Render)
// Env requis: DISCORD_WEBHOOK_NHL

import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const NHL_HOOK = process.env.DISCORD_WEBHOOK_NHL;

// Fenêtre d’envoi
const FIRST_WINDOW_MIN = 90;        // si 1er face-off <= 90 min → on envoie
const GAME_WINDOW_MIN = 360;        // ne couvrir que ~6h à partir de "main"

// Mémo anti-doublon
let lastPrematchStamp = null;       // "YYYY-MM-DD" pour lequel on a déjà envoyé

// ------------------ utilitaires temps / format ------------------
function nowParis() {
  return new Date();
}
function fmtParis(d) {
  try {
    return new Date(d).toLocaleString("fr-FR", {
      timeZone: "Europe/Paris",
      hour: "2-digit",
      minute: "2-digit",
      day: "2-digit",
      month: "2-digit"
    });
  } catch {
    return String(d);
  }
}
function fmtParisHM(d) {
  try {
    return new Date(d).toLocaleTimeString("fr-FR", {
      timeZone: "Europe/Paris",
      hour: "2-digit",
      minute: "2-digit"
    });
  } catch {
    return String(d);
  }
}
function ymdParis(dateObj = new Date()) {
  const d = new Date(dateObj);
  const tz = "Europe/Paris";
  const iso = d.toLocaleDateString("sv-SE", { timeZone: tz }); // YYYY-MM-DD (sv-SE)
  return iso;
}
function diffMin(a, b) {
  return Math.round((new Date(a) - new Date(b)) / 60000);
}
function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

// ------------------ Discord ------------------
async function postToDiscord(payload) {
  if (!NHL_HOOK) {
    console.error("DISCORD_WEBHOOK_NHL manquant.");
    return { ok: false, status: 0, error: "Missing webhook" };
  }
  try {
    const res = await fetch(NHL_HOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`Discord: ${res.status} ${txt}`);
    }
    return { ok: true, status: res.status };
  } catch (err) {
    console.error("Erreur Discord:", err.message);
    return { ok: false, status: 0, error: err.message };
  }
}

// ------------------ NHL API helpers ------------------
// Sources officielles NHL statsapi: https://statsapi.web.nhl.com
// & site public calendrier: https://api-web.nhle.com

async function getScheduleParisDay(parisDateStr) {
  // Source 1 (rapide): api-web.nhle.com
  const url1 = `https://api-web.nhle.com/v1/schedule/${parisDateStr}`;
  try {
    const r = await fetch(url1, { timeout: 15000 });
    if (r.ok) {
      const j = await r.json();
      const games = (j?.gameWeek?.[0]?.games || []).map((g) => ({
        id: g.id,
        gamePk: g.id,
        away: g.awayTeam?.abbrev,
        home: g.homeTeam?.abbrev,
        startUTC: g.startTimeUTC,
        state: g.gameState,
      }));
      return games;
    }
  } catch {}
  // Fallback: statsapi schedule
  const url2 = `https://statsapi.web.nhl.com/api/v1/schedule?date=${parisDateStr}`;
  const r2 = await fetch(url2);
  if (!r2.ok) return [];
  const j2 = await r2.json();
  const games = (j2.dates?.[0]?.games || []).map((g) => ({
    id: g.gamePk,
    gamePk: g.gamePk,
    away: g.teams?.away?.team?.abbreviation || g.teams?.away?.team?.name,
    home: g.teams?.home?.team?.abbreviation || g.teams?.home?.team?.name,
    startUTC: g.gameDate,
    state: g.status?.statusCode, // "1" futur, "3" Final
    awayId: g.teams?.away?.team?.id,
    homeId: g.teams?.home?.team?.id,
  }));
  return games;
}

async function getTeamSeasonStats(teamId) {
  // PP%, PK%, GF/GA, shotsFor/Against per game
  const url = `https://statsapi.web.nhl.com/api/v1/teams?teamId=${teamId}&expand=team.stats`;
  const r = await fetch(url);
  if (!r.ok) return null;
  const j = await r.json();
  const s = j.teams?.[0]?.teamStats?.[0]?.splits?.[0]?.stat || null;
  if (!s) return null;
  return {
    pp: s.powerPlayPercentage, // string "23.4"
    pk: s.penaltyKillPercentage, // "79.2"
    gf: s.goalsPerGame,
    ga: s.goalsAgainstPerGame,
    sf: s.shotsPerGame,
    sa: s.shotsAllowed,
    wins: s.wins,
    losses: s.losses,
    ot: s.ot,
    ptsPct: s.ptPctg,
  };
}

async function getRecentResults(teamId, days = 21) {
  const end = ymdParis();
  const start = ymdParis(new Date(Date.now() - days * 86400000));
  const url = `https://statsapi.web.nhl.com/api/v1/schedule?teamId=${teamId}&startDate=${start}&endDate=${end}`;
  const r = await fetch(url);
  if (!r.ok) return [];
  const j = await r.json();
  const games = (j.dates || []).flatMap(d => d.games || []);
  // map W/L & score
  const last = games
    .filter(g => g.status?.statusCode === "7" || g.status?.detailedState === "Final")
    .map(g => {
      const isHome = g.teams?.home?.team?.id === teamId;
      const us = isHome ? g.teams?.home?.score : g.teams?.away?.score;
      const them = isHome ? g.teams?.away?.score : g.teams?.home?.score;
      const wl = us > them ? "W" : "L";
      return { wl, us, them, when: g.gameDate, gamePk: g.gamePk };
    })
    .sort((a, b) => new Date(b.when) - new Date(a.when))
    .slice(0, 5);
  return last;
}

async function getHeadToHead(teamA, teamB, days = 365) {
  const end = ymdParis();
  const start = ymdParis(new Date(Date.now() - days * 86400000));
  const url = `https://statsapi.web.nhl.com/api/v1/schedule?teamId=${teamA}&opponentId=${teamB}&startDate=${start}&endDate=${end}`;
  const r = await fetch(url);
  if (!r.ok) return { count: 0, record: "—" };
  const j = await r.json();
  const games = (j.dates || []).flatMap(d => d.games || []);
  let w = 0, l = 0;
  for (const g of games) {
    if (g.status?.statusCode !== "7") continue;
    const aHome = g.teams?.home?.team?.id === teamA;
    const us = aHome ? g.teams?.home?.score : g.teams?.away?.score;
    const them = aHome ? g.teams?.away?.score : g.teams?.home?.score;
    if (us > them) w++; else l++;
  }
  return { count: games.length, record: `${w}-${l}` };
}

async function getTeamsDirectory() {
  const r = await fetch("https://statsapi.web.nhl.com/api/v1/teams");
  if (!r.ok) return { byAbbr: new Map(), byId: new Map() };
  const j = await r.json();
  const byAbbr = new Map();
  const byId = new Map();
  for (const t of j.teams || []) {
    byAbbr.set(t.abbreviation, t.id);
    byId.set(t.id, t.abbreviation);
  }
  return { byAbbr, byId };
}

async function isBackToBack(teamId) {
  // back-to-back si match hier ET aujourd’hui
  const today = new Date();
  const y = ymdParis(new Date(today.getTime() - 86400000));
  const t = ymdParis(today);
  const url = `https://statsapi.web.nhl.com/api/v1/schedule?teamId=${teamId}&startDate=${y}&endDate=${t}`;
  const r = await fetch(url);
  if (!r.ok) return false;
  const j = await r.json();
  const dates = (j.dates || []).filter(d => (d.games || []).length > 0).map(d => d.date);
  return dates.includes(y) && dates.includes(t);
}

// ------------------ contenu & assemblage ------------------
function shortFormL5(list) {
  if (!list?.length) return "—";
  return list.map(g => g.wl).join("");
}
function num(x, d = 1) {
  if (x == null || Number.isNaN(+x)) return "—";
  return (+x).toFixed(d);
}

async function enrichGame(game, dirs) {
  const { byAbbr } = dirs;
  const awayId = game.awayId || byAbbr.get(game.away) || null;
  const homeId = game.homeId || byAbbr.get(game.home) || null;

  let awayStats = null, homeStats = null;
  let awayL5 = [], homeL5 = [];
  let b2bAway = false, b2bHome = false;
  let h2h = { count: 0, record: "—" };

  if (awayId) {
    [awayStats, awayL5, b2bAway] = await Promise.all([
      getTeamSeasonStats(awayId),
      getRecentResults(awayId, 30),
      isBackToBack(awayId),
    ]);
  }
  if (homeId) {
    [homeStats, homeL5, b2bHome] = await Promise.all([
      getTeamSeasonStats(homeId),
      getRecentResults(homeId, 30),
      isBackToBack(homeId),
    ]);
  }
  if (awayId && homeId) {
    h2h = await getHeadToHead(awayId, homeId, 365);
  }

  return {
    ...game,
    awayId, homeId,
    awayStats, homeStats,
    awayL5, homeL5,
    b2bAway, b2bHome,
    h2h,
  };
}

function buildGameLine(g) {
  const tAway = g.away;
  const tHome = g.home;

  const a = g.awayStats || {};
  const h = g.homeStats || {};

  const l5Away = shortFormL5(g.awayL5);
  const l5Home = shortFormL5(g.homeL5);

  const b2bTagA = g.b2bAway ? " (B2B)" : "";
  const b2bTagH = g.b2bHome ? " (B2B)" : "";

  const line1 = `• ${tAway}${b2bTagA} @ ${tHome}${b2bTagH} — ${fmtParisHM(g.startUTC)} (Paris)`;
  const line2 = `  PP: ${num(a.pp)}% / ${num(h.pp)}%  |  PK: ${num(a.pk)}% / ${num(h.pk)}%`;
  const line3 = `  GF/GA: ${num(a.gf)}/${num(a.ga)} vs ${num(h.gf)}/${num(h.ga)}  |  SOG: ${num(a.sf)}/${num(a.sa)} vs ${num(h.sf)}/${num(h.sa)}`;
  const line4 = `  Forme L5: ${tAway} ${l5Away}  —  ${tHome} ${l5Home}`;
  const line5 = `  H2H (1 an): ${tAway} vs ${tHome}: ${g.h2h.record} (${g.h2h.count} m.)`;

  return [line1, line2, line3, line4, line5].join("\n");
}

function chunkByLength(lines, max = 1800) {
  // Discord content <= 2000 chars → gardons marge
  const chunks = [];
  let cur = "";
  for (const ln of lines) {
    if ((cur + ln + "\n").length > max) {
      chunks.push(cur.trimEnd());
      cur = "";
    }
    cur += ln + "\n";
  }
  if (cur.trim()) chunks.push(cur.trimEnd());
  return chunks;
}

// ------------------ logique pré-match ------------------
async function generatePrematchDiscord() {
  const now = nowParis();
  const today = ymdParis(now);
  const games = await getScheduleParisDay(today);
  if (!games.length) {
    return { ok: true, sent: false, reason: "No games today" };
  }

  // Trie par heure Paris
  const withParis = games.map(g => ({
    ...g,
    startParis: new Date(new Date(g.startUTC).toLocaleString("en-US", { timeZone: "Europe/Paris" })),
  })).sort((a,b) => a.startParis - b.startParis);

  const first = withParis[0];
  const minToFirst = diffMin(first.startParis, now);
  const windowOk = minToFirst <= FIRST_WINDOW_MIN;

  console.log(`[${new Date().toISOString()}] 🏒 Première mise au jeu à ${fmtParis(first.startParis)} — dans ${minToFirst} minutes`);

  if (!windowOk) {
    return {
      ok: true,
      sent: false,
      reason: `first puck in ${minToFirst} min (> ${FIRST_WINDOW_MIN})`,
    };
  }

  // Filtrer seulement les matchs dans ~6h
  const cutOff = new Date(+now + GAME_WINDOW_MIN * 60000);
  const toCover = withParis.filter(g => g.startParis <= cutOff);

  const dirs = await getTeamsDirectory();
  const enriched = [];
  for (const g of toCover) {
    try {
      enriched.push(await enrichGame(g, dirs));
    } catch (e) {
      console.error("enrich error", g.id, e.message);
    }
  }

  const header = `[DISCORD:NHL] 🕒 SmartScout — Pré-match NHL (auto)\nFenêtre ~6h à partir de ${fmtParisHM(withParis[0].startParis)} (Paris)`;
  const blocks = [header];

  for (const g of enriched) {
    blocks.push(buildGameLine(g));
  }

  const chunks = chunkByLength(blocks, 1800);
  let sent = 0;
  for (const c of chunks) {
    const r = await postToDiscord({ content: c });
    if (r.ok) sent++;
  }

  return { ok: true, sent: sent > 0, count: sent };
}

// ------------------ routes HTTP ------------------
app.get("/ping", (_req, res) => res.send("pong"));

app.get("/test/prematch", async (_req, res) => {
  const msg = `[DISCORD:NHL] 🔵 SmartScout — Simulation pré-match NHL TEST
Match test : Maple Leafs @ Canadiens
Heure : 01h00 (Europe/Paris)
Analyse : Toronto en PP, Montréal en difficulté PK.
Tendance : Leafs 🔹 Over 6.5 🔹 Matthews buteur.
Confiance globale SmartScout : 81/100`;
  await postToDiscord({ content: msg });
  res.send("Pré-match test envoyé sur Discord ✅");
});

// Déclencheur manuel (utile pour tester rapidement)
app.get("/cron", async (_req, res) => {
  const today = ymdParis();
  const r = await generatePrematchDiscord();
  res.json({ today, result: r });
});

// ------------------ scheduler minute ------------------
async function scheduler() {
  try {
    const now = nowParis();
    const today = ymdParis(now);
    const minutes = now.getUTCMinutes(); // pas critique, on passe chaque minute

    // Exécute uniquement entre 16h et 23h Paris (fenêtre matchs NA + Europe)
    const heureParis = +new Date(now).toLocaleString("en-US", { timeZone: "Europe/Paris", hour: "2-digit", hour12: false });
    const inWindow = (heureParis >= 16 && heureParis <= 23);

    // Une fois par minute dans la fenêtre, mais pas deux fois le même jour
    if (inWindow && lastPrematchStamp !== today) {
      const r = await generatePrematchDiscord();
      if (r.sent) {
        lastPrematchStamp = today;
        console.log(`[${new Date().toISOString()}] Pré-match envoyé (${r.count} message(s)).`);
      } else {
        console.log(`[${new Date().toISOString()}] Fenêtre OK mais non-envoi: ${r.reason || "n/a"}`);
      }
    }
  } catch (e) {
    console.error("Scheduler error:", e.message);
  }
}

setInterval(scheduler, 60 * 1000);

app.listen(3000, () => {
  console.log("SmartScout NHL autobot up on 3000");
});