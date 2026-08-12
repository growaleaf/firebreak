import * as Fire from './fire.mjs';

const STORAGE_KEY = 'firebreak_v1';
const YEARS = 10;
const CANVAS_SIZE = 380;
const ACTION_LABEL = { break: 'B', thin: 'T', burn: 'C' };
const SPEEDS = [700, 350, 140];

// ---------------------------------------------------------------- HEX PIXEL MATH ----
function computeLayout(cells, canvasSize, padding = 20) {
  const raw = cells.map((c) => ({ x: 1.5 * c.q, y: Math.sqrt(3) * (c.r + c.q / 2) }));
  const xs = raw.map((p) => p.x), ys = raw.map((p) => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const avail = canvasSize - padding * 2;
  const size = Math.min(avail / (maxX - minX + 2), avail / (maxY - minY + 2));
  const offsetX = canvasSize / 2 - (size * (minX + maxX)) / 2;
  const offsetY = canvasSize / 2 - (size * (minY + maxY)) / 2;
  return { size, offsetX, offsetY };
}
function hexCenter(q, r, layout) {
  return {
    x: layout.size * 1.5 * q + layout.offsetX,
    y: layout.size * Math.sqrt(3) * (r + q / 2) + layout.offsetY,
  };
}
function axialRound(q, r) {
  let x = q, z = r, y = -x - z;
  let rx = Math.round(x), ry = Math.round(y), rz = Math.round(z);
  const xd = Math.abs(rx - x), yd = Math.abs(ry - y), zd = Math.abs(rz - z);
  if (xd > yd && xd > zd) rx = -ry - rz;
  else if (yd > zd) ry = -rx - rz;
  else rz = -rx - ry;
  return { q: rx, r: rz };
}
function pixelToAxial(px, py, layout) {
  const x = (px - layout.offsetX) / layout.size;
  const y = (py - layout.offsetY) / layout.size;
  const q = (2 / 3) * x;
  const r = (-1 / 3) * x + (Math.sqrt(3) / 3) * y;
  return axialRound(q, r);
}
function hexPath(ctx, cx, cy, size) {
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 180) * (60 * i);
    const x = cx + size * Math.cos(angle);
    const y = cy + size * Math.sin(angle);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
}
function fuelColor(ratio) {
  const lo = [74, 107, 58], hi = [201, 138, 46];
  const t = Math.max(0, Math.min(1, ratio));
  const c = lo.map((v, i) => Math.round(v + (hi[i] - v) * t));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

// ---------------------------------------------------------------- STATE ----
let state = null;

function freshState(seed) {
  const radius = Fire.DEFAULT_RADIUS;
  const cells = Fire.generateGrid(radius);
  const terrain = Fire.generateTerrain(seed, cells);
  const landmarks = Fire.placeLandmarks(radius);
  const preppedFuel = Fire.initialFuelState(cells, terrain);
  const ghostFuel = new Map(preppedFuel);
  return {
    seed, radius, cells, terrain, landmarks,
    year: 1,
    preppedFuel, ghostFuel,
    budget: Fire.budgetForYear(1),
    plannedActions: new Map(), // key -> type
    actionMode: 'break',
    screen: 'title',
    lastRecord: null,
    anim: null,
    totalPreppedBurnedAll: 0,
    totalGhostBurnedAll: 0,
    yearLog: [],
  };
}

function randomSeed() {
  return `watch-${Math.floor(Math.random() * 1e9)}-${Date.now()}`;
}

function save() {
  try {
    const payload = {
      seed: state.seed,
      radius: state.radius,
      year: state.year,
      preppedFuel: [...state.preppedFuel.entries()],
      ghostFuel: [...state.ghostFuel.entries()],
      totalPreppedBurnedAll: state.totalPreppedBurnedAll,
      totalGhostBurnedAll: state.totalGhostBurnedAll,
      finished: state.screen === 'end',
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch (e) { /* ignore quota/private-mode errors */ }
}

function loadSaved() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) { return null; }
}

function resumeFromSaved(saved) {
  state = freshState(saved.seed);
  state.year = saved.year;
  state.preppedFuel = new Map(saved.preppedFuel);
  state.ghostFuel = new Map(saved.ghostFuel);
  state.budget = Fire.budgetForYear(state.year);
  state.totalPreppedBurnedAll = saved.totalPreppedBurnedAll || 0;
  state.totalGhostBurnedAll = saved.totalGhostBurnedAll || 0;
  showScreen('prep');
}

// ---------------------------------------------------------------- SCREENS ----
const screens = ['title', 'howto', 'prep', 'season', 'autopsy', 'end'];
function showScreen(name) {
  state.screen = name;
  for (const s of screens) {
    document.getElementById(`screen-${s}`).classList.toggle('active', s === name);
  }
  if (name === 'prep') renderPrep();
  if (name === 'season') renderSeasonFrame();
  if (name === 'autopsy') renderAutopsy();
  if (name === 'end') renderEnd();
}

function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), 1800);
}

