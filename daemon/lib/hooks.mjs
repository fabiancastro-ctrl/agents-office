// Oficina de Agentes · hooks de Claude Code y permisos retenidos.
// Parte de daemon/daemon.mjs, que carga los módulos de daemon/lib/ en orden y arranca la oficina.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  APPROVAL,
  APPROVAL_TIMEOUT_MS,
  ASK_TIMEOUT_MS,
  describeTool,
  EVENTS_FILE,
  HOLD_TOOLS,
  NEVER_ALLOW,
  now,
  pending,
  robots,
  run,
  RUNS,
  trunc,
  WORKSPACE
} from './base.mjs';
import { broadcast, emit } from './estado.mjs';
import { registerSession } from './uso.mjs';
import { log, setState, taskNote } from './persistencia.mjs';
import { trackFile } from './cambios.mjs';
import { clashPeers } from './choques.mjs';
import { finishTurn, trackDoc } from './turno.mjs';
import { pumpTranscript } from './transcript.mjs';

/* ---------- hooks ---------- */

// 2 · En qué repo trabaja cada robot (para el filtro de las tarjetas): sale de lo que edita o crea y, si no, de la carpeta
// donde está su consola. Repo = carpeta de primer nivel del workspace con .git, o <repo> en worktrees/<tarea>/<repo>.
const isRepo = new Map();
function repoOf(p) {
  if (!p || !WORKSPACE) return null;
  const rel = path.relative(WORKSPACE, path.resolve(WORKSPACE, String(p)));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const seg = rel.split(path.sep);
  if (seg[0] === 'worktrees' && seg.length >= 3) return seg[2];
  if (!isRepo.has(seg[0])) isRepo.set(seg[0], fs.existsSync(path.join(WORKSPACE, seg[0], '.git')));
  return isRepo.get(seg[0]) ? seg[0] : null;
}
// En espera: lo que el robot dejó corriendo en segundo plano al cerrar su turno (una shell que vigila un CI, un Monitor
// que revisa algo cada X min, un despertador de /loop o un cron). Mientras tenga algo así no está LISTO: está en espera.
// Cada tarea sale cuando Claude Code avisa que terminó (la notificación trae el mismo tool_use_id), cuando vence o
// cuando empieza una sesión nueva. Los subagentes de fondo ya se cuentan aparte (delegando).
const BG_MAX_MS = Number(process.env.OFFICE_BG_MAX_MS) || 12 * 3600e3; // por si nunca llega el aviso

