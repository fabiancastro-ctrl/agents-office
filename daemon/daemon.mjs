#!/usr/bin/env node
// Daemon de la Oficina de Agentes (MVP local).
// - Lanza robots como ventanas tmux corriendo `claude` con la suscripcion del usuario.
// - Recibe los hooks de Claude Code y mantiene el estado de cada robot.
// - Sigue el transcript JSONL de cada robot (texto que dice, tokens, interrupciones).
// - Sirve la oficina (web/) y le empuja los cambios por Server-Sent Events.
// Sin dependencias: solo modulos de Node.

import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const WEB = path.join(ROOT, 'web');
// Carpeta donde trabajan los robots (y de donde salen las skills del proyecto). Se elige en la primera
// ejecución desde la página y se guarda en runs/config.json; OFFICE_WORKSPACE manda si está definida.
let WORKSPACE = null;
const PORT = Number(process.env.OFFICE_PORT || 4777);
// Sesión de tmux donde viven los robots. Cada oficina del mismo equipo necesita la suya (y su puerto),
// o se pisarían las ventanas de los robots y la consola de /usage.
const SESSION = process.env.OFFICE_SESSION || 'office';
if (!/^[A-Za-z0-9_-]{1,40}$/.test(SESSION)) {
  console.error(`OFFICE_SESSION inválido: «${SESSION}». Usa solo letras, números, guion o guion bajo (sin puntos ni dos puntos).`);
  process.exit(1);
}
// Carpeta de datos de ESTA oficina (estado, bandeja, rutinas, salas, eventos, adjuntos). El código es uno solo
// y cada oficina del edificio trae la suya: `office start <nombre>` la pasa en OFFICE_DATA. Sin ella, runs/ junto al código.
const RUNS = path.resolve(process.env.OFFICE_DATA || path.join(ROOT, 'runs'));
const LEGACY_RUNS = RUNS === path.join(ROOT, 'runs');
// Hooks de los robots: se generan en la carpeta de datos con la ruta real de hooks/office-hook.sh,
// así el código se puede mover o clonar sin editar rutas a mano.
const SETTINGS = path.join(RUNS, 'office-settings.json');
// Tope de robots trabajando a la vez: todos gastan de la misma cuota de la suscripcion.
// Se ajusta desde la oficina (− / +) y se guarda en office-state.json.
let maxRobots = Number(process.env.OFFICE_MAX_ROBOTS || 3);
const MAX_ROBOTS_LIMIT = 20;
const APPROVAL = process.env.OFFICE_APPROVAL === '1';
const HOLD_TOOLS = new Set(['Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
// Nunca se responde "allow" a estos comandos aunque se aprueben. Los deny de settings
// igual ganan sobre el allow del hook (verificado en el paso 1); esta lista es una segunda barrera.
const NEVER_ALLOW = [/\brm\s+-[a-z]*r/i, /\bmv\s/, /\bgit\s+push\b/, /--force\b/, /--no-verify\b/, /\bgit\s+commit\b.*--amend\b/];
const APPROVAL_TIMEOUT_MS = 9 * 60 * 1000;
// Las preguntas (AskUserQuestion) tienen su propio hook de 8 h: puedes contestarlas cuando vuelvas, no en 9 minutos.
const ASK_HOOK_S = 8 * 60 * 60, ASK_TIMEOUT_MS = (ASK_HOOK_S - 120) * 1000;
const PERMISSION_MODES = new Set(['default', 'acceptEdits', 'plan', 'auto']);
const NAMES = ['rex', 'nova', 'bolt', 'atlas', 'pixel', 'kiro', 'lumo', 'zeta', 'orbi', 'juno', 'milo', 'vega', 'ciro', 'indi', 'brio'];
const ROUTINE_TICK_MS = Number(process.env.OFFICE_ROUTINE_TICK_MS) || 15000;
// El programa que abre cada robot. Las pruebas (test/) usan un Claude falso que no llama a nada ni gasta cuota.
const CLAUDE_BIN = process.env.OFFICE_CLAUDE_BIN || 'claude';
const TIMELINE_MAX = 600;
const ATTACH_DIR = path.join(RUNS, 'adjuntos');
const ATTACH_MAX_BYTES = 20 * 1024 * 1024;
const ATTACH_TTL_MS = 7 * 24 * 60 * 60 * 1000;

fs.mkdirSync(RUNS, { recursive: true });
{
  const hook = { type: 'command', command: path.join(ROOT, 'hooks', 'office-hook.sh') };
  const ev = (timeout, matcher) => [{ ...(matcher ? { matcher } : {}), hooks: [{ ...hook, timeout }] }];
  // PreToolUse: el hook general (10 min, para los permisos retenidos) y uno solo para las preguntas, de 8 h.
  // Los dos le llegan al daemon con AskUserQuestion; el general se hace a un lado (ver onHook, via).
  const askHook = { type: 'command', command: `"${hook.command}" ask`, timeout: ASK_HOOK_S };
  const settings = { hooks: {
    SessionStart: ev(10), UserPromptSubmit: ev(10), PreToolUse: [...ev(600, '*'), { matcher: 'AskUserQuestion', hooks: [askHook] }], PostToolUse: ev(10, '*'),
    SubagentStop: ev(10), Notification: ev(10), Stop: ev(10)
  } };
  fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + '\n');
}
// Una copia de la carpeta = una oficina: dos daemons sobre el mismo runs/ se pisarían el estado y la bandeja.
const LOCK_FILE = path.join(RUNS, 'daemon.lock');
try {
  const lock = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
  let alive = false;
  try { process.kill(lock.pid, 0); alive = lock.pid !== process.pid; } catch { /* proceso muerto: candado viejo */ }
  if (alive) {
    console.error(`Esta oficina ya está corriendo (pid ${lock.pid}, puerto ${lock.port}, datos en ${RUNS}).`);
    console.error('Para otra oficina usa el edificio: bin/office create <nombre> --workspace <carpeta> y bin/office start <nombre>.');
    process.exit(1);
  }
} catch { /* sin candado */ }
fs.writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, port: PORT, session: SESSION }));
process.on('exit', () => {
  try { flushConvs(); } catch { /* el daemon se va igual */ }
  try { if (JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8')).pid === process.pid) fs.unlinkSync(LOCK_FILE); } catch { /* ya no está */ }
});
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => process.exit(0));
const CONFIG_FILE = path.join(RUNS, 'config.json');
const EVENTS_FILE = path.join(RUNS, `events-${new Date().toISOString().slice(0, 10)}.jsonl`);

const robots = new Map();
const pending = new Map();
const inbox = [];
const clients = new Set();
let colorSeq = 0;

const trunc = (s, n = 160) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};
const now = () => new Date().toISOString();

function console_(robot, kind, text = '') {
  const t = new Date().toTimeString().slice(0, 8);
  console.log(`${t} [${robot}] ${kind.padEnd(12)} ${text}`);
}

function describeTool(tool, input = {}) {
  if (tool === 'Bash') return `Bash: ${trunc(input.command, 140)}`;
  if (['Read', 'Write', 'Edit', 'MultiEdit'].includes(tool)) return `${tool}: ${input.file_path ?? ''}`;
  if (tool === 'Grep' || tool === 'Glob') return `${tool}: ${trunc(input.pattern, 100)}`;
  if (tool === 'Agent' || tool === 'Task') return `${tool}: ${input.subagent_type ?? ''} ${trunc(input.description, 80)}`;
  if (tool === 'Skill') return `Skill: ${input.skill ?? ''} ${trunc(input.args, 80)}`;
  return tool;
}

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
    parent: r.parent || null, spawnReq: r.spawnReq || null, kids: kidsOf(r.name), note: r.note || '', summaryPending: !!r.summaryPending, consoleLost: !!r.consoleLost,
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

/* ---------- uso de tokens de toda la oficina, por semana ---------- */
// Se calcula desde los transcripts de las sesiones que lanzó la oficina (el hook SessionStart queda en
// runs/events-*.jsonl), incluidos sus subagentes. Así sobrevive a reinicios del daemon y no cuenta dos veces.
const officeSessions = new Map(); // sessionId -> { transcript, robot }
function registerSession(e) {
  if (e.session_id && e.transcript_path && !officeSessions.has(e.session_id)) officeSessions.set(e.session_id, { transcript: e.transcript_path, robot: e.robot });
}
function loadSessions() {
  for (const f of fs.readdirSync(RUNS).filter(f => /^events.*\.jsonl$/.test(f))) {
    for (const line of fs.readFileSync(path.join(RUNS, f), 'utf8').split('\n')) {
      if (!line.includes('"SessionStart"')) continue;
      try { registerSession(JSON.parse(line)); } catch { /* linea cortada */ }
    }
  }
}

// Lunes (hora local) de la semana del instante dado, como AAAA-MM-DD.
function weekOf(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - (d.getDay() + 6) % 7);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const usageCache = new Map(); // archivo -> { size, msgs: Map(id -> { at, u }) }
function fileUsage(file) {
  let size;
  try { size = fs.statSync(file).size; } catch { return null; }
  const c = usageCache.get(file);
  if (c && c.size === size) return c.msgs;
  const msgs = new Map();
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.includes('"usage"')) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    const m = e.message;
    if (e.type !== 'assistant' || !m?.id || !m.usage) continue;
    // Un mensaje llega en varias lineas con el mismo id; la ultima trae el usage final.
    msgs.set(m.id, { at: msgs.get(m.id)?.at || e.timestamp, u: m.usage });
  }
  usageCache.set(file, { size, msgs });
  return msgs;
}

function officeUsage() {
  const weeks = new Map();
  for (const [sid, s] of officeSessions) {
    const files = [s.transcript];
    const subDir = path.join(s.transcript.replace(/\.jsonl$/, ''), 'subagents');
    try { files.push(...fs.readdirSync(subDir).filter(f => f.endsWith('.jsonl')).map(f => path.join(subDir, f))); } catch { /* sin subagentes */ }
    for (const f of files) {
      const msgs = fileUsage(f);
      if (!msgs) continue;
      for (const { at, u } of msgs.values()) {
        const k = weekOf(at);
        let w = weeks.get(k);
        if (!w) weeks.set(k, w = { week: k, in: 0, out: 0, cacheRead: 0, cacheWrite: 0, sessions: new Set() });
        w.in += u.input_tokens || 0;
        w.out += u.output_tokens || 0;
        w.cacheRead += u.cache_read_input_tokens || 0;
        w.cacheWrite += u.cache_creation_input_tokens || 0;
        w.sessions.add(sid);
      }
    }
  }
  return [...weeks.values()].sort((a, b) => b.week.localeCompare(a.week)).slice(0, 8).map(w => ({ ...w, sessions: w.sessions.size }));
}

/* ---------- gasto por robot ---------- */
// Cuánto lleva cada robot esta semana (con sus subagentes) y en la última hora, y qué parte es del gasto de la
// oficina esta semana. Es la parte de lo que gastó la OFICINA, no del límite de tu suscripción (Claude no lo
// expone por robot). «Gasto» = entrada + salida + caché escrita, como los KPI de la oficina. No gasta cuota: son
// cuentas sobre los transcripts. Avisa una vez cuando un robot se dispara: mucho en la última hora (en NR el 95 %
// de las horas de un robot quedan bajo 1,65 M) o más de la cuarta parte de la semana con la semana ya avanzada.
const SPEND_HOUR_HOT = Number(process.env.OFFICE_SPEND_HOUR_HOT || 1.5e6);
const SPEND_SHARE_HOT = 25, SPEND_SHARE_MIN_WEEK = Number(process.env.OFFICE_SPEND_MIN_WEEK || 5e6);
const SPEND_TICK_MS = Number(process.env.OFFICE_SPEND_TICK_MS || 60000);
const fmtM = n => n >= 1e6 ? `${(n / 1e6).toFixed(1).replace('.', ',')} M` : fmtK(n);
const spendTok = u => (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_creation_input_tokens || 0);
function sessionFiles(transcript) {
  if (!transcript) return [];
  const files = [transcript];
  const subDir = path.join(transcript.replace(/\.jsonl$/, ''), 'subagents');
  try { files.push(...fs.readdirSync(subDir).filter(f => f.endsWith('.jsonl')).map(f => path.join(subDir, f))); } catch { /* sin subagentes */ }
  return files;
}
function robotSpend(r, wk, hourAgo) {
  let week = 0, hour = 0;
  for (const f of sessionFiles(r.transcript)) {
    const msgs = fileUsage(f);
    if (!msgs) continue;
    for (const { at, u } of msgs.values()) {
      if (weekOf(at) !== wk) continue;
      const t = spendTok(u);
      week += t;
      if (Date.parse(at) >= hourAgo) hour += t;
    }
  }
  return { week, hour };
}
/* ---------- empleado de la semana ---------- */
// El que más tokens gastó en la semana de tu cuota (entrada + salida + caché escrita, con sus subagentes; esté o no
// en la oficina) sale en el cuadro «Empleado de la semana». Se reinicia cuando se renueva tu cuota semanal (la hora
// que muestra /usage, guardada en la configuración; si no se conoce, el lunes 00:00). Si está en la oficina lleva el
// accesorio secreto: corona con un fuego, o con dos si además es el que más gastó en la sesión actual de 5 h de tu
// cuota. Se suma por nombre: retomar conserva el nombre.
const WEEK_MS = 7 * 86400e3, SESSION_MS = 5 * 3600e3;
function quotaPeriods(t = Date.now()) {
  const q = readConfig().quota || {};
  let weekEnd = Number(q.weekEnd) || 0;
  if (weekEnd) while (weekEnd <= t) weekEnd += WEEK_MS; // ya se renovó: la siguiente, 7 días después
  const monday = new Date(weekOf(t) + 'T00:00:00').getTime();
  const sessionEnd = Number(q.sessionEnd) || 0;
  return {
    weekFrom: weekEnd ? weekEnd - WEEK_MS : monday, weekTo: weekEnd || monday + WEEK_MS, weekKnown: !!weekEnd,
    sessionFrom: sessionEnd > t ? sessionEnd - SESSION_MS : t - SESSION_MS, sessionTo: sessionEnd > t ? sessionEnd : null
  };
}
let fame = { employee: null, sessionTop: null, period: null };
function computeFame(per) {
  const byWeek = new Map(), bySession = new Map();
  for (const s of officeSessions.values()) {
    if (!s.robot) continue;
    for (const f of sessionFiles(s.transcript)) {
      const msgs = fileUsage(f);
      if (!msgs) continue;
      for (const { at, u } of msgs.values()) {
        const ms = Date.parse(at);
        if (ms < per.weekFrom) continue;
        const t = spendTok(u);
        byWeek.set(s.robot, (byWeek.get(s.robot) || 0) + t);
        if (ms >= per.sessionFrom) bySession.set(s.robot, (bySession.get(s.robot) || 0) + t);
      }
    }
  }
  const top = m => [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0] || null;
  const em = top(byWeek), st = top(bySession);
  let employee = null;
  if (em && em[1] > 0) { // su cara: la del robot si está; si no, la que tenía al irse (archivo); si no, la de su nombre
    const live = robots.get(em[0]), gone = live ? null : [...archive].reverse().find(a => a.name === em[0]);
    const src = live || gone;
    employee = { name: em[0], tokens: em[1], color: src?.color ?? 0, look: src?.look || lookFromName(em[0]), present: !!live, title: live?.title || gone?.title || '' };
  }
  return { employee, sessionTop: st && st[1] > 0 ? { name: st[0], tokens: st[1] } : null,
    period: { from: new Date(per.weekFrom).toISOString(), to: new Date(per.weekTo).toISOString(), known: per.weekKnown } };
}
const crownOf = name => fame.employee?.name === name ? (fame.sessionTop?.name === name ? 2 : 1) : 0;

function updateSpend() {
  const wk = weekOf(Date.now()), hourAgo = Date.now() - 3600e3;
  const prevFame = fame;
  fame = computeFame(quotaPeriods());
  if (JSON.stringify(prevFame) !== JSON.stringify(fame)) {
    for (const n of new Set([prevFame.employee?.name, fame.employee?.name])) { const r = n && robots.get(n); if (r) emit(r); } // su corona cambió
    broadcast({ type: 'fame', fame }); // después de los robots: el cuadro se dibuja con la corona ya puesta
    if (fame.employee && prevFame.employee && fame.employee.name !== prevFame.employee.name)
      broadcast({ type: 'notice', text: fame.period.from !== prevFame.period?.from
        ? `👑 Se renovó la cuota semanal: arranca una semana nueva y ${fame.employee.name} es el primer empleado de la semana.`
        : `👑 Nuevo empleado de la semana: ${fame.employee.name} (${fmtM(fame.employee.tokens)} tokens).` });
  }
  const cur = officeUsage().find(w => w.week === wk);
  const officeWeek = cur ? cur.in + cur.out + cur.cacheWrite : 0;
  for (const r of robots.values()) {
    const { week, hour } = robotSpend(r, wk, hourAgo);
    const pct = officeWeek ? Math.min(100, Math.round(week * 100 / officeWeek)) : 0;
    const hot = hour >= SPEND_HOUR_HOT ? 'hour' : (pct >= SPEND_SHARE_HOT && officeWeek >= SPEND_SHARE_MIN_WEEK) ? 'share' : null;
    const next = { week, hour, pct, officeWeek, hot };
    const prev = r.spend;
    r.spend = next;
    if (hot && !prev?.hot) {
      const why = hot === 'hour' ? `gastó ${fmtM(hour)} tokens en la última hora` : `lleva el ${pct} % del gasto de la oficina esta semana (${fmtM(week)} de ${fmtM(officeWeek)})`;
      log(r, 'sys', `🔥 Se disparó: ${why}`);
      broadcast({ type: 'notice', text: `🔥 ${r.name} se disparó: ${why}. Míralo por si está en un bucle.` });
    }
    if (!prev || prev.week !== week || prev.hour !== hour || prev.pct !== pct || prev.hot !== hot) emit(r);
  }
}
const spendTick = () => { try { updateSpend(); } catch (e) { console_('oficina', 'gasto', e.message); } };
setInterval(spendTick, SPEND_TICK_MS);
setTimeout(spendTick, Math.min(1500, SPEND_TICK_MS)); // al arrancar: cuadro del mes y coronas sin esperar el primer minuto

/* ---------- estado de la suscripción (/usage) ---------- */
// Una consola tmux aparte (_status, sin hooks de la oficina) donde se abre /usage y se lee la pantalla.
// Mirar /usage no envía mensajes al modelo, así que no gasta cuota.
const STATUS_WIN = `${SESSION}:_status`;
const wait = ms => new Promise(r => setTimeout(r, ms));
let statusCache = null, statusPending = null;

async function capturePane(target) { return (await run('tmux', ['capture-pane', '-p', '-t', target])).stdout; }

async function readClaudeStatus() {
  await ensureSession();
  let windows = [];
  try { windows = (await run('tmux', ['list-windows', '-t', SESSION, '-F', '#{window_name}'])).stdout.split('\n'); } catch { /* sin sesion */ }
  const fresh = !windows.includes('_status');
  if (fresh) {
    await run('tmux', ['new-window', '-d', '-t', `${SESSION}:`, '-n', '_status', '-c', WORKSPACE, 'env', '-u', 'ANTHROPIC_API_KEY', CLAUDE_BIN]);
    await run('tmux', ['resize-window', '-t', STATUS_WIN, '-x', '120', '-y', '80']).catch(() => {});
    await wait(6000);
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    await run('tmux', ['send-keys', '-t', STATUS_WIN, 'Escape']);
    await wait(300);
    await run('tmux', ['send-keys', '-t', STATUS_WIN, '-l', '/usage']);
    await wait(700);
    await run('tmux', ['send-keys', '-t', STATUS_WIN, 'Enter']);
    for (let i = 0; i < 20; i++) {
      await wait(500);
      const text = await capturePane(STATUS_WIN);
      if (/\d+% used/.test(text) && /Resets/.test(text)) {
        await wait(800); // deja terminar de pintar la lista
        const full = await capturePane(STATUS_WIN);
        await run('tmux', ['send-keys', '-t', STATUS_WIN, 'Escape']).catch(() => {});
        return parseClaudeStatus(full);
      }
    }
    await wait(3000); // la consola pudo no estar lista todavia
  }
  throw new Error(`No se pudo leer /usage. Abre la consola con: tmux attach -t ${STATUS_WIN}`);
}

