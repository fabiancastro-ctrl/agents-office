// Oficina de Agentes · mantenimiento: salud de la oficina, limpieza de su carpeta de datos y respaldo.
// Parte de daemon/daemon.mjs, que carga los módulos de daemon/lib/ en orden y arranca la oficina.
// Nada de esto gasta cuota: lee archivos y tmux, y nunca abre /usage ni le escribe a un robot.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  ATTACH_DIR,
  CLAUDE_BIN,
  now,
  PORT,
  robots,
  run,
  RUNS,
  SESSION,
  SETTINGS,
  setMaxRobots,
  MAX_ROBOTS_LIMIT,
  WORKSPACE
} from './base.mjs';
import { broadcast, configView, emit, MAP_THEMES } from './estado.mjs';
import { officeName, readConfig, saveConfig, setOfficeName, OFFICE_NAME_MAX } from './carpeta.mjs';
import { saveState } from './persistencia.mjs';
import { headQuota } from './uso.mjs';
import { favorites, pins, saveFavorites, savePins } from './turno.mjs';
import { emitRoutines, routines, saveRoutines } from './rutinas.mjs';
import { salas, salasArchive, SALAS_DIR, toTrash } from './salas.mjs';
import { readBody, readRaw, send } from './http.mjs';
import { exportAll, healthReport, importAll, PROPOSAL_DAYS, writeIndex } from './memoria.mjs';

const STARTED = Date.now();
const DAY = 86400e3;

/* ---------- tamaño de la carpeta de datos ---------- */
function sizeOf(p) {
  let st;
  try {
    st = fs.lstatSync(p);
  } catch {
    return 0;
  }
  if (!st.isDirectory()) return st.size;
  let n = 0;
  for (const e of fs.readdirSync(p)) n += sizeOf(path.join(p, e));
  return n;
}
const mtimeOf = p => {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return 0;
  }
};

/* ---------- 4 · limpieza ---------- */
// Lo que se puede llevar a la Papelera sin perder nada que la oficina use: eventos crudos viejos (antes se rescatan sus
// SessionStart, que son los que arman el uso por semana), conversaciones y adjuntos de robots que ya no están, respaldos
// de conversaciones y carpetas de salas que no están abiertas ni en el archivo. Nunca lo de hoy ni lo de un robot vivo.
const SESSIONS_FILE = path.join(RUNS, 'sesiones.jsonl');
const CLEAN_DAYS = [3, 7, 14, 30];
function cleanCandidates(days = 7) {
  const cut = Date.now() - days * DAY,
    today = new Date().toISOString().slice(0, 10),
    out = [];
  const add = (kind, p, at) => out.push({ kind, path: p, rel: path.relative(RUNS, p), size: sizeOf(p), at: new Date(at).toISOString() });
  let names = [];
  try {
    names = fs.readdirSync(RUNS);
  } catch {
    return out;
  }
  for (const f of names) {
    const m = f.match(/^events-(\d{4}-\d{2}-\d{2})\.jsonl$/);
    if (m && m[1] !== today && Date.parse(m[1] + 'T23:59:59Z') < cut) add('eventos', path.join(RUNS, f), Date.parse(m[1]));
    if (/^conversaciones\.respaldo/.test(f) && mtimeOf(path.join(RUNS, f)) < cut)
      add('respaldos', path.join(RUNS, f), mtimeOf(path.join(RUNS, f)));
  }
  const conv = path.join(RUNS, 'conversaciones');
  try {
    for (const f of fs.readdirSync(conv)) {
      const p = path.join(conv, f),
        t = mtimeOf(p);
      if (!robots.has(f.replace(/\.json$/, '')) && t < cut) add('conversaciones', p, t);
    }
  } catch {
    /* sin carpeta */
  }
  try {
    for (const f of fs.readdirSync(ATTACH_DIR)) {
      const p = path.join(ATTACH_DIR, f),
        t = mtimeOf(p);
      if (!robots.has(f) && t < cut) add('adjuntos', p, t);
    }
  } catch {
    /* sin adjuntos */
  }
  const known = new Set([...salas.map(s => s.id), ...salasArchive.map(s => s.id)]);
  try {
    for (const f of fs.readdirSync(SALAS_DIR)) {
      const p = path.join(SALAS_DIR, f),
        t = mtimeOf(p);
      if (!known.has(f) && fs.statSync(p).isDirectory() && t < cut) add('salas sueltas', p, t);
    }
  } catch {
    /* sin salas */
  }
  return out.sort((a, b) => b.size - a.size);
}
// Antes de mover un archivo de eventos se guardan sus SessionStart en sesiones.jsonl (el uso por semana sale de ahí).
function keepSessions(file) {
  const lines = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) if (line.includes('"SessionStart"')) lines.push(line);
  if (lines.length) fs.appendFileSync(SESSIONS_FILE, lines.join('\n') + '\n');
}
function runClean(days) {
  let moved = 0,
    bytes = 0;
  const errors = [];
  for (const c of cleanCandidates(days)) {
    try {
      if (c.kind === 'eventos') keepSessions(c.path);
      toTrash(c.path, `oficina-${path.basename(c.path).replace(/\.jsonl?$/, '')}`);
      moved++;
      bytes += c.size;
    } catch (e) {
      errors.push(`${c.rel}: ${e.message}`);
    }
  }
  saveConfig({ clean: { ...(readConfig().clean || {}), last: now(), lastMoved: moved, lastBytes: bytes } });
  return { moved, bytes, errors };
}
// Limpieza automática (si la activas): una vez por semana, con los días que elegiste.
setInterval(() => {
  const c = readConfig().clean;
  if (!c?.auto || !WORKSPACE) return;
  if (c.last && Date.now() - Date.parse(c.last) < 7 * DAY) return;
  try {
    runClean(c.days || 7);
  } catch {
    /* se reintenta en la siguiente vuelta */
  }
}, Number(process.env.OFFICE_CLEAN_TICK_MS) || 3600e3);