// Rutinas sin cambios: un robot de rutina que cierra su turno sin haber cambiado nada se da de baja solo (turno.mjs).
// «Cambio» = editar o crear un archivo (salvo la memoria de la rutina y lo de la oficina), un comando que escribe en git,
// GitHub, Nexus o una API, o una herramienta MCP que crea, edita, comenta o envía. Ante la duda cuenta como cambio: el robot se queda.
const MUTATING_CMD = new RegExp(
  [
    String.raw`\bgit\s+(?:-C\s+\S+\s+)?(?:commit|push|merge|rebase|tag|cherry-pick|revert|am|apply|worktree\s+add)\b`,
    String.raw`\bgh\s+(?:pr|issue)\s+(?:create|comment|review|merge|edit|close|reopen|ready)\b`,
    String.raw`\bgh\s+(?:release|repo)\s+(?:create|edit|delete)\b`,
    String.raw`\bgh\s+api\b[^|;&]*(?:-X|--method)\s*['"]?(?:POST|PUT|PATCH|DELETE)`,
    String.raw`\bnx\s+\S*\s*(?:create|update|comment|move|close|take|assign|done)\b`,
    String.raw`\bcurl\b(?![^|;&]*(?:127\.0\.0\.1|localhost))[^|;&]*(?:-X\s*['"]?(?:POST|PUT|PATCH|DELETE)|--data\b|-d\s)`,
    String.raw`\bsed\s+-i\b|\btee\b|\b(?:rm|mv|cp|mkdir|touch)\s|>\s*(?!/dev/null|&)[\w~./"'-]`
  ].join('|')
);
const MUTATING_MCP = /(?:create|update|edit|delete|remove|comment|send|post|merge|publish|write|set|move|assign|upload|batch)/i;
function isChange(tool, input) {
  if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(tool)) {
    const p = String(input?.file_path || input?.notebook_path || '');
    return !p || !path.resolve(p).startsWith(RUNS + path.sep); // la memoria de la rutina no cuenta
  }
  if (tool === 'Bash') return MUTATING_CMD.test(String(input?.command || ''));
  if (String(tool).startsWith('mcp__')) return MUTATING_MCP.test(String(tool).split('__').pop());
  return false;
}
function trackBg(r, body) {
  addBg(r, body.tool_use_id || crypto.randomBytes(4).toString('hex'), body.tool_name, body.tool_input, Date.now());
}
// También la usa transcript.mjs: al reiniciar la oficina, lo pendiente se reconstruye leyendo el transcript (así cuentan
// las tareas lanzadas antes del reinicio). Si ya estaba anotada, no se toca.
function addBg(r, id, t, input, at) {
  const i = input || {};
  if (r.bg?.[id]) return;
  let e = null;
  if (t === 'Bash' && i.run_in_background)
    e = { kind: 'shell', what: trunc(i.description || i.command, 90), cmd: trunc(i.command, 300), until: at + BG_MAX_MS };
  else if (t === 'Monitor')
    e = {
      kind: 'monitor',
      what: trunc(i.description || i.command, 90),
      until: at + (Number(i.timeout_ms) > 0 ? Number(i.timeout_ms) + 60e3 : BG_MAX_MS)
    };
  else if (t === 'ScheduleWakeup')
    e = { kind: 'despertador', what: trunc(i.reason || 'vuelve a revisar', 90), until: at + (Number(i.delaySeconds) || 60) * 1000 + 120e3 };
  else if (t === 'CronCreate')
    e = { kind: 'cron', what: trunc(i.prompt || i.description || i.schedule || 'tarea programada', 90), until: at + BG_MAX_MS };
  else if (t === 'CronDelete') {
    for (const [k, v] of Object.entries(r.bg || {})) if (v.kind === 'cron') delete r.bg[k];
    return;
  }
  if (!e) return;
  (r.bg ||= {})[id] = { ...e, at: new Date(at).toISOString() };
}
function bgDone(r, prompt) {
  if (!r.bg) return;
  for (const m of String(prompt).matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)) {
    const id = /<tool-use-id>([^<]+)<\/tool-use-id>/.exec(m[1])?.[1],
      status = /<status>([^<]+)<\/status>/.exec(m[1])?.[1];
    if (id && status && r.bg[id]) delete r.bg[id]; // «Monitor event» (sin tool-use-id ni status) es un aviso intermedio: sigue en espera
  }
}
const bgList = r => Object.values(r.bg || {}).filter(e => e.until > Date.now());
// Lo que vence (un despertador que no sonó, un Monitor que pasó su tiempo) sale solo: se avisa a la página.
// Una shell de fondo puede morir sin aviso de fin (la consola se reinició, se mató el proceso). Cada una escribe su
// salida en un archivo (transcript: «Output is being written to: …»): si ningún proceso lo tiene abierto, ya terminó.
function bgOutput(r, toolUseId, text) {
  const out = /Output is being written to: (\S+?\.output)/.exec(String(text))?.[1];
  if (out && r.bg?.[toolUseId] && !r.bg[toolUseId].out) r.bg[toolUseId].out = out;
}
const LSOF = fs.existsSync('/usr/sbin/lsof') ? '/usr/sbin/lsof' : 'lsof';
async function checkBgAlive() {
  const files = new Map(); // archivo -> [robot, id]
  for (const r of robots.values())
    for (const [id, e] of Object.entries(r.bg || {})) if (e.out && Date.now() - Date.parse(e.at) > 60e3) files.set(e.out, [r, id]);
  if (!files.size) return;
  const touched = new Set();
  for (const [f, [r, id]] of files) {
    let alive;
    if (!fs.existsSync(f))
      alive = false; // se borró (p. ej. al reiniciar el computador)
    else {
      try {
        alive = !!(await run(LSOF, ['-t', '--', f])).stdout.trim();
      } catch (err) {
        if (err.code === 'ENOENT') return;
        alive = !!String(err.stdout || '').trim();
      } // sin lsof: solo queda el vencimiento; lsof sale con 1 si nadie lo tiene abierto
    }
    if (!alive && r.bg?.[id]) {
      delete r.bg[id];
      touched.add(r);
    }
  }
  for (const r of touched) {
    log(r, 'bg', 'Una tarea de fondo terminó sin aviso (su proceso ya no existe)');
    emit(r);
  }
}
setInterval(() => {
  checkBgAlive().catch(() => {});
}, Number(process.env.OFFICE_BG_CHECK_MS) || 120e3);
setTimeout(() => {
  checkBgAlive().catch(() => {});
}, 15e3); // al arrancar: lo reconstruido del transcript que ya murió
setInterval(() => {
  for (const r of robots.values()) {
    const n = Object.keys(r.bg || {}).length;
    if (!n) continue;
    for (const [k, v] of Object.entries(r.bg)) if (v.until <= Date.now()) delete r.bg[k];
    if (Object.keys(r.bg).length !== n) emit(r);
  }
}, 60e3);
function trackRepo(r, body) {
  const edit = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(body.tool_name) && body.hook_event_name === 'PreToolUse';
  const repo = (edit && repoOf(body.tool_input?.file_path || body.tool_input?.notebook_path)) || repoOf(body.cwd);
  if (repo && repo !== r.repo) {
    r.repo = repo;
    emit(r);
  }
  if (body.cwd && body.cwd !== r.gitCwd && repoOf(body.cwd)) r.gitCwd = body.cwd; // para «Cambios»: lo que cambió en su repo por otros medios
}

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
      r,
      tool: body.tool_name,
      input: body.tool_input,
      decide: d => {
        clearTimeout(timer);
        pending.delete(id);
        r.hold = null;
        resolve(d);
      }
    });
    closers.push(() => {
      const p = pending.get(id);
      if (p) {
        p.decide(null);
        log(r, 'sys', 'La consola cerró el permiso');
        emit(r);
      }
    });
  });
}