// ---------------------------------------------------------------- PREP SCREEN ----
function currentSpent() {
  let spent = 0;
  for (const type of state.plannedActions.values()) spent += Fire.ACTION_COSTS[type];
  return spent;
}

function landmarkAt(key) {
  const { town, grove, farm } = state.landmarks;
  if (key === Fire.cellKey(town)) return 'town';
  if (key === Fire.cellKey(grove)) return 'grove';
  if (key === Fire.cellKey(farm)) return 'farm';
  return null;
}

function renderPrep() {
  document.getElementById('hudYear').textContent = state.year;
  document.getElementById('hudBudget').textContent = state.budget;
  document.getElementById('hudSpent').textContent = currentSpent();

  const canvas = document.getElementById('mapCanvas');
  canvas.width = CANVAS_SIZE; canvas.height = CANVAS_SIZE;
  const ctx = canvas.getContext('2d');
  const layout = computeLayout(state.cells, CANVAS_SIZE);
  state._prepLayout = layout;
  ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

  for (const c of state.cells) {
    const key = Fire.cellKey(c);
    const t = state.terrain.get(key);
    const fuel = state.preppedFuel.get(key);
    const { x, y } = hexCenter(c.q, c.r, layout);
    hexPath(ctx, x, y, layout.size * 0.94);
    ctx.fillStyle = fuelColor(fuel / t.maxFuel);
    ctx.fill();

    if (state.plannedActions.has(key)) {
      ctx.fillStyle = 'rgba(233,226,198,0.6)';
      ctx.fill();
    }

    const lm = landmarkAt(key);
    if (lm) {
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#d9a441';
      hexPath(ctx, x, y, layout.size * 0.94);
      ctx.stroke();
      ctx.fillStyle = '#1a1206';
      ctx.font = `bold ${Math.max(9, layout.size * 0.5)}px Georgia`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(lm[0].toUpperCase(), x, y);
    } else if (state.plannedActions.has(key)) {
      ctx.fillStyle = '#1a1206';
      ctx.font = `${Math.max(8, layout.size * 0.42)}px Georgia`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(ACTION_LABEL[state.plannedActions.get(key)], x, y);
    }

    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(0,0,0,0.25)';
    hexPath(ctx, x, y, layout.size * 0.94);
    ctx.stroke();
  }

  document.getElementById('btnRunSeason').disabled = false;
}

function tapPrepCell(px, py) {
  const layout = state._prepLayout;
  if (!layout) return;
  const { q, r } = pixelToAxial(px, py, layout);
  const key = `${q},${r}`;
  if (!state.terrain.has(key)) return;
  applyTap(key);
}

function applyTap(key) {
  const mode = state.actionMode;
  const cost = Fire.ACTION_COSTS[mode];
  const existing = state.plannedActions.get(key);
  if (existing === mode) {
    state.plannedActions.delete(key);
    renderPrep();
    return;
  }
  const existingCost = existing ? Fire.ACTION_COSTS[existing] : 0;
  const spentWithout = currentSpent() - existingCost;
  if (spentWithout + cost > state.budget) {
    toast('Not enough budget left this year.');
    return;
  }
  state.plannedActions.set(key, mode);
  renderPrep();
}

// ---------------------------------------------------------------- RUN SEASON ----
function runSeason() {
  const actions = [...state.plannedActions.entries()].map(([key, type]) => ({ key, type }));
  const rec = Fire.runYear({
    seed: state.seed, year: state.year, radius: state.radius,
    terrain: state.terrain, cells: state.cells, landmarks: state.landmarks,
    preppedFuel: state.preppedFuel, ghostFuel: state.ghostFuel,
    actions, budget: state.budget,
  });
  state.lastRecord = rec;

  // Precompute wavefronts for the prepped fire by replaying spreadFire with the
  // same seed-derived prng at increasing step caps — deterministic, so this
  // reproduces the exact same burn each call, just revealed incrementally.
  const preppedFuelAfterActions = Fire.applyPrepActions(state.preppedFuel, actions, state.budget).fuelState;
  const weather = rec.weather;
  const strikeCumulative = [];
  for (let k = 0; k <= rec.preppedSteps; k++) {
    const prng = Fire.mulberry32(Fire.hashString(`${state.seed}:spread-prepped:${state.year}`));
    const { burned } = Fire.spreadFire(state.cells, preppedFuelAfterActions, state.terrain, weather, rec.strikeKeys, prng, k);
    strikeCumulative.push(burned);
  }
  const frontiers = strikeCumulative.map((set, i) => {
    if (i === 0) return new Set(set);
    const prev = strikeCumulative[i - 1];
    return new Set([...set].filter((k) => !prev.has(k)));
  });

  state.anim = {
    frontiers,
    step: 0,
    maxStep: frontiers.length - 1,
    playing: true,
    speedIdx: 0,
    lastTick: 0,
  };

  showScreen('season');
  requestAnimationFrame(tick);
}

