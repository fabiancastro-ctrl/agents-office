// Oficina de Agentes · relevo por contexto.
// Parte de daemon/daemon.mjs, que carga los módulos de daemon/lib/ en orden y arranca la oficina.
// Un robot con mucho contexto relee todo en cada turno y gasta tokens. El relevo: escribe un super resumen, se da de
// baja y entra un robot NUEVO con su mismo nombre que arranca solo con ese resumen (sesión nueva, contexto chico).
// - Oferta manual: al cerrar turno con ≥ OFFICE_RELEVO_K miles de tokens (300) la tarjeta ofrece «🔁 Relevar».
// - Automático: en espera (turno cerrado + tareas de fondo vivas) ≥ OFFICE_RELEVO_ESPERA_MIN minutos (45) con
//   ≥ OFFICE_RELEVO_ESPERA_K miles (150): la caché de Claude dura 1 h; retomar después reescribe todo el contexto.
import { robots } from './base.mjs';
import { ctxOf, emit, fmtK } from './estado.mjs';
import { log } from './persistencia.mjs';
import { removeRobot } from './consola.mjs';
import { archive } from './turno.mjs';
import { bgList } from './hooks.mjs';
import { launch, say } from './tmux.mjs';
import { holdSala, releaseSala } from './salas.mjs';

const num = (v, d) => {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isFinite(n) && n >= 0 ? n : d;
};
const OFFER_K = num(process.env.OFFICE_RELEVO_K, 300);
const WAIT_K = num(process.env.OFFICE_RELEVO_ESPERA_K, 150);
const WAIT_MIN = num(process.env.OFFICE_RELEVO_ESPERA_MIN, 45);
const SNOOZE_STEP = 100000; // «Seguir así»: no vuelve a ofrecer hasta que el contexto suba 100 k más
const TICK_MS = Number(process.env.OFFICE_RELEVO_TICK_MS) || 60e3;

const RELEVO_ASK =
  '[Oficina] Es un relevo por contexto: tu contexto ya es muy grande y te va a seguir un robot nuevo con tu mismo nombre, que arranca ' +
  'solo con lo que escribas ahora. Responde SOLO con un super resumen en Markdown (máximo 25 líneas): objetivo, qué hiciste, en qué quedaste, qué falta, ' +
  'y repos, ramas, PRs, archivos y documentos clave con su ruta. Incluye también lo que estabas esperando en segundo plano (CI, PR, despertador, ' +
  'monitor) y el comando exacto para volver a lanzarlo, porque esas tareas de fondo se cortan con el relevo. Sin saludos ni preguntas. No uses herramientas.';

// Qué impide ofrecer o hacer un relevo ahora (vacío = nada). Pura: recibe el robot y devuelve el motivo o null.
function blockedBy(r) {
  if (r.pendingSubs > 0) return 'subagentes';
  if (r.hold) return 'permiso retenido';
  if (r.ask) return 'pregunta';
  if (r.needsPermission) return 'permiso';
  if (r.spawnReq) return 'pide robots';
  if (r.summaryPending || r.relevoPending) return 'resumen en curso';
  if (r.routine) return 'rutina';
  if (r.consoleLost) return 'consola caída';
  return null;
}
// Turno cerrado: LISTO, o esperándote sin permiso ni pregunta pendiente.
const closed = r => r.state === 'done' || (r.state === 'input' && !r.needsPermission && !r.hold && !r.ask);

// Qué tarea de fondo es solo una espera (se puede cortar y relanzar sin perder nada) y cuál es trabajo de verdad
// (un build, pruebas largas, un apply): el relevo corta la consola, así que con trabajo vivo nunca se releva solo.
const ESPERA_CMD =
  /nr-esperar-ci|gh\s+pr\s+checks\b[^|;&]*--watch|gh\s+run\s+watch|^\s*(until|while)\b[\s\S]*\bsleep\b|^\s*sleep\s+\d+\s*$/;
const isWait = b => b.kind !== 'shell' || ESPERA_CMD.test(String(b.cmd || ''));

// La decisión, pura. null | 'oferta' | 'auto'.
// tokens: contexto actual · closedTurn: turno cerrado · blocked: hay algo en medio (blockedBy) · bg: tareas de fondo vivas ·
// bgWork: de esas, las que son trabajo y no espera (con alguna, no hay automático: solo la oferta) ·
// waitedMin: minutos con el turno cerrado · nextAt: umbral que dejó «Seguir así» · offerK/waitK/waitMin: umbrales (k = miles).
function decideRelevo({
  tokens = 0,
  closedTurn = false,
  blocked = false,
  bg = 0,
  bgWork = 0,
  waitedMin = 0,
  nextAt = 0,
  offerK = OFFER_K,
  waitK = WAIT_K,
  waitMin = WAIT_MIN
}) {
  if (!closedTurn || blocked) return null;
  if (bg > 0 && !bgWork && tokens >= waitK * 1000 && waitedMin >= waitMin) return 'auto';
  if (tokens >= Math.max(offerK * 1000, nextAt || 0)) return 'oferta';
  return null;
}

function evaluate(r, at = Date.now()) {
  const c = ctxOf(r);
  const since = Date.parse(r.timeline?.at(-1)?.at || '') || at;
  return decideRelevo({
    tokens: c?.tokens || 0,
    closedTurn: closed(r),
    blocked: !!blockedBy(r),
    bg: bgList(r).length,
    bgWork: bgList(r).filter(b => !isWait(b)).length,
    waitedMin: (at - since) / 60e3,
    nextAt: r.relevoNext || 0
  });
}

