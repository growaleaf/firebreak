// FIREBREAK — headless tests. `node test.mjs`. exit 0 = green.
import {
  mulberry32, hashString, generateGrid, axialNeighbors, hexDistance, cellKey,
  generateTerrain, placeLandmarks, initialFuelState, generateWeather,
  budgetForYear, strikeCountForWeather, sampleStrikes, applyPrepActions,
  windAlignment, spreadFire, regrowFuel, evaluateStructures, runYear,
  simulateGame, buildShareText, axialToCart, ACTION_COSTS, DEFAULT_RADIUS,
} from './fire.mjs';

// node has no btoa/atob global on older versions; shim just in case future code needs it.
if (typeof globalThis.btoa === 'undefined') {
  globalThis.btoa = (s) => Buffer.from(s, 'binary').toString('base64');
  globalThis.atob = (s) => Buffer.from(s, 'base64').toString('binary');
}

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; }
  else { fail++; console.error(`FAIL: ${name}`); }
}
function approxEqual(a, b, eps = 1e-9) { return Math.abs(a - b) <= eps; }

function deepMapEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) {
    if (!b.has(k)) return false;
    if (typeof v === 'number' && typeof b.get(k) === 'number') {
      if (!approxEqual(v, b.get(k))) return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------
// 1. PRNG determinism
{
  const a = mulberry32(42);
  const b = mulberry32(42);
  const seqA = [a(), a(), a()];
  const seqB = [b(), b(), b()];
  check('mulberry32 same seed -> same sequence', JSON.stringify(seqA) === JSON.stringify(seqB));
  const c = mulberry32(43);
  check('mulberry32 different seed -> different sequence', c() !== mulberry32(42)());
}

// 2. hashString determinism
{
  check('hashString deterministic', hashString('firebreak:seed:1') === hashString('firebreak:seed:1'));
  check('hashString sensitive to input', hashString('a') !== hashString('b'));
}

// 3. Hex grid geometry
{
  const cells = generateGrid(5);
  check('grid radius 5 has 91 cells', cells.length === 91);
  const center = cells.find((c) => c.q === 0 && c.r === 0);
  check('grid contains center', !!center);
  const allWithinRadius = cells.every((c) => hexDistance(c.q, c.r) <= 5);
  check('every cell within radius', allWithinRadius);
  const neighbors = axialNeighbors(0, 0);
  check('axial neighbors returns 6', neighbors.length === 6);
}

// 4. Landmarks placed in bounds and distinct
{
  const radius = DEFAULT_RADIUS;
  const landmarks = placeLandmarks(radius);
  const keys = [cellKey(landmarks.town), cellKey(landmarks.grove), cellKey(landmarks.farm)];
  check('landmarks distinct', new Set(keys).size === 3);
  check('landmarks within radius', [landmarks.town, landmarks.grove, landmarks.farm]
    .every((p) => hexDistance(p.q, p.r) <= radius));
}

// 5. Terrain generation determinism + bounds over many seeds
{
  const cells = generateGrid(DEFAULT_RADIUS);
  let allBounded = true;
  for (let s = 0; s < 100; s++) {
    const seed = `seed-${s}`;
    const terrain = generateTerrain(seed, cells);
    const terrain2 = generateTerrain(seed, cells);
    for (const c of cells) {
      const t = terrain.get(cellKey(c));
      const t2 = terrain2.get(cellKey(c));
      if (t.baseFlammability !== t2.baseFlammability) allBounded = false;
      if (t.baseFlammability < 0 || t.baseFlammability > 1) allBounded = false;
      if (t.moisture < 0 || t.moisture > 1) allBounded = false;
      if (t.maxFuel <= 0 || t.maxFuel > 1) allBounded = false;
    }
  }
  check('terrain deterministic + bounded over 100 seeds', allBounded);
}

// 6. Weather bounds + determinism over 365 "days" (years used as day proxy)
{
  let ok = true;
  for (let y = 1; y <= 365; y++) {
    const w1 = generateWeather('season-seed', y);
    const w2 = generateWeather('season-seed', y);
    if (w1.dryness !== w2.dryness || w1.windDir !== w2.windDir || w1.windStrength !== w2.windStrength) ok = false;
    if (w1.dryness < 0 || w1.dryness > 1) ok = false;
    if (w1.windDir < 0 || w1.windDir > 5) ok = false;
    if (w1.windStrength < 0 || w1.windStrength > 1) ok = false;
  }
  check('weather deterministic + bounded over 365 years', ok);
}

// 7. strikeCountForWeather bounds
{
  let ok = true;
  for (let d = 0; d <= 100; d++) {
    const count = strikeCountForWeather({ dryness: d / 100 });
    if (count < 1 || !Number.isInteger(count)) ok = false;
  }
  check('strike count always positive integer', ok);
}

// 8. sampleStrikes matches weights statistically
{
  const cells = [{ q: 0, r: 0 }, { q: 1, r: 0 }, { q: 2, r: 0 }];
  const terrain = new Map([
    ['0,0', { baseFlammability: 0.9, moisture: 0.2, maxFuel: 0.9 }],
    ['1,0', { baseFlammability: 0.1, moisture: 0.2, maxFuel: 0.3 }],
    ['2,0', { baseFlammability: 0.1, moisture: 0.2, maxFuel: 0.3 }],
  ]);
  const weather = { dryness: 0.5, windDir: 0, windStrength: 0.3 };
  const prng = mulberry32(777);
  const keys = sampleStrikes(cells, terrain, weather, prng, 5000);
  const counts = { '0,0': 0, '1,0': 0, '2,0': 0 };
  for (const k of keys) counts[k]++;
  const hotRatio = counts['0,0'] / keys.length;
  // weight('0,0') = 0.9*(0.8) = 0.72 ; weight(others) = 0.1*0.8=0.08 each; total=0.88 -> expect ~0.818
  check('strike sampling favors high-weight cell (statistical)', hotRatio > 0.7 && hotRatio < 0.92);
}

// 9. applyPrepActions respects budget and semantics
{
  const fuelState = new Map([['0,0', 0.8], ['1,0', 0.8], ['2,0', 0.8]]);
  const actions = [
    { type: 'break', key: '0,0' },
    { type: 'thin', key: '1,0' },
    { type: 'burn', key: '2,0' },
  ];
  const result = applyPrepActions(fuelState, actions, ACTION_COSTS.break + ACTION_COSTS.thin + ACTION_COSTS.burn);
  check('break sets fuel to 0', result.fuelState.get('0,0') === 0);
  check('thin reduces fuel', approxEqual(result.fuelState.get('1,0'), 0.32));
  check('burn reduces fuel to <=0.08', result.fuelState.get('2,0') <= 0.08);
  check('spent equals sum of costs', result.spent === ACTION_COSTS.break + ACTION_COSTS.thin + ACTION_COSTS.burn);

  const overBudget = applyPrepActions(fuelState, actions, 3);
  check('budget cap skips actions beyond budget', overBudget.applied.length === 1 && overBudget.spent === 3);
}

// 10. spreadFire: fuel 0 (a break) fully blocks spread
{
  const radius = 3;
  const cells = generateGrid(radius);
  const terrain = generateTerrain('break-test', cells);
  // ring of fuel-0 cells at distance 1 from center encircles it
  const fuel = new Map(cells.map((c) => [cellKey(c), terrain.get(cellKey(c)).maxFuel]));
  for (const c of cells) {
    if (hexDistance(c.q, c.r) === 1) fuel.set(cellKey(c), 0); // firebreak ring
  }
  const weather = { dryness: 0.9, windDir: 2, windStrength: 0.9 };
  const prng = mulberry32(123);
  const { burned } = spreadFire(cells, fuel, terrain, weather, ['0,0'], prng, radius * 2 + 2);
  const escaped = [...burned].some((k) => hexDistance(...k.split(',').map(Number)) > 1);
  check('fuel-0 ring blocks fire from escaping center', !escaped);
}

// 11. spreadFire: strike landing on fuel-0 cell never ignites
{
  const radius = 2;
  const cells = generateGrid(radius);
  const terrain = generateTerrain('zero-strike', cells);
  const fuel = new Map(cells.map((c) => [cellKey(c), 0]));
  const weather = { dryness: 0.9, windDir: 0, windStrength: 0.9 };
  const prng = mulberry32(9);
  const { burned } = spreadFire(cells, fuel, terrain, weather, ['0,0'], prng, radius * 2 + 2);
  check('strike on zero-fuel cell never ignites', burned.size === 0);
}

// 12. wind bias — downwind cells catch fire more than upwind (statistical)
{
  const radius = 6;
  const cells = generateGrid(radius);
  const terrain = new Map(cells.map((c) => [cellKey(c), { baseFlammability: 1, moisture: 0, maxFuel: 1 }]));
  const windDir = 0; // DIR_OFFSETS[0] = [1,0]
  const dirVec = axialToCart(1, 0);
  const weather = { dryness: 0.9, windDir, windStrength: 0.95 };
  let downwind = 0, upwind = 0;
  for (let seed = 0; seed < 20; seed++) {
    const fuel = new Map(cells.map((c) => [cellKey(c), 1]));
    const prng = mulberry32(1000 + seed);
    const { burned } = spreadFire(cells, fuel, terrain, weather, ['0,0'], prng, 4);
    for (const k of burned) {
      const [q, r] = k.split(',').map(Number);
      if (q === 0 && r === 0) continue;
      const cart = axialToCart(q, r);
      const dot = cart.x * dirVec.x + cart.y * dirVec.y;
      if (dot > 0.05) downwind++;
      else if (dot < -0.05) upwind++;
    }
  }
  check('wind bias: downwind burns more than upwind across seeds', downwind > upwind);
}

// 13. windAlignment table sanity
{
  check('windAlignment same direction is max', windAlignment(2, 2) === 1.0);
  check('windAlignment opposite direction is min', windAlignment(2, 5) === -1.0);
}

// 14. counterfactual uses identical seed — same strikes for prepped and ghost
{
  const radius = DEFAULT_RADIUS;
  const cells = generateGrid(radius);
  const terrain = generateTerrain('cf-seed', cells);
  const landmarks = placeLandmarks(radius);
  const preppedFuel = initialFuelState(cells, terrain);
  const ghostFuel = new Map(preppedFuel);
  const rec = runYear({
    seed: 'cf-seed', year: 3, radius, terrain, cells, landmarks,
    preppedFuel, ghostFuel, actions: [{ type: 'break', key: cellKey(landmarks.town) }], budget: 10,
  });
  check('counterfactual strikeKeys computed once, shared by construction', Array.isArray(rec.strikeKeys) && rec.strikeKeys.length > 0);
  // rerun with a totally different prep policy but same seed/year -> strikes must match
  const rec2 = runYear({
    seed: 'cf-seed', year: 3, radius, terrain, cells, landmarks,
    preppedFuel, ghostFuel, actions: [], budget: 10,
  });
  check('strikeKeys identical regardless of prep actions (same seed/year)', JSON.stringify(rec.strikeKeys) === JSON.stringify(rec2.strikeKeys));
}

// 15. regrowth bounded — fuel never exceeds maxFuel or drops below 0, across years
{
  const radius = 4;
  const cells = generateGrid(radius);
  const terrain = generateTerrain('regrow-seed', cells);
  let fuel = initialFuelState(cells, terrain);
  let ok = true;
  for (let y = 0; y < 30; y++) {
    // burn a random-ish subset deterministically
    const burned = new Set(cells.filter((c, i) => (i + y) % 5 === 0).map(cellKey));
    fuel = regrowFuel(fuel, terrain, burned);
    for (const [key, f] of fuel) {
      const maxFuel = terrain.get(key).maxFuel;
      if (f < 0 || f > maxFuel + 1e-9) ok = false;
    }
  }
  check('regrowth stays within [0, maxFuel] across 30 years', ok);
}

// 16. a known good prep measurably reduces burned area across 50 seeds
{
  const radius = DEFAULT_RADIUS;
  let preppedWins = 0;
  let preppedTotalBurned = 0, ghostTotalBurned = 0;
  for (let s = 0; s < 50; s++) {
    const seed = `good-prep-${s}`;
    const cells = generateGrid(radius);
    const terrain = generateTerrain(seed, cells);
    const landmarks = placeLandmarks(radius);
    const preppedFuel = initialFuelState(cells, terrain);
    const ghostFuel = new Map(preppedFuel);
    // good prep: cut a full ring of breaks around each landmark (its 6 neighbors)
    const actions = [];
    for (const lm of [landmarks.town, landmarks.grove, landmarks.farm]) {
      for (const [nq, nr] of axialNeighbors(lm.q, lm.r)) {
        actions.push({ type: 'break', key: `${nq},${nr}` });
      }
    }
    const budget = actions.length * ACTION_COSTS.break;
    const rec = runYear({ seed, year: 1, radius, terrain, cells, landmarks, preppedFuel, ghostFuel, actions, budget });
    preppedTotalBurned += rec.preppedBurned.size;
    ghostTotalBurned += rec.ghostBurned.size;
    if (rec.preppedBurned.size <= rec.ghostBurned.size) preppedWins++;
  }
  check('good prep reduces or matches burned area in most of 50 seeds', preppedWins >= 35);
  check('good prep reduces total burned area across 50 seeds', preppedTotalBurned < ghostTotalBurned);
}

// 17. determinism of full simulateGame across a run
{
  const policy = () => [];
  const a = simulateGame('det-seed', 10, DEFAULT_RADIUS, policy);
  const b = simulateGame('det-seed', 10, DEFAULT_RADIUS, policy);
  let same = a.records.length === b.records.length;
  for (let i = 0; i < a.records.length && same; i++) {
    if (JSON.stringify(a.records[i].strikeKeys) !== JSON.stringify(b.records[i].strikeKeys)) same = false;
    if (a.records[i].preppedBurned.size !== b.records[i].preppedBurned.size) same = false;
    if (a.records[i].ghostBurned.size !== b.records[i].ghostBurned.size) same = false;
  }
  check('simulateGame fully deterministic given same seed', same);
}

// 18. no-NaN fuzz across many seeds/params
{
  let clean = true;
  for (let s = 0; s < 40; s++) {
    const seed = `fuzz-${s}`;
    const policy = ({ cells, budget }) => {
      const acts = [];
      let spent = 0;
      for (const c of cells) {
        if (spent + ACTION_COSTS.thin > budget) break;
        if ((s + c.q + c.r) % 7 === 0) { acts.push({ type: 'thin', key: cellKey(c) }); spent += ACTION_COSTS.thin; }
      }
      return acts;
    };
    const game = simulateGame(seed, 10, DEFAULT_RADIUS, policy);
    for (const rec of game.records) {
      if (!Number.isFinite(rec.weather.dryness) || !Number.isFinite(rec.weather.windStrength)) clean = false;
      for (const [, f] of rec.nextPreppedFuel) if (!Number.isFinite(f)) clean = false;
      for (const [, f] of rec.nextGhostFuel) if (!Number.isFinite(f)) clean = false;
    }
  }
  check('no NaN/undefined across 40 fuzzed 10-year games', clean);
}

// 19. budgetForYear monotone non-decreasing and bounded reasonable
{
  let ok = true;
  let prev = -Infinity;
  for (let y = 1; y <= 20; y++) {
    const b = budgetForYear(y);
    if (b < prev) ok = false;
    prev = b;
  }
  check('budgetForYear non-decreasing over 20 years', ok);
}

// 20. structures evaluation + share text
{
  const landmarks = placeLandmarks(DEFAULT_RADIUS);
  const burned = new Set([cellKey(landmarks.grove)]);
  const s = evaluateStructures(landmarks, burned);
  check('evaluateStructures flags only the burned landmark', s.grove === true && s.town === false && s.farm === false);
  const text = buildShareText({ year: 7, headline: 'the east cut held', ghostLine: 'ghost-me lost the grove', url: 'http://firebreak.defimagic.io' });
  check('buildShareText contains year and url', text.includes('year 7') && text.includes('http://firebreak.defimagic.io'));
  check('buildShareText starts with axe emoji', text.startsWith('\u{1FA93}'));
}

// 21. spreadFire respects maxSteps (terminates, doesn't loop forever on huge fuel)
{
  const radius = 5;
  const cells = generateGrid(radius);
  const terrain = new Map(cells.map((c) => [cellKey(c), { baseFlammability: 1, moisture: 0, maxFuel: 1 }]));
  const fuel = new Map(cells.map((c) => [cellKey(c), 1]));
  const weather = { dryness: 1, windDir: 0, windStrength: 0 };
  const prng = mulberry32(55);
  const { steps } = spreadFire(cells, fuel, terrain, weather, ['0,0'], prng, 3);
  check('spreadFire honors maxSteps cap', steps <= 3);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
