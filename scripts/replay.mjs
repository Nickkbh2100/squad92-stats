// Bygger en kompakt 2D-replay ud fra PUBG-telemetri (typisk 20-30 MB -> 20-200 KB).
//
// Format (alle koordinater i meter, tider i sekunder fra kampstart):
// {
//   v, id, map, size, dur, rank,
//   team:   [{ name, accountId }],
//   tracks: { [name]: [t,x,y, t,x,y, ...] },       // vores spillere (fra de hopper ud af flyet)
//   others: [{ d: dødstid|null, p: [t,x,y, ...] }],  // alle andre spillere (fjernes fra ældre replays)
//   zone:   [[t, blåX, blåY, blåR, hvidX, hvidY, hvidR], ...],
//   plane:  [[x1,y1],[x2,y2]] | null,
//   alive:  [[t, spillere i live], ...],
//   events: [{ t, k: 'jump'|'land'|'knock'|'kill'|'revive', a, v, w, d, x, y, us }]
// }

import fs from 'node:fs';

const dict = JSON.parse(fs.readFileSync(new URL('../assets/damageCauserName.json', import.meta.url), 'utf8'));
const weapon = (id) => (id ? dict[id] || id.replace(/^Weap/, '').replace(/_C(_\d+)?$/, '') : '');
const m = (v) => Math.round(v / 100); // cm -> m

