// Oficina de Agentes · estado de los robots y lo que se le envía a la página.
// Parte de daemon/daemon.mjs, que carga los módulos de daemon/lib/ en orden y arranca la oficina.
import fs from 'node:fs';
import path from 'node:path';
import { APPROVAL, clients, inbox, MAX_ROBOTS_LIMIT, maxRobots, now, robots, RUNS, saveJson, SESSION, WORKSPACE } from './base.mjs';
import { crownOf, quotaPeriods } from './uso.mjs';
import { officeName, readConfig } from './carpeta.mjs';
import { saveState } from './persistencia.mjs';
import { kidsOf } from './equipo.mjs';
import { archive, criticalOf, requestOf } from './turno.mjs';
import { convDir } from './exportar.mjs';
import { contextPath, salaExportDir, salas, salasArchive, threadPath } from './salas.mjs';
import { bgList } from './hooks.mjs';

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
// «Frío»: sin actividad más de lo que dura la caché de su conversación. Escribirle le hace releerla (y pagarla) entera
// de nuevo, así que lo que la oficina pueda resolver sola (p. ej. el resumen para despedirlo) no se le pide.
const COLD_MS = Number(process.env.OFFICE_COLD_MS) || 55 * 60e3;
const isCold = r => Date.now() - (Date.parse(r.lastEventAt || r.startedAt || '') || Date.now()) > COLD_MS;

