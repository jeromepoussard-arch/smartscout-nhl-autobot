// index.js — SmartScout NHL autobot (Render/Web Service)
// Runtime: Node 18+  |  Start: `node index.js`

import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

// ====== ENV ======
const NHL_HOOK = process.env.DISCORD_WEBHOOK_NHL; // <-- ton webhook Discord Render
if (!NHL_HOOK) {
  console.warn("⚠️ DISCORD_WEBHOOK_NHL manquant dans Render.");
}

// ====== UTILS ======
function nowParisDate() {
  return new Date();
}
function fmtParis(d) {
  return d.toLocaleString("fr-FR", { timeZone: "Europe/Paris" });
}
function ymdParis(d) {
  const s = fmtParis(d);
  const [date] = s.split(",");
  const [dd, mm, yyyy] = date.split("/");
  return `${yyyy}-${mm}-${dd}`;
}
function diffMinSigned(targetDate, nowDate) {
  return Math.round((targetDate.getTime() - nowDate.getTime()) / 60000);
}

// ====== NHL SCHEDULE (version stable) ======
// Source : https://statsapi.web.nhl.com/api/v1/schedule?date=YYYY-MM-DD
async function fetchNhlSchedule(dateStr) {
  const url = `https://statsapi.web.nhl.com/api/v1/schedule?date=${dateStr}`;
  const res = await fetch(url, { timeout: 15000 });
  if (!res.ok) throw new Error(`NHL schedule HTTP ${res.status}`);
  const json = await res.json();

  const games = json.dates?.[0]?.games || [];
  return games.map(g => ({
    id: g.gamePk,
    away: g.teams?.away?.team?.abbreviation || g.teams?.away?.team?.name || "AWY",
    home: g.teams?.home?.team?.abbreviation || g.teams?.home?.team?.name || "HOME",
    startUTC: g.gameDate,
    startDate: new Date(g.gameDate),
    startParis: new Date(g.gameDate).toLocaleString("fr-FR", { timeZone: "Europe/Paris" }),
    state: g.status?.abstractGameState || "FUT",
  }));
}

async function getScheduleParisDay(now = nowParisDate()) {
  const dateStr = ymdParis(now);
  const games = await fetchNhlSchedule(dateStr);
  return games;
}

// ====== DISCORD ======
async function postToDiscord(payload) {
  if (!NHL_HOOK) {
    console.error("Discord webhook manquant.");
    return { ok: false, reason: "noWebhook" };
  }
  try {
    const res = await fetch(NHL_HOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`Discord ${res.status}`);
    return { ok: true };
  } catch (err) {
    console.error("Erreur Discord:", err.message);
    return { ok: false, reason: err.message };
  }
}

// ====== FENÊTRE “PROCHAIN PUCK” ======
const sentStarts = new Set();

function pickNextWindow(games, now) {
  const upcoming = games
    .filter(g => g.startDate.getTime() >= now.getTime() - 15 * 60 * 1000)
    .sort((a, b) => a.startDate - b.startDate);

  const next = upcoming[0];
  if (!next) return { windowOk: false, reason: "noUpcoming" };

  const minToNext = diffMinSigned(next.startDate, now);
  const inSixHours = minToNext <= 360;
  const inWindow = minToNext >= 0 && minToNext <= 90;
  const notSentYet = !sentStarts.has(next.startUTC);

  return {
    windowOk: inWindow && inSixHours && notSentYet,
    reason: inWindow ? (notSentYet ? "ok" : "alreadySentThisStart") : "outsideWindow",
    minToNext,
    nextGame: next,
  };
}

// ====== MESSAGE BUILDER ======
function buildPrematchMessage(gamesWindow, now) {
  const lines = [];
  const within6h = gamesWindow
    .filter(g => {
      const m = diffMinSigned(g.startDate, now);
      return m >= 0 && m <= 360;
    })
    .sort((a, b) => a.startDate - b.startDate)
    .map(g => `• ${g.away} @ ${g.home} — ${g.startParis} (Paris)`);

  if (within6h.length === 0) {
    lines.push("_Aucun match dans la fenêtre ~6h._");
  } else {
    lines.push("Fenêtre ~6h à partir de maintenant (Paris):");
    lines.push(...within6h);
  }

  const header = `[DISCORD:NHL] ⏰ SmartScout — Pré-match NHL (auto)`;
  return `${header}\n${lines.join("\n")}`;
}

// ====== ROUTES ======
app.get("/ping", (_req, res) => res.send("pong"));

app.post("/post", async (req, res) => {
  const payload = req.body && typeof req.body === "object" ? req.body : { content: String(req.body || "") };
  const r = await postToDiscord(payload);
  res.json({ ok: r.ok });
});

app.get("/prematch/why", async (_req, res) => {
  try {
    const now = nowParisDate();
    const games = await getScheduleParisDay(now);
    const window = pickNextWindow(games, now);

    res.json({
      ok: true,
      nowParis: fmtParis(now),
      diag: {
        count: games.length,
        minToNext: window.minToNext ?? null,
        windowOk: window.windowOk,
        reason: window.reason,
        next: window.nextGame
          ? { away: window.nextGame.away, home: window.nextGame.home, startParis: window.nextGame.startParis, startUTC: window.nextGame.startUTC }
          : null,
      },
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/prematch/force", async (_req, res) => {
  try {
    const now = nowParisDate();
    const games = await getScheduleParisDay(now);
    const msg = buildPrematchMessage(games, now);
    const r = await postToDiscord({ content: msg });
    if (r.ok) {
      return res.json({ ok: true, sent: true });
    }
    res.status(500).json({ ok: false, sent: false, reason: r.reason });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/cron/manual", async (_req, res) => {
  try {
    const now = nowParisDate();
    const games = await getScheduleParisDay(now);
    const window = pickNextWindow(games, now);

    if (window.windowOk) {
      const msg = buildPrematchMessage(games, now);
      const r = await postToDiscord({ content: msg });
      if (r.ok) {
        sentStarts.add(window.nextGame.startUTC);
        return res.json({ ok: true, cron: true, sent: true, nextStartUTC: window.nextGame.startUTC, minToNext: window.minToNext });
      }
      return res.status(500).json({ ok: false, cron: true, sent: false, reason: r.reason });
    } else {
      return res.json({
        ok: true,
        cron: true,
        sent: false,
        reason: window.reason,
        minToNext: window.minToNext ?? null,
      });
    }
  } catch (err) {
    res.status(500).json({ ok: false, cron: true, error: err.message });
  }
});

// ====== CRON TICK ======
async function cronTick() {
  try {
    const now = nowParisDate();
    const games = await getScheduleParisDay(now);
    const window = pickNextWindow(games, now);

    if (window.windowOk) {
      const msg = buildPrematchMessage(games, now);
      const r = await postToDiscord({ content: msg });
      if (r.ok) {
        sentStarts.add(window.nextGame.startUTC);
        console.log(`[${fmtParis(now)}] Pré-match auto envoyé ✅ pour ${window.nextGame.away}@${window.nextGame.home} (T-${window.minToNext}m)`);
      } else {
        console.log(`[${fmtParis(now)}] Discord error: ${r.reason}`);
      }
    }
  } catch (err) {
    console.error("cronTick error:", err.message);
  }
}
setInterval(cronTick, 60 * 1000);

// ====== SERVER ======
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`SmartScout NHL autobot up on ${PORT}`);
});