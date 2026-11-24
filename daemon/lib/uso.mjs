// Oficina de Agentes · uso de tokens, gasto por robot, empleado de la semana y estado de la suscripción.
// Parte de daemon/daemon.mjs, que carga los módulos de daemon/lib/ en orden y arranca la oficina.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CLAUDE_BIN, clients, console_, now, robots, run, RUNS, SESSION, WORKSPACE } from './base.mjs';
import { broadcast, configView, emit, fmtK } from './estado.mjs';
import { readConfig, saveConfig } from './carpeta.mjs';
import { accountName, accounts, accountTmuxEnv, normAccount, PRINCIPAL, weekUsed } from './cuentas.mjs';
import { log } from './persistencia.mjs';
import { lookFromName } from './equipo.mjs';
import { archive } from './turno.mjs';
import { ensureSession } from './tmux.mjs';
import { emitSalas, salas, saveSalas } from './salas.mjs';

/* ---------- uso de tokens de toda la oficina, por semana ---------- */
// Se calcula desde los transcripts de las sesiones que lanzó la oficina (el hook SessionStart queda en
// runs/events-*.jsonl), incluidos sus subagentes. Así sobrevive a reinicios del daemon y no cuenta dos veces.
const officeSessions = new Map(); // sessionId -> { transcript, robot }
function registerSession(e) {
  if (e.session_id && e.transcript_path && !officeSessions.has(e.session_id))
    officeSessions.set(e.session_id, { transcript: e.transcript_path, robot: e.robot });
}
function loadSessions() {
  for (const f of fs.readdirSync(RUNS).filter(f => /^(events.*|sesiones)\.jsonl$/.test(f))) {
    // sesiones.jsonl: lo rescatado de los eventos limpiados
    for (const line of fs.readFileSync(path.join(RUNS, f), 'utf8').split('\n')) {
      if (!line.includes('"SessionStart"')) continue;
      try {
        registerSession(JSON.parse(line));
      } catch {
        /* linea cortada */
      }
    }
  }
}

// Lunes (hora local) de la semana del instante dado, como AAAA-MM-DD.
function weekOf(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const usageCache = new Map(); // archivo -> { size, msgs: Map(id -> { at, u }) }
function fileUsage(file) {
  let size;
  try {
    size = fs.statSync(file).size;
  } catch {
    return null;
  }
  const c = usageCache.get(file);
  if (c && c.size === size) return c.msgs;
  const msgs = new Map();
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.includes('"usage"')) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
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
    try {
      files.push(
        ...fs
          .readdirSync(subDir)
          .filter(f => f.endsWith('.jsonl'))
          .map(f => path.join(subDir, f))
      );
    } catch {
      /* sin subagentes */
    }
    for (const f of files) {
      const msgs = fileUsage(f);
      if (!msgs) continue;
      for (const { at, u } of msgs.values()) {
        const k = weekOf(at);
        let w = weeks.get(k);
        if (!w) weeks.set(k, (w = { week: k, in: 0, out: 0, cacheRead: 0, cacheWrite: 0, sessions: new Set() }));
        w.in += u.input_tokens || 0;
        w.out += u.output_tokens || 0;
        w.cacheRead += u.cache_read_input_tokens || 0;
        w.cacheWrite += u.cache_creation_input_tokens || 0;
        w.sessions.add(sid);
      }
    }
  }
  return [...weeks.values()]
    .sort((a, b) => b.week.localeCompare(a.week))
    .slice(0, 8)
    .map(w => ({ ...w, sessions: w.sessions.size }));
}

/* ---------- gasto por robot ---------- */
// Cuánto lleva cada robot esta semana (con sus subagentes) y en la última hora, y qué parte es del gasto de la
// oficina esta semana. Es la parte de lo que gastó la OFICINA, no del límite de tu suscripción (Claude no lo
// expone por robot). «Gasto» = entrada + salida + caché escrita, como los KPI de la oficina. No gasta cuota: son
// cuentas sobre los transcripts. Avisa una vez cuando un robot se dispara: mucho en la última hora (en NR el 95 %
// de las horas de un robot quedan bajo 1,65 M) o más de la cuarta parte de la semana con la semana ya avanzada.
const SPEND_HOUR_HOT = Number(process.env.OFFICE_SPEND_HOUR_HOT || 1.5e6);
const SPEND_SHARE_HOT = 25,
  SPEND_SHARE_MIN_WEEK = Number(process.env.OFFICE_SPEND_MIN_WEEK || 5e6);
