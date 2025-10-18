// index.js (ESM) — SmartScout NHL autobot (Render) V2.1
// Env requis: DISCORD_WEBHOOK_NHL

import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const NHL_HOOK = process.env.DISCORD_WEBHOOK_NHL;

// Fenêtres
const FIRST_WINDOW_MIN = 90;         // déclenche auto si 1er puck <= 90 min
const GAME_WINDOW_MIN  = 360;        // ~6h de matchs à couvrir

// Anti-doublon (pré-match envoyé une fois/jour)
let lastPrematchStamp = null;        // "YYYY-MM-DD"

// -------------- utilitaires temps --------------
function nowParis(){ return new Date(); }
function ymdParis(dateObj=new Date()){
  const d = new Date(dateObj);
  return d.toLocaleDateString("sv-SE",{ timeZone:"Europe/Paris" }); // YYYY-MM-DD
}
function fmtParisHM(d){
  try{
    return new Date(d).toLocaleTimeString("fr-FR",{ timeZone:"Europe/Paris", hour:"2-digit", minute:"2-digit" });
  }catch{ return String(d); }
}
function fmtParis(d){
  try{
    return new Date(d).toLocaleString("fr-FR",{ timeZone:"Europe/Paris", day:"2-digit", month:"2-digit", hour:"2-digit", minute:"2-digit" });
  }catch{ return String(d); }
}
function diffMin(a,b){ return Math.round((new Date(a)-new Date(b))/60000); }
function num(x,d=1){ if(x==null||Number.isNaN(+x)) return "—"; return (+x).toFixed(d); }
function clamp(n,a,b){ return Math.max(a,Math.min(b,n)); }

// -------------- Discord --------------
async function postToDiscord(payload){
  if(!NHL_HOOK){ console.error("DISCORD_WEBHOOK_NHL manquant"); return {ok:false}; }
  try{
    const r = await fetch(NHL_HOOK,{ method:"POST", headers:{ "Content-Type":"application/json" }, body:JSON.stringify(payload) });
    if(!r.ok){ throw new Error(`Discord ${r.status} ${await r.text().catch(()=> "")}`); }
    return { ok:true };
  }catch(e){ console.error("Discord err:", e.message); return {ok:false}; }
}

// -------------- NHL helpers --------------
// Schedule (api-web en premier, sinon statsapi)
async function getScheduleParisDay(parisDateStr){
  const url1 = `https://api-web.nhle.com/v1/schedule/${parisDateStr}`;
  try{
    const r = await fetch(url1,{ timeout:15000 });
    if(r.ok){
      const j = await r.json();
      return (j?.gameWeek?.[0]?.games||[]).map(g=>({
        id:g.id, gamePk:g.id,
        away:g.awayTeam?.abbrev, home:g.homeTeam?.abbrev,
        startUTC:g.startTimeUTC, state:g.gameState
      }));
    }
  }catch{}
  const url2 = `https://statsapi.web.nhl.com/api/v1/schedule?date=${parisDateStr}`;
  const r2 = await fetch(url2);
  if(!r2.ok) return [];
  const j2 = await r2.json();
  return (j2.dates?.[0]?.games||[]).map(g=>({
    id:g.gamePk, gamePk:g.gamePk,
    away:g.teams?.away?.team?.abbreviation||g.teams?.away?.team?.name,
    home:g.teams?.home?.team?.abbreviation||g.teams?.home?.team?.name,
    startUTC:g.gameDate,
    state:g.status?.statusCode,
    awayId:g.teams?.away?.team?.id, homeId:g.teams?.home?.team?.id,
  }));
}

async function getTeamsDirectory(){
  const r = await fetch("https://statsapi.web.nhl.com/api/v1/teams");
  if(!r.ok) return {byAbbr:new Map(), byId:new Map()};
  const j = await r.json();
  const byAbbr=new Map(), byId=new Map();
  for(const t of j.teams||[]){ byAbbr.set(t.abbreviation,t.id); byId.set(t.id,t.abbreviation); }
  return { byAbbr, byId };
}

async function getTeamSeasonStats(teamId){
  const url = `https://statsapi.web.nhl.com/api/v1/teams?teamId=${teamId}&expand=team.stats`;
  const r = await fetch(url);
  if(!r.ok) return null;
  const s = (await r.json()).teams?.[0]?.teamStats?.[0]?.splits?.[0]?.stat || null;
  if(!s) return null;
  return { pp:+s.powerPlayPercentage, pk:+s.penaltyKillPercentage, gf:+s.goalsPerGame, ga:+s.goalsAgainstPerGame, sf:+s.shotsPerGame, sa:+s.shotsAllowed };
}

