// Oficina de Agentes · tmux: lanzar robots y escribirles.
// Parte de daemon/daemon.mjs, que carga los módulos de daemon/lib/ en orden y arranca la oficina.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CLAUDE_BIN,
  console_,
  maxRobots,
  NAMES,
  nextColor,
  now,
  PERMISSION_MODES,
  PORT,
  robots,
  run,
  SESSION,
  SETTINGS,
  trunc,
  WORKSPACE
} from './base.mjs';
import { emit } from './estado.mjs';
import { freeDesk, log, roomSeat, setState } from './persistencia.mjs';
import { cleanTitle, normModel, normTools, robotFlags, robotHints } from './turno.mjs';
import { attachmentNote } from './adjuntos.mjs';
import { routines } from './rutinas.mjs';
import { salaPreamble, salas } from './salas.mjs';

/* ---------- tmux ---------- */

// Concurrent launches share one check: two robots launched at once used to both try new-session and the second one
// failed with "duplicate session". A session created by someone else in between also counts as success.
let ensuring = null;
function ensureSession() {
  ensuring ??= (async () => {
    try {
      await run('tmux', ['has-session', '-t', SESSION]);
    } catch {
      await run('tmux', ['new-session', '-d', '-s', SESSION, '-n', 'lobby', '-c', WORKSPACE]).catch(async e => {
        await run('tmux', ['has-session', '-t', SESSION]).catch(() => {
          throw e;
        });
      });
    }
    await run('tmux', ['set-option', '-t', SESSION, '@office_port', String(PORT)]).catch(() => {});
  })().finally(() => {
    ensuring = null;
  });
  return ensuring;
}

// Si la sesión de tmux ya es de otra oficina que sigue viva en otro puerto, no arrancar: le robaríamos los robots.
async function guardSession() {
  try {
    await run('tmux', ['has-session', '-t', SESSION]);
  } catch {
    return;
  } // la sesión se crea al lanzar el primer robot
  let owner = '';
  try {
    owner = (await run('tmux', ['show-options', '-v', '-t', SESSION, '@office_port'])).stdout.trim();
  } catch {
    /* sin dueño */
  }
  if (owner && owner !== String(PORT)) {
    let alive = true;
    try {
      await fetch(`http://127.0.0.1:${owner}/api/setup`, { signal: AbortSignal.timeout(1500) });
    } catch {
      alive = false;
    }
    if (alive) {
      console.error(`La sesión de tmux «${SESSION}» ya la usa otra oficina que corre en el puerto ${owner}.`);
      console.error(
        'Arranca esta con otra sesión y otro puerto, por ejemplo: OFFICE_SESSION=office-2 OFFICE_PORT=4778 node daemon/daemon.mjs'
      );
      process.exit(1);
    }
  }
  await run('tmux', ['set-option', '-t', SESSION, '@office_port', String(PORT)]).catch(() => {});
}

