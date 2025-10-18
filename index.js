// index.js
import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

// ---------- CONFIG ----------
const NHL_HOOK = process.env.DISCORD_WEBHOOK_NHL; // à définir dans Render
const FIRST_WINDOW_MIN = 90;        // fenêtre avant 1er engagement
const LOOKAHEAD_HOURS = 6;          // matches couverts dans ~6h
const SCHED_HOURS = { start: 16, end: 23 }; // créneau auto (Paris)

// ---------- OUTILS TEMPS ----------
function nowParis() {
  return new Date();
}
function toParisString(d) {
  return d.toLocaleString("fr-FR", { timeZone: "Europe/Paris" });
}
function parisHours(d) {
  return Number(
    d.toLocaleString("en-CA", {
      timeZone: "Europe/Paris",
      hour12: false,
      hour: "2-digit",
    })
  );
}
function diffMin(a, b) {
  return Math.round((a.getTime() - b.getTime()) / 60000);
}

// ---------- NHL SCHEDULE (Render-compatible) ----------
async function fetchNhlSchedule(dateStr) {
  // Utilise l'API CDN de la NHL (fiable sur Render free)
  const url = `https://api.nhle.com/stats/rest/en/schedule?cayenneExp=gameDate%3E=%22${dateStr}%22%20and%20gameDate%3C=%22${dateStr}%22`;
  const res = await fetch(url, { timeout: 15000 });
  if (!res.ok) throw new Error(`NHL schedule HTTP ${res.status}`);
  const json = await res.json();

  const games = json?.data || [];
  return games.map((g) => {
    const startUTC = g.gameDate; // ISO
    const startDate = new Date(startUTC);
    return {
      id: g.gameId,
      away: g.awayTeamAbbrev || g.awayTeamName,
      home: g.homeTeamAbbrev || g.homeTeamName,
      startUTC,
      startDate,
      startParis: toParisString(startDate),
      state: "FUT",
    };
  });
}

async function getScheduleParisDay(dateObj) {
  // date format YYYY-MM-DD en Europe/Paris
  const y = dateObj
    .toLocaleString("en-CA", { timeZone: "Europe/Paris", year: "numeric" })
    .padStart(4, "0");
  const m = dateObj
    .toLocaleString("en-CA", { timeZone: "Europe/Paris", month: "2-digit" })
    .padStart(2, "0");
  const d = dateObj
    .toLocaleString("en-CA", { timeZone: "Europe/Paris", day: "2-digit" })
    .padStart(2, "0");

  return await fetchNhlSchedule(`${y}-${m}-${d}`);
}

// ---------- DISCORD ----------
async function postToDiscord(payload) {
  if (!NHL_HOOK) throw new Error("DISCORD_WEBHOOK_NHL manquant");
  const res = await fetch(NHL_HOOK, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Discord: ${res.status}`);
}

// ---------- LOGIQUE PRÉ-MATCH ----------
function windowAndGames(games, now, firstWindowMin, lookaheadHours) {
  if (!games.length) {
    return {
      ok: false,
      windowOk: false,
      reason: "No games today",
    };
  }

  // tri heure Paris
  const sorted = games
    .map((g) => ({
      ...g,
      parisDate: new Date(g.startUTC),
    }))
    .sort((a, b) => a.parisDate - b.parisDate);

  const first = sorted[0];
  const minToFirst = diffMin(first.parisDate, now);
  const windowOk = minToFirst <= firstWindowMin && minToFirst >= -10; // tolérance post coup d'envoi
  const lastWindow = new Date(now.getTime() + lookaheadHours * 3600 * 1000);

  const within = sorted.filter(
    (g) => g.parisDate <= lastWindow && diffMin(g.parisDate, now) >= -10
  );

  return {
    ok: true,
    windowOk,
    reason: windowOk ? "ok" : "windowClosedOrNotOpened",
    minToFirst,
    first,
    count: sorted.length,
    inWindowCount: within.length,
    within,
  };
}

function buildPrematchMessage(within, firstParisHuman) {
  const header =
    "[DISCORD:NHL] 🕑 SmartScout — Pré-match NHL (auto)\n" +
    `Fenêtre ~${LOOKAHEAD_HOURS}h à partir de ${firstParisHuman} (Paris)\n`;

  const lines = within.map(
    (g) => `• ${g.away} @ ${g.home} — ${toParisString(new Date(g.startUTC))} (Paris)`
  );

  return header + (lines.length ? "\n" + lines.join("\n") : "\n(aucun match dans la fenêtre)");
}

async function generatePrematchDiscord() {
  try {
    const now = nowParis();
    const games = await getScheduleParisDay(now);

    const diag = windowAndGames(
      games,
      now,
      FIRST_WINDOW_MIN,
      LOOKAHEAD_HOURS
    );

    if (!diag.ok) {
      return { ok: true, sent: false, reason: diag.reason, diag };
    }

    if (!diag.windowOk) {
      return {
        ok: true,
        sent: false,
        reason: "first puck not within window",
        diag,
      };
    }

    const msg = buildPrematchMessage(diag.within, toParisString(now));
    await postToDiscord({ content: msg });
    return { ok: true, sent: true, diag };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ---------- ROUTES ----------
app.get("/ping", (_req, res) => res.type("text").send("pong"));

app.post("/post", async (req, res) => {
  try {
    await postToDiscord(req.body);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Diagnostic : explique pourquoi ça enverrait/ne n’enverrait pas
app.get("/prematch/why", async (_req, res) => {
  try {
    const now = nowParis();
    const games = await getScheduleParisDay(now);
    const diag = windowAndGames(
      games,
      now,
      FIRST_WINDOW_MIN,
      LOOKAHEAD_HOURS
    );
    res.json({
      ok: true,
      cron: true,
      nowParis: toParisString(now),
      diag,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Force un envoi immédiat si fenêtre ouverte
app.get("/prematch/force", async (_req, res) => {
  const r = await generatePrematchDiscord();
  res.json(r);
});

// Simule le cron (déclenche la logique auto)
app.get("/cron/manual", async (_req, res) => {
  const r = await generatePrematchDiscord();
  res.json(r);
});

// ---------- SCHEDULER ----------
function tick() {
  const now = nowParis();
  const hr = parisHours(now);
  if (hr >= SCHED_HOURS.start && hr <= SCHED_HOURS.end) {
    // exécute à la minute *pile*
    const min = now.getUTCMinutes(); // minute réelle suffira
    if (min % 1 === 0) {
      generatePrematchDiscord().then((r) =>
        console.log(
          `[${toParisString(now)}] cron tick => sent=${r.sent || false} reason=${r.reason || "ok"}`
        )
      );
    }
  }
}
setInterval(tick, 60 * 1000);

// ---------- START ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`SmartScout NHL autobot up on ${PORT}`)
);