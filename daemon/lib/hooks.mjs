// Oficina de Agentes · hooks de Claude Code y permisos retenidos.
// Parte de daemon/daemon.mjs, que carga los módulos de daemon/lib/ en orden y arranca la oficina.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { APPROVAL, APPROVAL_TIMEOUT_MS, ASK_TIMEOUT_MS, describeTool, EVENTS_FILE, HOLD_TOOLS, NEVER_ALLOW, now, pending, robots, trunc } from './base.mjs';
import { broadcast, emit } from './estado.mjs';
import { registerSession } from './uso.mjs';
import { log, setState, taskNote } from './persistencia.mjs';
import { finishTurn, trackDoc } from './turno.mjs';
import { pumpTranscript } from './transcript.mjs';

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

// Detector de bucles: si el robot (o uno de sus subagentes) usa la MISMA herramienta con los MISMOS datos varias veces
// seguidas, probablemente está dando vueltas y gastando tokens sin avanzar. Se marca con ⟳ y se avisa una vez.
// No gasta nada: solo compara los avisos de herramientas que ya llegan. Puede ser una espera a propósito (un sondeo).
const LOOP_N = Number(process.env.OFFICE_LOOP_N) || 4;
function trackLoop(r, sub, body, what) {
  const who = sub ? `sub:${sub.type}:${sub.desc}` : 'robot';
  let sig;
  try { sig = `${body.tool_name}|${JSON.stringify(body.tool_input ?? {}).slice(0, 4000)}`; } catch { return; }
  r.loopTrack ||= {};
  const t = r.loopTrack[who];
  if (t && t.sig === sig) t.n++; else r.loopTrack[who] = { sig, n: 1 };
  const n = r.loopTrack[who].n;
  if (n >= LOOP_N) {
    const first = !r.loop || r.loop.who !== who;
    r.loop = { who: sub ? `su subagente ${sub.type}` : r.name, what: trunc(what, 140), n, since: r.loop?.since || now() };
    if (first) {
      log(r, 'sys', `⟳ Posible bucle: ${r.loop.who} repitió lo mismo ${n} veces seguidas (${r.loop.what})`);
      broadcast({ type: 'notice', text: `⟳ ${r.name} puede estar en un bucle: ${r.loop.who === r.name ? 'repitió' : r.loop.who + ' repitió'} lo mismo ${n} veces seguidas (${r.loop.what}). Si es una espera a propósito, ignóralo.` });
    }
  } else if (r.loop && r.loop.who === (sub ? `su subagente ${sub.type}` : r.name)) r.loop = null; // cambió de acción: ya salió
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
      if (r.loop) { r.loop = null; r.loopTrack = {}; } // le escribiste o le llegó algo: arranca de cero
      setState(r, 'working');
      break;
    }

    case 'PreToolUse': {
      if (internalHelper) break;
      const what = describeTool(body.tool_name, body.tool_input);
      trackLoop(r, sub, body, what);
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
      r.loop = null; r.loopTrack = {}; // terminó su turno: ya no está dando vueltas
      pumpTranscript(r);
      finishTurn(r, body.last_assistant_message);
      break;
  }
  return null; // sin salida: Claude Code sigue su flujo normal
}

export { answerAsk, decide, onHook };