/* ---------- 3 · salud ---------- */
// The notebook's health line. An out-of-sync INDICE.md is regenerated here (it is derived, nothing is lost); broken notes
// and old proposals are only reported: they are Fabian's to fix, approve or discard.
function notebookCheck() {
  let h;
  try {
    h = healthReport();
    if (h.indexStale) {
      writeIndex();
      h.indexRegenerated = true;
    }
  } catch (e) {
    return {
      label: 'Cuaderno',
      ok: false,
      detail: `No pude revisar el cuaderno: ${e.message}`,
      fix: 'Revisa la carpeta memoria/ de los datos de la oficina.'
    };
  }
  const problems = [];
  if (h.unparseable.length) problems.push(`${h.unparseable.length} sin formato legible (${h.unparseable.join(', ')})`);
  if (h.incomplete.length)
    problems.push(`${h.incomplete.length} con campos faltantes (${h.incomplete.map(i => `${i.id}: ${i.missing.join('/')}`).join('; ')})`);
  if (h.oldProposals.length)
    problems.push(
      `${h.oldProposals.length} propuesta${h.oldProposals.length === 1 ? '' : 's'} con más de ${PROPOSAL_DAYS} días sin decidir (${h.oldProposals.map(p => p.id).join(', ')})`
    );
  const base = `${h.notes} nota${h.notes === 1 ? '' : 's'}, ${h.proposals} propuesta${h.proposals === 1 ? '' : 's'}${h.indexRegenerated ? ' · regeneré INDICE.md' : ''}`;
  return {
    label: 'Cuaderno',
    ok: !problems.length,
    detail: problems.length ? `${base} · ${problems.join(' · ')}` : base,
    fix: problems.length ? 'Abre el Cuaderno: aprueba o descarta las propuestas viejas y corrige las notas con campos faltantes.' : ''
  };
}
async function healthView() {
  const checks = [];
  const ok = (label, good, detail, fix = '') => checks.push({ label, ok: !!good, detail, fix: good ? '' : fix });
  let windows = null;
  try {
    windows = (await run('tmux', ['list-windows', '-t', SESSION, '-F', '#{window_name}'])).stdout.split('\n').filter(Boolean);
  } catch {
    /* sin sesión */
  }
  ok(
    'Sesión de tmux',
    windows,
    windows ? `${SESSION}: ${windows.length} ventana${windows.length === 1 ? '' : 's'}` : `No existe la sesión ${SESSION}`,
    'Reinicia la oficina (bin/office restart <nombre>): la sesión se crea al lanzar el primer robot.'
  );
  let claudeOk = false;
  try {
    await run('sh', ['-c', 'command -v "$0"', CLAUDE_BIN], { timeout: 3000 });
    claudeOk = true;
  } catch {
    /* no está */
  } // solo si existe: no lo ejecuta
  ok(
    'Claude Code instalado',
    claudeOk,
    claudeOk ? `«${CLAUDE_BIN}» está instalado` : `No encuentro «${CLAUDE_BIN}»`,
    'Instala Claude Code o define OFFICE_CLAUDE_BIN con su ruta.'
  );
  ok(
    'Hooks de la oficina',
    fs.existsSync(SETTINGS),
    fs.existsSync(SETTINGS) ? 'office-settings.json listo' : 'Falta office-settings.json',
    'Reinicia la oficina: lo vuelve a escribir al arrancar.'
  );
  ok(
    'Carpeta de trabajo',
    WORKSPACE && fs.existsSync(WORKSPACE),
    WORKSPACE || 'Sin elegir',
    'Elige la carpeta de trabajo desde la página.'
  );
  const lost = [...robots.values()].filter(r => r.consoleLost || (windows && !windows.includes(r.name)));
  ok(
    'Consolas de los robots',
    !lost.length,
    lost.length
      ? `Sin consola: ${lost.map(r => r.name).join(', ')}`
      : `${robots.size} robot${robots.size === 1 ? '' : 's'}, todos con su consola`,
    'Abre cada robot y usa «Reanudar» (retoma su misma sesión) o dalo de baja.'
  );
  const q = headQuota(),
    qAt = Number(q.weekPctAt) || 0;
  ok(
    'Lectura de la cuota',
    qAt && Date.now() - qAt < 3 * 3600e3,
    qAt ? `Última lectura de /usage: ${new Date(qAt).toLocaleString('es')}` : 'Todavía no se leyó /usage',
    'Abre «Uso Claude» y pulsa «Actualizar» (abre /usage en una consola aparte; no gasta tokens).'
  );
  const total = sizeOf(RUNS),
    cand = cleanCandidates((readConfig().clean || {}).days || 7),
    freeable = cand.reduce((n, c) => n + c.size, 0);
  ok(
    'Espacio de la oficina',
    total < 500e6,
    `${fmtBytes(total)} en su carpeta de datos${freeable ? ` · ${fmtBytes(freeable)} se pueden limpiar` : ''}`,
    'Usa «Limpiar» aquí abajo.'
  );
  checks.push(notebookCheck());
  const robotsView = [...robots.values()].map(r => ({
    name: r.name,
    state: r.state,
    lastEventAt: r.lastEventAt || null,
    console: !r.consoleLost && (!windows || windows.includes(r.name))
  }));
  return {
    checks,
    robots: robotsView,
    daemon: { pid: process.pid, port: PORT, node: process.version, upMs: Date.now() - STARTED, data: RUNS },
    total,
    freeable,
    clean: { ...(readConfig().clean || {}), days: (readConfig().clean || {}).days || 7, options: CLEAN_DAYS },
    candidates: cand.map(({ path: _p, ...c }) => c)
  };
}
const fmtBytes = n =>
  n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n >= 1e3 ? `${Math.round(n / 1e3)} KB` : `${n} B`;

