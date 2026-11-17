// Oficina de Agentes · estado de los robots y lo que se le envía a la página.
// Parte de daemon/daemon.mjs, que carga los módulos de daemon/lib/ en orden y arranca la oficina.
import fs from 'node:fs';
import path from 'node:path';
import { APPROVAL, clients, inbox, MAX_ROBOTS_LIMIT, maxRobots, now, robots, RUNS, SESSION, WORKSPACE } from './base.mjs';
import { crownOf, quotaPeriods } from './uso.mjs';
import { officeName, readConfig } from './carpeta.mjs';
import { saveState } from './persistencia.mjs';
import { kidsOf } from './equipo.mjs';
import { archive, criticalOf, requestOf } from './turno.mjs';
import { convDir } from './exportar.mjs';
import { contextPath, salas, salasArchive, threadPath } from './salas.mjs';

/* ---------- estado ---------- */

function usage(r) {
  const s = { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 };
  for (const u of r.msgUsage.values()) {
    s.in += u.input_tokens || 0;
    s.out += u.output_tokens || 0;
    s.cacheRead += u.cache_read_input_tokens || 0;
    s.cacheWrite += u.cache_creation_input_tokens || 0;
  }
  return s;
}

// Qué tan lleno tiene el contexto: tokens del último mensaje (entrada + caché) sobre su ventana (200k, o 1M si ya la pasó).
const fmtK = n => n >= 1000 ? `${Math.round(n / 100) / 10} k` : String(n);
// Tamaño de la ventana de contexto según el modelo: los Claude 5 (Opus/Sonnet) y los «[1m]» trabajan con 1 M de
// tokens; Haiku y los modelos anteriores, con 200 k. Si no se sabe el modelo, se infiere por el tamaño (como antes).
function ctxWindow(model, t) {
  const m = String(model || '').toLowerCase();
  if (/\[1m\]|-1m\b/.test(m)) return 1000000;
  if (/haiku/.test(m)) return 200000;
  if (/claude-(opus|sonnet|fable)-[5-9]/.test(m)) return 1000000;
  if (m) return 200000;
  return t > 200000 ? 1000000 : 200000;
}
function ctxOf(r) {
  let last = null;
  for (const u of r.msgUsage.values()) last = u;
  if (r.ctxPost != null) last = { input_tokens: r.ctxPost }; // recién compactado, sin respuesta nueva todavía
  if (!last) return null;
  const t = (last.input_tokens || 0) + (last.cache_read_input_tokens || 0) + (last.cache_creation_input_tokens || 0);
  const lim = ctxWindow(r.model, t);
  return { tokens: t, pct: Math.min(100, Math.round(t * 100 / lim)), window: lim };
}

function view(r, withLog = false) {
  const v = {
    name: r.name, kind: r.kind, skill: r.skill, label: r.label, color: r.color,
    state: r.state, place: r.place, subs: r.subs, pendingSubs: r.pendingSubs,
    bubble: r.bubble, activity: r.activity, tool: r.tool || '', needsPermission: r.needsPermission,
    hold: r.hold, ask: r.ask || null, ctx: ctxOf(r), request: requestOf(r), docs: r.docs, usage: usage(r), sessionId: r.sessionId, origin: r.origin, inputAt: r.inputAt, critical: criticalOf(r), title: r.title || '', look: r.look || null,
    parent: r.parent || null, reported: !!r.reported, spawnReq: r.spawnReq || null, kids: kidsOf(r.name), note: r.note || '', summaryPending: !!r.summaryPending, consoleLost: !!r.consoleLost,
    permissionMode: r.permissionMode, startedAt: r.startedAt, timeline: r.timeline || [], lastEventAt: r.lastEventAt || null,
    spend: r.spend || null, crown: crownOf(r.name)
  };
  if (withLog) v.log = r.log.slice(-150);
  return v;
}

function broadcast(msg) {
  const data = `data: ${JSON.stringify(msg)}\n\n`;
  for (const res of clients) res.write(data);
}

function emit(r) { broadcast({ type: 'robot', robot: view(r) }); saveState(); }

// Solo se pueden ver/mostrar archivos que la oficina registro como documento (bandeja o robots).
const TEXT_DOC = /\.(md|markdown|html?|txt|csv|json|ya?ml|svg|drawio|mmd)$/i;
function knownDoc(p) {
  if (!p) return null;
  const abs = path.resolve(WORKSPACE, String(p));
  const known = inbox.some(i => i.path === abs) || [...robots.values()].some(r => r.docs.some(d => d.path === abs))
    || salas.some(s => contextPath(s) === abs || threadPath(s) === abs) || salasArchive.some(s => s.context === abs || s.threadFile === abs) || archive.some(a => a.docs.includes(abs) || a.summaryPath === abs)
    || (abs.startsWith(convDir() + path.sep) && abs.endsWith('.md')); // conversaciones exportadas
  return known ? abs : null;
}

const MAP_THEMES = ['moderna', 'garaje', 'nave', 'biblioteca', 'cafeteria'];
// Contadores de la oficina para la decoración que crece: trabajos terminados (total y hoy) y reviews.
const STATS_FILE = path.join(RUNS, 'estadisticas.json');
let stats = { total: 0, reviews: 0, day: '', today: 0 };
try { stats = { ...stats, ...JSON.parse(fs.readFileSync(STATS_FILE, 'utf8')) }; } catch { /* oficina nueva */ }
const localDay = () => new Date().toLocaleDateString('sv'); // AAAA-MM-DD en hora local
// Las plantas crecen con las tareas de la semana de la cuota (no con el total histórico, que las dejaba siempre al
// máximo). Al renovarse la cuota la cuenta vuelve a 0, se anota repotAt y la página cambia las materas con una animación.
// La primera vez (sin semana guardada) arranca con las de hoy, que seguro son de esta semana.
function rollWeek() {
  const from = quotaPeriods().weekFrom;
  if (stats.week && stats.week.from === from) return false;
  const first = !stats.week;
  stats.week = { from, count: first ? (stats.day === localDay() ? stats.today : 0) : 0, n: first ? 0 : (stats.week.n || 0) + 1 };
  if (!first) stats.repotAt = now();
  try { fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2)); } catch { /* sin disco: solo no se guarda */ }
  return !first;
}
function statsView() {
  rollWeek();
  return { total: stats.total, reviews: stats.reviews, today: stats.day === localDay() ? stats.today : 0, week: stats.week.count, pot: stats.week.n, repotAt: stats.repotAt || null, weekTo: quotaPeriods().weekTo };
}
setInterval(() => { if (rollWeek()) broadcast({ type: 'config', config: configView() }); }, 60e3);
function bumpStats(r) {
  const d = localDay();
  if (stats.day !== d) { stats.day = d; stats.today = 0; }
  rollWeek();
  stats.total++; stats.today++; stats.week.count++;
  if (/review|audit|security/i.test(String(r.skill || ''))) stats.reviews++;
  try { fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2)); } catch { /* sin disco: solo no se guarda */ }
  broadcast({ type: 'config', config: configView() });
}
function configView() { return { maxRobots, maxRobotsLimit: MAX_ROBOTS_LIMIT, approval: APPROVAL, name: officeName, session: SESSION, stats: statsView(), mapTheme: MAP_THEMES.includes(readConfig().mapTheme) ? readConfig().mapTheme : 'moderna' }; }

export { broadcast, bumpStats, configView, emit, fmtK, knownDoc, MAP_THEMES, TEXT_DOC, usage, view };