// /usage sale en inglés: se traducen las frases conocidas; lo que no se reconoce se deja tal cual.
const MONTHS = { Jan: 'ene', Feb: 'feb', Mar: 'mar', Apr: 'abr', May: 'may', Jun: 'jun', Jul: 'jul', Aug: 'ago', Sep: 'sep', Oct: 'oct', Nov: 'nov', Dec: 'dic' };
const USAGE_ES = [
  [/^Current session$/, 'Sesión actual'],
  [/^Current week \(all models\)$/, 'Semana actual (todos los modelos)'],
  [/^Current week \((.+)\)$/, 'Semana actual ($1)'],
  [/^Resets (\w{3}) (\d+) at (.+)$/, (m, mon, d, rest) => `Se reinicia el ${d} ${MONTHS[mon] || mon} a las ${rest}`],
  [/^Resets (.+)$/, 'Se reinicia a las $1'],
  [/What's contributing to your usage\?/, '¿Qué está consumiendo tu uso?'],
  [/Approximate · sessions on this machine only/, 'Aproximado · solo sesiones de este equipo'],
  [/Last 24h · shares overlap/, 'Últimas 24 h · los porcentajes se solapan'],
  [/Give "(.+)" subagents a cheaper model/, 'Usar un modelo más barato para los subagentes de "$1"'],
  [/Start fresh when you switch tasks · run \/clear/, 'Empezar de cero al cambiar de tarea · usar /clear'],
  [/Run fewer sessions at once · up to (\d+) at once/, 'Correr menos sesiones a la vez · hasta $1 simultáneas'],
  [/Trim (.+) · (\S+) tokens per request/, 'Recortar $1 · $2 tokens por pedido'],
  [/^(\s*)Skills(\s+)% of usage/, '$1Skills$2% del uso'],
  [/^(\s*)Subagents(\s+)% of usage/, '$1Subagentes$2% del uso'],
  [/^(\s*)Loops(\s+)every(\s+)runs(\s+)tokens(\s+)per run last run/, '$1Bucles$2cada$3veces$4tokens$5por vez última'],
  [/\bdynamic\b/, 'dinámico'],
  [/\b(\d+)([mhd]) ago\b/, 'hace $1$2']
];
const toSpanish = line => USAGE_ES.reduce((l, [re, to]) => l.replace(re, to), line);

// «Resets Nov 18 at 6pm (America/Bogota)» o «Resets 2:20am (America/Bogota)» → instante (ms). Se toma en la hora
// local del equipo (la que muestra /usage es la tuya). Sin fecha: hoy o, si ya pasó la hora, mañana.
const MON_N = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
function resetAt(line, from = Date.now()) {
  const m = String(line || '').match(/^Resets (?:(\w{3}) (\d{1,2}) at )?(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i);
  if (!m) return null;
  const h = (Number(m[3]) % 12) + (m[5].toLowerCase() === 'pm' ? 12 : 0), d = new Date(from);
  if (m[1] && MON_N[m[1]] !== undefined) {
    const t = new Date(d.getFullYear(), MON_N[m[1]], Number(m[2]), h, Number(m[4] || 0));
    if (t.getTime() < from - 86400e3) t.setFullYear(t.getFullYear() + 1); // «Jan 2» visto en diciembre
    return t.getTime();
  }
  const t = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, Number(m[4] || 0));
  if (t.getTime() <= from) t.setDate(t.getDate() + 1);
  return t.getTime();
}
function parseClaudeStatus(text) {
  const lines = text.split('\n').map(l => l.trimEnd());
  const clean = lines.map(l => l.trim());
  const limits = [];
  const ends = {};
  clean.forEach((l, i) => {
    const m = l.match(/(\d+)% used/);
    if (!m) return;
    const raw = clean[i + 1] || '';
    limits.push({ title: toSpanish(clean[i - 1] || ''), pct: Number(m[1]), resets: /^Resets/.test(raw) ? toSpanish(raw) : '' });
    const at = /^Resets/.test(raw) ? resetAt(raw) : null;
    if (at && /^Current session$/.test(clean[i - 1] || '')) ends.sessionEnd = at;
    if (at && /^Current week \(all models\)$/.test(clean[i - 1] || '')) ends.weekEnd = at;
  });
  if (ends.sessionEnd || ends.weekEnd) saveConfig({ quota: { ...(readConfig().quota || {}), ...ends } });
  const start = clean.findIndex(l => /^What's contributing/.test(l));
  const detail = start < 0 ? '' : lines.slice(start).filter(l => l.trim() && !/^\s*(Esc to|f to fix)/.test(l)).map(toSpanish).join('\n');
  return { limits, detail, at: now() };
}

async function claudeStatus(refresh) {
  if (statusCache && !refresh && Date.now() - Date.parse(statusCache.at) < 60_000) return statusCache;
  statusPending ||= readClaudeStatus().then(s => (statusCache = s)).finally(() => { statusPending = null; });
  return statusPending;
}

/* ---------- carpeta de trabajo ---------- */
const expandHome = p => String(p || '').trim().replace(/^~(?=$|\/)/, os.homedir());

function initialWorkspace() {
  if (process.env.OFFICE_WORKSPACE) return path.resolve(expandHome(process.env.OFFICE_WORKSPACE));
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')).workspace || null; } catch { /* sin config */ }
  // Instalaciones de antes de esta opción: ya tenían estado y usaban la carpeta de dos niveles arriba.
  if (LEGACY_RUNS && fs.existsSync(path.join(RUNS, 'office-state.json'))) return saveWorkspace(path.resolve(ROOT, '../..'));
  return null;
}
function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return {}; }
}
function saveConfig(patch) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({ ...readConfig(), ...patch }, null, 2));
}
function saveWorkspace(ws) {
  saveConfig({ workspace: ws });
  return ws;
}
// Nombre de la oficina: solo estético, para distinguir varias oficinas (una por workspace) en el navegador.
const OFFICE_NAME_MAX = 40;
let officeName = String(readConfig().name || '').slice(0, OFFICE_NAME_MAX);

// Claude Code pide confirmar la confianza la primera vez que se abre en una carpeta (o en una superior);
// mientras no se acepte, un robot quedaría detenido en esa pregunta.
function trustAccepted(ws) {
  let projects = {};
  try { projects = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8')).projects || {}; } catch { return null; }
  for (let d = ws; ; d = path.dirname(d)) {
    if (projects[d]?.hasTrustDialogAccepted) return true;
    if (d === path.dirname(d)) return false;
  }
}

function workspaceInfo(raw) {
  const ws = path.resolve(expandHome(raw));
  const st = fs.statSync(ws, { throwIfNoEntry: false });
  const info = { path: ws, exists: !!st, isDir: !!st?.isDirectory() };
  if (!info.isDir) return info;
  info.claudeMd = fs.existsSync(path.join(ws, 'CLAUDE.md'));
  info.projectSkills = listSkills(ws).length - listSkills(os.tmpdir()).length; // sin contar las de ~/.claude
  info.trusted = trustAccepted(ws);
  info.insideOffice = ws === ROOT || ws.startsWith(ROOT + path.sep);
  return info;
}

function setupView() {
  return { workspace: WORKSPACE, fromEnv: !!process.env.OFFICE_WORKSPACE, suggestion: path.resolve(ROOT, '../..') };
}

/* ---------- persistencia ---------- */
// Se guarda lo minimo para reconectar los robots cuya ventana tmux siga viva tras reiniciar el daemon.
const STATE_FILE = path.join(RUNS, 'office-state.json');
let saveTimer = null;
function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const data = {
      colorSeq,
      maxRobots,
      inbox,
      robots: [...robots.values()].map(r => ({
        name: r.name, kind: r.kind, skill: r.skill, label: r.label, prompt: r.prompt, color: r.color, place: r.place,
        permissionMode: r.permissionMode, sessionId: r.sessionId, transcript: r.transcript, startedAt: r.startedAt, state: r.state, docs: r.docs,
        leaveWhenDone: r.leaveWhenDone, origin: r.origin, inputAt: r.inputAt, critical: criticalOf(r), title: r.title || '', request: r.request, look: r.look || null, baseColor: r.baseColor, timeline: r.timeline, lastEventAt: r.lastEventAt,
        parent: r.parent || null, spawnReq: r.spawnReq || null, reported: !!r.reported, note: r.note || '', salaNote: r.salaNote || ''
      })),
      spawnQueue,
      pendingResults: [...pendingResults]
    };
    fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2));
  }, 500);
}