async function getRecentResults(teamId, days=30){
  const end = ymdParis(); const start = ymdParis(new Date(Date.now()-days*86400000));
  const url = `https://statsapi.web.nhl.com/api/v1/schedule?teamId=${teamId}&startDate=${start}&endDate=${end}`;
  const r = await fetch(url); if(!r.ok) return [];
  const j = await r.json();
  const games = (j.dates||[]).flatMap(d=> d.games||[]);
  return games.filter(g=> g.status?.statusCode==="7").map(g=>{
    const isHome = g.teams?.home?.team?.id===teamId;
    const us = isHome? g.teams?.home?.score : g.teams?.away?.score;
    const them = isHome? g.teams?.away?.score : g.teams?.home?.score;
    return { wl: us>them? "W":"L", gamePk:g.gamePk, when:g.gameDate };
  }).sort((a,b)=> new Date(b.when)-new Date(a.when)).slice(0,5);
}

async function getHeadToHead(teamA,teamB, days=365){
  const end = ymdParis(); const start = ymdParis(new Date(Date.now()-days*86400000));
  const url = `https://statsapi.web.nhl.com/api/v1/schedule?teamId=${teamA}&opponentId=${teamB}&startDate=${start}&endDate=${end}`;
  const r = await fetch(url); if(!r.ok) return {count:0,record:"—"};
  const games = ((await r.json()).dates||[]).flatMap(d=> d.games||[]);
  let w=0,l=0;
  for(const g of games){
    if(g.status?.statusCode!=="7") continue;
    const aHome = g.teams?.home?.team?.id===teamA;
    const us   = aHome? g.teams?.home?.score : g.teams?.away?.score;
    const them = aHome? g.teams?.away?.score : g.teams?.home?.score;
    if(us>them) w++; else l++;
  }
  return { count:games.length, record:`${w}-${l}` };
}

async function isBackToBack(teamId){
  const today = new Date();
  const y = ymdParis(new Date(today.getTime()-86400000));
  const t = ymdParis(today);
  const url = `https://statsapi.web.nhl.com/api/v1/schedule?teamId=${teamId}&startDate=${y}&endDate=${t}`;
  const r = await fetch(url); if(!r.ok) return false;
  const dates = ((await r.json()).dates||[]).map(d=> d.date);
  return dates.includes(y) && dates.includes(t);
}

// --- Joueurs chauds L5 (agrège boxscores des 5 derniers matchs) ---
async function collectTeamL5SkaterTrends(teamId){
  const rec = await getRecentResults(teamId, 30);
  const last = rec.map(r=> r.gamePk);
  const map = new Map(); // playerId -> {name, teamId, g,a,pts,sog}

  for(const gamePk of last){
    try{
      const u = `https://statsapi.web.nhl.com/api/v1/game/${gamePk}/boxscore`;
      const r = await fetch(u); if(!r.ok) continue;
      const j = await r.json();
      // repère si teamId est home/away
      const side = (j.teams?.home?.team?.id===teamId) ? "home":"away";
      const skaters = j.teams?.[side]?.players || {};
      for(const pid of Object.keys(skaters)){
        const p = skaters[pid];
        if(p?.position?.abbreviation==="G") continue; // ignore goalies ici
        const id = p?.person?.id; const name = p?.person?.fullName;
        const stats = p?.stats?.skaterStats || {};
        const g = +stats.goals || 0, a = +stats.assists || 0, sog = +stats.shots || 0;
        if(!id) continue;
        if(!map.has(id)) map.set(id,{name,teamId,g:0,a:0,pts:0,sog:0});
        const agg = map.get(id); agg.g+=g; agg.a+=a; agg.pts+=g+a; agg.sog+=sog;
      }
    }catch{}
  }
  const arr = [...map.values()].sort((x,y)=> (y.pts - x.pts) || (y.sog - x.sog)).slice(0,3);
  return arr; // [{name,g,a,pts,sog},...]
}

// -------------- Assemblage/enrichissement match --------------
function shortFormL5(list){ return !list?.length ? "—" : list.map(g=> g.wl).join(""); }