/* ---------- 7 · respaldo ---------- */
// Rutinas, encargos frecuentes, mensajes «para enviar», el nombre, estilo y tope de la oficina, y la apariencia de los
// robots que están ahora. Al importar se SUMA a lo que hay (no borra nada) y las rutinas llegan en pausa.
function backup() {
  const c = readConfig();
  return {
    app: 'agent-office',
    version: 1,
    at: now(),
    office: { name: officeName || '', mapTheme: c.mapTheme || 'moderna', maxRobots: configView().maxRobots },
    routines: routines.map(({ running, lastRun, runs, seen, baselined, history, ...rt }) => rt),
    favorites,
    pins,
    cuaderno: exportAll(),
    looks: Object.fromEntries(
      [...robots.values()].filter(r => r.look || Number.isInteger(r.color)).map(r => [r.name, { look: r.look || null, color: r.color }])
    )
  };
}
function restoreBackup(data, parts) {
  if (data?.app !== 'agent-office' || data.version !== 1) throw new Error('Ese archivo no es un respaldo de la oficina.');
  const want = new Set(Array.isArray(parts) && parts.length ? parts : ['routines', 'favorites', 'pins', 'office', 'looks', 'cuaderno']);
  const out = { routines: 0, favorites: 0, pins: 0, office: false, looks: 0, cuaderno: 0 };
  if (want.has('cuaderno') && data.cuaderno && typeof data.cuaderno === 'object') out.cuaderno = importAll(data.cuaderno);
  if (want.has('routines') && Array.isArray(data.routines)) {
    for (const rt of data.routines) {
      if (!rt || typeof rt !== 'object' || !rt.type) continue;
      const same = routines.find(x => x.id === rt.id);
      if (
        same &&
        JSON.stringify({ ...same, running: 0, lastRun: 0, runs: 0, seen: 0, baselined: 0, history: 0, paused: 0 }) ===
          JSON.stringify({ ...same, ...rt, running: 0, lastRun: 0, runs: 0, seen: 0, baselined: 0, history: 0, paused: 0 })
      )
        continue; // ya está
      routines.push({
        ...rt,
        id: same ? crypto.randomBytes(4).toString('hex') : rt.id,
        paused: true,
        lastRun: null,
        running: false,
        runs: 0,
        seen: {},
        baselined: false,
        history: []
      });
      out.routines++;
    }
    if (out.routines) {
      saveRoutines();
      emitRoutines();
    }
  }
  if (want.has('favorites') && Array.isArray(data.favorites)) {
    for (const f of data.favorites)
      if (f?.id && !favorites.some(x => x.id === f.id)) {
        favorites.push(f);
        out.favorites++;
      }
    if (out.favorites) saveFavorites();
  }
  if (want.has('pins') && Array.isArray(data.pins)) {
    for (const p of data.pins)
      if (p?.id && !pins.some(x => x.id === p.id)) {
        pins.push(p);
        out.pins++;
      }
    if (out.pins) savePins();
  }
  if (want.has('office') && data.office) {
    const o = data.office;
    if (typeof o.name === 'string') {
      setOfficeName(o.name.replace(/\s+/g, ' ').trim().slice(0, OFFICE_NAME_MAX));
      saveConfig({ name: officeName });
    }
    if (MAP_THEMES.includes(o.mapTheme)) saveConfig({ mapTheme: o.mapTheme });
    if (Number.isInteger(o.maxRobots) && o.maxRobots >= 1 && o.maxRobots <= MAX_ROBOTS_LIMIT) {
      setMaxRobots(o.maxRobots);
      saveState();
    }
    out.office = true;
    broadcast({ type: 'config', config: configView() });
  }
  if (want.has('looks') && data.looks && typeof data.looks === 'object') {
    for (const [name, v] of Object.entries(data.looks)) {
      const r = robots.get(name);
      if (!r || !v) continue;
      if (v.look && typeof v.look === 'object') r.look = v.look;
      if (Number.isInteger(v.color)) r.color = v.color;
      emit(r);
      out.looks++;
    }
    if (out.looks) saveState();
  }
  return out;
}