// ---------------------------------------------------------------- SEASON SCREEN ----
function renderSeasonFrame() {
  const canvas = document.getElementById('seasonCanvas');
  canvas.width = CANVAS_SIZE; canvas.height = CANVAS_SIZE;
  const ctx = canvas.getContext('2d');
  const layout = computeLayout(state.cells, CANVAS_SIZE);
  ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

  document.getElementById('seasonYear').textContent = state.year;
  const rec = state.lastRecord;
  document.getElementById('seasonWeatherLabel').textContent =
    `dryness ${(rec.weather.dryness * 100).toFixed(0)}% · wind ${(rec.weather.windStrength * 100).toFixed(0)}%`;

  const anim = state.anim;
  const burningNow = anim.frontiers[anim.step] || new Set();
  const burnedOut = new Set();
  for (let i = 0; i < anim.step; i++) for (const k of anim.frontiers[i]) burnedOut.add(k);

  for (const c of state.cells) {
    const key = Fire.cellKey(c);
    const { x, y } = hexCenter(c.q, c.r, layout);
    hexPath(ctx, x, y, layout.size * 0.94);
    if (burningNow.has(key)) ctx.fillStyle = '#c1502e';
    else if (burnedOut.has(key)) ctx.fillStyle = '#4a4a4a';
    else {
      const t = state.terrain.get(key);
      const fuel = state.preppedFuel.get(key);
      ctx.fillStyle = fuelColor(fuel / t.maxFuel);
    }
    ctx.fill();
    const lm = landmarkAt(key);
    if (lm) {
      ctx.lineWidth = 2; ctx.strokeStyle = '#d9a441';
      hexPath(ctx, x, y, layout.size * 0.94); ctx.stroke();
    }
    ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(0,0,0,0.25)';
    hexPath(ctx, x, y, layout.size * 0.94); ctx.stroke();
  }

  document.getElementById('btnPausePlay').textContent = anim.playing ? 'Pause' : 'Resume';
  document.getElementById('btnSpeed').textContent = `Speed ×${anim.speedIdx + 1}`;
}

function step(now) {
  const anim = state.anim;
  if (!anim || !anim.playing) return;
  if (now - anim.lastTick < SPEEDS[anim.speedIdx]) return;
  anim.lastTick = now;
  if (anim.step < anim.maxStep) {
    anim.step++;
    renderSeasonFrame();
  } else {
    anim.playing = false;
    finishSeason();
  }
}
function tick(now) {
  step(now);
  if (state.anim && state.anim.playing) requestAnimationFrame(tick);
}

function finishSeason() {
  showScreen('autopsy');
}

