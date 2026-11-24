// Oficina de Agentes · cuotas agotadas: lectura del aviso de Claude, política y cuenta activa.
// Parte de daemon/daemon.mjs, que carga los módulos de daemon/lib/ en orden y arranca la oficina.
// Aquí no se toca tmux: las acciones (pasar a otra cuenta, esperar) están en continuidad.mjs.
import { broadcast, configView } from './estado.mjs';
import { readConfig } from './carpeta.mjs';
import {
  accountName,
  accounts,
  activeAccount,
  clearExhausted,
  exhaustedMap,
  hasMany,
  isExhausted,
  markExhausted,
  PRINCIPAL,
  quotaReadings,
  readActive,
  weekUsed,
  writeActive
} from './cuentas.mjs';

/* ---------- cuentas agotadas ---------- */
// The weekly limit is gone: a «week» notice still in force, or the last /usage reading at 100 %.
const weekExhausted = (key, t = Date.now()) => {
  const e = exhaustedMap(t)[key || PRINCIPAL];
  if (e?.kind === 'week') return true;
  const used = weekUsed(quotaReadings(readConfig().quotaAcc)[key || PRINCIPAL], t);
  return used !== null && used >= 100;
};
// Account ids (registry ids, 'principal' included) that cannot be used right now for any reason.
const exhaustedIds = (t = Date.now()) =>
  accounts()
    .filter(a => isExhausted(a.id, t) || weekExhausted(a.id, t))
    .map(a => a.id);

/* ---------- cuenta activa ---------- */
const notice = text => broadcast({ type: 'notice', text });
const labelOf = id => accountName(id === PRINCIPAL ? '' : id) || 'Principal';
function setActive(id, why) {
  const from = activeAccount() || PRINCIPAL;
  const to = id || PRINCIPAL;
  writeActive({ id: to });
  broadcast({ type: 'config', config: configView() });
  if (why && from !== to) notice(`Cuenta activa: ${labelOf(from)} → ${labelOf(to)} (${why})`);
}
// Keeps the active account sensible: it moves to the next account with quota when its week is gone, and goes back to the
// principal one when that one renews (its weekly reset passed, or /usage reads it below 100 %).
function syncActive(t = Date.now()) {
  if (!hasMany()) return;
  const out = weekExhausted(PRINCIPAL, t);
  const state = readActive();
  const q = quotaReadings(readConfig().quotaAcc)[PRINCIPAL];
  const passed = !!state.principalEnd && state.principalEnd <= t;
  const patch = {};
  if (out && !state.principalOut) patch.principalOut = true;
  const renewed = (state.principalOut && !out) || passed;
  if (!out && state.principalOut) patch.principalOut = false;
  if (passed) patch.principalEnd = null;
  if (q?.weekEnd > t && q.weekEnd !== state.principalEnd) patch.principalEnd = q.weekEnd;
  if (Object.keys(patch).length) writeActive(patch);
  let active = activeAccount() || PRINCIPAL;
  if (renewed && active !== PRINCIPAL) {
    setActive('', 'se renovó la semana de la principal');
    active = PRINCIPAL;
  }
  if (weekExhausted(active, t)) {
    const list = accounts();
    const i = list.findIndex(a => a.id === active);
    const next = [...list.slice(i + 1), ...list.slice(0, i)].find(a => !isExhausted(a.id, t) && !weekExhausted(a.id, t));
    if (next) setActive(next.principal ? '' : next.id, 'semana agotada');
  }
}
// After a /usage reading of one account: forget notices the reading contradicts and re-evaluate the active account.
function onUsageReading(key, { weekPct, sessionPct }) {
  if (Number.isFinite(weekPct) && weekPct < 100) clearExhausted(key, 'week');
  if (Number.isFinite(sessionPct) && sessionPct < 100) clearExhausted(key, '5h');
  syncActive();
}
// A weekly reset can pass with nobody reading /usage.
setInterval(() => {
  try {
    syncActive();
  } catch {
    /* registry or config unreadable for a moment */
  }
}, 60e3);

export { exhaustedIds, labelOf, markExhausted, onUsageReading, setActive, syncActive, weekExhausted };
