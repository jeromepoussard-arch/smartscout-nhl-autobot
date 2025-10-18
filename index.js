// index.js — SmartScout NHL autobot (Render) – pré-match enrichi
// ESM (node >= 18). Dépendances: express, node-fetch

import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

// ------------- CONFIG -------------
const NHL_HOOK = process.env.DISCORD_WEBHOOK_NHL; // <- Webhook Discord (env Render)
const TZ = "Europe/Paris";
const FIRST_WINDOW_MIN = 90;   // déclenche si 1er engagement ≤ 90 min
const LOOKAHEAD_HOURS = 6;     // couvre ~6h de matchs à partir du 1er
// ----------------------------------

// ========== OUTILS TEMPS ==========
const nowParis = () => new Date(new Date().toLocaleString("en-US", { timeZone: TZ }));
const fmtParis = (d) =>
  new Date(d).toLocaleString("fr-FR", {
    timeZone: TZ,
    hour: "2-digit",
    minute: "2-digit",
  });

// minutes entre deux dates
function diffMin(a, b) {
  return Math.round((a.getTime() - b.getTime()) / 60000);
}

// ========== OUTILS HTTP ==========
async function fetchJSON(url, opt = {}, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opt, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} @ ${url}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

// Sécurise l’envoi vers Discord
async function postToDiscord(payload) {
  try {
    const res = await fetch(NHL_HOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`Discord: ${res.status}`);
  } catch (err) {
    console.error("[Discord] Erreur:", err.message);
  }
}

// ========== SOURCES NHL ==========
/**
 * Planning NHL du jour (API officielle Web NHL)
 * Exemple: https://api-web.nhle.com/v1/schedule/2025-10-18
 */
async function getScheduleParisDay(dParis) {
  const yyyy = dParis.getFullYear();
  const mm = String(dParis.getMonth() + 1).padStart(2, "0");
  const dd = String(dParis.getDate()).padStart(2, "0");
  const url = `https://api-web.nhle.com/v1/schedule/${yyyy}-${dd < 15 ? mm : mm}/${dd}`;

  // L’API NHL veut bien la forme YYYY-MM-DD ; on s’assure via Paris
  const urlFixed = `https://api-web.nhle.com/v1/schedule/${yyyy}-${mm}-${dd}`;
  const j = await fetchJSON(urlFixed).catch(() => fetchJSON(url).catch(() => null));
  if (!j || !Array.isArray(j.gameWeek)) return [];

  // Normalise les matchs du jour
  const games = [];
  for (const wk of j.gameWeek) {
    for (const g of wk.games || []) {
      // g.startTimeUTC (ISO), g.homeTeam.abbrev, g.awayTeam.abbrev, g.id
      games.push({
        id: g.id,
        away: g.awayTeam?.abbrev,
        home: g.homeTeam?.abbrev,
        startUTC: g.startTimeUTC,
      });
    }
  }
  return games;
}

/**
 * Données landing par match (pré-game) – utile pour diverses bribes
 * https://api-web.nhle.com/v1/gamecenter/{gameId}/landing
 */
async function getLanding(gameId) {
  const url = `https://api-web.nhle.com/v1/gamecenter/${gameId}/landing`;
  return await fetchJSON(url).catch(() => null);
}

/**
 * Mini-stats équipe sur la saison en cours & forme récente.
 * Ici on s’appuie surtout sur landing et ce qui est disponible rapidement.
 * (L’API NHL n’expose pas tout: xG, PP/PK avancés, etc. On formate “à confirmer” si absent.)
 */
function extractQuickTeamForm(landing, teamAbbrev) {
  if (!landing) return { form: "N/A", pp: "N/A", pk: "N/A", pace: "N/A" };

  // Derniers résultats récents depuis landing?.teamGameLog?? (selon expo)
  // On tente une lecture "last five" si présente ; sinon placeholder.
  let form = "à confirmer";
  try {
    const logs =
      landing?.teamGameLog?.[teamAbbrev]?.slice?.(0, 5) ||
      landing?.teamGameLog?.[teamAbbrev]?.games?.slice?.(0, 5);
    if (logs?.length) {
      const w = logs.filter((g) => g.decision?.toUpperCase?.() === "W").length;
      form = `L5: ${w}-${5 - w}`;
    }
  } catch (_) {}

  // PP/PK approximatifs si fournis dans landing?.teamRecords?.specialTeams
  let pp = "à confirmer";
  let pk = "à confirmer";
  try {
    const rec = landing?.teamRecords?.[teamAbbrev];
    if (rec?.powerPlayPct != null) pp = `${(rec.powerPlayPct * 100).toFixed(1)}%`;
    if (rec?.penaltyKillPct != null) pk = `${(rec.penaltyKillPct * 100).toFixed(1)}%`;
  } catch (_) {}

  // “Pace” (tempo) absent => placeholder
  const pace = "à confirmer";

  return { form, pp, pk, pace };
}

/**
 * Gardiens probables / confirmés:
 * - L’API NHL ne “garantit” pas de champ universel ; on tente quelques heuristiques
 *   via landing -> probableGoalies/probables, sinon on marque “(à confirmer)”.
 */
function extractProbableGoalies(landing) {
  try {
    const pg =
      landing?.probableGoalies ||
      landing?.startingGoalies ||
      landing?.goalies ||
      null;
    if (!pg) return { away: "(à confirmer)", home: "(à confirmer)" };

    const away =
      pg.away?.confirmed?.name ||
      pg.away?.probable?.name ||
      pg.away?.name ||
      "(à confirmer)";
    const home =
      pg.home?.confirmed?.name ||
      pg.home?.probable?.name ||
      pg.home?.name ||
      "(à confirmer)";

    return { away, home };
  } catch {
    return { away: "(à confirmer)", home: "(à confirmer)" };
  }
}

