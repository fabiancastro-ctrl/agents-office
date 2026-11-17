// Oficina de Agentes · rutinas y despertadores.
// Parte de daemon/daemon.mjs, que carga los módulos de daemon/lib/ en orden y arranca la oficina.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { now, PERMISSION_MODES, PORT, replaceList, robots, ROUTINE_TICK_MS, run, RUNS, trunc, WORKSPACE } from './base.mjs';
import { broadcast, usage } from './estado.mjs';
import { log } from './persistencia.mjs';
import { archive } from './turno.mjs';
import { retake } from './exportar.mjs';
import { revive } from './consola.mjs';
import { launch, say } from './tmux.mjs';
import { readBody, send } from './http.mjs';

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
const resetRepoIndex = () => { repoIndex = { at: 0, map: new Map() }; };
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

// Rutas de la API: rutinas y despertadores. Las llama http.mjs en orden; devuelven algo (true) si atendieron la petición.
async function rutinasApi(req, res, url, parts) {
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
        replaceList(routines, routines.filter(x => x !== rt));
        saveRoutines(); emitRoutines();
        return send(res, 200, { ok: true });
      }
    }
}

export { checkRoutine, createRoutine, emitRoutines, firstRun, previewRoutine, resetRepoIndex, routines, routineView, rutinasApi, saveRoutines, updateRoutine };