// ---------------------------------------------------------------- AUTOPSY ----
function renderAutopsy() {
  const rec = state.lastRecord;
  document.getElementById('autopsyYear').textContent = state.year;
  document.getElementById('statPrepped').textContent = rec.preppedBurned.size;
  document.getElementById('statGhost').textContent = rec.ghostBurned.size;

  const canvas = document.getElementById('autopsyCanvas');
  canvas.width = CANVAS_SIZE; canvas.height = CANVAS_SIZE;
  const ctx = canvas.getContext('2d');
  const layout = computeLayout(state.cells, CANVAS_SIZE);
  ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

  for (const c of state.cells) {
    const key = Fire.cellKey(c);
    const { x, y } = hexCenter(c.q, c.r, layout);
    hexPath(ctx, x, y, layout.size * 0.94);
    const inPrepped = rec.preppedBurned.has(key);
    const inGhost = rec.ghostBurned.has(key);
    if (inPrepped && inGhost) ctx.fillStyle = '#c1502e';
    else if (!inPrepped && inGhost) ctx.fillStyle = '#d9a441';
    else if (inPrepped && !inGhost) ctx.fillStyle = '#7a4fae';
    else {
      const t = state.terrain.get(key);
      const fuel = rec.nextPreppedFuel.get(key);
      ctx.fillStyle = fuelColor(fuel / t.maxFuel);
    }
    ctx.fill();
    const lm = landmarkAt(key);
    if (lm) {
      ctx.lineWidth = 2; ctx.strokeStyle = '#d9a441';
      hexPath(ctx, x, y, layout.size * 0.94); ctx.stroke();
    }
    ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(0,0,0,0.25)';
    hexPath(ctx, x, y, layout.size * 0.94); ctx.stroke();
  }

  const list = document.getElementById('landmarkList');
  list.innerHTML = '';
  const names = { town: 'The town', grove: 'The grove', farm: 'The ridge farm' };
  for (const key of ['town', 'grove', 'farm']) {
    const lost = rec.preppedStructures[key];
    const ghostLost = rec.ghostStructures[key];
    const row = document.createElement('div');
    row.className = `lm-row ${lost ? 'lost' : 'held'}`;
    let note = lost ? 'burned' : 'held';
    if (!lost && ghostLost) note += ' — the ghost year lost it';
    row.innerHTML = `<span>${names[key]}</span><span>${note}</span>`;
    list.appendChild(row);
  }

  state.totalPreppedBurnedAll += rec.preppedBurned.size;
  state.totalGhostBurnedAll += rec.ghostBurned.size;
  state.yearLog.push({
    year: state.year,
    preppedBurned: rec.preppedBurned.size,
    ghostBurned: rec.ghostBurned.size,
    preppedStructures: rec.preppedStructures,
    ghostStructures: rec.ghostStructures,
  });

  state.preppedFuel = rec.nextPreppedFuel;
  state.ghostFuel = rec.nextGhostFuel;
  save();
}

function buildYearShareText() {
  const rec = state.lastRecord;
  const names = { town: 'the town', grove: 'the grove', farm: 'the ridge farm' };
  let headline;
  const lostKeys = ['town', 'grove', 'farm'].filter((k) => rec.preppedStructures[k]);
  headline = lostKeys.length ? `${names[lostKeys[0]]} was lost` : 'the line held';
  const ghostLostKeys = ['town', 'grove', 'farm'].filter((k) => rec.ghostStructures[k] && !rec.preppedStructures[k]);
  const ghostLine = ghostLostKeys.length
    ? `ghost-me lost ${names[ghostLostKeys[0]]}`
    : `ghost year: ${rec.ghostBurned.size} hexes gone`;
  return Fire.buildShareText({
    year: state.year, headline, ghostLine, url: 'http://firebreak.defimagic.io',
  });
}

function nextYear() {
  if (state.year >= YEARS) {
    showScreen('end');
    return;
  }
  state.year += 1;
  state.budget = Fire.budgetForYear(state.year);
  state.plannedActions = new Map();
  showScreen('prep');
  save();
}

// ---------------------------------------------------------------- END ----
function renderEnd() {
  document.getElementById('endPrepped').textContent = state.totalPreppedBurnedAll;
  document.getElementById('endGhost').textContent = state.totalGhostBurnedAll;
  const saved = state.totalGhostBurnedAll - state.totalPreppedBurnedAll;
  const summary = saved > 0
    ? `Across ten years, your preparation kept roughly ${saved} hexes from burning that the ghost hillside lost.`
    : saved < 0
      ? `Across ten years, the ghost hillside came out ${-saved} hexes ahead of yours — the draw was unkind, or the plan was wrong. Hard to say which, honestly.`
      : `Across ten years, your hillside and the ghost hillside burned about the same amount. The land is a hard thing to out-guess.`;
  document.getElementById('endSummary').textContent = summary;
  save();
}

function buildEndShareText() {
  const saved = state.totalGhostBurnedAll - state.totalPreppedBurnedAll;
  const headline = saved > 0 ? `${saved} hexes saved over ghost-me` : saved < 0 ? `${-saved} hexes worse than doing nothing` : 'dead even with the ghost';
  return Fire.buildShareText({
    year: YEARS, headline, ghostLine: `${state.totalGhostBurnedAll} ghost hexes burned total`, url: 'http://firebreak.defimagic.io',
  });
}

function copyToClipboard(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => toast('Copied.')).catch(() => toast(text));
  } else {
    toast(text);
  }
}