async function enrichGame(game, dirs){
  const { byAbbr } = dirs;
  const awayId = game.awayId || byAbbr.get(game.away) || null;
  const homeId = game.homeId || byAbbr.get(game.home) || null;

  let [aStats,hStats] = [null,null];
  let [aL5,hL5] = [[],[]];
  let [b2bA,b2bH] = [false,false];
  let h2h = {count:0,record:"—"};
  let [hotA, hotH] = [[],[]];

  if(awayId){
    [aStats,aL5,b2bA,hotA] = await Promise.all([
      getTeamSeasonStats(awayId),
      getRecentResults(awayId,30),
      isBackToBack(awayId),
      collectTeamL5SkaterTrends(awayId),
    ]);
  }
  if(homeId){
    [hStats,hL5,b2bH,hotH] = await Promise.all([
      getTeamSeasonStats(homeId),
      getRecentResults(homeId,30),
      isBackToBack(homeId),
      collectTeamL5SkaterTrends(homeId),
    ]);
  }
  if(awayId && homeId){ h2h = await getHeadToHead(awayId,homeId,365); }

  // Angle Over/Under basique
  const angle = buildOuAngle(aStats,hStats);

  return {
    ...game, awayId, homeId,
    awayStats:aStats, homeStats:hStats,
    awayL5:aL5, homeL5:hL5,
    b2bAway:b2bA, b2bHome:b2bH,
    h2h, angle,
    hotAway:hotA, hotHome:hotH
  };
}

// Heuristique O/U (simple mais robuste)
function buildOuAngle(a={},h={}){
  const expGoals = (+a.gf||2.9) + (+h.gf||2.9); // moyenne buts pour
  const defense  = (+a.ga||2.9) + (+h.ga||2.9); // buts contre
  const shots    = (+a.sf||31)  + (+h.sf||31)   + (+a.sa||31) + (+h.sa||31);
  const ppEdge   = ( (+a.pp||0) > 22 || (+h.pp||0) > 22 ) ? 1 : 0;
  const pkWeak   = ( (+a.pk||100) < 78 || (+h.pk||100) < 78 ) ? 1 : 0;

  const pace = shots/2; // ≈ tirs par équipe cumulés
  let score = 0;
  score += expGoals>6.0 ? 2 : expGoals>5.6 ? 1 : -1;
  score += defense>6.0 ? 1 : defense<5.4 ? -1 : 0;
  score += pace>64 ? 1 : pace<58 ? -1 : 0;
  score += ppEdge + pkWeak;

  let pick="Équilibré", why=[];
  if(score>=2){ pick="Over";  why.push("volume offensif et rythme au-dessus de la moyenne"); }
  else if(score<=-2){ pick="Under"; why.push("défenses/rythme plus serrés"); }
  if(ppEdge)  why.push("avantage PP notable");
  if(pkWeak)  why.push("PK vulnérable");
  return { pick, note: why.length? why.join(" ; ") : "match neutre" };
}

// Présentation Discord (1 bloc par match)
function buildGameBlock(g){
  const b2bA = g.b2bAway ? " (B2B)" : "";
  const b2bH = g.b2bHome ? " (B2B)" : "";
  const L5A = shortFormL5(g.awayL5);
  const L5H = shortFormL5(g.homeL5);

  // joueurs chauds
  const topA = (g.hotAway||[]).map(p=> `${p.name} ${p.g}-${p.a}-${p.pts}, ${p.sog} T`).join(" · ") || "—";
  const topH = (g.hotHome||[]).map(p=> `${p.name} ${p.g}-${p.a}-${p.pts}, ${p.sog} T`).join(" · ") || "—";

  const a=g.awayStats||{}, h=g.homeStats||{};
  const lines = [
    `• ${g.away}${b2bA} @ ${g.home}${b2bH} — ${fmtParisHM(g.startUTC)} (Paris)`,
    `  PP: ${num(a.pp)}% / ${num(h.pp)}%  |  PK: ${num(a.pk)}% / ${num(h.pk)}%`,
    `  GF/GA: ${num(a.gf)}/${num(a.ga)} vs ${num(h.gf)}/${num(h.ga)}  |  SOG: ${num(a.sf)}/${num(a.sa)} vs ${num(h.sf)}/${num(h.sa)}`,
    `  Forme L5: ${g.away} ${L5A}  —  ${g.home} ${L5H}`,
    `  H2H (1 an): ${g.h2h.record} (${g.h2h.count} m.)`,
    `  📈 Angle O/U: ${g.angle.pick} — ${g.angle.note}`,
    `  🔥 Joueurs chauds ${g.away}: ${topA}`,
    `  🔥 Joueurs chauds ${g.home}: ${topH}`,
  ];
  return lines.join("\n");
}

function chunkByLength(lines, max=1800){
  const out=[]; let cur="";
  for(const ln of lines){
    if((cur+ln+"\n").length>max){ out.push(cur.trimEnd()); cur=""; }
    cur+=ln+"\n";
  }
  if(cur.trim()) out.push(cur.trimEnd());
  return out;
}