const SPEND_TICK_MS = Number(process.env.OFFICE_SPEND_TICK_MS || 60000);
const fmtM = n => (n >= 1e6 ? `${(n / 1e6).toFixed(1).replace('.', ',')} M` : fmtK(n));
const spendTok = u => (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_creation_input_tokens || 0);
function sessionFiles(transcript) {
  if (!transcript) return [];
  const files = [transcript];
  const subDir = path.join(transcript.replace(/\.jsonl$/, ''), 'subagents');
  try {
    files.push(
      ...fs
        .readdirSync(subDir)
        .filter(f => f.endsWith('.jsonl'))
        .map(f => path.join(subDir, f))
    );
  } catch {
    /* sin subagentes */
  }
  return files;
}
// Gasto de un robot en la semana de la cuota (desde weekFrom, la misma que usa el empleado de la semana) y en la última hora.
function robotSpend(r, weekFrom, hourAgo) {
  let week = 0,
    hour = 0;
  for (const f of sessionFiles(r.transcript)) {
    const msgs = fileUsage(f);
    if (!msgs) continue;
    for (const { at, u } of msgs.values()) {
      if (Date.parse(at) < weekFrom) continue;
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
const WEEK_MS = 7 * 86400e3,
  SESSION_MS = 5 * 3600e3;
function quotaPeriods(t = Date.now()) {
  const q = readConfig().quota || {};
  let weekEnd = Number(q.weekEnd) || 0;
  if (weekEnd) while (weekEnd <= t) weekEnd += WEEK_MS; // ya se renovó: la siguiente, 7 días después
  const monday = new Date(weekOf(t) + 'T00:00:00').getTime();
  const sessionEnd = Number(q.sessionEnd) || 0;
  return {
    weekFrom: weekEnd ? weekEnd - WEEK_MS : monday,
    weekTo: weekEnd || monday + WEEK_MS,
    weekKnown: !!weekEnd,
    sessionFrom: sessionEnd > t ? sessionEnd - SESSION_MS : t - SESSION_MS,
    sessionTo: sessionEnd > t ? sessionEnd : null
  };
}
let fame = { employee: null, sessionTop: null, period: null };
// 9 · Muro de la fama: el que más gastó en cada una de las últimas n semanas de la cuota (la actual incluida).
// Se calcula solo cuando abres la vista (lupa del cuadro), sobre los transcripts: no gasta cuota.
function topSpender(from, to) {
  const by = new Map();
  for (const s of officeSessions.values()) {
    if (!s.robot) continue;
    for (const f of sessionFiles(s.transcript)) {
      const msgs = fileUsage(f);
      if (msgs)
        for (const { at, u } of msgs.values()) {
          const ms = Date.parse(at);
          if (ms >= from && ms < to) by.set(s.robot, (by.get(s.robot) || 0) + spendTok(u));
        }
    }
  }
  const top = [...by].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  return top && top[1] > 0 ? top : null;
}
function fameWall(n = 4) {
  const per = quotaPeriods();
  return Array.from({ length: n }, (_, k) => {
    const from = per.weekFrom - k * WEEK_MS,
      to = from + WEEK_MS,
      t = topSpender(from, to),
      name = t?.[0] || null;
    const live = name && robots.get(name),
      gone = name && !live ? [...archive].reverse().find(a => a.name === name) : null,
      src = live || gone;
    return {
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
      current: k === 0,
      name,
      tokens: t?.[1] || 0,
      color: src?.color ?? 0,
      look: src?.look || (name ? lookFromName(name) : null),
      present: !!live,
      title: live?.title || gone?.title || ''
    };
  });
}
// Lo que gastó toda la oficina en la semana de la cuota: base del «% sem.» de cada robot (así cuadra con el empleado).
// quotaWeekByAcc: the same total split by the account that spent it ('' = principal), for the 25 % rule per account.
let quotaWeekByAcc = new Map();
const accountOfName = name => normAccount((robots.get(name) || [...archive].reverse().find(a => a.name === name))?.account);
function computeFame(per) {
  const byWeek = new Map(),
    bySession = new Map();
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
  const em = top(byWeek),
    st = top(bySession);
  quotaWeekByAcc = new Map();
  for (const [name, t] of byWeek) {
    const a = accountOfName(name);
    quotaWeekByAcc.set(a, (quotaWeekByAcc.get(a) || 0) + t); // total de cada cuenta en la semana de la cuota
  }
  let employee = null;
  if (em && em[1] > 0) {
    // su cara: la del robot si está; si no, la que tenía al irse (archivo); si no, la de su nombre
    const live = robots.get(em[0]),
      gone = live ? null : [...archive].reverse().find(a => a.name === em[0]);
    const src = live || gone;
    employee = {
      name: em[0],
      tokens: em[1],
      color: src?.color ?? 0,
      look: src?.look || lookFromName(em[0]),
      present: !!live,
      title: live?.title || gone?.title || ''
    };
  }
  return {
    employee,
    sessionTop: st && st[1] > 0 ? { name: st[0], tokens: st[1] } : null,
    period: { from: new Date(per.weekFrom).toISOString(), to: new Date(per.weekTo).toISOString(), known: per.weekKnown }
  };
}
// « (cuenta X)» when the office has several accounts and the robot is not on the principal one.
const accountTag = r => (normAccount(r.account) ? ` (cuenta ${accountName(r.account)})` : '');
const crownOf = name => (fame.employee?.name === name ? (fame.sessionTop?.name === name ? 2 : 1) : 0);

// Gasto de cada equipo: lo de todos los que pasaron por su sala (padre e hijos, también los que ya se fueron, con sus
// subagentes) desde que se armó. Sale de los transcripts como el gasto por robot: no gasta cuota. No se guarda: se
// recalcula cada minuto.
function updateTeamSpend() {
  let changed = false,
    learned = false;
  for (const s of salas) {
    if (!s.roster?.length) continue;
    const from = Date.parse(s.createdAt) || 0;
    let total = 0;
    for (const e of s.roster) {
      // Se anota el transcript mientras el robot está, así su gasto sigue contando cuando se va.
      const live = robots.get(e.name);
      if (live?.transcript && e.transcript !== live.transcript) {
        e.transcript = live.transcript;
        learned = true;
      }
      const sid = e.sessionId || live?.sessionId;
      const tr =
        e.transcript ||
        (sid && WORKSPACE ? path.join(os.homedir(), '.claude/projects', WORKSPACE.replace(/\//g, '-'), `${sid}.jsonl`) : null);
      for (const f of sessionFiles(tr)) {
        const msgs = fileUsage(f);
        if (msgs) for (const { at, u } of msgs.values()) if (Date.parse(at) >= from) total += spendTok(u);
      }
    }
    if (s.spend !== total) {
      s.spend = total;
      changed = true;
    }
  }
  if (learned) saveSalas();
  if (changed) emitSalas();
}
function updateSpend() {
  const hourAgo = Date.now() - 3600e3,
    per = quotaPeriods();
  const prevFame = fame;
  fame = computeFame(per);
  if (JSON.stringify(prevFame) !== JSON.stringify(fame)) {
    for (const n of new Set([prevFame.employee?.name, fame.employee?.name])) {
      const r = n && robots.get(n);
      if (r) emit(r);
    } // su corona cambió
    broadcast({ type: 'fame', fame }); // después de los robots: el cuadro se dibuja con la corona ya puesta
    if (fame.employee && prevFame.employee && fame.employee.name !== prevFame.employee.name)
      broadcast({
        type: 'notice',
        text:
          fame.period.from !== prevFame.period?.from
            ? `👑 Se renovó la cuota semanal: arranca una semana nueva y ${fame.employee.name} es el primer empleado de la semana.`
            : `👑 Nuevo empleado de la semana: ${fame.employee.name} (${fmtM(fame.employee.tokens)} tokens).`
      });
  }
  // «% sem.»: parte del gasto de la oficina en la semana de la cuota, la misma ventana que el empleado de la semana.
  // Antes usaba la semana del calendario (desde el lunes) y no cuadraba: un robot podía salir con 34 % sin ser el empleado.
  for (const r of robots.values()) {
    const officeWeek = quotaWeekByAcc.get(normAccount(r.account)) || 0; // the 25 % rule counts against the robot's own account
    const { week, hour } = robotSpend(r, per.weekFrom, hourAgo);
    const pct = officeWeek ? Math.min(100, Math.round((week * 100) / officeWeek)) : 0;
    const hot = hour >= SPEND_HOUR_HOT ? 'hour' : pct >= SPEND_SHARE_HOT && officeWeek >= SPEND_SHARE_MIN_WEEK ? 'share' : null;
    const next = { week, hour, pct, officeWeek, hot };
    const prev = r.spend;
    r.spend = next;
    if (hot && !prev?.hot) {
      const why =
        hot === 'hour'
          ? `gastó ${fmtM(hour)} tokens en la última hora`
          : `lleva el ${pct} % del gasto de la oficina esta semana${accountTag(r)} (${fmtM(week)} de ${fmtM(officeWeek)})`;
      log(r, 'sys', `🔥 Se disparó: ${why}`);
      broadcast({ type: 'notice', text: `🔥 ${r.name} se disparó: ${why}. Míralo por si está en un bucle.` });
    }
    if (!prev || prev.week !== week || prev.hour !== hour || prev.pct !== pct || prev.hot !== hot) emit(r);
  }
  updateTeamSpend();
}
const spendTick = () => {
  try {
    updateSpend();
  } catch (e) {
    console_('oficina', 'gasto', e.message);
  }
};
setInterval(spendTick, SPEND_TICK_MS);
setTimeout(spendTick, Math.min(1500, SPEND_TICK_MS)); // al arrancar: cuadro del mes y coronas sin esperar el primer minuto

/* ---------- estado de la suscripción (/usage) ---------- */
// Una consola tmux aparte por cuenta (_status para la principal, _status-<id> para las demás, cada una con su
// CLAUDE_CONFIG_DIR y sin hooks de la oficina) donde se abre /usage y se lee la pantalla.
// Mirar /usage no envía mensajes al modelo, así que no gasta cuota.
const statusWindow = id => (id ? `_status-${id}` : '_status');
const wait = ms => new Promise(r => setTimeout(r, ms));
const statusCache = new Map(), // account ('' = principal) -> { limits, detail, at } of the last good reading
  statusErr = new Map(), // account -> message of the last failed reading
  statusPending = new Map(); // account -> promise of the reading in progress

async function capturePane(target) {
  return (await run('tmux', ['capture-pane', '-p', '-t', target])).stdout;
}

async function readClaudeStatus(account = '') {
  await ensureSession();
  const win = statusWindow(account),
    target = `${SESSION}:${win}`;
  let windows = [];
  try {
    windows = (await run('tmux', ['list-windows', '-t', SESSION, '-F', '#{window_name}'])).stdout.split('\n');
  } catch {
    /* sin sesion */
  }
  const fresh = !windows.includes(win);
  if (fresh) {
    await run('tmux', [
      'new-window',
      '-d',
      '-t',
      `${SESSION}:`,
      '-n',
      win,
      '-c',
      WORKSPACE,
      ...accountTmuxEnv(account),
      'env',
      '-u',
      'ANTHROPIC_API_KEY',
      CLAUDE_BIN
    ]);
    await run('tmux', ['resize-window', '-t', target, '-x', '120', '-y', '80']).catch(() => {});
    await wait(6000);
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    await run('tmux', ['send-keys', '-t', target, 'Escape']);
    await wait(300);
    await run('tmux', ['send-keys', '-t', target, '-l', '/usage']);
    await wait(700);
    await run('tmux', ['send-keys', '-t', target, 'Enter']);
    for (let i = 0; i < 20; i++) {
      await wait(500);
      const text = await capturePane(target);
      if (/\d+% used/.test(text) && /Resets/.test(text)) {
        await wait(800); // deja terminar de pintar la lista
        const full = await capturePane(target);
        await run('tmux', ['send-keys', '-t', target, 'Escape']).catch(() => {});
        return parseClaudeStatus(full, account);
      }
    }
    await wait(3000); // la consola pudo no estar lista todavia
  }
  throw new Error(`No se pudo leer /usage. Abre la consola con: tmux attach -t ${target}`);
}

// /usage sale en inglés: se traducen las frases conocidas; lo que no se reconoce se deja tal cual.
const MONTHS = {
  Jan: 'ene',
  Feb: 'feb',
  Mar: 'mar',
  Apr: 'abr',
  May: 'may',
  Jun: 'jun',
  Jul: 'jul',
  Aug: 'ago',
  Sep: 'sep',
  Oct: 'oct',
  Nov: 'nov',
  Dec: 'dic'
};
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
  const h = (Number(m[3]) % 12) + (m[5].toLowerCase() === 'pm' ? 12 : 0),
    d = new Date(from);
  if (m[1] && MON_N[m[1]] !== undefined) {
    const t = new Date(d.getFullYear(), MON_N[m[1]], Number(m[2]), h, Number(m[4] || 0));
    if (t.getTime() < from - 86400e3) t.setFullYear(t.getFullYear() + 1); // «Jan 2» visto en diciembre
    return t.getTime();
  }
  const t = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, Number(m[4] || 0));
  if (t.getTime() <= from) t.setDate(t.getDate() + 1);
  return t.getTime();
}
function parseClaudeStatus(text, account = '') {
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
    if (at && /^Current week \(all models\)$/.test(clean[i - 1] || '')) {
      ends.weekEnd = at;
      ends.weekPct = Number(m[1]);
      ends.weekPctAt = Date.now();
    }
  });
  if (ends.sessionEnd || ends.weekEnd) {
    // Each account keeps its own reading in quotaAcc; `quota` (what the header chip, the coffee pot, the plants and the
    // employee of the week read) is a copy of the FULLEST account's reading. With one account it is that account's.
    const key = account || PRINCIPAL,
      cfg = readConfig(),
      qa = { ...(cfg.quotaAcc || {}) };
    const q = { ...(qa[key] || (account ? null : cfg.quota) || {}), ...ends };
    // 3 · Historial: el % más alto leído en cada semana de la cuota (clave = día en que termina), últimas 16 semanas.
    if (ends.weekEnd && Number.isFinite(ends.weekPct)) {
      const k = new Date(ends.weekEnd).toLocaleDateString('sv'),
        h = { ...(q.history || {}) };
      h[k] = Math.max(h[k] || 0, ends.weekPct);
      q.history = Object.fromEntries(Object.entries(h).sort().slice(-16));
    }
    qa[key] = q;
    const head = fullestQuota(qa);
    saveConfig({ quotaAcc: qa, quota: { ...head.q, account: head.id } });
    broadcast({ type: 'config', config: configView() });
    warnAccount(key, q);
  }
  const start = clean.findIndex(l => /^What's contributing/.test(l));
  const detail =
    start < 0
      ? ''
      : lines
          .slice(start)
          .filter(l => l.trim() && !/^\s*(Esc to|f to fix)/.test(l))
          .map(toSpanish)
          .join('\n');
  return { limits, detail, at: now() };
}

// La cafetera de la sala de descanso muestra cuánto queda de tu cuota semanal: se relee /usage (comando local de
// Claude Code, no gasta tokens) una vez por hora mientras haya alguien con la oficina abierta.
setInterval(() => {
  if (clients.size && WORKSPACE) claudeStatus(true).catch(() => {});
}, Number(process.env.OFFICE_USAGE_REFRESH_MS) || 3600e3);
// Notice (once per account and week) when an account passes 90 % of its weekly quota: suggests the least used other one.
const ACCOUNT_WARN_PCT = 90,
  warned = new Set();
function warnAccount(key, q) {
  const used = weekUsed(q);
  if (used === null || used < ACCOUNT_WARN_PCT || accounts().length < 2) return;
  const mark = `${key}:${q.weekEnd || ''}`;
  if (warned.has(mark)) return;
  warned.add(mark);
  const qa = readConfig().quotaAcc || {};
  const others = accounts()
    .filter(a => a.id !== key)
    .map(a => ({ a, used: weekUsed(qa[a.id]) }))
    .filter(x => x.used !== null && x.used < used)
    .sort((x, y) => x.used - y.used);
  const name = accountName(key === PRINCIPAL ? '' : key);
  const tip = others.length
    ? ` Lanza los siguientes robots en «${others[0].a.nombre}» (${others[0].used} %) o elige «Automática» en el selector de Cuenta.`
    : '';
  broadcast({ type: 'notice', text: `⚠ La cuenta «${name}» va en ${used} % de su cuota semanal.${tip}` });
}
// The registered account with the highest weekly % in the saved readings: { id, q }. Ties go to the first (principal).
function fullestQuota(qa) {
  let best = null;
  for (const a of accounts()) {
    const q = qa[a.id];
    if (q && Number.isFinite(q.weekPct) && (!best || q.weekPct > best.q.weekPct)) best = { id: a.id, q };
  }
  return best || { id: PRINCIPAL, q: qa[PRINCIPAL] || {} };
}
// Weekly % of a /usage reading (the «all models» limit; the highest limit if that one is missing).
const weekPctOf = s => {
  const lim = s?.limits || [];
  const w = lim.find(l => /^Semana actual \(todos los modelos\)$/.test(l.title));
  return w ? w.pct : lim.length ? Math.max(...lim.map(l => l.pct)) : -1;
};
function readOne(id, refresh) {
  const c = statusCache.get(id);
  if (c && !refresh && Date.now() - Date.parse(c.at) < 60_000) return Promise.resolve(c);
  if (!statusPending.has(id))
    statusPending.set(
      id,
      readClaudeStatus(id)
        .then(s => {
          statusErr.delete(id);
          statusCache.set(id, s);
          return s;
        })
        .catch(e => {
          statusErr.set(id, e.message);
          throw e;
        })
        .finally(() => statusPending.delete(id))
    );
  return statusPending.get(id);
}
// One reading per registered account. The top-level fields (limits, detail, at) are those of the FULLEST account, so
// the header chip and everything that read the single account before keep working; `accounts` has every one.
async function claudeStatus(refresh) {
  const accs = accounts();
  const done = await Promise.allSettled(accs.map(a => readOne(a.id === PRINCIPAL ? '' : a.id, refresh)));
  const list = accs.map((a, i) => {
    const r = done[i];
    const data = r.status === 'fulfilled' ? r.value : statusCache.get(a.id === PRINCIPAL ? '' : a.id) || null;
    return {
      id: a.id,
      nombre: a.nombre,
      principal: !!a.principal,
      ...(data || { limits: [], detail: '', at: null }),
      ...(r.status === 'rejected' ? { error: r.reason?.message || 'No se pudo leer /usage.' } : {})
    };
  });
  const withData = list.filter(a => a.at);
  if (!withData.length) throw new Error(list[0].error || 'No se pudo leer /usage.');
  const top = withData.reduce((b, a) => (weekPctOf(a) > weekPctOf(b) ? a : b));
  return { limits: top.limits, detail: top.detail, at: top.at, account: { id: top.id, nombre: top.nombre }, accounts: list };
}

export { claudeStatus, crownOf, fame, fameWall, loadSessions, officeUsage, quotaPeriods, registerSession, updateTeamSpend };