async function launch({
  kind,
  skill,
  args,
  text,
  permissionMode,
  name,
  origin,
  label: customLabel,
  title,
  leaveWhenDone,
  attachments,
  routine,
  sala: salaId,
  parent,
  color,
  look,
  tools,
  modelPick
}) {
  // El tope cuenta solo los que trabajan: los que terminaron esperan su baja sin gastar cuota.
  const active = [...robots.values()].filter(x => x.state !== 'done');
  if (active.filter(x => !x.consoleLost).length + launching.size >= maxRobots)
    throw new Error(`Ya hay ${maxRobots} robots trabajando (tope de la cuota). Súbelo con + en la barra o espera a que alguno termine.`);
  const taken = n => robots.has(n) || launching.has(n);
  name = (name || NAMES.find(n => !taken(n)) || `robot-${Date.now() % 1000}`).toLowerCase();
  if (!/^[a-z0-9-]{1,20}$/.test(name)) throw new Error('Nombre inválido: usa minúsculas, números y guiones.');
  if (taken(name)) throw new Error(`Ya existe un robot llamado ${name}.`);
  // El nombre queda apartado desde ya: dos pedidos casi simultáneos (doble clic) no abren dos consolas iguales.
  launching.add(name);
  try {
    return await launchReserved({
      kind,
      skill,
      args,
      text,
      permissionMode,
      name,
      origin,
      customLabel,
      title,
      leaveWhenDone,
      attachments,
      routine,
      salaId,
      parent,
      color,
      look,
      tools,
      modelPick
    });
  } finally {
    launching.delete(name);
  }
}
const launching = new Set();
async function launchReserved({
  kind,
  skill,
  args,
  text,
  permissionMode,
  name,
  origin,
  customLabel,
  title,
  leaveWhenDone,
  attachments,
  routine,
  salaId,
  parent,
  color,
  look,
  tools,
  modelPick
}) {
  let prompt, label;
  if (kind === 'skill') {
    skill = String(skill || '')
      .replace(/^\//, '')
      .trim();
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
  if (sala) prompt += salaPreamble(sala, name);
  const place = sala ? roomSeat(`sala-${sala.id}`, sala.name, { sala: sala.id }) : rt ? roomSeat(rt.id, rt.name) : freeDesk();
  if (!place) throw new Error('No hay escritorios libres en la oficina.');
  if (permissionMode && !PERMISSION_MODES.has(permissionMode)) throw new Error('Modo de permisos inválido.');

  await ensureSession();
  const sessionId = crypto.randomUUID();
  const r = {
    name,
    kind,
    skill,
    label,
    title: cleanTitle(title),
    prompt,
    color: Number.isInteger(color) ? color : nextColor() % 8,
    look: look || null,
    place,
    request: {
      kind,
      skill,
      args: kind === 'skill' ? String(args || '') : '',
      text: kind === 'libre' ? String(text || '').trim() : '',
      permissionMode: permissionMode || '',
      tools: normTools(tools),
      modelPick: normModel(modelPick)
    },
    permissionMode: permissionMode || '',
    tools: normTools(tools),
    modelPick: normModel(modelPick),
    leaveWhenDone: !!leaveWhenDone,
    origin: trunc(origin || 'Lanzado por la API local sin indicar quién', 200),
    routine: routine || null,
    sessionId,
    transcript: null,
    offset: 0,
    partial: '',
    msgUsage: new Map(),
    startedAt: now(),
    alive: true,
    state: 'walking',
    timeline: [{ at: now(), s: 'walking' }],
    subs: [],
    pendingSubs: 0,
    bubble: '',
    activity: '',
    needsPermission: false,
    hold: null,
    docs: [],
    log: [],
    parent: parent || null
  };
  robots.set(name, r);
  // env -u: si ANTHROPIC_API_KEY esta en el entorno, `claude` la usa en vez del login de la suscripcion.
  const tmuxArgs = [
    'new-window',
    '-d',
    '-t',
    `${SESSION}:`,
    '-n',
    name,
    '-c',
    WORKSPACE,
    '-e',
    `OFFICE_ROBOT=${name}`,
    '-e',
    `OFFICE_PORT=${PORT}`,
    'env',
    '-u',
    'ANTHROPIC_API_KEY',
    CLAUDE_BIN,
    '--settings',
    SETTINGS,
    '--session-id',
    sessionId,
    '--append-system-prompt',
    robotHints(r),
    ...robotFlags(r)
  ];
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
  // Lo pendiente de su sala (lo mudaron o se armó su equipo) viaja pegado a este mensaje, sin un turno aparte.
  const note = r.salaNote ? `${r.salaNote}\n\n` : '';
  r.salaNote = '';
  const full = note + (String(text || '').trim() || 'Te adjunto estos archivos.') + attachmentNote(attachments);
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
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (filesOnly && e.name.endsWith('.md')) out.add(e.name.slice(0, -3));
      if (!filesOnly && !e.name.startsWith('.') && e.name !== 'synced') out.add(e.name);
    }
  }
  return [...out].sort();
}

export { ensureSession, guardSession, launch, launching, listSkills, openConsole, pane, pressKey, say };