// Cuestionarios (AskUserQuestion): la oficina retiene el hook y te muestra las preguntas con sus opciones.
// Lo que respondas vuelve como `answers` en updatedInput y el robot lo recibe como si contestaras en su consola.
// «Responder en la consola», el reinicio de la oficina o el tiempo límite sueltan el hook y la consola muestra su menú.
function askHold(r, body, timeoutMs = APPROVAL_TIMEOUT_MS, closers = []) {
  const id = crypto.randomBytes(3).toString('hex');
  const questions = body.tool_input.questions.slice(0, 8).map(q => ({
    question: String(q.question ?? ''),
    header: trunc(q.header, 30),
    multiSelect: !!q.multiSelect,
    options: (q.options || []).slice(0, 10).map(o => ({ label: String(o.label ?? ''), description: trunc(o.description, 300) }))
  }));
  r.ask = { id, questions, at: now() };
  r.inputAt = now();
  setState(r, 'input');
  log(r, 'sys', `Te hizo ${questions.length === 1 ? 'una pregunta' : `${questions.length} preguntas`} con opciones`);
  emit(r);
  return new Promise(resolve => {
    const release = (out, note) => {
      clearTimeout(timer);
      pending.delete(id);
      if (r.ask?.id === id) r.ask = null;
      if (robots.get(r.name) === r) {
        if (note) log(r, 'sys', note);
        emit(r);
      }
      resolve(out);
    };
    const timer = setTimeout(() => release(null, 'Las preguntas pasaron a su consola (nadie respondió en la oficina)'), timeoutMs);
    pending.set(id, { r, ask: true, input: body.tool_input, release });
    closers.push(() => {
      if (pending.has(id)) {
        release(null, 'La consola cerró la pregunta (se respondió o canceló allá)');
        if (r.state === 'input' && !r.hold && !r.needsPermission) setState(r, 'working');
        emit(r);
      }
    });
  });
}

function answerAsk(r, id, answers, toConsole) {
  const p = pending.get(id);
  if (!p?.ask || p.r !== r) return false;
  if (toConsole) {
    p.release(null, 'Responderás las preguntas en su consola');
    return true;
  }
  const clean = {};
  for (const q of r.ask?.questions || []) {
    const a = String(answers?.[q.question] ?? '').trim();
    if (!a) throw new Error(`Falta responder: ${q.header || q.question}`);
    clean[q.question] = a.slice(0, 2000);
  }
  log(
    r,
    'user',
    Object.entries(clean)
      .map(([q, a]) => `**${q}** → ${a}`)
      .join('\n')
  );
  setState(r, 'working');
  p.release({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: 'Respondido desde la oficina',
      updatedInput: { ...p.input, answers: clean }
    }
  });
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
    s =
      r.subs.find(x => !x.id && x.status === 'running' && x.type === body.agent_type) || r.subs.find(x => !x.id && x.status === 'running');
    if (s) s.id = body.agent_id;
  }
  return s;
}

