// FIREBREAK — pure core. No DOM, no WebAudio, no Date.now()/Math.random().
// Everything that needs randomness takes a prng (see mulberry32) or a seed string.

export const DEFAULT_RADIUS = 5;
export const REGROWTH_RATE = 0.35;
export const SPREAD_BASE_RATE = 0.55;
export const BASE_STRIKES = 6;

export const ACTION_COSTS = { break: 3, thin: 1, burn: 2 };

const DIR_OFFSETS = [
  [1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1],
];
// alignment[i] keyed by (dirIdx - windDir + 6) % 6 — 0 = same direction as wind (strongest push)
const ALIGNMENT_BY_DIFF = [1.0, 0.4, -0.4, -1.0, -0.4, 0.4];

// ---------------------------------------------------------------- PRNG ----

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashString(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function prngFor(seed, ...parts) {
  return mulberry32(hashString(`${seed}:${parts.join(':')}`));
}

// ------------------------------------------------------------- HEX GRID ----

export function cellKey(c) { return `${c.q},${c.r}`; }

export function axialNeighbors(q, r) {
  return DIR_OFFSETS.map(([dq, dr]) => [q + dq, r + dr]);
}

export function hexDistance(q, r) {
  return (Math.abs(q) + Math.abs(r) + Math.abs(q + r)) / 2;
}

export function generateGrid(radius) {
  const cells = [];
  for (let q = -radius; q <= radius; q++) {
    const r1 = Math.max(-radius, -q - radius);
    const r2 = Math.min(radius, -q + radius);
    for (let r = r1; r <= r2; r++) cells.push({ q, r });
  }
  return cells;
}

export function axialToCart(q, r) {
  return { x: q + r / 2, y: r * (Math.sqrt(3) / 2) };
}

export function windAlignment(dirIdx, windDir) {
  const diff = ((dirIdx - windDir) % 6 + 6) % 6;
  return ALIGNMENT_BY_DIFF[diff];
}

// --------------------------------------------------------------- WORLD ----

export function placeLandmarks(radius) {
  const inBounds = (q, r) => hexDistance(q, r) <= radius;
  const town = { q: 0, r: -Math.floor(radius * 0.6) };
  const grove = { q: Math.floor(radius * 0.6), r: Math.floor(radius * 0.2) };
  const farm = { q: -Math.floor(radius * 0.6), r: Math.floor(radius * 0.4) };
  for (const p of [town, grove, farm]) {
    if (!inBounds(p.q, p.r)) throw new Error('landmark placed outside grid radius');
  }
  return { town, grove, farm };
}

export function generateTerrain(seed, cells) {
  const terrain = new Map();
  for (const c of cells) {
    const key = cellKey(c);
    const prng = prngFor(seed, 'terrain', key);
    const baseFlammability = 0.25 + 0.65 * prng();
    const moisture = 0.15 + 0.5 * prng();
    const maxFuel = 0.3 + 0.7 * baseFlammability;
    terrain.set(key, { baseFlammability, moisture, maxFuel });
  }
  return terrain;
}

export function initialFuelState(cells, terrain) {
  const fuel = new Map();
  for (const c of cells) {
    const key = cellKey(c);
    fuel.set(key, terrain.get(key).maxFuel * 0.6);
  }
  return fuel;
}

export function generateWeather(seed, year) {
  const prng = prngFor(seed, 'weather', year);
  const dryness = 0.2 + 0.7 * prng();
  const windDir = Math.floor(prng() * 6);
  const windStrength = 0.2 + 0.6 * prng();
  return { dryness, windDir, windStrength };
}

export function budgetForYear(year) {
  return 10 + Math.floor((year - 1) / 2) * 2;
}

// --------------------------------------------------------------- STRIKES ----

export function strikeCountForWeather(weather, baseStrikes = BASE_STRIKES) {
  return Math.max(1, Math.round(baseStrikes * (0.4 + weather.dryness)));
}

export function sampleStrikes(cells, terrain, weather, prng, count) {
  const weights = cells.map((c) => {
    const t = terrain.get(cellKey(c));
    return Math.max(0.0001, t.baseFlammability * (0.3 + weather.dryness));
  });
  const total = weights.reduce((a, b) => a + b, 0);
  const cum = [];
  let running = 0;
  for (const w of weights) { running += w; cum.push(running); }
  const keys = [];
  for (let i = 0; i < count; i++) {
    const roll = prng() * total;
    let lo = 0, hi = cum.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] < roll) lo = mid + 1; else hi = mid;
    }
    keys.push(cellKey(cells[lo]));
  }
  return keys;
}

// ------------------------------------------------------------ PREP ACTIONS ----

export function applyPrepActions(fuelState, actions, budget) {
  const next = new Map(fuelState);
  let spent = 0;
  const applied = [];
  for (const act of actions || []) {
    const cost = ACTION_COSTS[act.type];
    if (cost === undefined) continue;
    if (spent + cost > budget) continue;
    const cur = next.get(act.key);
    if (cur === undefined) continue;
    let val = cur;
    if (act.type === 'break') val = 0;
    else if (act.type === 'thin') val = cur * 0.4;
    else if (act.type === 'burn') val = Math.min(cur, 0.08);
    next.set(act.key, val);
    spent += cost;
    applied.push(act);
  }
  return { fuelState: next, spent, applied };
}

