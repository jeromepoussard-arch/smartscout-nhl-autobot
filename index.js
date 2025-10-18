// index.js
import express from "express";
import fetch from "node-fetch";

// ====== CONFIG ======
const PORT = process.env.PORT || 3000;
const NHL_HOOK = process.env.DISCORD_WEBHOOK_NHL; // ⚠️ à configurer sur Render
const FIRST_WINDOW_MIN = 90;                      // fenêtre avant 1er puck
const H6 = 6 * 60;                                // ~6h

if (!NHL_HOOK) {
  console.warn("[WARN] DISCORD_WEBHOOK_NHL manquant. Les envois échoueront.");
}

const app = express();
app.use(express.json());

// ====== UTILS TEMPS ======
function nowParis() {
  // Objet Date "réel", mais on manipule via toLocaleString pour la TZ
  return new Date();
}
function toParisDate(d) {
  // Construit un Date basé sur l'horodatage Paris (pour comparer en minutes)
  return new Date(
    new Date(d).toLocaleString("en-US", { timeZone: "Europe/Paris" })
  );
}
function diffMin(a, b) {
  // a et b = Date ; renvoie (a - b) en minutes
  return Math.round((a.getTime() - b.getTime()) / 60000);
}
function formatParis(dt) {
  return new Date(dt).toLocaleString("fr-FR", {
    timeZone: "Europe/Paris",
    hour: "2-digit",
    minute: "2-digit",
  });
}
function formatParisDayISO(d) {
  // yyyy-mm-dd en date Paris
  const paris = toParisDate(d);
  const y = paris.getFullYear();
  const m = String(paris.getMonth() + 1).padStart(2, "0");
  const da = String(paris.getDate()).padStart(2, "0");
  return `${y}-${m}-${da}`;
}

// ====== DISCORD ======
async function postToDiscord(payload) {
  if (!NHL_HOOK) throw new Error("DISCORD_WEBHOOK_NHL is undefined");
  const res = await fetch(NHL_HOOK, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Discord HTTP ${res.status}: ${txt}`);
  }
}

// ====== NHL SCHEDULE (jour Paris) ======
async function getScheduleParisDay(d = nowParis()) {
  // API NHL non authentifiée : https://api-web.nhle.com/v1/schedule/YYYY-MM-DD
  const day = formatParisDayISO(d);
  const url = `https://api-web.nhle.com/v1/schedule/${day}`;

  const res = await fetch(url, { timeout: 15000 }).catch((e) => {
    console.error("[NHL] fetch error:", e);
    throw new Error("Failed to fetch NHL schedule");
  });
  if (!res.ok) throw new Error(`NHL schedule HTTP ${res.status}`);
  const json = await res.json();

  // Normalisation
  // On renvoie une liste de { id, away, home, startUTC, state }
  const out = [];
  const games = json?.gameWeek?.flatMap((w) => w.games) || json?.games || [];
  for (const g of games) {
    // Les structures varient selon version; on essaie d'être permissif
    const id = g.id ?? g.gameId ?? `${g.awayTeam?.abbrev}-${g.homeTeam?.abbrev}-${g.startTimeUTC}`;
    const away = g.awayTeam?.abbrev || g.away || g.visitorTeam?.abbrev || "AWY";
    const home = g.homeTeam?.abbrev || g.home || g.homeTeamAbbrev || "HOM";
    const startUTC =
      g.startTimeUTC || g.gameDate || g.startTime || g.startUTC || null;
    const state = g.gameState || g.state || "FUT";
    if (id && away && home && startUTC) {
      out.push({ id, away, home, startUTC, state });
    }
  }
  return out;
}

// ====== BUILDER MESSAGE (simple, prêt à enrichir) ======
function buildPrematchMessage(g) {
  const startParis = formatParis(toParisDate(g.startUTC));
  return `[DISCORD:NHL] 🏒 SmartScout — Pré-match (auto)
${g.away} @ ${g.home} — **${startParis} (Paris)**
Fenêtre ~6h activée. (id: ${g.id})`;
}

// ====== LOGIQUE PRÉ-MATCH ======
async function generatePrematchDiscord(opts = {}) {
  const force = Boolean(opts.force);
  const now = nowParis();

  // 1) Planning jour Paris
  const games = await getScheduleParisDay(now);
  if (!games.length) {
    return { ok: true, sent: false, reason: "No games today" };
  }

  // 2) StartParis + tri
  const withParis = games
    .map((g) => ({
      ...g,
      startParis: toParisDate(g.startUTC),
    }))
    .sort((a, b) => a.startParis - b.startParis);

  // 3) Fenêtre par rapport au 1er engagement
  const first = withParis[0];
  const minToFirst = diffMin(first.startParis, now);
  const windowOk = minToFirst <= FIRST_WINDOW_MIN;

  if (!windowOk && !force) {
    return {
      ok: true,
      sent: false,
      reason: `first puck in ${minToFirst} min (outside 90-min window)`,
    };
  }

  // 4) Sélection des matchs qui démarrent dans ~6h (si force → toute la journée +/- 30min)
  const target = withParis.filter((g) => {
    const dt = diffMin(g.startParis, now);
    return force ? dt >= -30 && dt <= 24 * 60 : dt >= 0 && dt <= H6;
  });

  if (!target.length) {
    return { ok: true, sent: false, reason: "No games within window" };
  }

  // 5) Envois Discord
  let sentCount = 0;
  const details = [];
  for (const g of target) {
    const msg = buildPrematchMessage(g);
    await postToDiscord({ content: msg });
    sentCount++;
    details.push({
      away: g.away,
      home: g.home,
      startParis: formatParis(g.startParis),
      minToStart: diffMin(g.startParis, now),
    });
  }

  return { ok: true, sent: true, count: sentCount, details };
}

// ====== ROUTES ======

// Sanity check
app.get("/ping", (_req, res) => res.send("pong"));

// Force immédiat (bypass fenêtre 90 min)
app.get("/prematch/force", async (_req, res) => {
  try {
    const out = await generatePrematchDiscord({ force: true });
    res.status(200).json({ ok: true, ...out, forced: true });
  } catch (err) {
    console.error("Force prematch error:", err);
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// Respecte la fenêtre (≤ 90min avant 1er puck)
app.get("/prematch/cron", async (_req, res) => {
  try {
    const out = await generatePrematchDiscord({ force: false });
    res.status(200).json({ ok: true, ...out, cron: true });
  } catch (err) {
    console.error("Cron prematch error:", err);
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// Petit POST générique pour tester l’acheminement Discord
app.post("/post", async (req, res) => {
  try {
    const { content } = req.body || {};
    await postToDiscord({ content: content ?? "[DISCORD:NHL] relay test" });
    res.json({ ok: true });
  } catch (e) {
    console.error("POST /post error:", e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// ====== SCHEDULER (facultatif) ======
// Lance chaque minute; déclenche à mm===0 entre 16h–23h Paris
setInterval(async () => {
  try {
    const d = nowParis();
    const parisHour = toParisDate(d).getHours(); // heure Paris
    const minutes = toParisDate(d).getMinutes();

    if (minutes === 0 && parisHour >= 16 && parisHour <= 23) {
      console.log(`[${new Date().toISOString()}] Tick horaire → /prematch/cron`);
      await generatePrematchDiscord({ force: false });
    }
  } catch (e) {
    console.error("Scheduler error:", e);
  }
}, 60 * 1000);

// ====== START ======
app.listen(PORT, () =>
  console.log(`SmartScout NHL autobot up on ${PORT}`)
);