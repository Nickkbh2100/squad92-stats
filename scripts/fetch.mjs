// Henter Squad92's kampe og spillerprofiler fra PUBG API.
// Kør: PUBG_API_KEY=xxx node scripts/fetch.mjs
//
// data/matches.json  – fælles kampe, hvor et hold KUN består af clan-medlemmer (min. `minClanMembersInTeam`)
// data/players.json  – profiler: karriere- og sidste-års-stats, våben og en personlig kamplog (alle kampe)

import fs from 'node:fs/promises';
import { buildReplay } from './replay.mjs';

const root = new URL('..', import.meta.url);
const config = JSON.parse(await fs.readFile(new URL('config.json', root), 'utf8'));
const matchesPath = new URL('data/matches.json', root);
const playersPath = new URL('data/players.json', root);
const replayDir = new URL('data/replays/', root);
const REPLAY_FULL_KEEP = config.replayFullKeep ?? 40; // så mange nyeste replays beholder alle andre spillere

const KEY = process.env.PUBG_API_KEY;
if (!KEY) {
  console.error('Mangler PUBG_API_KEY (miljøvariabel).');
  process.exit(1);
}

const BASE = `https://api.pubg.com/shards/${config.platform}`;
const ACCEPT = 'application/vnd.api+json';
const HEADERS = { Authorization: `Bearer ${KEY}`, Accept: ACCEPT };
const CHECKED_TTL_DAYS = 30;               // PUBG gemmer kampe i 14 dage
const PERSONAL_LOG_DAYS = 400;             // personlig kamplog gemmes lidt over et år
const PROFILE_REFRESH_HOURS = config.profileRefreshHours ?? 6;
const YEAR_SEASONS = config.yearSeasons ?? 6; // ~2 mdr. pr. sæson => 6 sæsoner ≈ 1 år

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let rateRemaining = Infinity, rateReset = 0;

async function api(path, { auth = true } = {}) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    if (auth && rateRemaining <= 0 && rateReset * 1000 > Date.now()) {
      const wait = rateReset * 1000 - Date.now() + 1000;
      console.log(`Venter ${Math.round(wait / 1000)}s på PUBG's rate limit ...`);
      await sleep(Math.min(wait, 65_000));
    }
    const res = await fetch(BASE + path, { headers: auth ? HEADERS : { Accept: ACCEPT } });
    if (auth) {
      rateRemaining = Number(res.headers.get('x-ratelimit-remaining') ?? Infinity);
      rateReset = Number(res.headers.get('x-ratelimit-reset') ?? 0);
    }
    if (res.ok) return res.json();
    if (res.status === 404) return null;
    if (res.status === 429) { rateRemaining = 0; if (!rateReset) await sleep(60_000); continue; }
    if (res.status >= 500 && attempt < 5) { await sleep(attempt * 2000); continue; }
    throw new Error(`PUBG API ${res.status} på ${path}: ${await res.text()}`);
  }
  throw new Error(`Gav op efter flere forsøg: ${path}`);
}

async function readJson(url, fallback) {
  try { return JSON.parse(await fs.readFile(url, 'utf8')); } catch { return fallback; }
}

// Skriver kun filen, hvis indholdet har ændret sig (så workflowet ikke committer for ingenting)
async function writeIfChanged(url, obj) {
  const old = await readJson(url, {});
  if (JSON.stringify({ ...old, updatedAt: null }) === JSON.stringify({ ...obj, updatedAt: null })) return false;
  obj.updatedAt = new Date().toISOString();
  await fs.writeFile(url, JSON.stringify(obj, null, 1) + '\n');
  return true;
}

// --- Spillere ---
async function fetchPlayers(names) {
  const json = await api(`/players?filter[playerNames]=${encodeURIComponent(names.join(','))}`);
  const players = json?.data ?? [];
  if (players.length < names.length) {
    const found = new Set(players.map((p) => p.attributes.name.toLowerCase()));
    for (const name of names.filter((n) => !found.has(n.toLowerCase()))) {
      const one = await api(`/players?filter[playerNames]=${encodeURIComponent(name)}`);
      if (one?.data?.length) players.push(...one.data);
      else console.warn(`Spilleren "${name}" blev ikke fundet på ${config.platform}. (Store/små bogstaver tæller!)`);
    }
  }
  return players;
}

