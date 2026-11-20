// Oficina de Agentes · consola caída y revivir.
// Parte de daemon/daemon.mjs, que carga los módulos de daemon/lib/ en orden y arranca la oficina.
import fs from 'node:fs';
import { CLAUDE_BIN, console_, PORT, robots, run, SESSION, SETTINGS, WORKSPACE } from './base.mjs';
import { broadcast, emit, usage } from './estado.mjs';
import { convDirty, convFile, endWait, log, saveState, setState } from './persistencia.mjs';
import { drainSpawnQueue, flushIfIdle, pendingResults, resultTimers } from './equipo.mjs';
import { deliver, ROBOT_HINTS } from './turno.mjs';
import { archiveRobot } from './exportar.mjs';
import { ensureSession, launching } from './tmux.mjs';
import { emitRoutines, routines, saveRoutines } from './rutinas.mjs';
import { closeEmptyTeamSalas, ownerBackIfAlone, rosterOf, writeRoster } from './salas.mjs';

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
  endWait(r); // si se va mientras te esperaba, esa espera también cuenta
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
  for (const rt of routines) for (const h of rt.history || []) for (const x of h.robots || []) if (x.name === r.name && x.tokens == null) { x.tokens = u.out + u.in + u.cacheWrite; x.state = reason === 'rutina sin cambios' ? 'sin cambios' : 'se fue'; touched = true; }
  if (touched) { saveRoutines(); emitRoutines(); }
  for (const s of rosterOf(r.name)) { const e = s.roster.find(x => x.name === r.name); if (e && r.transcript) e.transcript = r.transcript; writeRoster(s); } // su transcript queda para el gasto del equipo
  if (pendingResults.has(r.name)) { clearTimeout(resultTimers.get(r.name)); resultTimers.delete(r.name); pendingResults.delete(r.name); } // se fue el padre
  flushIfIdle(r.parent);
  ownerBackIfAlone();
  closeEmptyTeamSalas();
  setTimeout(drainSpawnQueue, 500);
}

export { markLost, removeRobot, revive };
