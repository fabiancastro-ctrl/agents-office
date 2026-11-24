// Oficina de Agentes · lectura del transcript de cada robot.
// Parte de daemon/daemon.mjs, que carga los módulos de daemon/lib/ en orden y arranca la oficina.
import fs from 'node:fs';
import { now, robots, trunc } from './base.mjs';
import { emit, fmtK } from './estado.mjs';
import { log, setState } from './persistencia.mjs';
import { addBg, bgDone, bgOutput } from './hooks.mjs';

/* ---------- transcript ---------- */

function pumpTranscript(r) {
  if (!r.transcript) return;
  let size;
  try {
    size = fs.statSync(r.transcript).size;
  } catch {
    return;
  }
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
    // Un aviso de fin de tarea de fondo puede llegar en medio de un turno: Claude Code lo guarda como entrada interna
    // (attachment o queue-operation) y no pasa por el hook de tus mensajes. Se busca en cualquier línea.
    if (r.bg && line.includes('<task-notification>')) {
      const n = Object.keys(r.bg).length;
      bgDone(r, line.replace(/\\n/g, '\n').replace(/\\\//g, '/'));
      if (!r.restoring && Object.keys(r.bg).length !== n) emit(r);
    }
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    onTranscript(r, e);
  }
}

// Comandos que escribes en su consola y no pasan por el hook de tus mensajes: «!comando» (modo bash) y los
// comandos locales de Claude (/context, /compact, /model…). Solo quedan en el transcript: se muestran como «shell».
const tagOf = (t, k) => (new RegExp(`<${k}>([\\s\\S]*?)</${k}>`).exec(t) || [])[1];
const cutKeep = (t, n) => (t.length > n ? t.slice(0, n) + '\n…' : t); // como trunc, pero respeta los saltos de línea
const stripAnsi = t =>
  String(t ?? '')
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\r/g, '');
function shellLog(r, text) {
  const bi = tagOf(text, 'bash-input');
  if (bi != null) {
    log(r, 'shell', bi.trim(), { cmd: true });
    return true;
  }
  const bo = tagOf(text, 'bash-stdout'),
    be = tagOf(text, 'bash-stderr');
  if (bo != null || be != null) {
    const out = [stripAnsi(bo).trim(), stripAnsi(be).trim()].filter(Boolean).join('\n');
    log(r, 'shell', cutKeep(out, 6000) || '(sin salida)', { err: !!stripAnsi(be).trim() });
    return true;
  }
  const name = tagOf(text, 'command-name');
  if (name) {
    log(r, 'shell', `${name.trim()} ${(tagOf(text, 'command-args') || '').trim()}`.trim(), { cmd: true, slash: true });
    return true;
  }
  const lo = tagOf(text, 'local-command-stdout'),
    le = tagOf(text, 'local-command-stderr');
  if (lo != null || le != null) {
    const out = [stripAnsi(lo).trim(), stripAnsi(le).trim()].filter(Boolean).join('\n');
    log(r, 'shell', cutKeep(out, 6000) || '(sin salida)', { err: !!stripAnsi(le).trim() });
    return true;
  }
  return false;
}
function onTranscript(r, e) {
  if (e.isSidechain) return;
  if (e.type === 'system' && e.subtype === 'local_command') {
    if (shellLog(r, String(e.content ?? ''))) {
      r.lastEventAt = now();
      emit(r);
    }
    return;
  }
  // /compact (o el automático): Claude anota cuánto contexto quedó. Hasta su próxima respuesta, el medidor usa eso.
  if (e.type === 'system' && e.subtype === 'compact_boundary') {
    const post = Number(e.compactMetadata?.postTokens);
    r.ctxPost = Number.isFinite(post) && post > 0 ? post : 0;
    log(
      r,
      'sys',
      `Compactó su contexto${e.compactMetadata?.preTokens ? `: de ${fmtK(e.compactMetadata.preTokens)} a ${fmtK(r.ctxPost)} tokens` : ''}`
    );
    if (!r.restoring) emit(r); // el medidor del escritorio baja ya, sin esperar otro evento del robot
    return;
  }
  if (e.type === 'assistant' && e.message) {
    // Un mensaje llega en varias lineas con el mismo id; la ultima trae el usage final.
    if (e.message.id && e.message.usage) {
      r.msgUsage.set(e.message.id, e.message.usage);
      r.ctxPost = null;
    }
    if (e.message.model && e.message.model !== '<synthetic>') r.model = e.message.model;
    for (const c of e.message.content || []) {
      // Tareas de fondo (shell, Monitor, despertador, cron): quedan anotadas aunque se hayan lanzado antes de reiniciar.
      if (c.type === 'tool_use') addBg(r, c.id, c.name, c.input, Date.parse(e.timestamp) || Date.now());
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
    // Last tool result decides the ephemeral «frustrated» flag: PostToolUse only fires for successful tools, so the
    // failure shows up here as is_error. The user's own refusal or Esc is not a tool failure.
    const results = Array.isArray(content) ? content.filter(c => c.type === 'tool_result') : [];
    if (results.length) {
      const last = results[results.length - 1];
      const body = typeof last.content === 'string' ? last.content : JSON.stringify(last.content || '');
      const failed = last.is_error === true && !/doesn't want to proceed|Request interrupted|was rejected/i.test(body);
      if (!!r.toolError !== failed) {
        r.toolError = failed;
        if (!r.restoring) emit(r);
      }
    }
    if (r.bg && Array.isArray(content))
      for (const c of content)
        if (c.type === 'tool_result' && r.bg[c.tool_use_id])
          bgOutput(r, c.tool_use_id, typeof c.content === 'string' ? c.content : JSON.stringify(c.content));
    if (/<bash-(input|stdout|stderr)>/.test(text)) {
      shellLog(r, text);
      r.lastEventAt = now();
      emit(r);
      return;
    }
    // Esc no dispara Stop: la interrupcion solo se ve en el transcript.
    if (/\[Request interrupted/.test(text) && !r.restoring) {
      log(r, 'sys', 'Interrumpido');
      r.needsPermission = false;
      setState(r, 'idle');
      emit(r);
    }
  }
}

setInterval(() => {
  for (const r of robots.values()) pumpTranscript(r);
}, 1000);

export { pumpTranscript };