// --- Fælles kamp: hold der kun består af clan-medlemmer ---
function analyseSquadMatch(json, isMember) {
  const a = json.data.attributes;
  if (!config.gameModes.includes(a.gameMode) || !config.matchTypes.includes(a.matchType)) return null;
  const participants = new Map();
  const rosters = [];
  for (const inc of json.included ?? []) {
    if (inc.type === 'participant') participants.set(inc.id, inc.attributes.stats);
    else if (inc.type === 'roster') rosters.push(inc);
  }
  const teams = [];
  for (const r of rosters) {
    const stats = r.relationships.participants.data.map((p) => participants.get(p.id)).filter(Boolean);
    const members = stats.filter(isMember);
    if (members.length < config.minClanMembersInTeam || members.length !== stats.length) continue;
    teams.push({
      rank: r.attributes.stats.rank,
      won: r.attributes.won === 'true' || r.attributes.won === true,
      players: members.map((s) => ({
        name: s.name,
        accountId: s.playerId,
        damage: Math.round(s.damageDealt * 10) / 10,
        kills: s.kills,
        assists: s.assists,
        dbnos: s.DBNOs,
        headshots: s.headshotKills,
        revives: s.revives,
        timeSurvived: Math.round(s.timeSurvived),
        longestKill: Math.round(s.longestKill * 10) / 10,
        deathType: s.deathType,
        winPlace: s.winPlace,
      })),
    });
  }
  if (!teams.length) return null;
  return { id: json.data.id, createdAt: a.createdAt, map: a.mapName, gameMode: a.gameMode, matchType: a.matchType, duration: a.duration, teams };
}

// --- Personlig kamplog: alle kampe (også solo og med fremmede) ---
function personalEntries(json, memberIds) {
  const a = json.data.attributes;
  if (['custom', 'training'].includes(a.matchType)) return [];
  const out = [];
  for (const inc of json.included ?? []) {
    if (inc.type !== 'participant' || !memberIds.has(inc.attributes.stats.playerId)) continue;
    const s = inc.attributes.stats;
    out.push([s.playerId, {
      id: json.data.id, at: a.createdAt, mode: a.gameMode, type: a.matchType, map: a.mapName,
      dmg: Math.round(s.damageDealt), k: s.kills, kn: s.DBNOs, place: s.winPlace,
      lk: Math.round(s.longestKill), t: Math.round(s.timeSurvived),
    }]);
  }
  return out;
}

// --- Sammenlæg stats på tværs af spiltyper ---
function sumModes(gameModeStats = {}) {
  const t = { rounds: 0, wins: 0, top10s: 0, kills: 0, damage: 0, headshots: 0, dbnos: 0, assists: 0, revives: 0, seconds: 0, longestKill: 0, roundMostKills: 0, walkKm: 0, rideKm: 0 };
  for (const s of Object.values(gameModeStats)) {
    t.rounds += s.roundsPlayed; t.wins += s.wins; t.top10s += s.top10s; t.kills += s.kills;
    t.damage += s.damageDealt; t.headshots += s.headshotKills; t.dbnos += s.dBNOs; t.assists += s.assists;
    t.revives += s.revives; t.seconds += s.timeSurvived;
    t.walkKm += s.walkDistance / 1000; t.rideKm += s.rideDistance / 1000;
    t.longestKill = Math.max(t.longestKill, s.longestKill);
    t.roundMostKills = Math.max(t.roundMostKills, s.roundMostKills);
  }
  for (const k of ['damage', 'seconds', 'walkKm', 'rideKm', 'longestKill']) t[k] = Math.round(t[k] * 10) / 10;
  return t;
}
function addStats(a, b) {
  const t = { ...a };
  for (const k of Object.keys(b)) {
    t[k] = ['longestKill', 'roundMostKills'].includes(k) ? Math.max(a[k] ?? 0, b[k]) : Math.round(((a[k] ?? 0) + b[k]) * 10) / 10;
  }
  return t;
}

const WEAPON_NAMES = {
  HK416: 'M416', AK47: 'AKM', BerylM762: 'Beryl M762', SCAR_L: 'SCAR-L', 'SCAR-L': 'SCAR-L', QBZ95: 'QBZ', G36C: 'G36C',
  Groza: 'Groza', AUG: 'AUG', M16A4: 'M16A4', Mk47Mutant: 'Mk47 Mutant', ACE32: 'ACE32', K2: 'K2', FAMASG2: 'FAMAS',
  Mini14: 'Mini 14', SKS: 'SKS', Mk12: 'Mk12', Mk14: 'Mk14', FNFal: 'SLR', QBU88: 'QBU', VSS: 'VSS', Dragunov: 'Dragunov',
  Kar98k: 'Kar98k', M24: 'M24', AWM: 'AWM', Mosin: 'Mosin Nagant', Win1894: 'Win94', L6: 'Lynx AMR',
  UMP: 'UMP45', Vector: 'Vector', UZI: 'Micro UZI', Thompson: 'Tommy Gun', BizonPP19: 'PP-19 Bizon', MP5K: 'MP5K', P90: 'P90', JS9: 'JS9', MP9: 'MP9',
  M249: 'M249', DP28: 'DP-28', MG3: 'MG3', Saiga12: 'S12K', Berreta686: 'S686', Winchester: 'S1897', DP12: 'DBS', OriginS12: 'O12',
  Crossbow: 'Crossbow', Mads: 'MADs', P92: 'P92', P1911: 'P1911', NagantM1895: 'R1895', Rhino: 'R45', G18: 'P18C', DesertEagle: 'Deagle', Sawnoff: 'Sawed-off',
};
const weaponName = (id) => {
  const k = id.replace(/^Item_Weapon_/, '').replace(/_C$/, '');
  return WEAPON_NAMES[k] || k.replace(/_/g, ' ');
};