// ------------------------------------------------------------- SPREAD ----

export function spreadFire(cells, fuelState, terrain, weather, strikeKeys, prng, maxSteps) {
  const validKeys = new Set(cells.map(cellKey));
  const burned = new Set(strikeKeys.filter((k) => validKeys.has(k) && (fuelState.get(k) || 0) > 0));
  let frontier = [...burned];
  let steps = 0;
  while (frontier.length && steps < maxSteps) {
    const nextFrontier = [];
    for (const key of frontier) {
      const [q, r] = key.split(',').map(Number);
      const neighbors = axialNeighbors(q, r);
      neighbors.forEach(([nq, nr], dirIdx) => {
        const nkey = `${nq},${nr}`;
        if (!terrain.has(nkey) || burned.has(nkey)) return;
        const nFuel = fuelState.get(nkey) || 0;
        if (nFuel <= 0) return;
        const moisture = terrain.get(nkey).moisture;
        const align = windAlignment(dirIdx, weather.windDir);
        let p = nFuel * (1 - moisture * 0.6) * (1 + weather.windStrength * align) * SPREAD_BASE_RATE;
        p = Math.max(0, Math.min(1, p));
        if (prng() < p) {
          burned.add(nkey);
          nextFrontier.push(nkey);
        }
      });
    }
    frontier = nextFrontier;
    steps++;
  }
  return { burned, steps };
}

export function regrowFuel(fuelState, terrain, burnedSet, regrowthRate = REGROWTH_RATE) {
  const next = new Map();
  for (const [key, fuel] of fuelState) {
    const base = burnedSet.has(key) ? 0 : fuel;
    const maxFuel = terrain.get(key).maxFuel;
    const grown = base + regrowthRate * (maxFuel - base);
    next.set(key, Math.max(0, Math.min(maxFuel, grown)));
  }
  return next;
}

export function evaluateStructures(landmarks, burnedSet) {
  return {
    town: burnedSet.has(cellKey(landmarks.town)),
    grove: burnedSet.has(cellKey(landmarks.grove)),
    farm: burnedSet.has(cellKey(landmarks.farm)),
  };
}

// -------------------------------------------------------------- YEAR ----

export function runYear({ seed, year, radius, terrain, cells, landmarks, preppedFuel, ghostFuel, actions, budget }) {
  const weather = generateWeather(seed, year);
  const strikeCount = strikeCountForWeather(weather);
  const strikePrng = prngFor(seed, 'strikes', year);
  const strikeKeys = sampleStrikes(cells, terrain, weather, strikePrng, strikeCount);

  const prepResult = applyPrepActions(preppedFuel, actions, budget);
  const preppedFuelAfterActions = prepResult.fuelState;

  const maxSteps = radius * 2 + 2;
  const preppedSpreadPrng = prngFor(seed, 'spread-prepped', year);
  const ghostSpreadPrng = prngFor(seed, 'spread-ghost', year);

  const preppedResult = spreadFire(cells, preppedFuelAfterActions, terrain, weather, strikeKeys, preppedSpreadPrng, maxSteps);
  const ghostResult = spreadFire(cells, ghostFuel, terrain, weather, strikeKeys, ghostSpreadPrng, maxSteps);

  const nextPreppedFuel = regrowFuel(preppedFuelAfterActions, terrain, preppedResult.burned);
  const nextGhostFuel = regrowFuel(ghostFuel, terrain, ghostResult.burned);

  return {
    year, weather, strikeKeys,
    preppedBurned: preppedResult.burned, ghostBurned: ghostResult.burned,
    preppedSteps: preppedResult.steps, ghostSteps: ghostResult.steps,
    nextPreppedFuel, nextGhostFuel,
    actionsApplied: prepResult.applied, spent: prepResult.spent,
    preppedStructures: evaluateStructures(landmarks, preppedResult.burned),
    ghostStructures: evaluateStructures(landmarks, ghostResult.burned),
  };
}

export function simulateGame(seed, years, radius, prepPolicyFn) {
  const cells = generateGrid(radius);
  const terrain = generateTerrain(seed, cells);
  const landmarks = placeLandmarks(radius);
  let preppedFuel = initialFuelState(cells, terrain);
  let ghostFuel = new Map(preppedFuel);
  const records = [];
  for (let year = 1; year <= years; year++) {
    const budget = budgetForYear(year);
    const actions = prepPolicyFn
      ? prepPolicyFn({ year, terrain, cells, landmarks, fuelState: preppedFuel, budget })
      : [];
    const rec = runYear({ seed, year, radius, terrain, cells, landmarks, preppedFuel, ghostFuel, actions, budget });
    preppedFuel = rec.nextPreppedFuel;
    ghostFuel = rec.nextGhostFuel;
    records.push(rec);
  }
  return { cells, terrain, landmarks, records };
}

// -------------------------------------------------------------- SHARE ----

export function buildShareText({ year, headline, ghostLine, url }) {
  const parts = [`\u{1FA93} FIREBREAK year ${year}`];
  if (headline) parts.push(headline);
  if (ghostLine) parts.push(ghostLine);
  parts.push(url);
  return parts.join(' \u{00B7} ');
}