// Marca u quita la oferta del robot según el estado de ahora. Devuelve la decisión.
function check(r) {
  const d = evaluate(r);
  const c = ctxOf(r);
  if (c && c.tokens < OFFER_K * 1000 && r.relevoNext) r.relevoNext = 0; // compactó: vuelve a ofrecer desde el umbral normal
  if (d === 'oferta' || d === 'auto') {
    if (!r.relevo) {
      r.relevo = { tokens: c.tokens, at: new Date().toISOString() };
      emit(r);
    }
  } else if (r.relevo) {
    r.relevo = null;
    emit(r);
  }
  return d;
}

// Pide el relevo: el robot responde con su resumen y finishTurn (turno.mjs) lo da de baja y lanza el nuevo.
async function startRelevo(r, why = 'manual') {
  const c = ctxOf(r);
  r.summaryPending = true;
  r.relevoPending = true;
  r.relevo = null;
  r.bubble = 'Escribo mi relevo y me sigue otro yo';
  log(r, 'sys', `Relevo por contexto: ${fmtK(c?.tokens || 0)}${why === 'auto' ? ' (en espera, antes de que se enfríe la caché)' : ''}`);
  emit(r);
  try {
    await say(r, RELEVO_ASK);
  } catch (e) {
    r.summaryPending = false;
    r.relevoPending = false;
    emit(r);
    throw e;
  }
}

function snooze(r) {
  const c = ctxOf(r);
  r.relevo = null;
  r.relevoNext = (c?.tokens || 0) + SNOOZE_STEP;
  log(r, 'sys', `Seguir sin relevo: no se vuelve a ofrecer hasta ${fmtK(r.relevoNext)}`);
  emit(r);
}

// Al llegar su resumen: se da de baja (queda archivado) y entra el robot nuevo, con el mismo nombre y aspecto.
async function finishRelevo(r, summary) {
  const old = {
    name: r.name,
    title: r.title || '',
    label: r.label,
    color: r.color,
    look: r.look || null,
    note: r.note || '',
    priority: r.priority || null,
    salaNote: r.salaNote || '',
    parent: r.parent || null,
    sala: r.place?.sala || null,
    permissionMode: r.permissionMode || '',
    tools: r.tools || [],
    modelPick: r.modelPick || '',
    account: r.account || '',
    request: r.request || null,
    skill: r.skill,
    kind: r.kind,
    baseColor: r.baseColor,
    bg: bgList(r).map(b => `${b.kind}: ${b.what}`),
    tokens: ctxOf(r)?.tokens || 0
  };
  holdSala(old.sala); // su sala no se cierra (ni manda al que coordina a su escritorio) en el hueco hasta que entra el relevo
  try {
    return await relaunch(r, old, summary);
  } finally {
    releaseSala(old.sala);
  }
}
async function relaunch(r, old, summary) {
  await removeRobot(r, 'relevado por contexto', summary);
  const a = archive.at(-1);
  const arch = a && a.name === old.name && a.summary === String(summary).trim() ? a : null;
  const prompt =
    `Retomas una tarea como relevo por contexto: eres el mismo robot ${old.name}${old.title ? ` («${old.title}»)` : ''}, pero con la sesión nueva porque la anterior (${fmtK(old.tokens)} de contexto) ya era muy cara de releer. ` +
    `No tienes su conversación: solo este resumen${arch?.summaryPath ? ` (también en ${arch.summaryPath})` : ''}.\n\n---\n${String(summary).trim()}\n---\n\n` +
    `Si había algo en espera en segundo plano (CI, PR, despertador, monitor), esas tareas se cortaron con el relevo: vuelve a lanzarlas en segundo plano con lo que dice el resumen y sigue desde ahí. ` +
    `Si necesitas más contexto, pídemelo o búscalo en los documentos que menciona y en la memoria del proyecto.` +
    (old.bg.length ? `\n\n(La oficina veía en espera: ${old.bg.join('; ')}.)` : '');
  const launchArgs = {
    kind: 'libre',
    text: prompt,
    name: old.name,
    title: old.title,
    label: old.label,
    color: old.color,
    look: old.look,
    parent: old.parent || undefined,
    permissionMode: old.permissionMode || undefined,
    tools: old.tools,
    modelPick: old.modelPick,
    account: old.account,
    origin: `Relevo por contexto de ${old.name} (${fmtK(old.tokens)}): sigue con su resumen`
  };
  let n,
    noSala = '';
  try {
    n = await launch({ ...launchArgs, sala: old.sala || undefined });
  } catch (e) {
    // la sala pudo cerrarse al irse el último robot, o el nombre/cupo fallar: se reintenta sin sala
    if (!old.sala) throw e;
    n = await launch(launchArgs);
    noSala = e.message;
  }
  if (noSala) log(n, 'sys', `Entró sin su sala (${noSala}): múdalo desde su ventana si hace falta`);
  n.note = old.note;
  if (old.priority) n.priority = old.priority;
  n.salaNote = old.salaNote;
  if (old.request) n.request = old.request;
  if (Number.isInteger(old.baseColor)) n.baseColor = old.baseColor;
  log(n, 'sys', `Relevo por contexto: sigue a ${old.name} (${fmtK(old.tokens)} de contexto) con su resumen`);
  emit(n);
  return n;
}

setInterval(() => {
  for (const r of [...robots.values()]) {
    if (!r.alive) continue;
    try {
      if (check(r) === 'auto') startRelevo(r, 'auto').catch(() => {});
    } catch {
      /* un robot no frena a los demás */
    }
  }
}, TICK_MS);

export { blockedBy, check, isWait, check as checkRelevo, closed, decideRelevo, finishRelevo, RELEVO_ASK, snooze, startRelevo };