export function buildReplay(events, { matchId, memberIds }) {
  const startEv = events.find((e) => e._T === 'LogMatchStart');
  if (!startEv) return null;
  const start = Date.parse(startEv._D);
  const T = (e) => Math.round((Date.parse(e._D) - start) / 100) / 10;
  const isUs = (c) => !!c && memberIds.has(c.accountId);

  const team = [];
  for (const c of startEv.characters ?? []) {
    if (isUs(c.character)) team.push({ name: c.character.name, accountId: c.character.accountId });
  }
  const nameOf = new Map(team.map((p) => [p.accountId, p.name]));

  const gs = events.filter((e) => e._T === 'LogGameStatePeriodic');
  const center = gs[0]?.gameState?.safetyZonePosition?.x;
  const size = center ? m(center * 2) : 8160;

  // Hvornår hopper hver spiller ud af flyet?
  const jumped = new Map();
  const planePts = [];
  for (const e of events) {
    if (e._T === 'LogVehicleLeave' && e.vehicle?.vehicleType === 'TransportAircraft' && !jumped.has(e.character.accountId)) {
      jumped.set(e.character.accountId, T(e));
      if (T(e) < 240) planePts.push([T(e), m(e.character.location.x), m(e.character.location.y)]);
    }
  }
  planePts.sort((a, b) => a[0] - b[0]);
  const plane = planePts.length >= 2 ? [planePts[0].slice(1), planePts.at(-1).slice(1)] : null;

  // Dødstider
  const death = new Map();
  for (const e of events) if (e._T === 'LogPlayerKillV2' && e.victim) death.set(e.victim.accountId, T(e));

  // Positioner
  const tracks = Object.fromEntries(team.map((p) => [p.name, []]));
  const others = new Map();
  for (const e of events) {
    if (e._T !== 'LogPlayerPosition') continue;
    const c = e.character;
    if (!c || c.type === 'monster' || e.vehicle?.vehicleType === 'TransportAircraft') continue;
    const t = T(e);
    if (t < 0 || !jumped.has(c.accountId) || t < jumped.get(c.accountId)) continue;
    const pt = [Math.round(t), m(c.location.x), m(c.location.y)];
    if (isUs(c)) tracks[nameOf.get(c.accountId)]?.push(...pt);
    else {
      if (!others.has(c.accountId)) others.set(c.accountId, []);
      others.get(c.accountId).push(...pt);
    }
  }
  // Tilføj eksakte positioner fra hændelser til vores spor (hop, landing, knock, død) for mere præcis bevægelse
  const addPoint = (c, t) => {
    if (!isUs(c) || !c.location) return;
    const tr = tracks[nameOf.get(c.accountId)];
    if (!tr) return;
    tr.push(Math.round(t * 10) / 10, m(c.location.x), m(c.location.y));
  };

  const ev = [];
  for (const e of events) {
    const t = T(e);
    if (t < 0) continue;
    switch (e._T) {
      case 'LogVehicleLeave':
        if (e.vehicle?.vehicleType === 'TransportAircraft' && isUs(e.character) && jumped.get(e.character.accountId) === t) {
          ev.push({ t, k: 'jump', a: e.character.name, x: m(e.character.location.x), y: m(e.character.location.y), us: 1 });
          addPoint(e.character, t);
        }
        break;
      case 'LogParachuteLanding':
        if (isUs(e.character)) {
          ev.push({ t, k: 'land', a: e.character.name, x: m(e.character.location.x), y: m(e.character.location.y), us: 1 });
          addPoint(e.character, t);
        }
        break;
      case 'LogPlayerMakeGroggy':
        if (isUs(e.attacker) || isUs(e.victim)) {
          ev.push({
            t, k: 'knock', a: e.attacker?.name || '', v: e.victim.name, w: weapon(e.damageCauserName),
            d: Math.round((e.distance ?? 0) / 100), x: m(e.victim.location.x), y: m(e.victim.location.y), us: isUs(e.attacker) ? 1 : 0,
          });
          addPoint(e.attacker, t); addPoint(e.victim, t);
        }
        break;
      case 'LogPlayerKillV2': {
        const actor = e.killer?.name ? e.killer : e.finisher?.name ? e.finisher : e.dBNOMaker;
        if (isUs(actor) || isUs(e.victim) || isUs(e.dBNOMaker)) {
          const info = e.killer?.name ? e.killerDamageInfo : e.finishDamageInfo;
          const loc = e.victim.location;
          ev.push({
            t, k: 'kill', a: actor?.name || '', v: e.victim.name, w: weapon(info?.damageCauserName),
            d: Math.max(0, Math.round((info?.distance ?? 0) / 100)), x: m(loc.x), y: m(loc.y), us: isUs(actor) ? 1 : 0,
          });
          if (isUs(e.victim) && loc.x) addPoint(e.victim, t);
        }
        break;
      }
      case 'LogPlayerRevive':
        if (isUs(e.reviver) || isUs(e.victim)) {
          ev.push({ t, k: 'revive', a: e.reviver.name, v: e.victim.name, x: m(e.victim.location.x), y: m(e.victim.location.y), us: isUs(e.reviver) ? 1 : 0 });
          addPoint(e.reviver, t); addPoint(e.victim, t);
        }
        break;
    }
  }

  // Sortér vores spor efter tid (hændelsespunkter blev tilføjet bagefter)
  for (const name of Object.keys(tracks)) {
    const arr = tracks[name], pts = [];
    for (let i = 0; i < arr.length; i += 3) pts.push(arr.slice(i, i + 3));
    pts.sort((a, b) => a[0] - b[0]);
    const d = death.get(team.find((p) => p.name === name)?.accountId);
    tracks[name] = pts.filter((p) => d == null || p[0] <= d + 0.5).flat();
  }

  const zone = [];
  let last = '';
  for (const e of gs) {
    const g = e.gameState;
    const row = [m(g.safetyZonePosition.x), m(g.safetyZonePosition.y), m(g.safetyZoneRadius), m(g.poisonGasWarningPosition.x), m(g.poisonGasWarningPosition.y), m(g.poisonGasWarningRadius)];
    const key = row.join(',');
    if (key !== last) { zone.push([Math.round(T(e)), ...row]); last = key; }
  }

  const alive = [];
  for (const e of gs) {
    const n = e.gameState.numAlivePlayers;
    if (!alive.length || alive.at(-1)[1] !== n) alive.push([Math.round(T(e)), n]);
  }

  const endEv = events.find((e) => e._T === 'LogMatchEnd');
  const rank = endEv?.characters?.find((c) => isUs(c.character))?.character?.ranking ?? null;

  return {
    v: 1, id: matchId, map: startEv.mapName, size, dur: endEv ? T(endEv) : ev.at(-1)?.t ?? 0, rank,
    team: team.map((p) => ({ name: p.name, accountId: p.accountId })),
    tracks,
    others: [...others.entries()].map(([id, p]) => ({ d: death.get(id) ?? null, p })),
    zone, plane, alive, events: ev.sort((a, b) => a.t - b.t),
  };
}