function weaponList(wm) {
  const out = [];
  for (const [id, w] of Object.entries(wm?.data?.attributes?.weaponSummaries ?? {})) {
    const o = w.OfficialStatsTotal ?? {}, c = w.CompetitiveStatsTotal ?? {};
    const kills = (o.Kills ?? 0) + (c.Kills ?? 0);
    if (!kills) continue;
    out.push({
      id, name: weaponName(id), kills,
      damage: Math.round((o.DamagePlayer ?? 0) + (c.DamagePlayer ?? 0)),
      headshots: (o.HeadShots ?? 0) + (c.HeadShots ?? 0),
      knocks: (o.Groggies ?? 0) + (c.Groggies ?? 0),
      longestKill: Math.round(Math.max(o.LongestKill ?? 0, c.LongestKill ?? 0)),
      mostKillsInAGame: Math.max(o.MostKillsInAGame ?? 0, c.MostKillsInAGame ?? 0),
      level: w.LevelCurrent ?? null,
    });
  }
  return out.sort((a, b) => b.kills - a.kills);
}

// ================= Main =================
const data = await readJson(matchesPath, { updatedAt: null, members: [], matches: [], checked: {} });
data.checked ??= {};
const prof = await readJson(playersPath, { updatedAt: null, profilesAt: null, seasons: null, players: {}, seasonCache: {}, logged: {} });
prof.players ??= {}; prof.seasonCache ??= {}; prof.logged ??= {};

const players = await fetchPlayers(config.members);
data.members = players.map((p) => ({ name: p.attributes.name, accountId: p.id }));
const memberIds = new Set(players.map((p) => p.id));
const memberNames = new Set(config.members.map((n) => n.toLowerCase()));
const isMember = (s) => memberIds.has(s.playerId) || memberNames.has(String(s.name).toLowerCase());
for (const p of players) {
  prof.players[p.id] ??= { name: p.attributes.name, games: [] };
  prof.players[p.id].name = p.attributes.name;
}

// 1) Kampe: nye fælles kampe + personlig kamplog
const known = new Set(data.matches.map((m) => m.id));
const matchIds = new Set();
for (const p of players) for (const m of p.relationships?.matches?.data ?? []) matchIds.add(m.id);
const todo = [...matchIds].filter((id) => !(data.checked[id] || known.has(id)) || !prof.logged[id]);
console.log(`${players.length} spillere, ${matchIds.size} kampe i alt, ${todo.length} at tjekke.`);

let added = 0;
const queue = [...todo];
async function worker() {
  while (queue.length) {
    const id = queue.shift();
    const json = await api(`/matches/${id}`, { auth: false }); // tæller ikke i rate limit
    if (!json) continue;
    const at = json.data.attributes.createdAt;
    if (!data.checked[id] && !known.has(id)) {
      const match = analyseSquadMatch(json, isMember);
      if (match) {
        match.telemetry = json.included.find((i) => i.type === 'asset')?.attributes?.URL;
        data.matches.push(match); added++;
      }
    }
    data.checked[id] = at;
    if (!prof.logged[id]) {
      for (const [pid, entry] of personalEntries(json, memberIds)) {
        const g = prof.players[pid].games;
        if (!g.some((x) => x.id === id)) g.push(entry);
      }
      prof.logged[id] = at;
    }
  }
}
await Promise.all(Array.from({ length: 5 }, worker));

const now = Date.now();
for (const [id, at] of Object.entries(data.checked)) if (Date.parse(at) < now - CHECKED_TTL_DAYS * 864e5) delete data.checked[id];
for (const [id, at] of Object.entries(prof.logged)) if (Date.parse(at) < now - CHECKED_TTL_DAYS * 864e5) delete prof.logged[id];
for (const p of Object.values(prof.players)) {
  p.games = p.games.filter((g) => Date.parse(g.at) > now - PERSONAL_LOG_DAYS * 864e5)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}