// La línea de tiempo completa (hasta TIMELINE_MAX entradas) vive solo en el daemon y en office-state.json. La página solo
// lee la última entrada (fecha de la última actividad cuando falta lastEventAt), así que cada evento manda solo esa.
function view(r, withLog = false) {
  const v = {
    name: r.name, kind: r.kind, skill: r.skill, label: r.label, color: r.color,
    state: r.state, place: r.place, subs: r.subs, pendingSubs: r.pendingSubs,
    bubble: r.bubble, activity: r.activity, tool: r.tool || '', needsPermission: r.needsPermission,
    hold: r.hold, ask: r.ask || null, ctx: ctxOf(r), request: requestOf(r), docs: r.docs, usage: usage(r), sessionId: r.sessionId, origin: r.origin, inputAt: r.inputAt, critical: criticalOf(r), title: r.title || '', look: r.look || null,
    parent: r.parent || null, reported: !!r.reported, spawnReq: r.spawnReq || null, kids: kidsOf(r.name), note: r.note || '', summaryPending: !!r.summaryPending, relevo: r.relevo && ['done', 'input'].includes(r.state) ? r.relevo : null, relevoPending: !!r.relevoPending, consoleLost: !!r.consoleLost,
    bg: bgList(r), permissionMode: r.permissionMode, startedAt: r.startedAt, timeline: (r.timeline || []).slice(-1), lastEventAt: r.lastEventAt || null, repo: r.repo || null, files: (r.files || []).length,
    spend: r.spend || null, crown: crownOf(r.name), loop: r.loop || null
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
    || (abs.startsWith(convDir() + path.sep) && abs.endsWith('.md')) // conversaciones exportadas
    || (abs.startsWith(salaExportDir() + path.sep) && abs.endsWith('.md')); // salas exportadas
  return known ? abs : null;
}

const MAP_THEMES = ['moderna', 'garaje', 'nave', 'biblioteca', 'cafeteria', 'bosque'];
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
  try { saveJson(STATS_FILE, stats, { pretty: true }); } catch { /* sin disco: solo no se guarda */ }
  return !first;
}
// Tareas por día (para la pizarra de la semana de la sala de descanso): se guardan los últimos 21 días. La primera vez
// arranca con las de hoy.
function dayCounts() {
  if (!stats.days) stats.days = stats.day ? { [stats.day]: stats.today || 0 } : {};
  return stats.days;
}
function statsView() {
  rollWeek();
  const per = quotaPeriods(), days = dayCounts();
  // Los 7 días de la semana de la cuota, desde el día en que se renovó.
  const week = Array.from({ length: 7 }, (_, i) => { const day = new Date(per.weekFrom + i * 86400e3).toLocaleDateString('sv'); return { day, n: days[day] || 0 }; });
  // % usado de la cuota semanal (de /usage) para la cafetera; si se midió antes de la última renovación, ya volvió a 0.
  const q = readConfig().quota || {}, measured = Number(q.weekPctAt) || 0;
  const quotaPct = Number.isFinite(q.weekPct) && measured ? (measured < per.weekFrom ? 0 : q.weekPct) : null;
  return { total: stats.total, reviews: stats.reviews, today: stats.day === localDay() ? stats.today : 0, week: stats.week.count, pot: stats.week.n, repotAt: stats.repotAt || null, weekTo: per.weekTo, days: week, quotaPct, quotaAt: measured || null,
    quotaHistory: Object.entries(q.history || {}).sort().map(([end, pct]) => ({ end, pct })), waits: waitsView(), hours: hoursView() };
}
setInterval(() => { if (rollWeek()) broadcast({ type: 'config', config: configView() }); }, 60e3);
function bumpStats(r) {
  const d = localDay();
  if (stats.day !== d) { stats.day = d; stats.today = 0; }
  rollWeek();
  stats.total++; stats.today++; stats.week.count++;
  const days = dayCounts();
  days[d] = (days[d] || 0) + 1;
  for (const k of Object.keys(days).sort().slice(0, -21)) delete days[k]; // solo los últimos 21 días
  if (/review|audit|security/i.test(String(r.skill || ''))) stats.reviews++;
  try { saveJson(STATS_FILE, stats, { pretty: true }); } catch { /* sin disco: solo no se guarda */ }
  broadcast({ type: 'config', config: configView() });
}
// 3 · Tiempo esperándote: cuánto pasaron los robots esperando un permiso, una pregunta o tu respuesta, por día (7 días).
// Por día: total, por robot, por tipo y los permisos que más hicieron esperar (para decidir si darlos fijos).
const WAIT_MIN_MS = 3000; // menos que eso es un permiso que se resolvió solo
function addWait(name, startIso, kind, perm) {
  const ms = Date.now() - (Date.parse(startIso || '') || Date.now());
  if (!(ms >= WAIT_MIN_MS)) return;
  const d = localDay(), all = (stats.waits ||= {});
  const w = (all[d] ||= { total: 0, by: {}, kinds: {}, perms: {} });
  w.total += ms;
  w.by[name] = (w.by[name] || 0) + ms;
  w.kinds[kind] = (w.kinds[kind] || 0) + ms;
  if (perm) { const p = (w.perms[perm] ||= { n: 0, ms: 0 }); p.n++; p.ms += ms; }
  const keys = Object.keys(w.perms);
  if (keys.length > 20) for (const k of keys.sort((a, b) => w.perms[a].ms - w.perms[b].ms).slice(0, keys.length - 20)) delete w.perms[k];
  for (const k of Object.keys(all).sort().slice(0, -7)) delete all[k]; // solo los últimos 7 días
  try { saveJson(STATS_FILE, stats, { pretty: true }); } catch { /* sin disco: solo no se guarda */ }
  broadcast({ type: 'config', config: configView() });
}
// 6 · Horas de trabajo: minutos-robot trabajando y esperándote por hora del día (últimos 14 días). Se puede apagar
// desde «Uso Claude» (config.hoursOn = false): deja de registrar y la sección se esconde.
const HOURS_DAYS = 14;
const hoursOn = () => readConfig().hoursOn !== false;
let hoursDirty = 0;
setInterval(() => {
  if (!hoursOn() || !robots.size) return;
  const t = new Date(), d = localDay(), h = t.getHours(), all = (stats.hours ||= {});
  const day = (all[d] ||= { w: Array(24).fill(0), i: Array(24).fill(0) });
  for (const r of robots.values()) {
    if (['working', 'delegating', 'walking'].includes(r.state)) day.w[h]++;
    else if (r.state === 'input') day.i[h]++;
  }
  for (const k of Object.keys(all).sort().slice(0, -HOURS_DAYS)) delete all[k];
  if (++hoursDirty >= 10) { hoursDirty = 0; try { saveJson(STATS_FILE, stats, { pretty: true }); } catch { /* sin disco */ } broadcast({ type: 'config', config: configView() }); }
}, Number(process.env.OFFICE_HOURS_TICK_MS) || 60e3);
function hoursView() {
  const all = stats.hours || {}, days = Object.keys(all).sort().slice(-HOURS_DAYS);
  const w = Array(24).fill(0), i = Array(24).fill(0);
  for (const k of days) for (let h = 0; h < 24; h++) { w[h] += all[k].w[h] || 0; i[h] += all[k].i[h] || 0; }
  return { on: hoursOn(), days: days.length, w, i };
}
function waitsView() {
  const all = stats.waits || {};
  return Array.from({ length: 7 }, (_, i) => { const day = new Date(Date.now() - (6 - i) * 86400e3).toLocaleDateString('sv'); const w = all[day]; return { day, total: w?.total || 0, by: w?.by || {}, kinds: w?.kinds || {}, perms: w?.perms || {} }; });
}
// Fecha en que se creó la oficina (bin/office la deja en office.json): para el aniversario del mapa.
let createdAt; try { createdAt = JSON.parse(fs.readFileSync(path.join(RUNS, 'office.json'), 'utf8')).createdAt || null; } catch { createdAt = null; }
function configView() { return { createdAt, maxRobots, maxRobotsLimit: MAX_ROBOTS_LIMIT, approval: APPROVAL, name: officeName, session: SESSION, stats: statsView(), mapTheme: MAP_THEMES.includes(readConfig().mapTheme) ? readConfig().mapTheme : 'moderna' }; }

export { addWait, broadcast, bumpStats, configView, ctxOf, emit, fmtK, isCold, knownDoc, MAP_THEMES, TEXT_DOC, usage, view };
