// Base de las pruebas: levanta una oficina aislada (carpeta de datos y carpeta de trabajo temporales, su propia
// sesión de tmux y un puerto libre) con un «Claude falso» que no llama a nada ni gasta cuota. Los avisos de Claude
// (hooks) se simulan con POST /hook, igual que los manda hooks/office-hook.sh.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const sleep = ms => new Promise(r => setTimeout(r, ms));

const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); s.on('error', rej); });

export async function waitFor(fn, { timeout = 15000, every = 150, what = 'la condición' } = {}) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) { try { last = await fn(); if (last) return last; } catch (e) { last = e; } await sleep(every); }
  throw new Error(`Se acabó el tiempo esperando ${what}${last instanceof Error ? `: ${last.message}` : ''}`);
}

// opts.robots: robots ya «en la oficina» al arrancar (con su ventana de tmux), como tras un reinicio.
export async function startOffice(opts = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'office-test-'));
  const data = path.join(base, 'datos'), ws = path.join(base, 'trabajo');
  fs.mkdirSync(data); fs.mkdirSync(path.join(ws, 'docs'), { recursive: true });
  const port = await freePort();
  const session = `office-test-${port}`;
  const claudeLog = path.join(base, 'claude.log');
  // Claude falso: anota con qué argumentos lo abrieron y se queda vivo (cat) para que la ventana exista.
  const fake = path.join(base, 'claude-falso.sh');
  // Una llamada por línea: los saltos de línea del prompt se anotan como espacios.
  fs.writeFileSync(fake, `#!/bin/sh\n{ printf '%s' "$*" | tr '\\n' ' '; printf '\\n'; } >> '${claudeLog}'\nexec cat\n`, { mode: 0o755 });
  if (opts.robots?.length) {
    execFileSync('tmux', ['new-session', '-d', '-s', session, '-n', 'lobby']);
    for (const r of opts.robots) execFileSync('tmux', ['new-window', '-d', '-t', `${session}:`, '-n', r.name, 'cat']);
    fs.writeFileSync(path.join(data, 'office-state.json'), JSON.stringify({ colorSeq: 0, maxRobots: opts.maxRobots || 4, inbox: [], robots: opts.robots.map(fakeRobot) }));
  }
  if (opts.maxRobots) process.env.OFFICE_MAX_ROBOTS_TEST = String(opts.maxRobots);
  const env = { ...process.env, OFFICE_DATA: data, OFFICE_PORT: String(port), OFFICE_SESSION: session, OFFICE_WORKSPACE: ws,
    OFFICE_CLAUDE_BIN: fake, OFFICE_CONSOLE_CHECK_MS: '700', OFFICE_ROUTINE_TICK_MS: '300', ...(opts.maxRobots ? { OFFICE_MAX_ROBOTS: String(opts.maxRobots) } : {}), ...opts.env };
  const proc = spawn(process.execPath, [path.join(ROOT, 'daemon/daemon.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; proc.stdout.on('data', d => { out += d; }); proc.stderr.on('data', d => { out += d; });
  const url = `http://127.0.0.1:${port}`;
  // /api/setup responde siempre (GET /api/config no existe: config solo acepta POST). Si no arranca, se cierra el
  // daemon y su sesión para que no queden procesos vivos que cuelguen la corrida.
  try {
    await waitFor(async () => (await fetch(`${url}/api/setup`)).ok, { what: 'que arranque la oficina' });
  } catch (e) {
    proc.kill();
    try { execFileSync('tmux', ['kill-session', '-t', session], { stdio: 'ignore' }); } catch { /* no estaba */ }
    fs.rmSync(base, { recursive: true, force: true });
    throw new Error(`${e.message}\n--- salida del daemon ---\n${out}`);
  }
  const o = {
    url, port, session, data, ws, base, proc, log: () => out,
    claudeCalls: () => (fs.existsSync(claudeLog) ? fs.readFileSync(claudeLog, 'utf8').trim().split('\n').filter(Boolean) : []),
    async api(method, p, body) {
      const res = await fetch(url + p, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      const txt = await res.text();
      let json; try { json = JSON.parse(txt); } catch { json = txt; }
      return { status: res.status, ok: res.ok, body: json };
    },
    // El primer mensaje de /api/events: el estado completo de la oficina.
    async snapshot() {
      const ac = new AbortController();
      const res = await fetch(`${url}/api/events`, { signal: ac.signal });
      const reader = res.body.getReader(); let buf = '';
      while (!buf.includes('\n\n')) { const { value, done } = await reader.read(); if (done) break; buf += new TextDecoder().decode(value); }
      ac.abort();
      return JSON.parse(buf.split('\n\n')[0].replace(/^data: /, ''));
    },
    async robot(name) { return (await o.snapshot()).robots.find(r => r.name === name); },
    // Aviso de Claude simulado (hook). Devuelve la respuesta de la oficina (p. ej. la decisión de una pregunta).
    async hook(robot, body, via = '') {
      const res = await fetch(`${url}/hook?robot=${robot}${via ? `&via=${via}` : ''}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return res.json().catch(() => null);
    },
    windows() { try { return execFileSync('tmux', ['list-windows', '-t', session, '-F', '#{window_name}']).toString().trim().split('\n'); } catch { return []; } },
    async stop() {
      proc.kill();
      await new Promise(r => proc.once('exit', r)).catch(() => {});
      try { execFileSync('tmux', ['kill-session', '-t', session], { stdio: 'ignore' }); } catch { /* ya no estaba */ }
      fs.rmSync(base, { recursive: true, force: true });
    }
  };
  return o;
}

function fakeRobot(r) {
  return { kind: 'libre', skill: null, label: r.label || 'prueba', prompt: 'prueba', color: r.color ?? 1, place: { type: 'desk', idx: r.idx ?? 0 }, permissionMode: '',
    sessionId: r.sessionId || '11111111-2222-3333-4444-' + String(Math.random()).slice(2, 14).padEnd(12, '0'), transcript: null,
    startedAt: new Date().toISOString(), state: r.state || 'done', docs: [], timeline: [{ at: new Date().toISOString(), s: r.state || 'done' }], ...r };
}

// Un turno completo simulado: tú le escribes y el robot responde.
export async function turn(o, robot, said, reply) {
  await o.hook(robot, { hook_event_name: 'UserPromptSubmit', prompt: said });
  await o.hook(robot, { hook_event_name: 'Stop', last_assistant_message: reply });
}