// ========== CONSTRUCTION MESSAGE ==========
function buildMatchLine({ away, home, startParis, goalies, aTeam, hTeam }) {
  // aTeam/hTeam = { form, pp, pk, pace }
  return (
    `• **${away} @ ${home}** — **${fmtParis(startParis)} (Paris)**\n` +
    `  • Gardiens: ${away} 🧤 ${goalies.away}  |  ${home} 🧤 ${goalies.home}\n` +
    `  • ${away}: ${aTeam.form} | PP ${aTeam.pp} • PK ${aTeam.pk} • Pace ${aTeam.pace}\n` +
    `  • ${home}: ${hTeam.form} | PP ${hTeam.pp} • PK ${hTeam.pk} • Pace ${hTeam.pace}\n`
  );
}

function buildHeader(windowInfo) {
  return (
    `[DISCORD:NHL] ⏰ SmartScout — **Pré-match NHL (auto)**\n` +
    `Fenêtre ~${LOOKAHEAD_HOURS}h à partir de **${fmtParis(windowInfo.firstStart)} (Paris)**\n`
  );
}

function buildAnglesNote() {
  // Placeholder pédagogique : on pose les sections ; les vraies règles d’angles
  // (xG/pace/O-U/joueurs) peuvent être codées plus finement ensuite.
  return (
    `\n__Angles & tendances (aperçu)__\n` +
    `• Over/Under (match): *à confirmer selon xG & pace*\n` +
    `• Buteurs/Points (2–4 joueurs): *à confirmer via usage PP/forme*\n`
  );
}

// ========== LOGIQUE PRÉ-MATCH ==========
async function generatePrematchDiscord() {
  const now = nowParis();

  // 1) Charge planning du jour (heure Paris)
  const games = await getScheduleParisDay(now);
  if (!games.length) {
    return { ok: false, reason: "No games today" };
  }

  // 2) Calcule la 1re mise au jeu (Paris)
  const withParis = games.map((g) => ({
    ...g,
    startParis: new Date(new Date(g.startUTC).toLocaleString("en-US", { timeZone: TZ })),
  }));
  withParis.sort((a, b) => a.startParis - b.startParis);

  const first = withParis[0];
  const minToFirst = diffMin(first.startParis, now);
  const windowOk = minToFirst <= FIRST_WINDOW_MIN;

  if (!windowOk) {
    return {
      ok: true,
      sent: false,
      reason: `first puck in ${minToFirst} min`,
      firstStart: first.startParis,
    };
  }

  // 3) Sélectionne les matchs qui commencent dans ~6h à partir du 1er
  const windowEnd = new Date(first.startParis.getTime() + LOOKAHEAD_HOURS * 3600 * 1000);
  const bucket = withParis.filter(
    (g) => g.startParis >= first.startParis && g.startParis <= windowEnd
  );

  // 4) Enrichit via landing (goalies, forme simplifiée, PP/PK si dispo)
  const enriched = [];
  for (const g of bucket) {
    const landing = await getLanding(g.id).catch(() => null);

    const goalies = extractProbableGoalies(landing);
    const aTeam = extractQuickTeamForm(landing, g.away);
    const hTeam = extractQuickTeamForm(landing, g.home);

    enriched.push({
      ...g,
      goalies,
      aTeam,
      hTeam,
    });
  }

  // 5) Compose message Discord
  const header = buildHeader({ firstStart: first.startParis });
  const body = enriched.map((g) =>
    buildMatchLine({
      away: g.away,
      home: g.home,
      startParis: g.startParis,
      goalies: g.goalies,
      aTeam: g.aTeam,
      hTeam: g.hTeam,
    })
  ).join("\n");

  const tail = buildAnglesNote();

  const content =
    `${header}\n` +
    body +
    tail;

  // 6) Envoi
  await postToDiscord({ content });

  return { ok: true, sent: true, count: enriched.length, firstStart: first.startParis };
}

// ========== ROUTES HTTP ==========

// ping (debug)
app.get("/ping", (_req, res) => res.send("pong"));

// test manuel (message court fixe)
app.get("/test/prematch", async (_req, res) => {
  await postToDiscord({
    content:
      `[DISCORD:NHL] 🔵 SmartScout — Simulation pré-match NHL TEST\n` +
      `Match test : Maple Leafs @ Canadiens\nHeure : 01h00 (Europe/Paris)\n` +
      `Analyse : Toronto domine en xG et PP, Montréal peine en PK.\n` +
      `Tendance : Victoire Leafs 🔹 Over 6.5 🔹 Matthews buteur.\n` +
      `Confiance globale SmartScout : 81/100`,
  });
  res.send("Pré-match test envoyé ✅");
});

// CRON: vérifie fenêtre & envoie si éligible
// - /cron/prematch           -> logique normale (fenêtre ≤ 90 min)
// - /cron/prematch?force=1   -> FORCER l’envoi (utile pour tests/backup)
app.get("/cron/prematch", async (req, res) => {
  try {
    const force = `${req.query.force || ""}` === "1";
    if (force) {
      const r = await generatePrematchDiscord();
      return res.json({ ok: true, forced: true, ...r });
    }

    const r = await generatePrematchDiscord();
    return res.json({ ok: true, forced: false, ...r });
  } catch (err) {
    console.error("Cron/prematch error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Boucle minute (log local – garde l’appli vivante, mais Render peut dormir)
setInterval(() => {
  const d = nowParis();
  if (d.getMinutes() % 15 === 0) {
    console.log(`[${d.toISOString()}] heartbeat`);
  }
}, 60 * 1000);

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`SmartScout NHL autobot up on ${PORT}`);
});