// Detector de bucles: si el robot (o uno de sus subagentes) usa la MISMA herramienta con los MISMOS datos varias veces
// seguidas, probablemente está dando vueltas y gastando tokens sin avanzar. Se marca con ⟳ y se avisa una vez.
// No gasta nada: solo compara los avisos de herramientas que ya llegan. Puede ser una espera a propósito (un sondeo).
const LOOP_N = Number(process.env.OFFICE_LOOP_N) || 4;
function trackLoop(r, sub, body, what) {
  const who = sub ? `sub:${sub.type}:${sub.desc}` : 'robot';
  let sig;
  try {
    sig = `${body.tool_name}|${JSON.stringify(body.tool_input ?? {}).slice(0, 4000)}`;
  } catch {
    return;
  }
  r.loopTrack ||= {};
  const t = r.loopTrack[who];
  if (t && t.sig === sig) t.n++;
  else r.loopTrack[who] = { sig, n: 1 };
  const n = r.loopTrack[who].n;
  if (n >= LOOP_N) {
    const first = !r.loop || r.loop.who !== who;
    r.loop = { who: sub ? `su subagente ${sub.type}` : r.name, what: trunc(what, 140), n, since: r.loop?.since || now() };
    if (first) {
      log(r, 'sys', `⟳ Posible bucle: ${r.loop.who} repitió lo mismo ${n} veces seguidas (${r.loop.what})`);
      broadcast({
        type: 'notice',
        text: `⟳ ${r.name} puede estar en un bucle: ${r.loop.who === r.name ? 'repitió' : r.loop.who + ' repitió'} lo mismo ${n} veces seguidas (${r.loop.what}). Si es una espera a propósito, ignóralo.`
      });
    }
  } else if (r.loop && r.loop.who === (sub ? `su subagente ${sub.type}` : r.name)) r.loop = null; // cambió de acción: ya salió
}
async function onHook(name, body, via = '', closers = []) {
  // Pregunta: la atiende el hook largo (via=ask). Si llega por el general, espera un momento por si llega el largo;
  // los robots lanzados antes de este cambio solo tienen el general y siguen como antes (9 minutos).
  if (body.hook_event_name === 'PreToolUse' && body.tool_name === 'AskUserQuestion') {
    const r0 = robots.get(name);
    if (via === 'ask') {
      if (r0) r0.longAsk = true;
    } else if (r0?.longAsk) return null;
    else {
      await new Promise(res => setTimeout(res, 1500));
      if (robots.get(name)?.longAsk) return null;
    }
  }
  fs.appendFileSync(EVENTS_FILE, JSON.stringify({ at: now(), robot: name, ...body }) + '\n');
  if (body.hook_event_name === 'SessionStart') registerSession({ robot: name, ...body });
  const r = robots.get(name);
  if (!r) return null; // robot que la oficina no lanzo: no se toca
  r.lastEventAt = now(); // la UI marca «sin actividad» a un robot ocupado que lleva mucho sin eventos
  trackRepo(r, body);
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
      if (body.source !== 'resume') r.bg = {}; // sesión nueva (o /clear): lo de fondo de antes ya no es suyo
      break;

    case 'UserPromptSubmit': {
      const p = String(body.prompt ?? '');
      if (p.startsWith('<agent-message')) log(r, 'sub', 'Un subagente entregó su resultado');
      // Claude Code le avisa al robot cuando termina algo que dejó en segundo plano: no lo escribiste tú.
      else if (/^\s*<task-notification>/.test(p)) {
        log(r, 'bg', taskNote(p));
        bgDone(r, p);
      } else {
        log(r, 'user', p);
        r.prompts = (r.prompts || 0) + 1;
        if (r.bg) for (const [k, v] of Object.entries(r.bg)) if (v.kind === 'despertador') delete r.bg[k];
      } // un despertador que sonó
      r.needsPermission = false;
      if (r.loop) {
        r.loop = null;
        r.loopTrack = {};
      } // le escribiste o le llegó algo: arranca de cero
      setState(r, 'working');
      break;
    }

    case 'PreToolUse': {
      if (internalHelper) break;
      const what = describeTool(body.tool_name, body.tool_input);
      trackLoop(r, sub, body, what);
      if (!sub) trackBg(r, body);
      if (r.routine && !r.changed && isChange(body.tool_name, body.tool_input)) r.changed = true; // también lo de sus subagentes
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
      if (!sub && body.tool_name === 'AskUserQuestion' && Array.isArray(body.tool_input?.questions))
        return askHold(r, body, via === 'ask' ? ASK_TIMEOUT_MS : APPROVAL_TIMEOUT_MS, closers);
      if (APPROVAL && HOLD_TOOLS.has(body.tool_name)) return hold(r, body, closers);
      break;
    }

    case 'PostToolUse': {
      if (internalHelper) break;
      if (['Write', 'Edit', 'MultiEdit'].includes(body.tool_name)) trackDoc(r, body.tool_name, body.tool_input?.file_path);
      if (trackFile(r, body.tool_name, body.tool_input?.file_path || body.tool_input?.notebook_path)) {
        emit(r);
        for (const o of clashPeers(r)) emit(o); // their view shows the clash too
      }
      if (!sub && r.tool) {
        r.tool = '';
        emit(r);
      } // entre herramientas, el robot piensa
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
      r.loop = null;
      r.loopTrack = {}; // terminó su turno: ya no está dando vueltas
      pumpTranscript(r);
      finishTurn(r, body.last_assistant_message);
      break;
  }
  return null; // sin salida: Claude Code sigue su flujo normal
}

export { addBg, answerAsk, bgDone, bgList, bgOutput, checkBgAlive, decide, isChange, onHook };