async function mantenimientoApi(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/salud') return send(res, 200, await healthView());
  if (req.method === 'POST' && url.pathname === '/api/limpieza') {
    const b = await readBody(req);
    const days = CLEAN_DAYS.includes(Number(b.days)) ? Number(b.days) : (readConfig().clean || {}).days || 7;
    if (b.auto !== undefined || b.days !== undefined)
      saveConfig({ clean: { ...(readConfig().clean || {}), days, ...(b.auto !== undefined ? { auto: !!b.auto } : {}) } });
    if (!b.run) return send(res, 200, { ok: true, clean: readConfig().clean });
    return send(res, 200, { ok: true, ...runClean(days) });
  }
  if (req.method === 'GET' && url.pathname === '/api/respaldo') {
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="oficina-${(officeName || 'respaldo').replace(/[^\w-]+/g, '-')}-${now().slice(0, 10)}.json"`
    });
    return res.end(JSON.stringify(backup(), null, 2)) || true;
  }
  if (req.method === 'POST' && url.pathname === '/api/respaldo') {
    let b;
    try {
      b = JSON.parse((await readRaw(req, 8e6)).toString('utf8'));
    } catch {
      return send(res, 400, { error: 'No pude leer el respaldo (¿es el archivo .json que exportó la oficina?).' });
    }
    try {
      return send(res, 200, { ok: true, ...restoreBackup(b.data, b.parts) });
    } catch (e) {
      return send(res, 400, { error: e.message });
    }
  }
  return false;
}

export { cleanCandidates, fmtBytes, healthView, mantenimientoApi, runClean, SESSIONS_FILE };