async function restore() {
  let saved;
  try { saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return; }
  inbox.push(...(saved.inbox || []).map(i => ({ status: 'nuevo', ...i })));
  if (!process.env.OFFICE_MAX_ROBOTS && Number.isInteger(saved.maxRobots)) maxRobots = saved.maxRobots;
  colorSeq = saved.colorSeq || 0;
  spawnQueue.push(...(saved.spawnQueue || []));
  for (const [parent, b] of saved.pendingResults || []) pendingResults.set(parent, b); // se entregan al terminar de restaurar
  let windows = [];
  try { windows = (await run('tmux', ['list-windows', '-t', SESSION, '-F', '#{window_name}'])).stdout.split('\n'); } catch { /* sin sesion */ }
  const used = new Set();
  for (const s of saved.robots || []) {
    // Sin consola: si su sesión de Claude sigue en disco no se pierde, queda «consola caída» para revivirlo.
    const lost = !windows.includes(s.name);
    if (lost && !fs.existsSync(s.transcript || path.join(os.homedir(), '.claude/projects', WORKSPACE.replace(/\//g, '-'), `${s.sessionId}.jsonl`))) continue;
    const place = s.place?.type === 'room' ? s.place : s.place?.type === 'desk' && !used.has(s.place.idx) ? s.place : null;
    const r = {
      ...s, place, offset: 0, partial: '', msgUsage: new Map(), alive: true, subs: [], pendingSubs: 0, bubble: '', activity: '',
      needsPermission: false, hold: null, log: [], restoring: true
    };
    r.docs = s.docs || (s.doc ? [{ path: s.doc, at: s.startedAt, delivered: false, updated: false }] : []);
    if (!r.place) r.place = freeDesk();
    if (!r.place) continue;
    if (r.place.type === 'desk') used.add(r.place.idx);
    if (r.state === 'input') r.inputAt ||= now();
    r.transcript ||= path.join(os.homedir(), '.claude/projects', WORKSPACE.replace(/\//g, '-'), `${r.sessionId}.jsonl`);
    if (['walking', 'delegating'].includes(r.state)) r.state = 'working';
    r.timeline = Array.isArray(s.timeline) && s.timeline.length ? s.timeline : [{ at: s.startedAt || now(), s: r.state }];
    robots.set(r.name, r);
    loadConv(r);
    pumpTranscript(r); // desde el inicio para el uso de tokens; al log solo entra lo posterior a lo guardado
    r.muteUntil = 0;
    r.restoring = false;
    if (lost) markLost(r);
    else { log(r, 'sys', 'Reconectado tras reiniciar la oficina'); console_(r.name, 'reconectado', r.label); }
  }
}

// «Background command "X" completed (exit code 0)» → «✓ Terminó: X». Se muestra como globo «Aviso de su consola».
function taskNote(p) {
  const tag = k => (new RegExp(`<${k}>([\\s\\S]*?)</${k}>`).exec(p) || [])[1]?.trim() || '';
  const sum = tag('summary'), status = tag('status');
  const what = /"([^"]+)"/.exec(sum)?.[1];
  const ok = !/fail|error|killed|exit code [1-9]/i.test(sum + ' ' + status);
  if (what) return `${ok ? '✓ Terminó' : '✗ Falló'}: ${what}${ok ? '' : ` (${status || sum})`}`;
  return sum || status || 'Tarea en segundo plano sin detalle';
}

function log(r, kind, text, extra) {
  if (r.muteUntil && r.linePos <= r.muteUntil) return;
  const entry = { kind, text: String(text ?? ''), ...(extra || {}), at: extra?.at && !Number.isNaN(Date.parse(extra.at)) ? extra.at : now() };
  // Claude guarda el transcript en tandas: un texto puede llegar después de la herramienta que vino luego.
  // Con su hora real se inserta en su lugar, así la conversación queda en el orden en que pasó.
  let k = r.log.length;
  while (k > 0 && r.log[k - 1].at > entry.at) k--;
  r.log.splice(k, 0, entry);
  if (r.log.length > 400) r.log.splice(0, r.log.length - 400);
  saveConv(r);
  broadcast({ type: 'log', name: r.name, entry });
}

// Conversación de cada robot en disco (conversaciones/<robot>.json): al reiniciar la oficina se recupera entera
// (herramientas, avisos, tus respuestas) en vez de reconstruir solo lo que dijo desde el transcript.
// `offset` marca hasta dónde del transcript ya está en el log: lo que llegó con la oficina apagada se suma después.
const CONV_DIR = path.join(RUNS, 'conversaciones');
const convDirty = new Set();
let convTimer = null;
const convFile = name => path.join(CONV_DIR, `${name}.json`);
function saveConv(r) { convDirty.add(r.name); if (!convTimer) convTimer = setTimeout(flushConvs, 2000); }
function flushConvs() {
  clearTimeout(convTimer); convTimer = null;
  if (!convDirty.size) return;
  try { fs.mkdirSync(CONV_DIR, { recursive: true }); } catch { return; }
  for (const name of convDirty) {
    const r = robots.get(name);
    if (!r) continue;
    try { fs.writeFileSync(convFile(name), JSON.stringify({ sessionId: r.sessionId, offset: Math.max(r.offset - Buffer.byteLength(r.partial || ''), r.muteUntil || 0), log: r.log })); } catch { /* disco lleno o sin permisos: se reintenta con el próximo mensaje */ }
  }
  convDirty.clear();
}
function loadConv(r) {
  try {
    const c = JSON.parse(fs.readFileSync(convFile(r.name), 'utf8'));
    if (c.sessionId && c.sessionId !== r.sessionId) return;
    if (Array.isArray(c.log)) r.log = c.log.slice(-400);
    if (Number.isInteger(c.offset)) r.muteUntil = c.offset;
  } catch { /* sin conversación guardada: se reconstruye desde el transcript */ }
}

function setState(r, state) {
  if (r.state === state) return;
  r.state = state;
  r.inputAt = state === 'input' ? now() : null; // desde cuándo espera tu respuesta (la web cuenta el tiempo)
  // Historial de estados para la línea de tiempo de la oficina (acotado: un robot largo no crece sin fin).
  (r.timeline ||= []).push({ at: now(), s: state });
  if (r.timeline.length > TIMELINE_MAX) r.timeline.splice(0, r.timeline.length - TIMELINE_MAX);
  emit(r);
}

function freeDesk() {
  const used = new Set([...robots.values()].filter(r => r.place.type === 'desk').map(r => r.place.idx));
  // Sin limite: si no hay escritorio libre, la oficina agrega uno (y una fila nueva en el mapa).
  for (let i = 0; ; i++) if (!used.has(i)) return { type: 'desk', idx: i };
}

// Los robots de una rutina (o de una sala de épica) se sientan en una sala temporal con su nombre
// (la web la dibuja mientras tenga robots). extra marca de qué sala de épica es, si aplica.
function roomSeat(room, name, extra = {}) {
  const used = new Set([...robots.values()].filter(r => r.place.type === 'room' && r.place.room === room).map(r => r.place.slot));
  let slot = 0;
  while (used.has(slot)) slot++;
  return { type: 'room', room, name, slot, ...extra };
}

/* ---------- robots que lanza un robot ---------- */
// Un robot puede pedirle a la oficina robots nuevos (cada uno con su consola y su contexto) en vez de subagentes.
// La petición queda en r.spawnReq hasta que la apruebas; los aprobados entran si hay cupo y si no esperan en
// spawnQueue. Cuando un hijo termina su primer encargo, su respuesta final se le escribe al padre en su consola.
const SPAWN_MAX = 6;
const spawnQueue = []; // [{ id, parent, title, text, at }] o, si es un encargo tuyo que esperó cupo, [{ id, job, title, name, at }]
// Encargos tuyos que esperan en la puerta (sin padre): se ven en la barra y en «Nuevo encargo».
const doorView = () => spawnQueue.filter(q => q.job).map(q => ({ id: q.id, title: q.title, name: q.name || null, at: q.at }));
const emitDoor = () => broadcast({ type: 'door', door: doorView() });
const FULL_RE = /escritorios libres|tope/i;
// «Nuevo encargo» con la oficina llena: en vez de error, el encargo espera en la puerta y entra solo al haber cupo.
// Solo si el pedido lo pide (queue: true) y no es de una rutina: las rutinas ya reintentan solas en su próxima revisión.
async function launchOrQueue(body) {
  try { return { robot: await launch(body) }; } catch (e) {
    if (!body?.queue || body.routine || !FULL_RE.test(e.message)) throw e;
    const name = body.name ? String(body.name).toLowerCase() : '';
    if (name && !/^[a-z0-9-]{1,20}$/.test(name)) throw new Error('Nombre inválido: usa minúsculas, números y guiones.');
    if (name && (robots.has(name) || spawnQueue.some(q => q.name === name))) throw new Error(`Ya existe un robot llamado ${name} (o espera en la puerta).`);
    if (body.kind === 'libre' ? !String(body.text || '').trim() : !String(body.skill || '').trim()) throw new Error(body.kind === 'libre' ? 'Escribe qué necesitas.' : 'Elige la skill.');
    const { queue, ...job } = body;
    const title = cleanTitle(body.title || '') || trunc(body.kind === 'libre' ? String(body.text).replace(/\s+/g, ' ') : `/${body.skill} ${body.args || ''}`.trim(), 60);
    const q = { id: crypto.randomBytes(3).toString('hex'), job, title, name: name || null, at: now() };
    spawnQueue.push(q);
    console_(name || 'puerta', 'espera cupo', title);
    saveState(); emitDoor();
    return { queued: q, position: spawnQueue.filter(x => x.job).length };
  }
}
const kidsOf = name => [
  ...[...robots.values()].filter(x => x.parent === name).map(x => ({ name: x.name, state: x.state, title: x.title || '' })),
  ...spawnQueue.filter(q => q.parent === name).map(q => ({ name: null, state: 'queued', title: q.title, qid: q.id }))
];
// Nombre de un hijo según lo que hace: «Puertos de wallet» → «puertos-wallet» (sin tildes ni palabras vacías, máx. 17
// letras para que quepa un «-2» si se repite). El robot puede proponer el suyo con "nombre" y tú lo corriges al aprobar.
const NAME_STOP = new Set('de del la el los las lo y e o u en para con por a al un una unos unas que se su sus es the of and to for in on with'.split(' '));
function kidName(title, text) {
  const words = String(title || text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/[\s-]+/).filter(w => w && !NAME_STOP.has(w));
  const two = words.slice(0, 2).join('-');
  const base = (two.length <= 17 ? two : words[0] || '').slice(0, 17).replace(/-+$/, '');
  return base.length >= 3 ? base : '';
}
const validName = n => { const s = String(n ?? '').trim().toLowerCase(); return /^[a-z0-9-]{1,20}$/.test(s) ? s : ''; };
function uniqueName(base) {
  if (!base) return undefined;
  const taken = n => robots.has(n) || launching.has(n);
  if (!taken(base)) return base;
  for (let i = 2; ; i++) { const n = `${base.slice(0, 17).replace(/-+$/, '')}-${i}`; if (!taken(n)) return n; }
}
function requestSpawn(r, body) {
  const list = Array.isArray(body) ? body : body?.encargos || body?.robots || [];
  const items = list.map(x => { const title = cleanTitle(x.titulo ?? x.title ?? ''), text = String(x.encargo ?? x.text ?? x.tarea ?? '').trim().slice(0, 20000); return { title, text, name: validName(x.nombre ?? x.name) || kidName(title, text) }; }).filter(x => x.text);
  if (!items.length) throw new Error('Manda {"encargos":[{"titulo":"…","encargo":"…"}]} con al menos un encargo.');
  if (items.length > SPAWN_MAX) throw new Error(`Máximo ${SPAWN_MAX} robots por petición.`);
  // contexto: lo que todos los del equipo deben saber (lo que el padre ya averiguó). Va al CONTEXT.md de la sala del equipo.
  const context = Array.isArray(body) ? '' : String(body?.contexto ?? body?.context ?? '').trim().slice(0, 30000);
  // La sala se reserva desde ya: así la respuesta del curl le da al padre la ruta del CONTEXT.md sin abrirle un turno.
  const salaId = r.place.sala && salas.some(x => x.id === r.place.sala) ? r.place.sala : crypto.randomBytes(4).toString('hex');
  // Nombres fijados desde ya (sin repetir con robots, cola ni otras peticiones): la respuesta se los dice al padre.
  const used = new Set([...robots.keys(), ...launching, ...spawnQueue.map(q => q.name).filter(Boolean), ...[...robots.values()].flatMap(x => x.spawnReq?.items?.map(i => i.name) || [])]);
  for (const it of items) {
    const base = (it.name || 'robot').slice(0, 17).replace(/-+$/, '');
    let n = it.name || base;
    for (let i = 2; used.has(n); i++) n = `${base}-${i}`;
    it.name = n; used.add(n);
  }
  r.toldNames = items.map(i => i.name); // si al aprobar cambian, se le aclara con sus primeros resultados
  r.spawnReq = { id: crypto.randomBytes(3).toString('hex'), at: now(), items, salaId, ...(context ? { context } : {}) };
  log(r, 'sys', `Pidió ${items.length} robot${items.length === 1 ? '' : 's'} nuevo${items.length === 1 ? '' : 's'}: espera tu aprobación`);
  console_(r.name, 'pide robots', items.map(i => i.title || trunc(i.text, 40)).join(' · '));
  emit(r);
  return r.spawnReq;
}
// Aspecto que el robot muestra: el que le elegiste o el que sale de su nombre (misma cuenta que lookOf en web/robot-art.js).
function lookFromName(name) {
  let h = 7;
  for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return { ant: h % 4, visor: (h >>> 3) % 3, acc: (h >>> 6) % 4 };
}
const KID_PREAMBLE = parent => `\n\n(Te lanzó el robot ${parent} desde la Oficina de Agentes. Arrancas sin su conversación: lo que necesitas está en este encargo y en el contexto compartido de la sala de tu equipo (abajo). Cuando termines, tu respuesta final se le envía a ${parent}, así que hazla completa y autosuficiente: resultado, archivos que tocaste o creaste y pendientes.)`;
async function decideSpawn(r, id, approve, edited) {
  if (!r.spawnReq || r.spawnReq.id !== id) throw new Error('Esa petición ya no está pendiente.');
  const items = Array.isArray(edited) ? edited.map(x => ({ title: cleanTitle(x.title ?? ''), text: String(x.text ?? '').trim(), name: validName(x.name) || kidName(x.title, x.text) })).filter(x => x.text) : r.spawnReq.items;
  const context = r.spawnReq.context || '', salaId = r.spawnReq.salaId;
  r.spawnReq = null;
  if (!approve || !items.length) {
    log(r, 'sys', 'No aprobaste los robots que pidió');
    emit(r);
    await say(r, '[Oficina] El usuario no aprobó lanzar los robots que pediste. Sigue tú con el trabajo o pregúntale cómo prefiere hacerlo.').catch(() => {});
    return { launched: [], queued: 0 };
  }
  // El padre y sus hijos quedan juntos en una sala: se ve que trabajan en lo mismo y comparten CONTEXT.md y el hilo.
  const { sala, created } = teamSala(r, items, context, salaId);
  const qs = items.map(it => ({ id: crypto.randomBytes(3).toString('hex'), parent: r.name, title: it.title, text: it.text, name: it.name || '', sala: sala.id, at: now() }));
  spawnQueue.push(...qs);
  sala.roster = [...(sala.roster || []), ...qs.map(q => ({ qid: q.id, name: q.name, title: q.title, parent: r.name }))];
  saveSalas(); writeRoster(sala);
  log(r, 'sys', `Aprobaste ${items.length} robot${items.length === 1 ? '' : 's'} · ${created ? 'pasa a la sala' : 'entran a su sala'} «${sala.name}»`);
  const launched = await drainSpawnQueue();
  emit(r);
  // Sin mensaje aparte (abriría un turno completo del padre solo para avisar): la nota viaja con sus primeros resultados.
  if (created) { r.salaNote = `[Oficina] Aprobé tus robots: tú y ellos están en la sala «${sala.name}». Su contexto compartido es ${contextPath(sala)}; si sabes algo durable que ellos no, agrégalo ahí.`; saveState(); }
  return { launched, queued: spawnQueue.filter(q => q.parent === r.name).length, sala: sala.id };
}
// Lanza los que esperan mientras haya cupo; se llama al aprobar, cuando un robot termina o se va, y cada tanto.
let draining = false;
async function drainSpawnQueue() {
  if (draining) return [];
  draining = true;
  const launched = [];
  try {
    while (spawnQueue.length && [...robots.values()].filter(x => x.state !== 'done').length < maxRobots) {
      const q = spawnQueue.shift();
      if (q.job) { // encargo tuyo que esperaba en la puerta
        try {
          const r = await launch({ ...q.job, origin: `${q.job.origin || 'Lanzado por ti'} · esperó cupo en la puerta desde ${new Date(q.at).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })}` });
          launched.push(r.name);
          broadcast({ type: 'notice', text: `Se liberó un escritorio: entró ${r.name}${q.title ? ` («${q.title}»)` : ''}, que esperaba en la puerta.` });
        } catch (e) {
          if (FULL_RE.test(e.message)) { spawnQueue.unshift(q); break; }
          broadcast({ type: 'notice', text: `No pude lanzar «${q.title || 'el encargo'}» que esperaba en la puerta: ${e.message}` });
        }
        emitDoor();
        continue;
      }
      try {
        const par = robots.get(q.parent); // los hijos salen con el mismo diseño que el padre: color, antena, visor y accesorio
        const sala = q.sala && salas.some(s => s.id === q.sala) ? q.sala : undefined; // si cerraron su sala mientras esperaba, entra a un escritorio
        const kid = await launch({ kind: 'libre', name: uniqueName(q.name || kidName(q.title, q.text)), text: q.text + KID_PREAMBLE(q.parent), label: q.title || trunc(q.text, 80), title: q.title, parent: q.parent, sala,
          color: par?.color, look: par ? { ...lookFromName(par.name), ...(par.look || {}) } : null,
          origin: `Lanzado por el robot ${q.parent} (lo aprobaste en la oficina)` });
        launched.push(kid.name);
        const rs = sala && salas.find(x => x.id === sala), e = rs?.roster?.find(x => x.qid === q.id);
        if (e) { e.name = kid.name; saveSalas(); writeRoster(rs); }
        const p = robots.get(q.parent); if (p) emit(p);
      } catch (e) {
        if (FULL_RE.test(e.message)) { spawnQueue.unshift(q); break; }
        const p = robots.get(q.parent); if (p) log(p, 'sys', `No se pudo lanzar «${q.title || trunc(q.text, 40)}»: ${e.message}`);
      }
    }
  } finally { draining = false; saveState(); }
  return launched;
}
setInterval(() => { if (spawnQueue.length) drainSpawnQueue(); }, 5000);
// Resultados de los hijos. Si el padre está libre le llegan enseguida (así sigue avanzando: ese turno es trabajo útil).
// Si está ocupado, escribirle no sirve de nada hasta que termine: los que lleguen mientras tanto se guardan y le
// llegan JUNTOS en un solo mensaje al terminar su turno, en vez de uno por hijo. Nadie espera a sus hermanos.
// Una pausa corta (RESULT_DEBOUNCE_MS) junta los que terminan casi a la vez.
const RESULT_DEBOUNCE_MS = Number(process.env.OFFICE_RESULT_DEBOUNCE_MS) || 20e3;
const pendingResults = new Map(); // padre -> { items: [{ name, title, text }], first }
const resultTimers = new Map();
const kidsWorking = parent => [...robots.values()].filter(x => x.parent === parent && !x.reported).length + spawnQueue.filter(q => q.parent === parent).length;
// Ocupado: en pleno turno, esperando un permiso o una respuesta tuya a una pregunta, o escribiendo su resumen para irse.
const parentBusy = p => ['working', 'delegating', 'walking'].includes(p.state) || p.needsPermission || !!p.hold || !!p.ask || !!p.summaryPending || !!p.consoleLost;
function reportToParent(r, lastMessage) {
  const p = r.parent && robots.get(r.parent);
  if (r.reported || !p || !String(lastMessage ?? '').trim()) return;
  r.reported = true;
  const b = pendingResults.get(p.name) || { items: [], first: Date.now() };
  b.items.push({ name: r.name, title: r.title || '', text: String(lastMessage).slice(0, 20000) });
  pendingResults.set(p.name, b);
  saveState();
  checkTeamDone(r);
  for (const s of rosterOf(r.name)) writeRoster(s);
  if (parentBusy(p)) log(p, 'sys', `${r.name} terminó; su resultado te llega apenas termines lo que haces`);
  else scheduleFlush(p.name);
  emit(p);
  setTimeout(drainSpawnQueue, 500);
}
function scheduleFlush(parent, ms = RESULT_DEBOUNCE_MS) {
  if (!resultTimers.has(parent)) resultTimers.set(parent, setTimeout(() => { resultTimers.delete(parent); maybeFlush(parent); }, ms));
}
// Entrega lo guardado si el padre está libre; si sigue ocupado, se reintenta al cerrar su turno (o en la revisión periódica).
function maybeFlush(parent) {
  const p = robots.get(parent);
  if (!p) { pendingResults.delete(parent); return; }
  if (pendingResults.has(parent) && !parentBusy(p)) flushResults(parent);
}
function flushResults(parent) {
  clearTimeout(resultTimers.get(parent)); resultTimers.delete(parent);
  const b = pendingResults.get(parent), p = robots.get(parent);
  if (!b?.items.length || !p) return;
  pendingResults.delete(parent);
  const left = kidsWorking(parent), n = b.items.length;
  let note = p.salaNote ? `${p.salaNote}\n\n` : '';
  p.salaNote = '';
  if (p.toldNames) { // si al aprobar cambiaron los nombres que le dije, se lo aclaro aquí (no en un mensaje aparte)
    const team = [...robots.values()].filter(x => x.parent === p.name).map(x => x.name);
    const changed = p.toldNames.filter(n => !team.includes(n) && !b.items.some(i => i.name === n));
    if (changed.length) note += `[Oficina] Nombres finales de tu equipo: ${[...robots.values()].filter(x => x.parent === p.name).map(x => `${x.name} (${x.title || 'sin título'})`).join(', ')}.\n\n`;
    p.toldNames = null;
  }
  const head = n === 1 ? `[Oficina] Resultado de ${b.items[0].name}${b.items[0].title ? ` («${b.items[0].title}»)` : ''}` : `[Oficina] Resultados de ${n} robots (terminaron mientras trabajabas)`;
  const body = n === 1 ? b.items[0].text : b.items.map(i => `## ${i.name}${i.title ? ` («${i.title}»)` : ''}\n\n${i.text}`).join('\n\n');
  say(p, `${note}${head}${left ? ` · ${left} sigue${left === 1 ? '' : 'n'} trabajando` : ' · ya terminaron todos'}:\n\n${body}`).catch(() => {});
  log(p, 'sys', n === 1 ? `Te llegó el resultado de ${b.items[0].name}` : `Te llegaron juntos los resultados de ${b.items.map(i => i.name).join(', ')}`);
  emit(p);
  saveState();
}
const flushIfIdle = parent => { if (parent && pendingResults.has(parent)) maybeFlush(parent); };
// Red de seguridad: tras reiniciar la oficina o si un padre se desocupa sin cerrar turno (p. ej. respondiste su pregunta).
function resumeResults() { for (const parent of pendingResults.keys()) maybeFlush(parent); }
setInterval(resumeResults, 15e3);

/* ---------- ciclo de vida del turno ---------- */

const SUMMARY_ASK = '[Oficina] Te vamos a despedir. Responde SOLO con un super resumen en Markdown (máximo 25 líneas) para que otro robot, '
  + 'sin tu contexto, pueda retomar la tarea: objetivo, qué hiciste, en qué quedaste, qué falta, qué estabas esperando (de quién o de qué), '
  + 'y repos, ramas, PRs, archivos y documentos clave con su ruta. Sin saludos ni preguntas. No uses herramientas.';
function finishTurn(r, lastMessage) {
  if (lastMessage) r.bubble = trunc(lastMessage, 140);
  if (r.summaryPending && r.pendingSubs <= 0 && String(lastMessage ?? '').trim()) { // su resumen: se guarda y se va
    r.summaryPending = false;
    removeRobot(r, 'despedido con su resumen', lastMessage);
    return;
  }
  r.activity = '';
  r.tool = '';
  if (r.pendingSubs > 0) { setState(r, 'delegating'); emit(r); return; }
  // En una sala de épica, lo que dijo al cerrar el turno queda en el hilo para los demás robots.
  const sala = r.place.sala && salas.find(s => s.id === r.place.sala);
  if (sala && String(lastMessage ?? '').trim()) postThread(sala, r.name, lastMessage);
  // Los documentos se entregan al terminar cada turno, aunque el robot quede esperando una respuesta.
  deliver(r);
  // Un turno que termina en pregunta queda esperando tu respuesta: no se va.
  if (/\?\s*[`*_)\]]*\s*$/.test(String(lastMessage ?? '').trim())) {
    setState(r, 'input');
    emit(r);
    return;
  }
  // Ningún robot se va solo: queda con el cartel LISTO y su conversación hasta que lo des de baja.
  if (r.state !== 'done') bumpStats(r);
  reportToParent(r, lastMessage);
  setState(r, 'done');
  emit(r);
  // Cerró su turno: si le guardé resultados de sus hijos mientras trabajaba, le llegan ahora, todos juntos.
  if (pendingResults.has(r.name)) setTimeout(() => maybeFlush(r.name), 1500);
}

// Entrega a la bandeja todos los documentos del robot que aun no entrego (o que cambio despues de entregarlos).
function deliver(r) {
  const pending = r.docs.filter(d => !d.delivered);
  if (!pending.length) return;
  const items = pending.map(d => ({
    id: crypto.randomBytes(4).toString('hex'), path: d.path, robot: r.name, label: r.label, sessionId: r.sessionId,
    at: now(), status: 'nuevo', updated: !!d.updated, critical: countCriticals(d.path)
  }));
  for (const d of pending) { d.delivered = true; d.updated = false; }
  // Un documento actualizado reemplaza su entrada anterior en la bandeja.
  for (const it of items) {
    const old = inbox.findIndex(x => x.path === it.path);
    if (old >= 0) inbox.splice(old, 1);
    inbox.unshift(it);
  }
  log(r, 'sys', `Entregó ${items.length} documento${items.length === 1 ? '' : 's'} en tu bandeja: ${items.map(i => path.basename(i.path)).join(', ')}`);
  broadcast({ type: 'deliver', name: r.name, items });
  emitInbox();
  emit(r);
}

// Hallazgos críticos de un review: los `###` bajo «## Hallazgos Criticos» (con o sin tilde) hasta la siguiente sección.
function countCriticals(file) {
  if (!/\.(md|markdown)$/i.test(file)) return 0;
  let text;
  try { if (fs.statSync(file).size > 2e6) return 0; text = fs.readFileSync(file, 'utf8'); } catch { return 0; }
  let inSection = false, n = 0;
  for (const line of text.split('\n')) {
    if (/^##\s/.test(line)) inSection = /^##\s+(hallazgos\s+cr[ií]ticos|critical\s+findings)\b/i.test(line);
    else if (inSection && /^###\s/.test(line)) n++;
  }
  return n;
}

// Críticos del robot = los de sus entregas que siguen sin ver en la bandeja (de este robot, no de uno anterior
// con el mismo nombre). Al abrir el review, marcarlo visto o archivarlo, el cartel ⚠ del robot se quita;
// si lo vuelve a entregar corregido, cuenta lo nuevo.
// Lo que se le encargó al robot, para «Lanzar otro igual». Los robots de antes de guardarlo se deducen del prompt.
function requestOf(r) {
  if (r.request) return r.request;
  const p = String(r.prompt || '').replace(/ \[Adjuntos: [^\]]*\]$/, '');
  const m = /^\/([a-z0-9:_-]+)\s*([\s\S]*)$/i.exec(p);
  return m ? { kind: 'skill', skill: m[1], args: m[2], text: '', permissionMode: r.permissionMode || '' }
    : { kind: 'libre', skill: null, args: '', text: p, permissionMode: r.permissionMode || '' };
}

// Encargos frecuentes: atajos guardados en Nuevo encargo (por oficina, en su carpeta de datos).
const FAV_FILE = path.join(RUNS, 'frecuentes.json');
let favorites = [];
try { favorites = JSON.parse(fs.readFileSync(FAV_FILE, 'utf8')); } catch { /* sin frecuentes */ }
function saveFavorites() { fs.writeFileSync(FAV_FILE, JSON.stringify(favorites, null, 2)); broadcast({ type: 'favorites', favorites }); }
// «Para enviar»: mensajes de robots que fijaste para pegarlos después en Google Chat o Slack. Guardan el texto,
// así siguen aunque el robot se vaya.
const PIN_FILE = path.join(RUNS, 'para-enviar.json');
let pins = [];
try { pins = JSON.parse(fs.readFileSync(PIN_FILE, 'utf8')); } catch { /* sin fijados */ }
function savePins() { fs.writeFileSync(PIN_FILE, JSON.stringify(pins, null, 2)); broadcast({ type: 'pins', pins }); }

// Indicaciones que la oficina le suma a cada robot nuevo: los mensajes para enviar van en una cita (>) para que la
// oficina les ponga «📋 Copiar»; al copiar se convierten al formato del chat, así que el robot escribe Markdown normal.
// Va como --append-system-prompt en cada robot (viaja en cada llamada a la API, en caché). Sin relleno, pero sin
// quitar nada que cambie la calidad de lo que hace el robot.
const ROBOT_HINTS = 'Trabajas dentro de la Oficina de Agentes, que muestra tus respuestas en una página web. '
  + 'Si te piden redactar un mensaje para otra persona (Google Chat, WhatsApp, Slack, correo), entrégalo completo dentro de una cita Markdown (cada línea empieza con «> »), una cita por mensaje y sin comentarios tuyos adentro; lo que quieras decirme a mí va fuera. '
  + 'Dentro de la cita usa Markdown normal (**negrita**, _cursiva_, listas con -, enlaces): la oficina lo convierte al formato del chat al copiarlo. '
  + 'Esos mensajes los firmo yo: primera persona del singular (yo hice, revisé, encontré, necesito), nunca en plural (hicimos, revisamos), y sin mencionar a Claude ni a la IA salvo que te lo pida; el plural solo vale cuando de verdad incluye al destinatario o a su equipo ("necesitamos validar juntos"). '
  + 'Si te piden repartir trabajo en ROBOTS (robots nuevos, independientes, otras consolas), no uses subagentes: pídeselos a la oficina con un archivo JSON '
  + '{"contexto":"lo que ya averiguaste y sirve a todos: decisiones, datos verificados, qué no repetir","encargos":[{"nombre":"una o dos palabras de lo que hace, ej. puertos-wallet","titulo":"título corto","encargo":"qué debe hacer"}]} (máximo 6) '
  + 'enviado con: curl -s -X POST "http://127.0.0.1:$OFFICE_PORT/api/robots/$OFFICE_ROBOT/encargos" -H "Content-Type: application/json" --data-binary @<archivo>. '
  + 'Cada robot nuevo arranca sin tu conversación: el encargo debe ser autosuficiente (objetivo, repos y rutas, documentos de entrada, restricciones, qué entregar y en qué formato). '
  + 'El usuario los aprueba en la oficina; tú y ellos quedan en una sala cuyo CONTEXT.md recibe ese contexto (la respuesta del curl te da su ruta). '
  + 'Sigue con tu trabajo: cada resultado te llega como mensaje «[Oficina] Resultado…» (los que terminen mientras trabajas te llegan juntos al terminar tu turno); intégralos. '
  + 'Si te piden agentes o subagentes, usa la herramienta de agentes como siempre.';

const cleanTitle = t => String(t ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);

function criticalOf(r) {
  const since = Date.parse(r.startedAt || '') || 0;
  return inbox.reduce((n, i) => n + (i.robot === r.name && i.status !== 'visto' && (Date.parse(i.at) || 0) >= since ? i.critical || 0 : 0), 0);
}

function emitInbox() {
  broadcast({ type: 'inbox', inbox });
  for (const r of robots.values()) {
    const c = criticalOf(r);
    if (c !== r.critShown) { r.critShown = c; broadcast({ type: 'robot', robot: view(r) }); }
  }
  saveState();
}

// Que cuenta como documento: Write de estos tipos; Edit solo en Markdown (para no contar cada archivo de codigo).
const DOC_WRITE = /\.(md|markdown|html?|txt|csv|json|ya?ml|pdf|png|jpe?g|gif|svg|drawio|mmd|docx|xlsx|pptx)$/i;
const DOC_EDIT = /\.(md|markdown)$/i;
function trackDoc(r, tool, file) {
  if (!file) return;
  const p = path.resolve(file);
  if (p.startsWith(RUNS + path.sep)) return; // memoria de rutinas, adjuntos, estado de la oficina
  const isDoc = tool === 'Write' ? DOC_WRITE.test(p) : DOC_EDIT.test(p);
  if (!isDoc) return;
  const d = r.docs.find(x => x.path === p);
  if (!d) r.docs.push({ path: p, at: now(), delivered: false, updated: false });
  else if (d.delivered) { d.delivered = false; d.updated = true; }
  else return;
  const sala = r.place.sala && salas.find(s => s.id === r.place.sala);
  if (sala && !sala.docs.some(x => x.path === p)) { sala.docs.push({ path: p, robot: r.name, at: now() }); saveSalas(); emitSalas(); }
  log(r, 'doc', p.startsWith(WORKSPACE + path.sep) ? path.relative(WORKSPACE, p) : p);
  emit(r);
}

// Archivo de despedidos: al dar de baja a un robot se guarda su resumen (encargo, título, documentos y sus
// mensajes y los tuyos, sin herramientas) para encontrarlo después con el buscador. Se guardan los últimos 200.
const ARCH_FILE = path.join(RUNS, 'despedidos.json');
const ARCH_MAX = 200;
let archive = [];
try { archive = JSON.parse(fs.readFileSync(ARCH_FILE, 'utf8')); } catch { /* sin despedidos */ }
const normText = t => String(t ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
// Super resumen de lo que hacía: el que escribió el robot al despedirlo con «📝 Despedir con su resumen» o, si no,
// uno que arma la oficina con el encargo, tu nota, su último mensaje y sus documentos. Queda como documento en
// docs/resumenes-robots/ de la carpeta de trabajo (a mano, aparte del resto de docs y fácil de borrar) y es lo
// único que recibe el robot que retome la tarea.
const sumDir = () => path.join(WORKSPACE || RUNS, 'docs', 'resumenes-robots');

/* ---------- exportar una conversación ---------- */
// Copia limpia de la conversación de un robot (vivo o del archivo) en docs/conversaciones-robots/, por si un resumen
// falla o queda corto. Sale del transcript completo de Claude: la oficina solo guarda los últimos 400 eventos. Lleva tus
// mensajes y los suyos en orden, con hora; los avances («Ahora reviso…») se marcan aparte de sus respuestas y las
// herramientas quedan como una línea con cuántas usó. Si el transcript ya no está, usa lo que guardó la oficina.
const flat = t => String(t ?? '').replace(/\s+/g, ' ').trim();
const convDir = () => path.join(WORKSPACE || RUNS, 'docs', 'conversaciones-robots');
const NOISE_RE = /^\s*<(command-name|command-message|command-args|local-command-stdout|local-command-stderr|bash-stdout|bash-stderr|task-notification)\b|^\s*\[Request interrupted/;
const cleanText = t => String(t ?? '').replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
  .replace(/<\\?\/?pasted_content(?:\s+id=["']?[\w-]*["']?)?\s*>/gi, '').trim();
function transcriptTurns(file) {
  let lines;
  try { lines = fs.readFileSync(file, 'utf8').split('\n'); } catch { return null; }
  const items = [], seen = new Set();
  for (const line of lines) {
    if (!line.trim()) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e.isMeta || e.isCompactSummary || e.isSidechain) continue;
    const at = e.timestamp, c = e.message?.content;
    if (e.type === 'user') {
      const parts = typeof c === 'string' ? [c] : Array.isArray(c) && !c.some(b => b.type === 'tool_result') ? c.filter(b => b.type === 'text').map(b => b.text) : [];
      for (const raw of parts) {
        const bash = String(raw).match(/^\s*<bash-input>([\s\S]*?)<\/bash-input>/);
        if (bash) { items.push({ who: 'user', text: '`! ' + bash[1].trim() + '`', at }); continue; }
        if (NOISE_RE.test(raw)) continue;
        const text = cleanText(raw);
        if (text) items.push({ who: /^\[Oficina\]/.test(text) ? 'office' : 'user', text, at });
      }
    } else if (e.type === 'assistant' && Array.isArray(c)) {
      for (const b of c) {
        const key = `${e.message?.id}|${b.type}|${b.type === 'text' ? b.text : b.id}`;
        if (seen.has(key)) continue; // Claude repite el mismo mensaje en varias líneas mientras lo escribe
        seen.add(key);
        if (b.type === 'text' && cleanText(b.text)) items.push({ who: 'agent', text: cleanText(b.text), at });
        else if (b.type === 'tool_use') items.push({ who: 'tool', at });
      }
    }
  }
  return items;
}
function convMarkdown(src, items) {
  const when = t => t ? new Date(t).toLocaleString('es', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
  const hhmm = t => t ? new Date(t).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' }) : '';
  const out = [`# Conversación de ${src.name}${src.title ? ` · ${src.title}` : ''}`, '',
    `_Exportada por la Oficina de Agentes el ${when(Date.now())} · entró ${when(src.startedAt)}${src.leftAt ? ` · se fue ${when(src.leftAt)}` : ''}${src.fromLog ? ' · desde lo que guardó la oficina (el transcript ya no estaba)' : ''}_`, '',
    `- **Encargo:** ${flat(src.label)}`];
  if (src.origin) out.push(`- **Origen:** ${flat(src.origin)}`);
  if (src.note) out.push(`- **Nota:** ${flat(src.note)}`);
  if (src.sessionId) out.push(`- **Sesión de Claude:** \`${src.sessionId}\` (para retomarla: \`claude --resume ${src.sessionId}\`)`);
  out.push('', '---', '');
  let tools = 0, msgs = 0;
  const flushTools = () => { if (tools) out.push(`_… usó ${tools} herramienta${tools === 1 ? '' : 's'} …_`, ''); tools = 0; };
  items.forEach((it, i) => {
    if (it.who === 'tool') { tools++; return; }
    flushTools();
    msgs++;
    if (it.who === 'agent') {
      // Avance: después vienen más herramientas o mensajes suyos antes de que le vuelvas a escribir.
      let interim = false;
      for (let k = i + 1; k < items.length && items[k].who !== 'user'; k++) if (items[k].who === 'tool' || items[k].who === 'agent') { interim = true; break; }
      out.push(interim ? `#### 🤖 ${src.name} · avance · ${hhmm(it.at)}` : `### 🤖 ${src.name} · ${hhmm(it.at)}`, '', it.text, '');
    } else out.push(`### ${it.who === 'office' ? '🏢 Oficina' : '🧑 Tú'} · ${hhmm(it.at)}`, '', it.text, '');
  });
  flushTools();
  if (src.summary) out.push('---', '', `## Su resumen al irse (${src.summaryBy === 'robot' ? 'lo escribió el robot' : 'lo armó la oficina'})`, '', String(src.summary).trim(), '');
  return { md: out.join('\n'), msgs };
}
function exportConversation(src) {
  let items = src.transcript ? transcriptTurns(src.transcript) : null;
  const fromLog = !items || !items.some(x => x.who !== 'tool');
  if (fromLog) items = (src.log || []).filter(l => ['user', 'agent', 'bg'].includes(l.kind))
    .map(l => ({ who: l.kind === 'agent' ? 'agent' : /^\[Oficina\]/.test(l.text) ? 'office' : 'user', text: cleanText(l.text), at: l.at })).filter(x => x.text);
  if (!items.length) throw new Error(`${src.name} todavía no tiene conversación para exportar.`);
  const { md, msgs } = convMarkdown({ ...src, fromLog }, items);
  const file = path.join(convDir(), `${now().slice(0, 10)}-${src.name}-${crypto.randomBytes(2).toString('hex')}.md`);
  fs.mkdirSync(convDir(), { recursive: true });
  fs.writeFileSync(file, md + '\n');
  console_(src.name, 'exportada', path.relative(WORKSPACE || RUNS, file));
  return { path: file, shown: path.relative(WORKSPACE || RUNS, file), messages: msgs, fromLog };
}
// Los resúmenes de antes vivían en la carpeta de datos de la oficina (runs/resumenes): se mudan a la nueva.
function migrateSummaries() {
  const old = path.join(RUNS, 'resumenes');
  if (!WORKSPACE || !fs.existsSync(old)) return;
  let moved = 0;
  try {
    fs.mkdirSync(sumDir(), { recursive: true });
    for (const f of fs.readdirSync(old)) {
      const from = path.join(old, f), to = path.join(sumDir(), f);
      if (!f.endsWith('.md') || fs.existsSync(to)) continue;
      fs.copyFileSync(from, to); fs.unlinkSync(from); moved++;
      for (const a of archive) if (a.summaryPath === from) a.summaryPath = to;
    }
    if (!fs.readdirSync(old).length) fs.rmdirSync(old);
  } catch (e) { console.error(`No se pudieron mudar los resúmenes a ${sumDir()}: ${e.message}`); }
  if (moved) { fs.writeFileSync(ARCH_FILE, JSON.stringify(archive)); console.log(`Resúmenes mudados a ${sumDir()}: ${moved}`); }
}
function writeSummary(r, summary, by) {
  const day = now().slice(0, 10);
  const file = path.join(sumDir(), `${day}-${r.name}-${crypto.randomBytes(2).toString('hex')}.md`);
  const head = `# ${r.name}${r.title ? ` · ${r.title}` : ''}\n\n_${by === 'robot' ? 'Resumen escrito por el robot al despedirlo' : 'Resumen armado por la oficina al despedirlo'} · entró ${r.startedAt?.slice(0, 16).replace('T', ' ')} · se fue ${now().slice(0, 16).replace('T', ' ')}_\n\n`;
  try { fs.mkdirSync(sumDir(), { recursive: true }); fs.writeFileSync(file, head + summary.trim() + '\n'); return file; } catch { return null; }
}
// Solo se archiva (con su documento en docs/resumenes-robots/) quien se fue con «📝 Despedir con su resumen».
// «Dar de baja» es solo eso: se va sin resumen ni archivo.
function archiveRobot(r, reason, robotSummary) {
  const summary = String(robotSummary || '').trim();
  if (!summary) return;
  const by = 'robot';
  const summaryPath = writeSummary(r, summary, by);
  const log = r.log.filter(l => ['user', 'agent', 'bg', 'doc'].includes(l.kind)).slice(-80)
    .map(l => ({ kind: l.kind, at: l.at, text: String(l.text ?? '').slice(0, 6000), ...(l.who ? { who: l.who } : {}) }));
  archive.push({ id: crypto.randomBytes(4).toString('hex'), name: r.name, title: r.title || '', label: r.label, kind: r.kind, skill: r.skill,
    origin: r.origin, color: r.color, look: { ...lookFromName(r.name), ...(r.look || {}) }, parent: r.parent || null, note: r.note || '',
    summary, summaryBy: by, summaryPath, permissionMode: r.permissionMode || '', request: r.request || null, transcript: r.transcript || null, sessionId: r.sessionId || null,
    startedAt: r.startedAt, leftAt: now(), reason, docs: r.docs.map(d => d.path), log });
  if (archive.length > ARCH_MAX) archive = archive.slice(-ARCH_MAX);
  fs.promises.writeFile(ARCH_FILE, JSON.stringify(archive)).catch(() => {});
  emitArchive();
}
const archMeta = a => ({ id: a.id, name: a.name, title: a.title, label: a.label, color: a.color, look: a.look, startedAt: a.startedAt, leftAt: a.leftAt, docs: a.docs.length, note: a.note || '',
  summaryBy: a.summaryBy || 'oficina', summaryPath: a.summaryPath || null, excerpt: trunc(String(a.summary || '').replace(/[#*_`>|-]+/g, ' '), 260) });
const emitArchive = () => broadcast({ type: 'archive', count: archive.length });
// Busca en el archivo (sin tildes ni mayúsculas): devuelve por robot las posiciones de los mensajes que coinciden.
function searchArchive(q) {
  const qn = normText(q).trim();
  if (qn.length < 2) return [];
  const out = [];
  for (const a of archive.slice().reverse()) {
    const hits = [];
    a.log.forEach((l, i) => { if (hits.length < 25 && normText(l.text).includes(qn)) hits.push({ i, at: l.at, kind: l.kind, who: l.who || null, text: l.text.slice(0, 1500) }); });
    const inMeta = !hits.length && normText(`${a.name} ${a.title} ${a.label} ${a.note || ''} ${a.summary || ''}`).includes(qn);
    if (hits.length || inMeta) out.push({ ...archMeta(a), hits });
    if (out.length >= 40) break;
  }
  return out;
}

// Retomar: entra un robot nuevo (sesión nueva) con solo el super resumen del que se fue y tu instrucción. Si necesita
// más contexto, se lo das tú o lo busca en los documentos y la memoria del proyecto.
async function retake(id, text) {
  const a = archive.find(x => x.id === id);
  if (!a) throw new Error('Ese robot ya no está en el archivo.');
  const summary = a.summary || '(sin resumen)';
  const prompt = `Retomas una tarea que dejó el robot ${a.name}${a.title ? ` («${a.title}»)` : ''}, que se fue el ${new Date(a.leftAt).toLocaleString('es')}. `
    + `No tienes su contexto: solo este resumen${a.summaryPath ? ` (también en ${a.summaryPath})` : ''}.\n\n---\n${summary}\n---\n\n`
    + `Si necesitas más contexto, pídemelo o búscalo en los documentos que menciona y en la memoria del proyecto.`
    + (String(text || '').trim() ? `\n\n${String(text).trim()}` : '');
  const r = await launch({ kind: 'libre', text: prompt, name: robots.has(a.name) ? undefined : a.name, title: a.title, label: `Retoma: ${a.title || a.label}`,
    color: a.color, look: a.look, origin: `Retoma la tarea de ${a.name} con su resumen (se había ido el ${new Date(a.leftAt).toLocaleString('es')})` });
  r.note = a.note || '';
  emit(r);
  return r;
}

/* ---------- consola caída y revivir ---------- */
// Si la ventana tmux de un robot desaparece (se cerró tmux, alguien la mató, se cayó), el robot no se borra:
// queda «⚠ consola caída» con su conversación, y «Revivir» le abre otra consola con su misma sesión (--resume).
function markLost(r) {
  if (r.consoleLost) return;
  r.consoleLost = true; r.hold = null; r.ask = null; r.needsPermission = false; r.activity = ''; r.tool = '';
  r.subs = r.subs.map(x => ({ ...x, status: 'done' })); r.pendingSubs = 0;
  log(r, 'sys', '⚠ Su consola se cerró (tmux). Su sesión sigue en disco: puedes revivirlo.');
  console_(r.name, 'consola caída', r.label);
  emit(r);
}
async function checkConsoles() {
  if (!robots.size) return;
  let windows;
  try { windows = new Set((await run('tmux', ['list-windows', '-t', SESSION, '-F', '#{window_name}'])).stdout.split('\n')); }
  catch { windows = new Set(); } // sin sesión o sin servidor de tmux: ninguna consola sigue viva
  for (const r of robots.values()) if (!r.consoleLost && r.state !== 'walking' && !launching.has(r.name) && !windows.has(r.name)) markLost(r);
}
setInterval(() => { checkConsoles().catch(() => {}); }, Number(process.env.OFFICE_CONSOLE_CHECK_MS) || 10000);
async function revive(r) {
  if (!r.consoleLost) throw new Error('Su consola sigue abierta.');
  await ensureSession();
  let size = 0; try { size = fs.statSync(r.transcript).size; } catch { /* sin transcript */ }
  const tmuxArgs = ['new-window', '-d', '-t', `${SESSION}:`, '-n', r.name, '-c', WORKSPACE,
    '-e', `OFFICE_ROBOT=${r.name}`, '-e', `OFFICE_PORT=${PORT}`, 'env', '-u', 'ANTHROPIC_API_KEY',
    CLAUDE_BIN, '--settings', SETTINGS, '--resume', r.sessionId, '--append-system-prompt', ROBOT_HINTS];
  if (r.permissionMode) tmuxArgs.push('--permission-mode', r.permissionMode);
  await run('tmux', tmuxArgs);
  // Lo que ya estaba en su sesión no se repite en la conversación: se sigue leyendo desde el final.
  r.offset = size; r.partial = '';
  r.consoleLost = false;
  setState(r, 'done');
  log(r, 'sys', `Revivido con su misma sesión (${r.sessionId.slice(0, 8)}): recuerda todo. Escríbele para seguir.`);
  console_(r.name, 'revivido', `tmux attach -t ${SESSION}:${r.name}`);
  emit(r);
}

async function removeRobot(r, reason, robotSummary) {
  deliver(r); // si se da de baja con documentos sin entregar, no se pierden
  try { archiveRobot(r, reason, robotSummary); } catch { /* el archivo es un extra: no frena la baja */ }
  r.alive = false;
  try { await run('tmux', ['kill-window', '-t', `${SESSION}:${r.name}`]); } catch { /* ya cerrada */ }
  const u = usage(r);
  console_(r.name, 'salio', `${reason} · tokens out=${u.out} cache_read=${u.cacheRead}`);
  robots.delete(r.name);
  convDirty.delete(r.name);
  try { fs.unlinkSync(convFile(r.name)); } catch { /* no tenía */ }
  broadcast({ type: 'left', name: r.name });
  saveState();
  const p = r.parent && robots.get(r.parent); if (p) emit(p);
  // Historial de rutinas: lo que gastó el robot que lanzaron, al irse.
  let touched = false;
  for (const rt of routines) for (const h of rt.history || []) for (const x of h.robots || []) if (x.name === r.name && x.tokens == null) { x.tokens = u.out + u.in + u.cacheWrite; x.state = 'se fue'; touched = true; }
  if (touched) { saveRoutines(); emitRoutines(); }
  for (const s of rosterOf(r.name)) writeRoster(s);
  if (pendingResults.has(r.name)) { clearTimeout(resultTimers.get(r.name)); resultTimers.delete(r.name); pendingResults.delete(r.name); } // se fue el padre
  flushIfIdle(r.parent);
  ownerBackIfAlone();
  closeEmptyTeamSalas();
  setTimeout(drainSpawnQueue, 500);
}

/* ---------- transcript ---------- */

function pumpTranscript(r) {
  if (!r.transcript) return;
  let size;
  try { size = fs.statSync(r.transcript).size; } catch { return; }
  if (size <= r.offset) return;
  const fd = fs.openSync(r.transcript, 'r');
  const buf = Buffer.alloc(size - r.offset);
  fs.readSync(fd, buf, 0, buf.length, r.offset);
  fs.closeSync(fd);
  let pos = r.offset - Buffer.byteLength(r.partial);
  r.offset = size;
  const lines = (r.partial + buf.toString('utf8')).split('\n');
  r.partial = lines.pop();
  for (const line of lines) {
    pos += Buffer.byteLength(line) + 1;
    r.linePos = pos; // log() no repite lo que ya estaba en la conversación guardada
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    onTranscript(r, e);
  }
}

// Comandos que escribes en su consola y no pasan por el hook de tus mensajes: «!comando» (modo bash) y los
// comandos locales de Claude (/context, /compact, /model…). Solo quedan en el transcript: se muestran como «shell».
const tagOf = (t, k) => (new RegExp(`<${k}>([\\s\\S]*?)</${k}>`).exec(t) || [])[1];
const cutKeep = (t, n) => t.length > n ? t.slice(0, n) + '\n…' : t; // como trunc, pero respeta los saltos de línea
const stripAnsi = t => String(t ?? '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r/g, '');
function shellLog(r, text) {
  const bi = tagOf(text, 'bash-input');
  if (bi != null) { log(r, 'shell', bi.trim(), { cmd: true }); return true; }
  const bo = tagOf(text, 'bash-stdout'), be = tagOf(text, 'bash-stderr');
  if (bo != null || be != null) {
    const out = [stripAnsi(bo).trim(), stripAnsi(be).trim()].filter(Boolean).join('\n');
    log(r, 'shell', cutKeep(out, 6000) || '(sin salida)', { err: !!stripAnsi(be).trim() });
    return true;
  }
  const name = tagOf(text, 'command-name');
  if (name) { log(r, 'shell', `${name.trim()} ${(tagOf(text, 'command-args') || '').trim()}`.trim(), { cmd: true, slash: true }); return true; }
  const lo = tagOf(text, 'local-command-stdout'), le = tagOf(text, 'local-command-stderr');
  if (lo != null || le != null) {
    const out = [stripAnsi(lo).trim(), stripAnsi(le).trim()].filter(Boolean).join('\n');
    log(r, 'shell', cutKeep(out, 6000) || '(sin salida)', { err: !!stripAnsi(le).trim() });
    return true;
  }
  return false;
}
function onTranscript(r, e) {
  if (e.isSidechain) return;
  if (e.type === 'system' && e.subtype === 'local_command') { if (shellLog(r, String(e.content ?? ''))) { r.lastEventAt = now(); emit(r); } return; }
  // /compact (o el automático): Claude anota cuánto contexto quedó. Hasta su próxima respuesta, el medidor usa eso.
  if (e.type === 'system' && e.subtype === 'compact_boundary') {
    const post = Number(e.compactMetadata?.postTokens);
    r.ctxPost = Number.isFinite(post) && post > 0 ? post : 0;
    log(r, 'sys', `Compactó su contexto${e.compactMetadata?.preTokens ? `: de ${fmtK(e.compactMetadata.preTokens)} a ${fmtK(r.ctxPost)} tokens` : ''}`);
    if (!r.restoring) emit(r); // el medidor del escritorio baja ya, sin esperar otro evento del robot
    return;
  }
  if (e.type === 'assistant' && e.message) {
    // Un mensaje llega en varias lineas con el mismo id; la ultima trae el usage final.
    if (e.message.id && e.message.usage) { r.msgUsage.set(e.message.id, e.message.usage); r.ctxPost = null; }
    if (e.message.model && e.message.model !== '<synthetic>') r.model = e.message.model;
    for (const c of e.message.content || []) {
      if (c.type === 'text' && c.text.trim()) {
        log(r, 'agent', c.text.trim(), { at: e.timestamp });
        r.bubble = trunc(c.text, 140);
        emit(r);
      }
    }
  }
  if (e.type === 'user' && e.message) {
    const content = e.message.content;
    const text = typeof content === 'string' ? content : (content || []).map(c => c.text || '').join(' ');
    if (/<bash-(input|stdout|stderr)>/.test(text)) { shellLog(r, text); r.lastEventAt = now(); emit(r); return; }
    // Esc no dispara Stop: la interrupcion solo se ve en el transcript.
    if (/\[Request interrupted/.test(text) && !r.restoring) {
      log(r, 'sys', 'Interrumpido');
      r.needsPermission = false;
      setState(r, 'idle');
      emit(r);
    }
  }
}

setInterval(() => { for (const r of robots.values()) pumpTranscript(r); }, 1000);

/* ---------- hooks ---------- */

function hold(r, body, closers = []) {
  const id = crypto.randomBytes(3).toString('hex');
  r.hold = { id, tool: describeTool(body.tool_name, body.tool_input) };
  setState(r, 'input');
  emit(r);
  log(r, 'sys', `Pide permiso: ${r.hold.tool}`);
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      pending.delete(id);
      r.hold = null;
      emit(r);
      resolve(null);
    }, APPROVAL_TIMEOUT_MS);
    pending.set(id, {
      r, tool: body.tool_name, input: body.tool_input,
      decide: d => { clearTimeout(timer); pending.delete(id); r.hold = null; resolve(d); }
    });
    closers.push(() => { const p = pending.get(id); if (p) { p.decide(null); log(r, 'sys', 'La consola cerró el permiso'); emit(r); } });
  });
}

// Cuestionarios (AskUserQuestion): la oficina retiene el hook y te muestra las preguntas con sus opciones.
// Lo que respondas vuelve como `answers` en updatedInput y el robot lo recibe como si contestaras en su consola.
// «Responder en la consola», el reinicio de la oficina o el tiempo límite sueltan el hook y la consola muestra su menú.
function askHold(r, body, timeoutMs = APPROVAL_TIMEOUT_MS, closers = []) {
  const id = crypto.randomBytes(3).toString('hex');
  const questions = body.tool_input.questions.slice(0, 8).map(q => ({
    question: String(q.question ?? ''), header: trunc(q.header, 30), multiSelect: !!q.multiSelect,
    options: (q.options || []).slice(0, 10).map(o => ({ label: String(o.label ?? ''), description: trunc(o.description, 300) }))
  }));
  r.ask = { id, questions, at: now() };
  r.inputAt = now();
  setState(r, 'input');
  log(r, 'sys', `Te hizo ${questions.length === 1 ? 'una pregunta' : `${questions.length} preguntas`} con opciones`);
  emit(r);
  return new Promise(resolve => {
    const release = (out, note) => { clearTimeout(timer); pending.delete(id); if (r.ask?.id === id) r.ask = null; if (robots.get(r.name) === r) { if (note) log(r, 'sys', note); emit(r); } resolve(out); };
    const timer = setTimeout(() => release(null, 'Las preguntas pasaron a su consola (nadie respondió en la oficina)'), timeoutMs);
    pending.set(id, { r, ask: true, input: body.tool_input, release });
    closers.push(() => { if (pending.has(id)) { release(null, 'La consola cerró la pregunta (se respondió o canceló allá)'); if (r.state === 'input' && !r.hold && !r.needsPermission) setState(r, 'working'); emit(r); } });
  });
}

function answerAsk(r, id, answers, toConsole) {
  const p = pending.get(id);
  if (!p?.ask || p.r !== r) return false;
  if (toConsole) { p.release(null, 'Responderás las preguntas en su consola'); return true; }
  const clean = {};
  for (const q of r.ask?.questions || []) {
    const a = String(answers?.[q.question] ?? '').trim();
    if (!a) throw new Error(`Falta responder: ${q.header || q.question}`);
    clean[q.question] = a.slice(0, 2000);
  }
  log(r, 'user', Object.entries(clean).map(([q, a]) => `**${q}** → ${a}`).join('\n'));
  setState(r, 'working');
  p.release({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'Respondido desde la oficina', updatedInput: { ...p.input, answers: clean } } });
  return true;
}

function decide(id, decision) {
  const p = pending.get(id);
  if (!p || p.ask) return false;
  let d = decision === 'allow' ? 'allow' : 'deny';
  let reason = `Decidido desde la oficina (${d})`;
  if (d === 'allow' && p.tool === 'Bash' && NEVER_ALLOW.some(rx => rx.test(p.input?.command || ''))) {
    d = 'deny';
    reason = 'Comando prohibido por la oficina';
  }
  p.decide({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: d, permissionDecisionReason: reason } });
  log(p.r, 'sys', `Permiso ${d === 'allow' ? 'aprobado' : 'denegado'}${reason.startsWith('Comando') ? ' (comando prohibido)' : ''}`);
  setState(p.r, 'working');
  emit(p.r);
  return true;
}

function subFor(r, body) {
  if (!body.agent_id || !body.agent_type) return null;
  let s = r.subs.find(x => x.id === body.agent_id);
  if (!s) {
    s = r.subs.find(x => !x.id && x.status === 'running' && x.type === body.agent_type) || r.subs.find(x => !x.id && x.status === 'running');
    if (s) s.id = body.agent_id;
  }
  return s;
}

async function onHook(name, body, via = '', closers = []) {
  // Pregunta: la atiende el hook largo (via=ask). Si llega por el general, espera un momento por si llega el largo;
  // los robots lanzados antes de este cambio solo tienen el general y siguen como antes (9 minutos).
  if (body.hook_event_name === 'PreToolUse' && body.tool_name === 'AskUserQuestion') {
    const r0 = robots.get(name);
    if (via === 'ask') { if (r0) r0.longAsk = true; }
    else if (r0?.longAsk) return null;
    else { await new Promise(res => setTimeout(res, 1500)); if (robots.get(name)?.longAsk) return null; }
  }
  fs.appendFileSync(EVENTS_FILE, JSON.stringify({ at: now(), robot: name, ...body }) + '\n');
  if (body.hook_event_name === 'SessionStart') registerSession({ robot: name, ...body });
  const r = robots.get(name);
  if (!r) return null; // robot que la oficina no lanzo: no se toca
  r.lastEventAt = now(); // la UI marca «sin actividad» a un robot ocupado que lleva mucho sin eventos
  if (body.session_id) r.sessionId = body.session_id;
  if (body.transcript_path && r.transcript !== body.transcript_path) {
    r.transcript = body.transcript_path;
    r.offset = 0;
    r.partial = '';
  }
  // Antes de anotar una herramienta, lo que el robot ya escribió en el transcript (p. ej. «Voy a contar…»):
  // así la conversación queda en el orden en que pasó y el avance no aparece después de su herramienta.
  if (!r.restoring && (body.hook_event_name === 'PreToolUse' || body.hook_event_name === 'PostToolUse')) pumpTranscript(r);
  const internalHelper = body.agent_id && !body.agent_type;
  const sub = subFor(r, body);

  switch (body.hook_event_name) {
    case 'SessionStart':
      log(r, 'sys', `Sesión ${body.source ?? ''} · modelo ${body.model ?? ''}`);
      break;

    case 'UserPromptSubmit': {
      const p = String(body.prompt ?? '');
      if (p.startsWith('<agent-message')) log(r, 'sub', 'Un subagente entregó su resultado');
      // Claude Code le avisa al robot cuando termina algo que dejó en segundo plano: no lo escribiste tú.
      else if (/^\s*<task-notification>/.test(p)) log(r, 'bg', taskNote(p));
      else log(r, 'user', p);
      r.needsPermission = false;
      setState(r, 'working');
      break;
    }

    case 'PreToolUse': {
      if (internalHelper) break;
      const what = describeTool(body.tool_name, body.tool_input);
      if (sub) {
        sub.activity = what;
        emit(r);
      } else {
        r.activity = what;
        r.tool = body.tool_name; // la web anima al robot según la herramienta que usa
        r.needsPermission = false;
        log(r, 'tool', what);
        if (body.tool_name === 'Agent' || body.tool_name === 'Task') {
          const type = body.tool_input?.subagent_type || 'general-purpose';
          r.subs.push({ id: null, type, desc: trunc(body.tool_input?.description, 60), status: 'running', activity: '' });
          r.pendingSubs++;
          setState(r, 'delegating');
        } else if (r.state !== 'delegating') {
          setState(r, 'working');
        }
        emit(r);
      }
      if (!sub && body.tool_name === 'AskUserQuestion' && Array.isArray(body.tool_input?.questions)) return askHold(r, body, via === 'ask' ? ASK_TIMEOUT_MS : APPROVAL_TIMEOUT_MS, closers);
      if (APPROVAL && HOLD_TOOLS.has(body.tool_name)) return hold(r, body, closers);
      break;
    }

    case 'PostToolUse': {
      if (internalHelper) break;
      if (['Write', 'Edit', 'MultiEdit'].includes(body.tool_name)) trackDoc(r, body.tool_name, body.tool_input?.file_path);
      if (!sub && r.tool) { r.tool = ''; emit(r); } // entre herramientas, el robot piensa
      break;
    }

    case 'SubagentStop': {
      if (!body.agent_type) break; // ayudante interno de Claude Code
      const s = sub || r.subs.find(x => x.status === 'running');
      if (s && s.status === 'running') {
        s.status = 'done';
        s.activity = '';
        r.pendingSubs = Math.max(0, r.pendingSubs - 1);
        log(r, 'sub', `${s.type} terminó`);
      }
      if (r.pendingSubs === 0 && r.state === 'delegating') setState(r, 'working');
      emit(r);
      break;
    }

    case 'Notification': {
      const msg = String(body.message ?? '');
      if (/permission/i.test(msg)) {
        r.needsPermission = true;
        log(r, 'sys', 'Pide permiso en su consola');
        setState(r, 'input');
        emit(r);
      }
      break;
    }

    case 'Stop':
      pumpTranscript(r);
      finishTurn(r, body.last_assistant_message);
      break;
  }
  return null; // sin salida: Claude Code sigue su flujo normal
}

/* ---------- adjuntos ---------- */
// Se guardan dentro del workspace para que el robot los abra con Read; se borran a los 7 dias.

function validAttachments(list) {
  return (Array.isArray(list) ? list : [])
    .map(p => path.resolve(WORKSPACE, String(p)))
    .filter(p => p.startsWith(ATTACH_DIR + path.sep) && fs.existsSync(p));
}

function attachmentNote(list) {
  const files = validAttachments(list);
  if (!files.length) return '';
  return ` [Adjuntos: ${files.map(f => path.relative(WORKSPACE, f)).join(', ')} — ábrelos con la herramienta Read]`;
}

function cleanAttachments() {
  const walk = dir => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(p);
        try { if (!fs.readdirSync(p).length) fs.rmdirSync(p); } catch { /* en uso */ }
      } else if (Date.now() - fs.statSync(p).mtimeMs > ATTACH_TTL_MS) {
        fs.unlinkSync(p);
      }
    }
  };
  walk(ATTACH_DIR);
}
cleanAttachments();
setInterval(cleanAttachments, 6 * 60 * 60 * 1000);

/* ---------- tmux ---------- */

async function ensureSession() {
  try {
    await run('tmux', ['has-session', '-t', SESSION]);
  } catch {
    await run('tmux', ['new-session', '-d', '-s', SESSION, '-n', 'lobby', '-c', WORKSPACE]);
  }
  await run('tmux', ['set-option', '-t', SESSION, '@office_port', String(PORT)]).catch(() => {});
}

// Si la sesión de tmux ya es de otra oficina que sigue viva en otro puerto, no arrancar: le robaríamos los robots.
async function guardSession() {
  try { await run('tmux', ['has-session', '-t', SESSION]); } catch { return; } // la sesión se crea al lanzar el primer robot
  let owner = '';
  try { owner = (await run('tmux', ['show-options', '-v', '-t', SESSION, '@office_port'])).stdout.trim(); } catch { /* sin dueño */ }
  if (owner && owner !== String(PORT)) {
    let alive = true;
    try { await fetch(`http://127.0.0.1:${owner}/api/setup`, { signal: AbortSignal.timeout(1500) }); } catch { alive = false; }
    if (alive) {
      console.error(`La sesión de tmux «${SESSION}» ya la usa otra oficina que corre en el puerto ${owner}.`);
      console.error('Arranca esta con otra sesión y otro puerto, por ejemplo: OFFICE_SESSION=office-2 OFFICE_PORT=4778 node daemon/daemon.mjs');
      process.exit(1);
    }
  }
  await run('tmux', ['set-option', '-t', SESSION, '@office_port', String(PORT)]).catch(() => {});
}

async function launch({ kind, skill, args, text, permissionMode, name, origin, label: customLabel, title, leaveWhenDone, attachments, routine, sala: salaId, parent, color, look }) {
  // El tope cuenta solo los que trabajan: los que terminaron esperan su baja sin gastar cuota.
  const active = [...robots.values()].filter(x => x.state !== 'done');
  if (active.filter(x => !x.consoleLost).length + launching.size >= maxRobots) throw new Error(`Ya hay ${maxRobots} robots trabajando (tope de la cuota). Súbelo con + en la barra o espera a que alguno termine.`);
  const taken = n => robots.has(n) || launching.has(n);
  name = (name || NAMES.find(n => !taken(n)) || `robot-${Date.now() % 1000}`).toLowerCase();
  if (!/^[a-z0-9-]{1,20}$/.test(name)) throw new Error('Nombre inválido: usa minúsculas, números y guiones.');
  if (taken(name)) throw new Error(`Ya existe un robot llamado ${name}.`);
  // El nombre queda apartado desde ya: dos pedidos casi simultáneos (doble clic) no abren dos consolas iguales.
  launching.add(name);
  try { return await launchReserved({ kind, skill, args, text, permissionMode, name, origin, customLabel, title, leaveWhenDone, attachments, routine, salaId, parent, color, look }); }
  finally { launching.delete(name); }
}
const launching = new Set();
async function launchReserved({ kind, skill, args, text, permissionMode, name, origin, customLabel, title, leaveWhenDone, attachments, routine, salaId, parent, color, look }) {

  let prompt, label;
  if (kind === 'skill') {
    skill = String(skill || '').replace(/^\//, '').trim();
    if (!/^[a-z0-9:_-]+$/i.test(skill)) throw new Error('Elige una skill válida.');
    prompt = `/${skill} ${args || ''}`.trim();
    label = prompt;
  } else {
    kind = 'libre';
    prompt = String(text || '').trim();
    if (!prompt) throw new Error('Escribe qué necesitas que haga el robot.');
    label = trunc(prompt, 80);
    skill = null;
  }
  if (customLabel) label = trunc(customLabel, 80);
  prompt += attachmentNote(attachments);
  const rt = routine ? routines.find(x => x.id === routine) : null;
  const sala = salaId ? salas.find(x => x.id === salaId) : null;
  if (salaId && !sala) throw new Error('Esa sala de épica no existe.');
  if (sala) prompt += salaPreamble(sala);
  const place = sala ? roomSeat(`sala-${sala.id}`, sala.name, { sala: sala.id }) : rt ? roomSeat(rt.id, rt.name) : freeDesk();
  if (!place) throw new Error('No hay escritorios libres en la oficina.');
  if (permissionMode && !PERMISSION_MODES.has(permissionMode)) throw new Error('Modo de permisos inválido.');

  await ensureSession();
  const sessionId = crypto.randomUUID();
  const r = {
    name, kind, skill, label, title: cleanTitle(title), prompt, color: Number.isInteger(color) ? color : colorSeq++ % 8, look: look || null, place,
    request: { kind, skill, args: kind === 'skill' ? String(args || '') : '', text: kind === 'libre' ? String(text || '').trim() : '', permissionMode: permissionMode || '' }, permissionMode: permissionMode || '', leaveWhenDone: !!leaveWhenDone,
    origin: trunc(origin || 'Lanzado por la API local sin indicar quién', 200),
    routine: routine || null, sessionId, transcript: null, offset: 0, partial: '', msgUsage: new Map(), startedAt: now(),
    alive: true, state: 'walking', timeline: [{ at: now(), s: 'walking' }], subs: [], pendingSubs: 0, bubble: '', activity: '',
    needsPermission: false, hold: null, docs: [], log: [], parent: parent || null
  };
  robots.set(name, r);
  // env -u: si ANTHROPIC_API_KEY esta en el entorno, `claude` la usa en vez del login de la suscripcion.
  const tmuxArgs = ['new-window', '-d', '-t', `${SESSION}:`, '-n', name, '-c', WORKSPACE,
    '-e', `OFFICE_ROBOT=${name}`, '-e', `OFFICE_PORT=${PORT}`,
    'env', '-u', 'ANTHROPIC_API_KEY',
    CLAUDE_BIN, '--settings', SETTINGS, '--session-id', sessionId, '--append-system-prompt', ROBOT_HINTS];
  if (permissionMode) tmuxArgs.push('--permission-mode', permissionMode);
  tmuxArgs.push(prompt);
  try {
    await run('tmux', tmuxArgs);
  } catch (e) {
    robots.delete(name);
    throw new Error(`No se pudo abrir la consola: ${e.message}`);
  }
  log(r, 'sys', `Encargo: ${label}`);
  log(r, 'sys', r.origin);
  console_(name, 'lanzado', `${label} · tmux attach -t ${SESSION}:${name}`);
  emit(r);
  return r;
}

async function say(r, text, attachments) {
  const target = `${SESSION}:${r.name}`;
  const buffer = `office-${r.name}`;
  const full = (String(text || '').trim() || 'Te adjunto estos archivos.') + attachmentNote(attachments);
  // paste-buffer -p usa bracketed paste: los saltos de linea llegan como parte del mensaje
  // en vez de enviarlo a medias (send-keys los tomaria como Enter).
  await run('tmux', ['set-buffer', '-b', buffer, full]);
  await run('tmux', ['paste-buffer', '-p', '-d', '-b', buffer, '-t', target]);
  await new Promise(res => setTimeout(res, 300));
  await run('tmux', ['send-keys', '-t', target, 'Enter']);
}

async function pressKey(r, key) {
  // approve = Enter sobre la opcion resaltada ("Yes"); reject = Esc (cancela e interrumpe el turno)
  await run('tmux', ['send-keys', '-t', `${SESSION}:${r.name}`, key === 'approve' ? 'Enter' : 'Escape']);
  r.needsPermission = false;
  log(r, 'sys', key === 'approve' ? 'Aprobaste el permiso desde la oficina' : 'Rechazaste el permiso desde la oficina');
  setState(r, key === 'approve' ? 'working' : 'idle');
  emit(r);
}

async function pane(r) {
  const { stdout } = await run('tmux', ['capture-pane', '-p', '-t', `${SESSION}:${r.name}`]);
  return stdout.replace(/\s+$/, '');
}

async function openConsole(r) {
  const cmd = `tmux attach -t ${SESSION}:${r.name}`;
  await run('osascript', ['-e', `tell application "Terminal" to do script "${cmd}"`, '-e', 'tell application "Terminal" to activate']);
}

function listSkills(ws = WORKSPACE) {
  const out = new Set();
  const dirs = [
    [path.join(ws, '.claude/commands'), true],
    [path.join(ws, '.claude/skills'), false],
    [path.join(os.homedir(), '.claude/commands'), true],
    [path.join(os.homedir(), '.claude/skills'), false]
  ];
  for (const [dir, filesOnly] of dirs) {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (filesOnly && e.name.endsWith('.md')) out.add(e.name.slice(0, -3));
      if (!filesOnly && !e.name.startsWith('.') && e.name !== 'synced') out.add(e.name);
    }
  }
  return [...out].sort();
}

/* ---------- rutinas ---------- */
// Dos tipos:
// - watch: vigila PRs (un repo o toda la organizacion, con filtro de busqueda de GitHub). El chequeo
//   es deterministico (gh): solo lanza un robot por PR nuevo o con commits nuevos. Sin cambios no gasta cuota.
// - agenda: lanza un robot con instrucciones libres y un archivo de memoria compartido entre ejecuciones.
//   Gasta cuota en cada ejecucion.
// - wake (despertador): espera una condición (un PR aprobado/mergeado/comentado/con checks, un ticket de Nexus
//   que cambia de estado o una hora) y entonces te avisa, le escribe a un robot, retoma un resumen del archivo o
//   lanza un robot. Vigilar no gasta cuota (gh y Nexus por API); solo la acción, si despierta a un robot.
// Horario (schedule): cada N minutos (con horario laboral opcional), todos los días/días elegidos a una hora, o
// una sola vez. Los horarios no gastan cuota: deciden cuándo corre la rutina.

const ROUTINES_FILE = path.join(RUNS, 'routines.json');
const ROUTINES_DIR = path.join(RUNS, 'routines');
let routines = [];
try { routines = JSON.parse(fs.readFileSync(ROUTINES_FILE, 'utf8')); } catch { routines = []; }
for (const rt of routines) {
  rt.running = false;
  rt.schedule ||= { mode: 'every', everyMin: rt.everyMin || 30 }; // formato anterior: solo «cada N min»
  // Formato anterior: solo repo + accion.
  if (!rt.type) { rt.type = 'watch'; rt.source = { scope: 'repo', repo: rt.repo, query: '' }; delete rt.repo; }
}

function saveRoutines() {
  const data = routines.map(({ running, ...rest }) => rest);
  fs.writeFileSync(ROUTINES_FILE, JSON.stringify(data, null, 2));
}

/* horarios */
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
const hmOf = t => { const [h, m] = String(t || '0:0').split(':').map(Number); return (h || 0) * 60 + (m || 0); };
const atMin = (base, k, mins) => { const d = new Date(base); d.setDate(d.getDate() + k); d.setHours(0, 0, 0, 0); d.setMinutes(mins); return d.getTime(); };
// Primer momento >= t dentro del horario laboral (si lo hay).
function inWindow(sch, t) {
  const w = sch.hours; if (!w) return t;
  const days = w.days?.length ? w.days : ALL_DAYS;
  for (let k = 0; k < 9; k++) {
    const start = atMin(t, k, hmOf(w.from)), end = atMin(t, k, hmOf(w.to));
    if (!days.includes(new Date(start).getDay())) continue;
    if (t < end) return Math.max(t, start);
  }
  return t + 864e5;
}
const firstRun = (rt, t = Date.now()) => rt.schedule?.mode === 'every' ? inWindow(rt.schedule, t) : nextRun(rt, t);
function nextRun(rt, from = Date.now()) {
  const sch = rt.schedule || { mode: 'every', everyMin: 30 };
  if (sch.mode === 'once') return rt.doneOnce ? Infinity : (Date.parse(sch.at) || Infinity);
  if (sch.mode === 'daily') {
    const days = sch.days?.length ? sch.days : ALL_DAYS;
    for (let k = 0; k < 9; k++) { const t = atMin(from, k, hmOf(sch.time)); if (t > from && days.includes(new Date(t).getDay())) return t; }
    return from + 864e5;
  }
  return inWindow(sch, from + (sch.everyMin || 30) * 60000);
}
function cleanSchedule(b) {
  const sch = b.schedule || { mode: 'every', everyMin: b.everyMin };
  const days = d => (Array.isArray(d) ? d : []).map(Number).filter(n => Number.isInteger(n) && n >= 0 && n <= 6);
  const time = t => { if (!/^\d{1,2}:\d{2}$/.test(String(t || ''))) throw new Error('Hora inválida: usa HH:MM, ej. 08:00.'); return String(t).padStart(5, '0'); };
  if (sch.mode === 'daily') { const ds = days(sch.days); if (!ds.length) throw new Error('Elige al menos un día.'); return { mode: 'daily', time: time(sch.time), days: ds }; }
  if (sch.mode === 'once') { const t = Date.parse(sch.at); if (!t) throw new Error('Elige la fecha y hora.'); return { mode: 'once', at: new Date(t).toISOString() }; }
  const everyMin = Number(sch.everyMin);
  if (!Number.isFinite(everyMin) || everyMin < 1 || everyMin > 1440) throw new Error('La frecuencia debe estar entre 1 y 1440 minutos.');
  const out = { mode: 'every', everyMin };
  if (sch.hours) { const ds = days(sch.hours.days); out.hours = { from: time(sch.hours.from), to: time(sch.hours.to), days: ds.length ? ds : [1, 2, 3, 4, 5] }; if (hmOf(out.hours.to) <= hmOf(out.hours.from)) throw new Error('El horario laboral debe terminar después de empezar.'); }
  return out;
}

function routineView(rt) {
  const live = n => { const r = robots.get(n); if (!r) return null; const u = usage(r); return { state: r.state, tokens: u.out + u.in + u.cacheWrite }; };
  return {
    id: rt.id, type: rt.type, name: rt.name, everyMin: rt.schedule?.everyMin || rt.everyMin, schedule: rt.schedule, source: rt.source, onlyNew: rt.onlyNew,
    includeDrafts: rt.includeDrafts, action: rt.action, extra: rt.extra, text: rt.text, delegate: rt.delegate, events: rt.events || ['new', 'commits'],
    cond: rt.cond || null, wake: rt.wake || null, status: rt.status || '', fired: rt.fired || null, doneOnce: !!rt.doneOnce,
    memory: rt.type === 'agenda' ? path.relative(WORKSPACE, memoryPath(rt)) : null, runs: rt.runs || 0,
    permissionMode: rt.permissionMode, paused: rt.paused, running: !!rt.running,
    nextAt: Number.isFinite(rt.nextAt) ? rt.nextAt : null, lastRun: rt.lastRun, seen: Object.keys(rt.seen || {}).length,
    history: (rt.history || []).map(h => ({ ...h, robots: (h.robots || []).map(x => ({ ...x, ...(live(x.name) || {}) })) }))
  };
}

function emitRoutines() { broadcast({ type: 'routines', routines: routines.map(routineView) }); }
// Próxima ejecución al arrancar la oficina (aquí, ya definidas las funciones de horario).
for (const rt of routines) rt.nextAt = rt.paused ? Infinity : rt.schedule.mode === 'every' ? firstRun(rt, Date.now() + 20000) : nextRun(rt, Date.now());

// Indice nombre-de-repo → carpeta local del workspace, para la variable {local}.
let repoIndex = { at: 0, map: new Map() };
async function localRepoPath(nameWithOwner) {
  if (Date.now() - repoIndex.at > 10 * 60000) {
    const map = new Map();
    try {
      const { stdout } = await run('find', [WORKSPACE, '-maxdepth', '3', '-name', '.git', '-type', 'd', '-not', '-path', '*/reviews/*'], { timeout: 30000 });
      for (const g of stdout.split('\n').filter(Boolean)) {
        const dir = path.dirname(g);
        if (!map.has(path.basename(dir))) map.set(path.basename(dir), dir);
      }
    } catch { /* sin indice: {local} queda vacio */ }
    repoIndex = { at: Date.now(), map };
  }
  return repoIndex.map.get(String(nameWithOwner).split('/').pop()) || '';
}

function fillTemplate(s, pr) {
  return String(s || '').replace(/\{(url|number|repo|head|base|title|author|local|event)\}/g, (_, k) => pr[k] ?? '');
}

function jobFor(rt, pr) {
  const origin = `Lanzado por la rutina «${rt.name}» para ${pr.repo}#${pr.number} (${trunc(pr.title, 60)})${pr.event ? ` · ${pr.event}` : ''}`;
  const extra = rt.extra ? `\n\nInstrucciones adicionales: ${fillTemplate(rt.extra, pr)}` : '';
  const base = { permissionMode: rt.permissionMode, origin, leaveWhenDone: true, routine: rt.id };
  if (rt.action.kind === 'skill') return { ...base, kind: 'skill', skill: rt.action.skill, args: fillTemplate(rt.action.args, pr) + extra };
  return { ...base, kind: 'libre', text: fillTemplate(rt.action.text, pr) + extra };
}

// Lo que se mira de cada PR para los eventos (aprobado, cambios pedidos, comentario, checks). Solo se pide si la
// rutina vigila alguno de esos eventos: es más pesado para la API de GitHub (no para tu cuota de Claude).
const PR_RICH = 'reviewDecision,statusCheckRollup,comments,reviews';
function checksOf(list) {
  const checks = list || [];
  if (!checks.length) return 'none';
  const c = x => String(x.conclusion || x.state || '').toUpperCase();
  if (checks.some(x => ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(c(x)))) return 'fail';
  if (checks.some(x => (x.status && x.status !== 'COMPLETED') || ['PENDING', 'EXPECTED', 'QUEUED', 'IN_PROGRESS', ''].includes(c(x)))) return 'pending';
  return 'ok';
}
async function findPRs(rt) {
  const s = rt.source;
  const rich = (rt.events || []).some(e => !['new', 'commits'].includes(e));
  const query = String(s.query || '').trim();
  const opts = { timeout: 60000 };
  let prs;
  if (s.scope === 'repo') {
    const args = ['pr', 'list', '-R', s.repo, '--state', 'open', '--limit', '50', '--json', `number,headRefOid,title,url,headRefName,baseRefName,isDraft,author${rich ? ',' + PR_RICH : ''}`];
    if (query) args.push('--search', query);
    prs = JSON.parse((await run('gh', args, opts)).stdout).map(p => ({ ...p, repo: s.repo }));
  } else {
    const args = ['search', 'prs', '--owner', s.owner, '--state', 'open', '--limit', '30', '--json', 'number,title,url,repository,isDraft,author'];
    if (query) args.push('--', ...query.split(/\s+/));
    const found = JSON.parse((await run('gh', args, opts)).stdout);
    prs = [];
    // La busqueda no trae ramas ni commit: se piden PR por PR.
    for (const p of found) {
      const repo = p.repository.nameWithOwner;
      const v = JSON.parse((await run('gh', ['pr', 'view', String(p.number), '-R', repo, '--json', `headRefOid,headRefName,baseRefName${rich ? ',' + PR_RICH : ''}`], opts)).stdout);
      prs.push({ ...p, ...v, repo });
    }
  }
  prs = prs.filter(p => rt.includeDrafts || !p.isDraft);
  for (const p of prs) {
    p.key = `${p.repo}#${p.number}`;
    p.head = p.headRefName;
    p.base = p.baseRefName;
    p.author = p.author?.login || '';
    p.local = await localRepoPath(p.repo);
    p.review = p.reviewDecision || '';
    p.ncomments = (p.comments || []).length + (p.reviews || []).length;
    p.checks = rich ? checksOf(p.statusCheckRollup) : '';
    delete p.comments; delete p.reviews; delete p.statusCheckRollup;
  }
  return prs;
}
// Qué pasó con un PR desde la última vez (vacío si nada que le interese a la rutina).
const EV_TXT = { new: 'PR nuevo', commits: 'commits nuevos', approved: 'aprobado', changes: 'pidieron cambios', comment: 'comentario o review nuevo', checks_fail: 'falló un check' };
function prEvents(rt, p, prev) {
  const want = new Set(rt.events || ['new', 'commits']), out = [];
  if (!prev) { if (want.has('new')) out.push('new'); return out; }
  if (want.has('commits') && prev.sha !== p.headRefOid) out.push('commits');
  if (want.has('approved') && p.review === 'APPROVED' && prev.review !== 'APPROVED') out.push('approved');
  if (want.has('changes') && p.review === 'CHANGES_REQUESTED' && prev.review !== 'CHANGES_REQUESTED') out.push('changes');
  if (want.has('comment') && p.ncomments > (prev.ncomments ?? p.ncomments)) out.push('comment');
  if (want.has('checks_fail') && p.checks === 'fail' && prev.checks !== 'fail') out.push('checks_fail');
  return out;
}
const snapOf = p => ({ sha: p.headRefOid, review: p.review, ncomments: p.ncomments, checks: p.checks });

// Freno: por comentarios nuevos no se lanza más de un robot por PR cada 30 min (un hilo activo no dispara en cadena).
const COMMENT_COOLDOWN_MS = 30 * 60000;
async function checkWatch(rt) {
  const prs = await findPRs(rt);
  rt.seen = rt.seen || {};
  rt.lastLaunch = rt.lastLaunch || {};
  // Formato anterior: seen[key] era solo el commit.
  for (const k of Object.keys(rt.seen)) if (typeof rt.seen[k] === 'string') rt.seen[k] = { sha: rt.seen[k] };
  // Se olvidan los PRs que ya no aparecen (cerrados o fuera del filtro).
  for (const k of Object.keys(rt.seen)) if (!prs.some(p => p.key === k)) { delete rt.seen[k]; delete rt.lastLaunch[k]; }
  if (rt.onlyNew && !rt.baselined) {
    for (const p of prs) rt.seen[p.key] = snapOf(p);
    rt.baselined = true;
    return { open: prs.length, changed: 0, dispatched: 0, pending: 0, note: `Línea base: ${prs.length} PRs marcados como vistos; desde ahora solo actúa sobre lo que pase después` };
  }
  let dispatched = 0, pending = 0, changed = 0, note = null;
  const launched = [];
  for (const p of prs) {
    const prev = rt.seen[p.key];
    let evs = prEvents(rt, p, prev);
    if (evs.length === 1 && evs[0] === 'comment' && Date.now() - (rt.lastLaunch[p.key] || 0) < COMMENT_COOLDOWN_MS) evs = [];
    if (!evs.length) { rt.seen[p.key] = snapOf(p); continue; } // nada que le interese: se anota cómo está ahora
    changed++;
    p.event = evs.map(e => EV_TXT[e]).join(', ');
    try {
      const r = await launch(jobFor(rt, p));
      launched.push(r.name);
      rt.seen[p.key] = snapOf(p);
      rt.lastLaunch[p.key] = Date.now();
      dispatched++;
    } catch (e) {
      // Sin cupo o sin escritorio: queda sin marcar y se reintenta en el proximo chequeo.
      pending++;
      note = e.message;
    }
  }
  return { open: prs.length, changed, dispatched, pending, note, robots: launched };
}

function memoryPath(rt) { return path.join(ROUTINES_DIR, rt.id, 'memoria.md'); }

function agendaPrompt(rt) {
  const mem = memoryPath(rt);
  let p = `${rt.text}\n\n--- Contexto de la rutina «${rt.name}» (ejecución #${rt.runs}, ${scheduleText(rt.schedule)}) ---\n`;
  p += `Memoria entre ejecuciones: ${mem}. Léela al empezar y actualízala al terminar con lo que hiciste (por ejemplo, qué PRs ya procesaste y con qué commit) para no repetir trabajo en la próxima ejecución.`;
  if (rt.delegate) {
    const safeName = rt.name.replace(/['"\\]/g, '');
    p += `\nPara pasarle trabajo a otro robot de la oficina usa: curl -s -X POST http://127.0.0.1:${PORT}/api/robots -H 'Content-Type: application/json' -d '{"kind":"skill","skill":"review-deep","args":"<argumentos>","origin":"Delegado por la rutina ${safeName}","leaveWhenDone":true,"routine":"${rt.id}"}' (o {"kind":"libre","text":"<instrucciones>",...}). Un robot por pedido. Si responde que no hay cupo, anótalo en la memoria para la próxima ejecución.`;
  }
  return p;
}

async function runAgenda(rt) {
  const prev = rt.lastRobot && robots.get(rt.lastRobot);
  if (prev && prev.state !== 'done') return { dispatched: 0, note: `La ejecución anterior (${prev.name}) sigue trabajando; se salta esta` };
  fs.mkdirSync(path.dirname(memoryPath(rt)), { recursive: true });
  if (!fs.existsSync(memoryPath(rt))) fs.writeFileSync(memoryPath(rt), `# Memoria de la rutina «${rt.name}»\n\n`);
  rt.runs = (rt.runs || 0) + 1;
  try {
    const r = await launch({
      kind: 'libre', text: agendaPrompt(rt), label: `Rutina «${rt.name}» #${rt.runs}`, permissionMode: rt.permissionMode,
      origin: `Ejecución #${rt.runs} de la rutina «${rt.name}»`, leaveWhenDone: true, routine: rt.id
    });
    rt.lastRobot = r.name;
    return { dispatched: 1, note: `Lanzó a ${r.name}`, robots: [r.name] };
  } catch (e) {
    rt.runs--;
    return { dispatched: 0, pending: 1, note: e.message };
  }
}

const DAY_NAMES = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
const daysText = ds => { const s = [...ds].sort().join(); return s === '0,1,2,3,4,5,6' ? 'todos los días' : s === '1,2,3,4,5' ? 'días hábiles' : ds.map(d => DAY_NAMES[d]).join(', '); };
function scheduleText(sch) {
  if (!sch) return '';
  if (sch.mode === 'once') return `una sola vez, ${new Date(sch.at).toLocaleString('es')}`;
  if (sch.mode === 'daily') return `${daysText(sch.days)} a las ${sch.time}`;
  return `cada ${sch.everyMin} min${sch.hours ? `, ${daysText(sch.hours.days)} de ${sch.hours.from} a ${sch.hours.to}` : ''}`;
}

/* despertador */
// PR por URL, owner/repo#123 o repo#123 (el dueño sale del remoto del repo en tu carpeta de trabajo).
async function resolvePR(ref) {
  ref = String(ref || '').trim();
  let m = /github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/.exec(ref) || /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(ref);
  if (m) return { repo: m[1], number: +m[2] };
  m = /^([\w.-]+)#(\d+)$/.exec(ref);
  if (!m) throw new Error('PR inválido: usa owner/repo#123, repo#123 o la URL del PR.');
  const local = await localRepoPath(m[1]);
  if (!local) throw new Error(`No encuentro el repo ${m[1]} en tu carpeta de trabajo: escríbelo como owner/repo#${m[2]}.`);
  const url = (await run('git', ['-C', local, 'remote', 'get-url', 'origin'])).stdout.trim();
  const o = /[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(url);
  if (!o) throw new Error(`No pude leer el dueño del repo ${m[1]}: escríbelo como owner/repo#${m[2]}.`);
  return { repo: `${o[1]}/${o[2]}`, number: +m[2] };
}
async function prStatus(repo, number) {
  const v = JSON.parse((await run('gh', ['pr', 'view', String(number), '-R', repo, '--json', 'state,title,url,' + PR_RICH], { timeout: 60000 })).stdout);
  return { state: v.state, review: v.reviewDecision || '', comments: (v.comments || []).length + (v.reviews || []).length, checks: checksOf(v.statusCheckRollup), title: v.title, url: v.url };
}
const WAKE_PR = { approved: 'se aprobó', merged: 'se mergeó', changes: 'pidieron cambios', comment: 'tiene un comentario o review nuevo', checks_ok: 'pasaron sus checks', checks_fail: 'falló un check', closed: 'se cerró o mergeó' };
function prHit(ev, s, base) {
  switch (ev) {
    case 'approved': return s.review === 'APPROVED';
    case 'merged': return s.state === 'MERGED';
    case 'changes': return s.review === 'CHANGES_REQUESTED';
    case 'comment': return s.comments > (base?.comments ?? s.comments);
    case 'checks_ok': return s.checks === 'ok';
    case 'checks_fail': return s.checks === 'fail';
    case 'closed': return s.state !== 'OPEN';
  }
  return false;
}
// Nexus: el token sale del entorno o de ~/.zshrc (como lo usan los robots). Solo se lee si hay un despertador de Nexus.
let nexusTok = { v: '', at: 0 };
async function nexusToken() {
  if (process.env.NEXUS_TOKEN) return process.env.NEXUS_TOKEN;
  if (nexusTok.v && Date.now() - nexusTok.at < 3600e3) return nexusTok.v;
  const { stdout } = await run('zsh', ['-c', 'source ~/.zshrc >/dev/null 2>&1; printf %s "$NEXUS_TOKEN"'], { timeout: 15000 }).catch(() => ({ stdout: '' }));
  nexusTok = { v: stdout.trim(), at: Date.now() };
  return nexusTok.v;
}
async function nexusItem(key) {
  const tok = await nexusToken();
  if (!tok) throw new Error('No encuentro NEXUS_TOKEN (ni en el entorno de la oficina ni en ~/.zshrc).');
  const res = await fetch('https://nexus.dropi.co/api/mcp', { method: 'POST', signal: AbortSignal.timeout(20000),
    headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'work_item', arguments: { action: 'get', key } } }) });
  const txt = await res.text();
  const body = txt.trim().startsWith('{') ? txt : (txt.split('\n').find(l => l.startsWith('data:')) || 'data:{}').slice(5);
  let item = {};
  try { item = JSON.parse(JSON.parse(body).result?.content?.[0]?.text || '{}'); } catch { /* respuesta rara */ }
  if (!item.key) throw new Error(`Nexus no devolvió ${key}${res.ok ? '' : ` (HTTP ${res.status})`}.`);
  return { title: item.title || '', state: item.state?.name || item.state?.code || '', code: item.state?.code || '', group: item.state?.group || '' };
}
const normS = t => String(t ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
// Revisa la condición del despertador (sin gastar cuota). Devuelve { hit, status, what }.
async function wakeCheck(rt) {
  const c = rt.cond;
  if (c.kind === 'time') { const t = Date.parse(c.at); return { hit: Date.now() >= t, status: `espera hasta ${new Date(t).toLocaleString('es')}`, what: `llegó la hora (${new Date(t).toLocaleString('es')})` }; }
  if (c.kind === 'pr') {
    const s = await prStatus(c.repo, c.number);
    rt.base ||= s;
    const rev = { APPROVED: 'aprobado', CHANGES_REQUESTED: 'con cambios pedidos', REVIEW_REQUIRED: 'esperando review' }[s.review] || 'sin review';
    return { hit: prHit(c.event, s, rt.base), status: `${c.repo}#${c.number} ${s.state === 'OPEN' ? 'abierto' : s.state === 'MERGED' ? 'mergeado' : 'cerrado'} · ${rev} · checks ${{ ok: 'verdes', fail: 'con fallas', pending: 'corriendo', none: 'sin checks' }[s.checks]}`, what: `el PR ${c.repo}#${c.number} ${WAKE_PR[c.event]} (${s.url})` };
  }
  if (c.kind === 'nexus') {
    const s = await nexusItem(c.key);
    rt.base ||= s;
    const hit = c.to === 'any' ? s.code !== rt.base.code : c.to === 'completed' ? s.group === 'completed' : normS(s.state) === normS(c.to) || normS(s.code) === normS(c.to);
    return { hit, status: `${c.key} «${trunc(s.title, 60)}»: ${s.state}`, what: `${c.key} pasó a «${s.state}»` };
  }
  return { hit: false, status: 'condición desconocida', what: '' };
}
// La acción del despertador: avisarte (sin cuota), escribirle a un robot, retomar un resumen o lanzar uno nuevo.
async function wakeAct(rt, what) {
  const a = rt.wake || { kind: 'notify' };
  const msg = `[Oficina] ⏰ Despertador «${rt.name}»: ${what}.${a.text ? `\n\n${a.text}` : ''}`;
  if (a.kind === 'say') {
    let r = robots.get(a.robot);
    if (!r) {
      const ar = [...archive].reverse().find(x => x.name === a.robot);
      if (!ar) throw new Error(`${a.robot} ya no está en la oficina ni en el archivo.`);
      r = await retake(ar.id, msg);
      return `${a.robot} se había ido: entró ${r.name} con su resumen`;
    }
    if (r.consoleLost) await revive(r);
    await say(r, msg);
    log(r, 'sys', `⏰ Lo despertó «${rt.name}»: ${what}`);
    return `le escribí a ${r.name}`;
  }
  if (a.kind === 'retake') { const r = await retake(a.archId, msg); return `entró ${r.name} con el resumen`; }
  if (a.kind === 'launch') {
    const r = await launch({ kind: 'libre', text: `${a.text}\n\n(Lo lanzó el despertador «${rt.name}»: ${what}.)`, title: rt.name, permissionMode: rt.permissionMode, origin: `Lanzado por el despertador «${rt.name}»` });
    return `lancé a ${r.name}`;
  }
  return 'solo aviso';
}
async function checkWake(rt) {
  const { hit, status, what } = await wakeCheck(rt);
  rt.status = status;
  if (!hit) return { dispatched: 0, note: status };
  const done = await wakeAct(rt, what); // si falla (sin cupo, etc.) lanza y se reintenta en la próxima revisión
  rt.fired = { at: now(), what, done };
  rt.paused = true;
  broadcast({ type: 'notice', text: `⏰ ${rt.name}: ${what} · ${done}` });
  return { dispatched: done === 'solo aviso' ? 0 : 1, note: `✓ Se cumplió: ${what} · ${done}`, robots: (/(?:entró|lancé a|escribí a) (\S+)/.exec(done) || [])[1] ? [/(?:entró|lancé a|escribí a) (\S+)/.exec(done)[1]] : [] };
}

async function checkRoutine(rt) {
  if (rt.running) return;
  rt.running = true;
  emitRoutines();
  try {
    rt.lastRun = { at: now(), ...(rt.type === 'agenda' ? await runAgenda(rt) : rt.type === 'wake' ? await checkWake(rt) : await checkWatch(rt)) };
  } catch (e) {
    rt.lastRun = { at: now(), error: trunc(e.stderr || e.message, 240) };
  }
  // Historial: las últimas 20 ejecuciones que hicieron algo (o fallaron), con los robots que lanzaron.
  const lr = rt.lastRun;
  if (lr.error || lr.dispatched || lr.pending || rt.type === 'agenda' || (rt.type === 'wake' && /^✓/.test(lr.note || ''))) {
    rt.history = [{ at: lr.at, note: lr.error || lr.note || '', error: !!lr.error, robots: (lr.robots || []).map(name => ({ name })) }, ...(rt.history || [])].slice(0, 20);
  }
  delete lr.robots;
  rt.running = false;
  if (rt.schedule?.mode === 'once' && rt.type !== 'wake') { rt.doneOnce = true; rt.paused = true; }
  rt.nextAt = rt.paused ? Infinity : nextRun(rt);
  saveRoutines();
  emitRoutines();
}

// Valida lo que llega del formulario y arma los campos de la rutina (sirve para crear, editar y la vista previa).
async function buildRoutine(b) {
  if (b.permissionMode && !PERMISSION_MODES.has(b.permissionMode)) throw new Error('Modo de permisos inválido.');
  const type = ['agenda', 'wake'].includes(b.type) ? b.type : 'watch';
  const f = { type, permissionMode: b.permissionMode || '', schedule: cleanSchedule(type === 'wake' ? { mode: 'every', everyMin: b.schedule?.everyMin || b.everyMin || 5 } : b) };
  if (type === 'agenda') {
    f.text = String(b.text || '').trim();
    if (!f.text) throw new Error('Escribe las instrucciones de la tarea programada.');
    f.delegate = !!b.delegate;
    f.name = trunc(b.name || trunc(f.text, 40), 60);
  } else if (type === 'wake') {
    const c = b.cond || {};
    if (c.kind === 'pr') {
      const pr = await resolvePR(c.ref);
      if (!WAKE_PR[c.event]) throw new Error('Elige qué esperar del PR.');
      f.cond = { kind: 'pr', repo: pr.repo, number: pr.number, event: c.event, ref: String(c.ref).trim() };
    } else if (c.kind === 'nexus') {
      const key = String(c.key || '').trim().toUpperCase();
      if (!/^[A-Z][A-Z0-9]{1,9}-\d{1,6}$/.test(key)) throw new Error('Ticket de Nexus inválido, ej. INT-40.');
      f.cond = { kind: 'nexus', key, to: String(c.to || 'any').trim() || 'any' };
    } else if (c.kind === 'time') {
      const t = Date.parse(c.at); if (!t) throw new Error('Elige la fecha y hora.');
      f.cond = { kind: 'time', at: new Date(t).toISOString() };
    } else throw new Error('Elige qué esperar.');
    const w = b.wake || {};
    if (w.kind === 'say') { if (!w.robot) throw new Error('Elige a qué robot escribirle.'); f.wake = { kind: 'say', robot: String(w.robot), text: String(w.text || '').trim() }; }
    else if (w.kind === 'retake') { if (!archive.some(x => x.id === w.archId)) throw new Error('Elige un resumen del archivo.'); f.wake = { kind: 'retake', archId: w.archId, text: String(w.text || '').trim() }; }
    else if (w.kind === 'launch') { if (!String(w.text || '').trim()) throw new Error('Escribe qué debe hacer el robot nuevo.'); f.wake = { kind: 'launch', text: String(w.text).trim() }; }
    else f.wake = { kind: 'notify' };
    const what = f.cond.kind === 'pr' ? `${f.cond.repo.split('/')[1]}#${f.cond.number} ${WAKE_PR[f.cond.event]}` : f.cond.kind === 'nexus' ? `${f.cond.key} ${f.cond.to === 'any' ? 'cambie de estado' : f.cond.to === 'completed' ? 'se complete' : `pase a ${f.cond.to}`}` : `a las ${new Date(f.cond.at).toLocaleString('es')}`;
    f.name = trunc(b.name || `⏰ Cuando ${what}`, 60);
  } else {
    const s = b.source || {};
    if (s.scope === 'org') {
      const owner = String(s.owner || '').trim();
      if (!/^[\w.-]+$/.test(owner)) throw new Error('Organización inválida, ej. DROPI-SAS.');
      f.source = { scope: 'org', owner, query: String(s.query || '').trim() };
    } else {
      const repo = String(s.repo || '').trim();
      if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('Repositorio inválido: usa owner/nombre, ej. DROPI-SAS/dropi-specs.');
      f.source = { scope: 'repo', repo, query: String(s.query || '').trim() };
    }
    if (/[`$;|&<>]/.test(f.source.query)) throw new Error('El filtro solo admite términos de búsqueda de GitHub, ej. author:karol label:hotfix.');
    const a = b.action || {};
    if (a.kind === 'skill') {
      const skill = String(a.skill || '').replace(/^\//, '').trim();
      if (!/^[a-z0-9:_-]+$/i.test(skill)) throw new Error('Elige una skill válida para la rutina.');
      f.action = { kind: 'skill', skill, args: String(a.args || '').trim() };
    } else {
      const text = String(a.text || '').trim();
      if (!text) throw new Error('Escribe qué debe hacer el robot con cada PR.');
      f.action = { kind: 'libre', text };
    }
    const evs = (Array.isArray(b.events) ? b.events : ['new', 'commits']).filter(e => EV_TXT[e]);
    if (!evs.length) throw new Error('Elige al menos un evento de los PRs.');
    f.events = evs;
    f.extra = String(b.extra || '').trim();
    f.onlyNew = !!b.onlyNew;
    f.includeDrafts = !!b.includeDrafts;
    const where = f.source.scope === 'org' ? f.source.owner : f.source.repo.split('/')[1];
    f.name = trunc(b.name || `PRs ${f.source.query ? f.source.query + ' ' : ''}en ${where}`, 60);
  }
  return f;
}
async function createRoutine(b) {
  const f = await buildRoutine(b);
  const rt = { id: crypto.randomBytes(4).toString('hex'), ...f, paused: false, lastRun: null, running: false, runs: 0, seen: {}, baselined: false, history: [] };
  rt.nextAt = firstRun(rt);
  routines.push(rt);
  saveRoutines();
  if (rt.nextAt <= Date.now()) checkRoutine(rt);
  return rt;
}
// Editar: se conserva lo aprendido (PRs vistos, memoria, historial) salvo que cambie dónde mira.
async function updateRoutine(rt, b) {
  const f = await buildRoutine(b);
  if (f.type !== rt.type) throw new Error('No se puede cambiar el tipo de una rutina: crea otra.');
  if (JSON.stringify(f.source) !== JSON.stringify(rt.source) || f.onlyNew !== rt.onlyNew) { rt.seen = {}; rt.baselined = false; }
  if (JSON.stringify(f.cond) !== JSON.stringify(rt.cond)) { delete rt.base; delete rt.fired; rt.paused = false; }
  Object.assign(rt, f);
  rt.doneOnce = false;
  rt.nextAt = rt.paused ? Infinity : firstRun(rt);
  saveRoutines();
  return rt;
}
// Vista previa sin gastar cuota: qué haría la rutina si corriera ahora.
async function previewRoutine(b) {
  const f = await buildRoutine(b);
  const tmp = { ...f, nextAt: 0 };
  if (f.type === 'watch') {
    const prs = await findPRs(tmp);
    const fire = f.onlyNew ? [] : prs.filter(p => prEvents(tmp, p, undefined).length);
    return { kind: 'watch', open: prs.map(p => ({ key: p.key, title: p.title, author: p.author, url: p.url, draft: p.isDraft })), fire: fire.map(p => p.key), onlyNew: f.onlyNew, events: f.events };
  }
  if (f.type === 'wake') { const r = await wakeCheck({ ...tmp }); return { kind: 'wake', status: r.status, hit: r.hit, what: r.what }; }
  const next = []; let t = Date.now(); const tr = { ...tmp };
  t = firstRun(tr, t); for (let k = 0; k < 4 && Number.isFinite(t); k++) { next.push(t); if (f.schedule.mode === 'once') break; t = nextRun(tr, t); }
  return { kind: 'agenda', next };
}

setInterval(() => {
  if (!WORKSPACE) return;
  for (const rt of routines) if (!rt.paused && !rt.running && Number.isFinite(rt.nextAt) && Date.now() >= rt.nextAt) checkRoutine(rt);
}, ROUTINE_TICK_MS);

/* ---------- salas de épica ---------- */
// Una sala agrupa a los robots que trabajan sobre una misma épica de Jira. Comparten dos archivos en runs/salas/<id>/:
// - CONTEXT.md: lo que todos deben saber (alcance, decisiones, estado verificado). Lo leen al entrar y lo corrigen
//   cuando aprenden algo durable. Está fuera de la bandeja: editarlo no se entrega como documento.
// - HILO.md: el hilo de la sala. Al cerrar cada turno, lo que dijo el robot se publica solo; tú escribes desde la oficina.

const SALAS_FILE = path.join(RUNS, 'salas.json');
const SALAS_DIR = path.join(RUNS, 'salas');
const THREAD_MAX = 300;
let salas = [];
try { salas = JSON.parse(fs.readFileSync(SALAS_FILE, 'utf8')); } catch { salas = []; }

function saveSalas() { fs.writeFileSync(SALAS_FILE, JSON.stringify(salas, null, 2)); }
function contextPath(s) { return path.join(SALAS_DIR, s.id, 'CONTEXT.md'); }
function threadPath(s) { return path.join(SALAS_DIR, s.id, 'HILO.md'); }

function salaView(s) {
  return { id: s.id, name: s.name, key: s.key, folder: s.folder, context: contextPath(s), threadFile: threadPath(s), thread: s.thread.slice(-150), docs: s.docs, createdAt: s.createdAt, auto: !!s.auto, owner: s.owner || null, color: Number.isInteger(s.color) ? s.color : null, purpose: s.purpose || '', done: !!s.done };
}
function emitSalas() { broadcast({ type: 'salas', salas: salas.map(salaView) }); }

function writeThreadFile(s) {
  const msgs = s.thread.map(m => `### ${m.from} · ${new Date(m.at).toLocaleString('es', { dateStyle: 'short', timeStyle: 'short' })}\n\n${m.text}\n`);
  fs.writeFileSync(threadPath(s), `# Hilo de la sala «${s.name}»${s.key ? ` (${s.key})` : ''}\n\nMás reciente al final.\n\n${msgs.join('\n')}`);
}

function postThread(s, from, text) {
  const t = String(text ?? '').trim();
  if (!t) throw new Error('Mensaje vacío.');
  s.thread.push({ id: crypto.randomBytes(4).toString('hex'), from: trunc(from, 40), text: t.slice(0, 12000), at: now() });
  if (s.thread.length > THREAD_MAX) s.thread.splice(0, s.thread.length - THREAD_MAX);
  writeThreadFile(s);
  saveSalas();
  emitSalas();
}

function createSala(b) {
  const name = trunc(b.name, 60);
  if (!name) throw new Error('Ponle nombre a la sala.');
  const key = String(b.key || '').trim().toUpperCase();
  if (key && !/^[A-Z][A-Z0-9]+-\d+$/.test(key)) throw new Error('Clave de Jira inválida, ej. TECH-2783.');
  let folder = String(b.folder || '').trim();
  if (folder) {
    const abs = path.resolve(WORKSPACE, folder);
    if (!abs.startsWith(WORKSPACE + path.sep) || !fs.statSync(abs, { throwIfNoEntry: false })?.isDirectory()) throw new Error('La carpeta de documentos debe existir dentro del workspace.');
    folder = path.relative(WORKSPACE, abs);
  }
  const id = /^[0-9a-f]{8}$/.test(String(b.id || '')) && !salas.some(x => x.id === b.id) ? b.id : crypto.randomBytes(4).toString('hex');
  const s = { id, name, key, folder, thread: [], docs: [], createdAt: now() };
  fs.mkdirSync(path.join(SALAS_DIR, s.id), { recursive: true });
  const initial = String(b.context || '').trim();
  fs.writeFileSync(contextPath(s), initial ? initial + '\n' : `# Contexto de la sala «${name}»${key ? ` (${key})` : ''}\n\n## Alcance\n\n## Decisiones tomadas\n\n## Estado verificado\n\n## Bloqueos y pendientes\n`);
  salas.push(s);
  writeThreadFile(s);
  saveSalas();
  return s;
}

// Sala de equipo: cuando un robot pide robots y tú los apruebas. Si el padre ya está en una sala (de épica o de equipo),
// los hijos entran a esa; si no, se crea una con su objetivo y el reparto en CONTEXT.md y el padre se muda a ella.
// Las salas de equipo (auto) se cierran solas cuando no queda nadie ni nadie esperando para entrar; sus archivos quedan.
function teamSala(r, items, context, salaId) {
  const team = items.map(it => `- ${it.title || trunc(it.text.replace(/\s+/g, ' '), 80)}`).join('\n');
  const stamp = now().slice(0, 16).replace('T', ' ');
  const cur = r.place.sala && salas.find(s => s.id === r.place.sala);
  if (cur) {
    if (context) fs.appendFileSync(contextPath(cur), `\n## Contexto que mandó ${r.name} al lanzar más robots (${stamp})\n\n${context}\n`);
    if (cur.done) { cur.done = false; saveSalas(); emitSalas(); } // entra más trabajo: el equipo vuelve a estar en curso
    return { sala: cur, created: false };
  }
  const goal = r.title || r.label || 'su encargo';
  const s = createSala({ id: salaId, name: `Equipo de ${r.name} · ${goal}`, context: `# Contexto del equipo de ${r.name}\n\n_Sala creada por la oficina el ${stamp} cuando ${r.name} pidió robots. La comparten ${r.name} y los robots que lanzó._\n\n`
    + `## Objetivo\n\n${goal}\n\n## Reparto\n\n- ${r.name} (coordina)\n${team}\n\n## Contexto que mandó ${r.name}\n\n${context || '_Sin contexto adicional: está en cada encargo._'}\n\n`
    + '## Decisiones tomadas\n\n## Estado verificado\n\n## Bloqueos y pendientes\n' });
  s.auto = true;
  s.owner = r.name;
  s.color = r.color; // el piso de la sala lleva el color de quien la armó
  s.purpose = `${r.name} armó este equipo para «${trunc(goal, 120)}» y repartió: ${items.map(it => it.title || trunc(it.text.replace(/\s+/g, ' '), 40)).join(', ')}`;
  saveSalas();
  r.place = roomSeat(`sala-${s.id}`, s.name, { sala: s.id });
  log(r, 'sys', `Se mudó a la sala «${s.name}» con su equipo`);
  emit(r);
  saveState();
  emitSalas();
  s.roster = [{ name: r.name, title: r.title || '', owner: true }];
  return { sala: s, created: true };
}
// «Reparto» del CONTEXT.md: quién es quién (nombre · tarea · estado), para el padre, los hijos y tú. Lo reescribe
// la oficina al entrar, entregar o irse cada uno; el resto del archivo es de los robots y no se toca.
function rosterState(e) {
  if (e.owner) return robots.has(e.name) ? 'coordina' : 'se fue';
  const live = robots.get(e.name);
  if (live) return live.reported ? 'entregó' : 'trabajando';
  if (spawnQueue.some(q => q.id === e.qid)) return 'esperando cupo';
  return e.dropped ? 'no se lanzó' : 'se fue';
}
function writeRoster(s) {
  if (!s?.roster?.length) return;
  const lines = s.roster.map(e => `- \`${e.name}\` · ${e.title || 'sin título'} · ${rosterState(e)}`).join('\n');
  const block = `## Reparto\n\n${lines}\n`;
  try {
    const f = contextPath(s), txt = fs.readFileSync(f, 'utf8');
    const re = /## Reparto\n[\s\S]*?(?=\n## |$)/;
    fs.writeFileSync(f, re.test(txt) ? txt.replace(re, block) : `${txt.trimEnd()}\n\n${block}`);
  } catch { /* sin archivo */ }
}
const rosterOf = name => salas.filter(s => s.roster?.some(e => e.name === name));
function closeEmptyTeamSalas() {
  const keep = s => !s.auto || [...robots.values()].some(r => r.place.sala === s.id) || spawnQueue.some(q => q.sala === s.id);
  if (salas.every(keep)) return;
  for (const s of salas.filter(x => !keep(x))) archiveSala(s, 'se fue todo el equipo');
  salas = salas.filter(keep);
  saveSalas(); emitSalas();
}
// Equipo terminado: todos los hijos que siguen en la sala ya entregaron su resultado y nadie espera para entrar.
// Te avisa una vez y la sala queda marcada en verde hasta que entre más trabajo.
function checkTeamDone(kid) {
  const s = kid.place.sala && salas.find(x => x.id === kid.place.sala);
  if (!s?.auto || s.done) return;
  const kids = [...robots.values()].filter(x => x.place.sala === s.id && x.parent);
  if (!kids.length || spawnQueue.some(q => q.sala === s.id) || kids.some(x => !x.reported)) return;
  s.done = true;
  saveSalas(); emitSalas();
  const p = robots.get(s.owner);
  if (p) log(p, 'sys', `Su equipo terminó: ${kids.length} de ${kids.length} entregaron`);
  broadcast({ type: 'notice', text: `El equipo de ${s.owner} terminó: ${kids.length} de ${kids.length} entregaron. ${p ? `${s.owner} ya tiene sus resultados: revísalo.` : ''}`.trim() });
}
// Si en una sala de equipo queda solo quien la armó, vuelve caminando a un escritorio y la sala pasa al archivo.
function ownerBackIfAlone() {
  for (const s of salas) {
    if (!s.auto) continue;
    const inSala = [...robots.values()].filter(r => r.place.sala === s.id);
    if (inSala.length !== 1 || inSala[0].name !== s.owner || spawnQueue.some(q => q.sala === s.id)) continue;
    const o = inSala[0];
    o.place = freeDesk();
    log(o, 'sys', `Se quedó solo en «${s.name}»: volvió a su escritorio y la sala pasó al archivo`);
    broadcast({ type: 'notice', text: `${o.name} se quedó solo en su sala: volvió a su escritorio. La sala «${s.name}» quedó en el archivo con su contexto y su hilo.` });
    emit(o);
    saveState();
  }
}
// Papelera: lo que borras desde la oficina (resúmenes de despedidos, salas cerradas) va a la de macOS, de donde se
// recupera; sin ella, a runs/papelera. OFFICE_TRASH la cambia (las pruebas usan una temporal). null si no existía.
function toTrash(src, label) {
  if (!src || !fs.existsSync(src)) return null;
  const trash = process.env.OFFICE_TRASH || (fs.existsSync(path.join(os.homedir(), '.Trash')) ? path.join(os.homedir(), '.Trash') : path.join(RUNS, 'papelera'));
  fs.mkdirSync(trash, { recursive: true });
  const ext = fs.statSync(src).isDirectory() ? '' : path.extname(src);
  const dest = path.join(trash, `${label}-${now().slice(0, 19).replace(/[:T]/g, '-')}${ext}`);
  try { fs.renameSync(src, dest); } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    fs.cpSync(src, dest, { recursive: true }); fs.rmSync(src, { recursive: true }); // otro disco: copiar y quitar
  }
  return dest;
}
// Salas cerradas (a mano o solas): se guardan para abrir su contexto y su hilo desde el archivo.
const SALAS_ARCH_FILE = path.join(RUNS, 'salas-archivo.json');
let salasArchive = [];
try { salasArchive = JSON.parse(fs.readFileSync(SALAS_ARCH_FILE, 'utf8')); } catch { salasArchive = []; }
function archiveSala(s, reason) {
  salasArchive.unshift({ id: s.id, name: s.name, key: s.key || '', purpose: s.purpose || '', owner: s.owner || null, auto: !!s.auto, color: Number.isInteger(s.color) ? s.color : null,
    context: contextPath(s), threadFile: threadPath(s), messages: s.thread.length, docs: s.docs.length, createdAt: s.createdAt, closedAt: now(), reason });
  salasArchive = salasArchive.slice(0, 300);
  fs.writeFileSync(SALAS_ARCH_FILE, JSON.stringify(salasArchive, null, 2));
}

// Lo que recibe un robot al entrar a una sala. El CONTEXT.md va copiado aquí (si es razonable): leerlo con una
// herramienta costaría lo mismo más una vuelta extra con todo su contexto. El hilo NO se lee entero: puede ser largo.
const SALA_CTX_INLINE = 8000;
function salaPreamble(s) {
  let ctx = '';
  try { ctx = fs.readFileSync(contextPath(s), 'utf8').trim(); } catch { /* sin archivo */ }
  const inline = ctx && ctx.length <= SALA_CTX_INLINE;
  const last = s.thread.slice(-5).map(m => `· ${m.from}: ${trunc(m.text.replace(/\s+/g, ' '), 600)}`).join('\n');
  return `\n\n--- Sala «${s.name}»${s.key ? ` (Jira ${s.key})` : ''}: la compartes con otros robots ---
Contexto compartido: ${contextPath(s)}${s.folder ? ` · documentos en ${path.join(WORKSPACE, s.folder)}` : ''}${inline ? ` (copia, no hace falta leerlo):\n${ctx}\n` : ' (léelo antes de empezar).\n'}${last ? `Lo último del hilo (para no repetir trabajo; más atrás en ${threadPath(s)}):\n${last}\n` : ''}- Si confirmas algo durable que falte o esté mal en el contexto (decisión, estado, bloqueo), corrígelo con Edit en su lugar, sin volverlo bitácora, con fecha absoluta.
- Tu respuesta final de cada turno se publica sola en el hilo: escríbela para que la entienda otro robot que no vio tu conversación. Para publicar a mitad de turno: curl -s -X POST "http://127.0.0.1:${PORT}/api/salas/${s.id}/hilo?from=$OFFICE_ROBOT" -H 'Content-Type: text/plain' --data-binary @<archivo>
--- fin de la sala ---`;
}

/* ---------- http ---------- */

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function readRaw(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > max) { reject(new Error('El archivo supera 20 MB.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(obj == null ? '' : JSON.stringify(obj));
}

// La página vive en web/app/*.js, un archivo por tema (mapa, robots, rutinas, panel…). Se sirven unidos en orden de
// nombre dentro de una sola función, como si fueran un archivo: comparten variables y funciones sin volverse globales
// del navegador. Se arma en cada pedido, así que un cambio solo necesita recargar la página.
const APP_DIR = path.join(WEB, 'app');
function appBundle() {
  const parts = fs.readdirSync(APP_DIR).filter(f => f.endsWith('.js')).sort();
  return '// Oficina de Agentes: dibuja el estado que empuja el daemon y manda tus acciones por la API.\n'
    + `// Armado por el daemon a partir de web/app/ (${parts.join(', ')}). No se edita aquí.\n(() => {\n`
    + parts.map(f => fs.readFileSync(path.join(APP_DIR, f), 'utf8')).join('') + '})();\n';
}
const STATIC = { '/': 'index.html', '/robot-art.js': 'robot-art.js', '/style.css': 'style.css', '/vendor/marked.min.js': 'vendor/marked.min.js', '/vendor/purify.min.js': 'vendor/purify.min.js' };
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

function robotOr404(res, name) {
  const r = robots.get(name);
  if (!r) send(res, 404, { error: `No hay un robot llamado ${name}.` });
  return r;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const parts = url.pathname.split('/').filter(Boolean);
  try {
    if (url.pathname === '/api/setup' && req.method === 'GET') return send(res, 200, setupView());
    if (url.pathname === '/api/setup/check' && req.method === 'POST') return send(res, 200, workspaceInfo((await readBody(req)).workspace));
    if (url.pathname === '/api/setup' && req.method === 'POST') {
      if (process.env.OFFICE_WORKSPACE) return send(res, 409, { error: 'La carpeta viene de OFFICE_WORKSPACE; cámbiala ahí y reinicia la oficina.' });
      if (robots.size) return send(res, 409, { error: 'Da de baja a los robots antes de cambiar la carpeta de trabajo.' });
      const { workspace, create } = await readBody(req);
      if (!String(workspace || '').trim()) return send(res, 400, { error: 'Escribe la ruta de la carpeta.' });
      let info = workspaceInfo(workspace);
      if (!info.exists && create) { fs.mkdirSync(info.path, { recursive: true }); info = workspaceInfo(workspace); }
      if (!info.isDir) return send(res, 400, { error: info.exists ? 'Esa ruta es un archivo, no una carpeta.' : 'Esa carpeta no existe (marca «Crearla si no existe»).' });
      if (info.insideOffice) return send(res, 400, { error: 'Elige una carpeta fuera de la oficina.' });
      const first = !WORKSPACE;
      WORKSPACE = saveWorkspace(info.path);
      repoIndex = { at: 0, map: new Map() };
      console.log(`Carpeta de trabajo: ${WORKSPACE}`);
      if (first) { loadSessions(); await restore(); resumeResults(); }
      broadcast({ type: 'setup', setup: setupView(), skills: listSkills() });
      return send(res, 200, { ok: true, ...setupView(), info });
    }
    // Sin carpeta de trabajo solo funcionan la página y la configuración inicial.
    if (!WORKSPACE && parts[0] === 'api' && url.pathname !== '/api/events') return send(res, 409, { error: 'Elige primero la carpeta de trabajo.', setup: true });
    if (!WORKSPACE && url.pathname === '/hook') return send(res, 200, null);
    if (req.method === 'GET' && url.pathname === '/app.js') {
      res.writeHead(200, { 'Content-Type': MIME['.js'], 'Cache-Control': 'no-store' });
      return res.end(appBundle());
    }
    if (req.method === 'GET' && STATIC[url.pathname]) {
      const file = path.join(WEB, STATIC[url.pathname]);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)], 'Cache-Control': 'no-store' });
      return res.end(fs.readFileSync(file));
    }
    if (req.method === 'POST' && url.pathname === '/hook') {
      const name = url.searchParams.get('robot') || 'desconocido';
      // Si la consola corta el hook (la cerraron, cancelaron la pregunta o se reinició), lo retenido se suelta.
      const closers = [];
      res.on('close', () => { if (!res.writableEnded) closers.splice(0).forEach(f => { try { f(); } catch { /* ya resuelto */ } }); });
      return send(res, 200, await onHook(name, await readBody(req), url.searchParams.get('via') || '', closers));
    }
    if (req.method === 'GET' && url.pathname === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify({ type: 'snapshot', setup: setupView(), robots: [...robots.values()].map(r => view(r, true)), inbox, routines: routines.map(routineView), salas: salas.map(salaView), config: configView(), favorites, pins, archiveCount: archive.length, door: doorView(), fame })}\n\n`);
      clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 20000);
      req.on('close', () => { clearInterval(ping); clients.delete(res); });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/attachments') {
      if (Number(req.headers['content-length'] || 0) > ATTACH_MAX_BYTES) return send(res, 413, { error: 'El archivo supera 20 MB.' });
      const scope = (url.searchParams.get('scope') || '').replace(/[^a-z0-9-]/gi, '').slice(0, 20) || 'encargos';
      const safe = path.basename(url.searchParams.get('name') || 'adjunto').replace(/[^\w.-]+/g, '_').slice(-80) || 'adjunto';
      const buf = await readRaw(req, ATTACH_MAX_BYTES);
      if (!buf.length) return send(res, 400, { error: 'Archivo vacío.' });
      const dir = path.join(ATTACH_DIR, scope);
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${Date.now().toString(36)}-${safe}`);
      fs.writeFileSync(file, buf);
      return send(res, 201, { path: path.relative(WORKSPACE, file), name: safe, size: buf.length });
    }
    if (req.method === 'POST' && url.pathname === '/api/config') {
      const body = await readBody(req);
      if (body.name !== undefined) {
        officeName = String(body.name ?? '').replace(/\s+/g, ' ').trim().slice(0, OFFICE_NAME_MAX);
        saveConfig({ name: officeName });
      }
      if (body.mapTheme !== undefined) {
        if (!MAP_THEMES.includes(body.mapTheme)) return send(res, 400, { error: 'Estilo de oficina desconocido.' });
        saveConfig({ mapTheme: body.mapTheme }); // estilo del mapa: es de la oficina, no del navegador
      }
      if (body.maxRobots !== undefined) {
        const n = Number(body.maxRobots);
        if (!Number.isInteger(n) || n < 1 || n > MAX_ROBOTS_LIMIT) return send(res, 400, { error: `El tope debe estar entre 1 y ${MAX_ROBOTS_LIMIT}.` });
        maxRobots = n;
        saveState();
        if (spawnQueue.length) setTimeout(drainSpawnQueue, 0); // con más cupo, lo que espera en la puerta entra ya
      }
      broadcast({ type: 'config', config: configView() });
      return send(res, 200, configView());
    }
    if (req.method === 'GET' && url.pathname === '/api/usage') return send(res, 200, { weeks: officeUsage() });
    if (req.method === 'GET' && url.pathname === '/api/claude-status') return send(res, 200, await claudeStatus(url.searchParams.get('refresh') === '1'));
    if (req.method === 'GET' && url.pathname === '/api/skills') return send(res, 200, { skills: listSkills() });
    // Repos de la carpeta de trabajo (primer nivel con .git): el autocompletado del chat los sugiere.
    if (req.method === 'GET' && url.pathname === '/api/vocab') {
      let repos = [];
      try { repos = fs.readdirSync(WORKSPACE, { withFileTypes: true }).filter(e => e.isDirectory() && !e.name.startsWith('.') && fs.existsSync(path.join(WORKSPACE, e.name, '.git'))).map(e => e.name).sort(); } catch { /* sin carpeta */ }
      return send(res, 200, { repos });
    }
    if (req.method === 'POST' && url.pathname === '/api/routines/preview') {
      try { return send(res, 200, await previewRoutine(await readBody(req))); } catch (e) { return send(res, 400, { error: trunc(e.stderr || e.message, 300) }); }
    }
    if (req.method === 'POST' && url.pathname === '/api/routines') {
      try { const rt = await createRoutine(await readBody(req)); emitRoutines(); return send(res, 201, { ok: true, id: rt.id }); }
      catch (e) { return send(res, 400, { error: trunc(e.stderr || e.message, 300) }); }
    }
    if (parts[0] === 'api' && parts[1] === 'routines' && parts[2]) {
      const rt = routines.find(x => x.id === parts[2]);
      if (!rt) return send(res, 404, { error: 'Esa rutina no existe.' });
      if (req.method === 'POST' && parts[3] === 'run') { checkRoutine(rt); return send(res, 200, { ok: true }); }
      if (req.method === 'PUT' && !parts[3]) {
        try { await updateRoutine(rt, await readBody(req)); emitRoutines(); return send(res, 200, { ok: true }); }
        catch (e) { return send(res, 400, { error: trunc(e.stderr || e.message, 300) }); }
      }
      if (req.method === 'POST' && parts[3] === 'pause') {
        rt.paused = !rt.paused;
        if (!rt.paused) { if (rt.type === 'wake') delete rt.fired; rt.doneOnce = false; rt.nextAt = firstRun(rt); } else rt.nextAt = Infinity;
        saveRoutines(); emitRoutines();
        return send(res, 200, { ok: true, paused: rt.paused });
      }
      if (req.method === 'DELETE' && !parts[3]) {
        routines = routines.filter(x => x !== rt);
        saveRoutines(); emitRoutines();
        return send(res, 200, { ok: true });
      }
    }
    if (req.method === 'GET' && url.pathname === '/api/salas-cerradas') return send(res, 200, { salas: salasArchive });
    if (req.method === 'DELETE' && parts[0] === 'api' && parts[1] === 'salas-cerradas' && parts[2]) {
      // Borra una sala cerrada: sale del archivo y su carpeta (CONTEXT.md, HILO.md) va a la Papelera, de donde se recupera.
      const e = salasArchive.find(x => x.id === parts[2]);
      if (!e) return send(res, 404, { error: 'Esa sala ya no está en el archivo.' });
      if (salas.some(x => x.id === e.id)) return send(res, 409, { error: 'Esa sala está abierta otra vez: ciérrala primero.' });
      const dir = path.dirname(e.context);
      const moved = dir.startsWith(SALAS_DIR + path.sep) ? toTrash(dir, `sala-${e.id}`) : null;
      salasArchive = salasArchive.filter(x => x !== e);
      fs.writeFileSync(SALAS_ARCH_FILE, JSON.stringify(salasArchive, null, 2));
      return send(res, 200, { ok: true, papelera: moved });
    }
    if (req.method === 'POST' && url.pathname === '/api/salas') {
      const s = createSala(await readBody(req));
      emitSalas();
      return send(res, 201, { ok: true, id: s.id });
    }
    if (parts[0] === 'api' && parts[1] === 'salas' && parts[2]) {
      const s = salas.find(x => x.id === parts[2]);
      if (!s) return send(res, 404, { error: 'Esa sala no existe.' });
      const inSala = [...robots.values()].filter(r => r.place.sala === s.id);
      if (req.method === 'GET' && parts[3] === 'hilo') {
        res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' });
        return res.end(fs.readFileSync(threadPath(s)));
      }
      if (req.method === 'POST' && parts[3] === 'hilo') {
        // Desde la oficina llega JSON; un robot publica texto plano con ?from=$OFFICE_ROBOT.
        if (String(req.headers['content-type'] || '').startsWith('application/json')) {
          const { text, notify } = await readBody(req);
          postThread(s, 'Coordinador', text);
          // Avisar gasta cuota: cada robot de la sala recibe el mensaje como un turno nuevo.
          if (notify) for (const r of inSala) await say(r, `[Hilo de la sala «${s.name}»] El coordinador escribió:\n${String(text).trim()}`);
          return send(res, 201, { ok: true, notified: notify ? inSala.length : 0 });
        }
        const from = url.searchParams.get('from') || '';
        postThread(s, robots.has(from) ? from : `externo (${trunc(from, 20) || 'sin nombre'})`, (await readRaw(req, 1e6)).toString('utf8'));
        return send(res, 201, { ok: true });
      }
      if (req.method === 'DELETE' && !parts[3]) {
        if (inSala.length) return send(res, 409, { error: `La sala tiene ${inSala.length} robot${inSala.length === 1 ? '' : 's'}; dalos de baja antes de cerrarla.` });
        archiveSala(s, 'la cerraste');
        salas = salas.filter(x => x !== s); // los archivos quedan en runs/salas/<id>/
        saveSalas(); emitSalas();
        return send(res, 200, { ok: true });
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/favorites') {
      const b = await readBody(req);
      const kind = b.kind === 'libre' ? 'libre' : 'skill';
      const f = { id: crypto.randomBytes(3).toString('hex'), name: trunc(String(b.name || '').trim(), 40), kind,
        skill: kind === 'skill' ? String(b.skill || '').replace(/^\//, '').trim() : null, args: kind === 'skill' ? String(b.args || '') : '',
        text: kind === 'libre' ? String(b.text || '') : '', permissionMode: b.permissionMode || '', title: cleanTitle(b.title) };
      if (kind === 'skill' ? !f.skill : !f.text.trim()) return send(res, 400, { error: 'Llena el encargo antes de guardarlo.' });
      f.name ||= f.title || (kind === 'skill' ? trunc(`/${f.skill} ${f.args}`.trim(), 40) : trunc(f.text, 40));
      favorites.push(f); if (favorites.length > 30) favorites.shift();
      saveFavorites();
      return send(res, 201, { ok: true, favorite: f });
    }
    if (req.method === 'DELETE' && parts[0] === 'api' && parts[1] === 'favorites' && parts[2]) {
      favorites = favorites.filter(f => f.id !== parts[2]);
      saveFavorites();
      return send(res, 200, { ok: true });
    }
    if (req.method === 'GET' && url.pathname === '/api/despedidos') {
      const q = url.searchParams.get('q');
      const all = url.searchParams.get('all') === '1';
      return send(res, 200, q ? { results: searchArchive(q) } : { recent: (all ? archive : archive.slice(-30)).slice().reverse().map(archMeta), total: archive.length });
    }
    if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'despedidos' && parts[2] && parts[3] === 'retomar') {
      try { const r = await retake(parts[2], (await readBody(req)).text); return send(res, 201, { ok: true, name: r.name }); }
      catch (e) { return send(res, 409, { error: e.message }); }
    }
    if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'despedidos' && parts[2] && parts[3] === 'exportar') {
      const a = archive.find(x => x.id === parts[2]);
      if (!a) return send(res, 404, { error: 'Ese robot ya no está en el archivo.' });
      try { return send(res, 200, { ok: true, ...exportConversation(a) }); } catch (e) { return send(res, 409, { error: e.message }); }
    }
    if (req.method === 'DELETE' && parts[0] === 'api' && parts[1] === 'despedidos' && parts[2]) { // lo quita de la lista y su resumen va a la Papelera
      const a = archive.find(x => x.id === parts[2]);
      if (!a) return send(res, 404, { error: 'Ese robot ya no está en el archivo.' });
      archive = archive.filter(x => x !== a);
      fs.promises.writeFile(ARCH_FILE, JSON.stringify(archive)).catch(() => {});
      emitArchive();
      // Solo si ningún otro despedido usa ese mismo .md (no debería, pero no se borra lo que otro necesita).
      const moved = a.summaryPath && !archive.some(x => x.summaryPath === a.summaryPath) ? toTrash(a.summaryPath, path.basename(a.summaryPath, '.md')) : null;
      return send(res, 200, { ok: true, papelera: moved });
    }
    if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'despedidos' && parts[2]) {
      const a = archive.find(x => x.id === parts[2]);
      return a ? send(res, 200, a) : send(res, 404, { error: 'Ese robot ya no está en el archivo.' });
    }
    if (req.method === 'POST' && url.pathname === '/api/pins') {
      const b = await readBody(req);
      const text = String(b.text || '').slice(0, 60000), robot = trunc(String(b.robot || '').trim(), 40);
      if (!text.trim() || !robot) return send(res, 400, { error: 'Falta el mensaje.' });
      const at = String(b.at || new Date().toISOString());
      const dup = pins.find(p => p.robot === robot && p.at === at);
      if (dup) return send(res, 200, { ok: true, pin: dup });
      const p = { id: crypto.randomBytes(4).toString('hex'), robot, title: trunc(String(b.title || ''), 80), at, text, pinnedAt: new Date().toISOString() };
      pins.push(p); if (pins.length > 100) pins.shift();
      savePins();
      return send(res, 201, { ok: true, pin: p });
    }
    if (req.method === 'DELETE' && parts[0] === 'api' && parts[1] === 'pins' && parts[2]) {
      pins = pins.filter(p => p.id !== parts[2]);
      savePins();
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/robots') {
      const out = await launchOrQueue(await readBody(req));
      if (out.queued) return send(res, 202, { ok: true, queued: true, id: out.queued.id, title: out.queued.title, position: out.position });
      return send(res, 201, { ok: true, name: out.robot.name });
    }
    if (req.method === 'DELETE' && parts[0] === 'api' && parts[1] === 'puerta' && parts[2]) { // sacar un encargo tuyo de la puerta
      const i = spawnQueue.findIndex(q => q.job && q.id === parts[2]);
      if (i < 0) return send(res, 404, { error: 'Ese encargo ya entró o no estaba en la puerta.' });
      const [q] = spawnQueue.splice(i, 1);
      console_(q.name || 'puerta', 'sale de la puerta', q.title);
      saveState(); emitDoor();
      return send(res, 200, { ok: true });
    }
    if (parts[0] === 'api' && parts[1] === 'robots' && parts[2]) {
      const r = robotOr404(res, parts[2]);
      if (!r) return;
      const action = parts[3];
      if (req.method === 'POST' && action === 'exportar') {
        try { return send(res, 200, { ok: true, ...exportConversation(r) }); } catch (e) { return send(res, 409, { error: e.message }); }
      }
      if (req.method === 'POST' && action === 'revivir') {
        try { await revive(r); return send(res, 200, { ok: true }); } catch (e) { return send(res, 409, { error: e.message }); }
      }
      if (req.method === 'POST' && action === 'say') {
        if (r.consoleLost) return send(res, 409, { error: `La consola de ${r.name} está caída: revívelo primero.` });
        const { text, attachments } = await readBody(req);
        if (!String(text || '').trim() && !validAttachments(attachments).length) return send(res, 400, { error: 'Mensaje vacío.' });
        await say(r, text, attachments);
        return send(res, 200, { ok: true });
      }
      // Un robot pide robots nuevos (curl desde su consola) y tú decides desde la oficina.
      if (req.method === 'POST' && action === 'encargos' && !parts[4]) {
        try { const q = requestSpawn(r, await readBody(req)); const ctx = path.join(SALAS_DIR, q.salaId, 'CONTEXT.md'); const team = q.items.map(i => `${i.name} (${i.title || trunc(i.text.replace(/\s+/g, ' '), 40)})`).join(', '); return send(res, 202, { ok: true, id: q.id, contexto: ctx, equipo: q.items.map(i => ({ nombre: i.name, titulo: i.title })), mensaje: `Petición enviada. Si la aprueba, tus robots se llamarán: ${team}. El usuario la aprueba en la oficina; sigue con tu trabajo. Si la aprueba, tú y ellos quedan en una sala con el contexto compartido en ${ctx}: agrega ahí lo durable que averigües y ellos necesiten. Sus resultados te llegan como mensajes «[Oficina] Resultado…» (juntos los que terminen mientras trabajas).` }); }
        catch (e) { return send(res, 400, { error: e.message }); }
      }
      if (req.method === 'POST' && action === 'encargos' && parts[4]) {
        const b = await readBody(req);
        try { return send(res, 200, { ok: true, ...(await decideSpawn(r, parts[4], b.decision === 'approve', b.items)) }); }
        catch (e) { return send(res, 409, { error: e.message }); }
      }
      if (req.method === 'POST' && action === 'cola' && parts[4]) { // quitar uno que espera cupo en la puerta
        const i = spawnQueue.findIndex(q => q.id === parts[4] && q.parent === r.name);
        if (i < 0) return send(res, 404, { error: 'Ese robot ya entró o no estaba en la cola.' });
        const [q] = spawnQueue.splice(i, 1);
        log(r, 'sys', `Quitaste de la cola «${q.title || trunc(q.text, 40)}»`);
        for (const s of salas) { const e = s.roster?.find(x => x.qid === q.id); if (e) { e.dropped = true; saveSalas(); writeRoster(s); } }
        flushIfIdle(r.name);
        emit(r);
        return send(res, 200, { ok: true });
      }
      if (req.method === 'POST' && action === 'permission') {
        const { decision } = await readBody(req);
        await pressKey(r, decision === 'approve' ? 'approve' : 'reject');
        return send(res, 200, { ok: true });
      }
      // Título que le pones tú al robot («Tareas de QA», «Revisando wallet#32 Ramiro»); vacío lo quita.
      if (req.method === 'POST' && action === 'ask') {
        const { id, answers, console: toConsole } = await readBody(req);
        return answerAsk(r, id, answers, !!toConsole) ? send(res, 200, { ok: true }) : send(res, 404, { error: 'Esas preguntas ya no están pendientes.' });
      }
      // Aspecto que le eliges al robot: color (0-7), antena (0-3), visor (0-2) y accesorio (0-3). reset vuelve al de su nombre.
      if (req.method === 'POST' && action === 'look') {
        const b = await readBody(req);
        if (b.reset) { r.look = null; if (Number.isInteger(r.baseColor)) r.color = r.baseColor; }
        else {
          const lim = { ant: 4, visor: 3, acc: 4 }, look = { ...(r.look || {}) };
          for (const [k, n] of Object.entries(lim)) if (b[k] !== undefined) { const v = Number(b[k]); if (!Number.isInteger(v) || v < 0 || v >= n) return send(res, 400, { error: `Valor inválido para ${k}.` }); look[k] = v; }
          if (b.color !== undefined) { const c = Number(b.color); if (!Number.isInteger(c) || c < 0 || c > 7) return send(res, 400, { error: 'Color inválido.' }); if (!Number.isInteger(r.baseColor)) r.baseColor = r.color; r.color = c; }
          r.look = Object.keys(look).length ? look : null;
        }
        emit(r);
        return send(res, 200, { ok: true });
      }
      // Despedir con su resumen: le pide un super resumen (su próxima respuesta) y al recibirlo lo da de baja.
      if (req.method === 'POST' && action === 'despedir-con-resumen') {
        if (r.state !== 'done' && !(r.state === 'input' && !r.needsPermission && !r.hold && !r.ask)) return send(res, 409, { error: 'Está en medio de algo: espera a que termine su turno.' });
        r.summaryPending = true;
        log(r, 'sys', 'Le pediste su resumen para despedirlo');
        emit(r);
        await say(r, SUMMARY_ASK);
        return send(res, 200, { ok: true });
      }
      // Nota tuya pegada al robot («esperando respuesta de Ramiro»): se ve en la tarjeta, el mapa y el archivo.
      if (req.method === 'POST' && action === 'note') {
        r.note = String((await readBody(req)).note ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
        emit(r);
        return send(res, 200, { ok: true, note: r.note });
      }
      if (req.method === 'POST' && action === 'title') {
        r.title = cleanTitle((await readBody(req)).title);
        emit(r);
        return send(res, 200, { ok: true, title: r.title });
      }
      if (req.method === 'GET' && action === 'pane') return send(res, 200, { text: await pane(r) });
      if (req.method === 'POST' && action === 'console') { await openConsole(r); return send(res, 200, { ok: true }); }
      if (req.method === 'DELETE' && !action) { await removeRobot(r, 'dado de baja'); return send(res, 200, { ok: true }); }
    }
    if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'decision' && parts[2]) {
      const { decision } = await readBody(req);
      return decide(parts[2], decision) ? send(res, 200, { ok: true }) : send(res, 404, { error: 'Ese permiso ya no está pendiente.' });
    }
    if (req.method === 'GET' && url.pathname === '/api/doc') {
      const p = knownDoc(url.searchParams.get('path'));
      if (!p) return send(res, 403, { error: 'Ese archivo no es un documento de la oficina.' });
      if (!fs.existsSync(p)) return send(res, 404, { error: 'El archivo ya no existe en el disco.' });
      const shown = p.startsWith(WORKSPACE + path.sep) ? path.relative(WORKSPACE, p) : p;
      if (!TEXT_DOC.test(p)) return send(res, 200, { path: shown, binary: true });
      return send(res, 200, { path: shown, text: fs.readFileSync(p, 'utf8') });
    }
    if (req.method === 'POST' && url.pathname === '/api/reveal') {
      const p = knownDoc((await readBody(req)).path);
      if (!p || !fs.existsSync(p)) return send(res, 404, { error: 'El archivo ya no existe.' });
      await run('open', ['-R', p]);
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/inbox/seen-all') {
      for (const it of inbox) it.status = 'visto';
      emitInbox();
      return send(res, 200, { ok: true });
    }
    if (parts[0] === 'api' && parts[1] === 'inbox' && parts[2]) {
      const idx = inbox.findIndex(x => x.id === parts[2]);
      if (idx < 0) return send(res, 404, { error: 'Ese documento ya no está en la bandeja.' });
      if (req.method === 'POST') {
        const { status } = await readBody(req);
        inbox[idx].status = status === 'nuevo' ? 'nuevo' : 'visto';
      } else if (req.method === 'DELETE') {
        inbox.splice(idx, 1); // archivar: sale de la bandeja, el archivo queda en el disco
      }
      emitInbox();
      return send(res, 200, { ok: true });
    }
    send(res, 404, { error: 'Ruta desconocida.' });
  } catch (e) {
    send(res, 400, { error: e.message });
  }
});

await guardSession();
WORKSPACE = initialWorkspace();
if (WORKSPACE) { loadSessions(); await restore(); resumeResults(); migrateSummaries(); }
server.listen(PORT, '127.0.0.1', () => {
  console.log(`Oficina de Agentes · http://127.0.0.1:${PORT}`);
  console.log(WORKSPACE ? `Carpeta de trabajo: ${WORKSPACE}` : `Primera ejecución: abre http://127.0.0.1:${PORT} para elegir la carpeta de trabajo`);
  console.log(`Sesión de tmux de los robots: ${SESSION} (tmux attach -t ${SESSION})`);
  console.log(`Tope de robots simultáneos: ${maxRobots}`);
  console.log(`Aprobaciones retenidas por el daemon: ${APPROVAL ? 'activas' : 'apagadas (OFFICE_APPROVAL=1)'}`);
  console.log(`Datos de la oficina: ${RUNS}`);
  console.log(`Eventos crudos: ${EVENTS_FILE}\n`);
});