// -------------- générateurs (auto & manu) --------------
async function generatePrematch({force=false, dateStr=null, onlyGamePk=null}={}){
  const now = nowParis();
  const day = dateStr || ymdParis(now);

  const schedule = await getScheduleParisDay(day);
  if(!schedule.length) return { ok:true, sent:false, reason:"No games today", source:day };

  // Ajoute horodatage Paris et trie
  const withParis = schedule.map(g=> ({
    ...g,
    startParis:new Date(new Date(g.startUTC).toLocaleString("en-US",{ timeZone:"Europe/Paris" }))
  })).sort((a,b)=> a.startParis - b.startParis);

  const first = withParis[0];
  const minToFirst = diffMin(first.startParis, now);
  if(!force && minToFirst>FIRST_WINDOW_MIN){
    return { ok:true, sent:false, reason:`first puck in ${minToFirst} min (> ${FIRST_WINDOW_MIN})`, source:day };
  }

  // Fenêtre ~6h
  const cut = new Date(+now + GAME_WINDOW_MIN*60000);
  let toCover = withParis.filter(g=> g.startParis<=cut);
  if(onlyGamePk) toCover = toCover.filter(g=> String(g.gamePk)===String(onlyGamePk));
  if(!toCover.length) return { ok:true, sent:false, reason:"no games in ~6h window", source:day };

  const dirs = await getTeamsDirectory();
  const enriched=[];
  for(const g of toCover){
    try{ enriched.push(await enrichGame(g, dirs)); }catch(e){ console.error("enrich",g.id,e.message); }
  }

  const header = `[DISCORD:NHL] 🕒 SmartScout — Pré-match NHL (auto${force?"/force":""})\nFenêtre ~6h à partir de ${fmtParisHM(withParis[0].startParis)} (Paris)`;
  const blocks=[header, ...enriched.map(buildGameBlock)];
  const chunks = chunkByLength(blocks, 1800);

  let sent=0;
  for(const c of chunks){ const r=await postToDiscord({content:c}); if(r.ok) sent++; }
  return { ok:true, sent:sent>0, count:sent, source:day, tmin:minToFirst };
}

// -------------- Routes HTTP --------------
app.get("/ping", (_req,res)=> res.send("pong"));

// test visuel
app.get("/test/prematch", async (_req,res)=>{
  await postToDiscord({ content:
`[DISCORD:NHL] 🔵 SmartScout — Simulation pré-match NHL TEST
Match test : Maple Leafs @ Canadiens
Heure : 01h00 (Europe/Paris)
Analyse : Leafs en PP, Habs pénalisés en PK. Tendance Over.
Confiance : 81/100`
  });
  res.send("Test envoyé ✅");
});

// force fenêtre ~6h maintenant
app.get("/prematch/force", async (req,res)=>{
  const dry = !!req.query.dry;
  const r = await generatePrematch({ force:true });
  if(dry) return res.json(r);
  res.json({ ok:r.ok, sent:r.sent, count:r.count, reason:r.reason });
});

// force jour donné ?date=YYYY-MM-DD
app.get("/prematch/day", async (req,res)=>{
  const day = req.query.date || ymdParis();
  const dry = !!req.query.dry;
  const r = await generatePrematch({ force:true, dateStr:day });
  if(dry) return res.json(r);
  res.json({ ok:r.ok, sent:r.sent, count:r.count, reason:r.reason, day });
});

// un seul match ?gamePk=123456 (option &dry=1)
app.get("/prematch/game", async (req,res)=>{
  const pk = req.query.gamePk;
  if(!pk) return res.status(400).json({ ok:false, error:"Missing gamePk" });
  const dry = !!req.query.dry;
  const r = await generatePrematch({ force:true, onlyGamePk:pk });
  if(dry) return res.json(r);
  res.json({ ok:r.ok, sent:r.sent, count:r.count, reason:r.reason, gamePk:pk });
});

// -------------- Scheduler minute --------------
async function scheduler(){
  try{
    const now = nowParis();
    const today = ymdParis(now);

    // fenêtre envoi : 16h–23h heure Paris
    const hourParis = +new Date(now).toLocaleString("en-US",{ timeZone:"Europe/Paris", hour:"2-digit", hour12:false });
    const inWindow  = (hourParis>=16 && hourParis<=23);

    if(inWindow && lastPrematchStamp!==today){
      const r = await generatePrematch({ force:false });
      if(r.sent){ lastPrematchStamp=today; console.log(`[${new Date().toISOString()}] Pré-match envoyé (${r.count} msg).`); }
      else{ console.log(`[${new Date().toISOString()}] Pas d’envoi: ${r.reason||"n/a"}`); }
    }
  }catch(e){ console.error("Scheduler error:", e.message); }
}
setInterval(scheduler, 60*1000);

// -------------- Start --------------
app.listen(3000, ()=> console.log("SmartScout NHL autobot up on 3000"));