// ---------------------------------------------------------------- WIRE UP ----
function wire() {
  document.getElementById('btnNewGame').addEventListener('click', () => {
    state = freshState(randomSeed());
    showScreen('prep');
    save();
  });
  document.getElementById('btnHowTo').addEventListener('click', () => showScreen('howto'));
  document.getElementById('btnHowToBack').addEventListener('click', () => showScreen(state._prevBeforeHowTo || 'title'));
  document.getElementById('btnContinue').addEventListener('click', () => {
    const saved = loadSaved();
    if (saved && !saved.finished) resumeFromSaved(saved);
  });

  document.getElementById('actionButtons').addEventListener('click', (e) => {
    const btn = e.target.closest('.actbtn');
    if (!btn) return;
    state.actionMode = btn.dataset.mode;
    document.querySelectorAll('.actbtn').forEach((b) => b.classList.toggle('selected', b === btn));
  });

  const mapCanvas = document.getElementById('mapCanvas');
  mapCanvas.addEventListener('click', (e) => {
    const rect = mapCanvas.getBoundingClientRect();
    const scale = mapCanvas.width / rect.width;
    tapPrepCell((e.clientX - rect.left) * scale, (e.clientY - rect.top) * scale);
  });

  document.getElementById('btnRunSeason').addEventListener('click', runSeason);

  document.getElementById('btnPausePlay').addEventListener('click', () => {
    state.anim.playing = !state.anim.playing;
    if (state.anim.playing) { state.anim.lastTick = 0; requestAnimationFrame(tick); }
    renderSeasonFrame();
  });
  document.getElementById('btnSpeed').addEventListener('click', () => {
    state.anim.speedIdx = (state.anim.speedIdx + 1) % SPEEDS.length;
    renderSeasonFrame();
  });
  document.getElementById('btnSkip').addEventListener('click', () => {
    state.anim.step = state.anim.maxStep;
    state.anim.playing = false;
    finishSeason();
  });

  document.getElementById('btnShare').addEventListener('click', () => copyToClipboard(buildYearShareText()));
  document.getElementById('btnShareEnd').addEventListener('click', () => copyToClipboard(buildEndShareText()));
  document.getElementById('btnNextYear').addEventListener('click', nextYear);
  document.getElementById('btnRestart').addEventListener('click', () => {
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) { /* ignore */ }
    state = freshState(randomSeed());
    showScreen('title');
  });
}

function init() {
  state = freshState(randomSeed());
  wire();
  const saved = loadSaved();
  if (saved && !saved.finished && saved.year) {
    document.getElementById('btnContinue').style.display = '';
    document.getElementById('continueYear').textContent = saved.year;
  }
  showScreen('title');
  maybeInstallDevHook();
}

// ---------------------------------------------------------------- DEV HOOK ----
function maybeInstallDevHook() {
  const params = new URLSearchParams(location.search);
  if (params.get('dev') !== '1') return;
  window.__g = {
    getState() {
      return {
        screen: state.screen,
        year: state.year,
        budget: state.budget,
        spent: currentSpent(),
        plannedActions: [...state.plannedActions.entries()],
        actionMode: state.actionMode,
        landmarks: state.landmarks,
        totalPreppedBurnedAll: state.totalPreppedBurnedAll,
        totalGhostBurnedAll: state.totalGhostBurnedAll,
        lastRecord: state.lastRecord && {
          preppedBurned: [...state.lastRecord.preppedBurned],
          ghostBurned: [...state.lastRecord.ghostBurned],
          preppedStructures: state.lastRecord.preppedStructures,
          ghostStructures: state.lastRecord.ghostStructures,
          weather: state.lastRecord.weather,
        },
        anim: state.anim && { step: state.anim.step, maxStep: state.anim.maxStep, playing: state.anim.playing },
        yearLog: state.yearLog,
      };
    },
    newGame(seed) { state = freshState(seed || randomSeed()); showScreen('prep'); },
    goTitle() { showScreen('title'); },
    showHowTo() { showScreen('howto'); },
    setMode(mode) { state.actionMode = mode; },
    tapCell(q, r) { applyTap(`${q},${r}`); },
    runSeason() { runSeason(); },
    stepAnimation(now) { step(now != null ? now : (state.anim ? state.anim.lastTick + SPEEDS[state.anim.speedIdx] + 1 : 0)); },
    skipAnimation() {
      if (!state.anim) return;
      state.anim.step = state.anim.maxStep;
      state.anim.playing = false;
      finishSeason();
    },
    nextYear() { nextYear(); },
    resume() {
      const saved = loadSaved();
      if (saved && !saved.finished) resumeFromSaved(saved);
    },
    restart() {
      try { localStorage.removeItem(STORAGE_KEY); } catch (e) { /* ignore */ }
      state = freshState(randomSeed());
      showScreen('title');
    },
    shareYearText() { return buildYearShareText(); },
    shareEndText() { return buildEndShareText(); },
  };
}

init();