data.matches.sort((x, y) => Date.parse(y.createdAt) - Date.parse(x.createdAt));

// 2) 2D-replays for fælles kampe (telemetri findes kun i 14 dage)
await fs.mkdir(replayDir, { recursive: true });
let builtReplays = 0;
for (const match of data.matches) {
  if ((match.replay && match.weapons) || Date.parse(match.createdAt) < now - 13.5 * 864e5) continue;
  try {
    if (!match.telemetry) {
      const json = await api(`/matches/${match.id}`, { auth: false });
      match.telemetry = json?.included?.find((i) => i.type === 'asset')?.attributes?.URL;
      if (!match.telemetry) continue;
    }
    const res = await fetch(match.telemetry);
    if (!res.ok) { console.warn(`Telemetri for ${match.id}: HTTP ${res.status}`); continue; }
    const replay = buildReplay(await res.json(), { matchId: match.id, memberIds });
    if (!replay) continue;
    match.weapons = replay.weapons;   // våbenskade pr. spiller (bruges på forsiden)
    delete replay.weapons;
    if (!match.replay) await fs.writeFile(new URL(`${match.id}.json`, replayDir), JSON.stringify(replay));
    match.replay = 1;
    builtReplays++;
  } catch (err) {
    console.warn(`Kunne ikke bygge replay for ${match.id}: ${err.message}`);
  }
}
// Ældre replays: fjern de andre spillere for at spare plads (jeres egne spor og hændelser beholdes)
for (const match of data.matches.filter((x) => x.replay).slice(REPLAY_FULL_KEEP)) {
  const file = new URL(`${match.id}.json`, replayDir);
  const r = await readJson(file, null);
  if (r?.others?.length) { r.others = []; await fs.writeFile(file, JSON.stringify(r)); }
}
if (builtReplays) console.log(`${builtReplays} kampe fik replay/våbendata.`);

// 3) Profiler (karriere, sidste år, våben) – kun hver X. time pga. rate limit
const due = !prof.profilesAt || now - Date.parse(prof.profilesAt) > PROFILE_REFRESH_HOURS * 3600e3 || process.env.FORCE_PROFILES;
if (due) {
  if (!prof.seasons || now - Date.parse(prof.seasons.at) > 24 * 3600e3) {
    const s = await api('/seasons');
    const list = (s?.data ?? [])
      .filter((x) => /official\.pc-2018-\d+$/.test(x.id) || x.attributes.isCurrentSeason)
      .sort((a, b) => Number(a.id.split('-').pop()) - Number(b.id.split('-').pop()));
    const ci = list.findIndex((x) => x.attributes.isCurrentSeason);
    const end = ci >= 0 ? ci : list.length - 1;
    prof.seasons = { at: new Date().toISOString(), current: list[end]?.id, year: list.slice(Math.max(0, end - YEAR_SEASONS + 1), end + 1).map((x) => x.id) };
  }
  for (const p of players) {
    const pr = prof.players[p.id];
    const life = await api(`/players/${p.id}/seasons/lifetime`);
    if (life) pr.lifetime = sumModes(life.data.attributes.gameModeStats);
    const wm = await api(`/players/${p.id}/weapon_mastery`);
    if (wm) pr.weapons = weaponList(wm);
    // Sidste år = summen af de seneste sæsoner. Afsluttede sæsoner ændrer sig ikke og caches.
    const cache = (prof.seasonCache[p.id] ??= {});
    for (const sid of Object.keys(cache)) if (!prof.seasons.year.includes(sid)) delete cache[sid];
    let year = null;
    for (const sid of prof.seasons.year) {
      if (!cache[sid] || sid === prof.seasons.current) {
        const s = await api(`/players/${p.id}/seasons/${sid}`);
        if (s) cache[sid] = sumModes(s.data.attributes.gameModeStats);
      }
      if (cache[sid]) year = year ? addStats(year, cache[sid]) : cache[sid];
    }
    pr.year = year;
  }
  prof.profilesAt = new Date().toISOString();
}

const wroteMatches = await writeIfChanged(matchesPath, data);
const wroteProfiles = await writeIfChanged(playersPath, prof);
console.log(`Færdig: ${added} nye fælles kampe (${data.matches.length} i alt).` +
  ` Profiler ${due ? 'opdateret' : 'ikke opdateret denne gang'}.` +
  ` Filer skrevet: ${[wroteMatches && 'matches', wroteProfiles && 'players'].filter(Boolean).join(', ') || 'ingen'}.`);
