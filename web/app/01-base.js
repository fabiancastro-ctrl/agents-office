const $ = (s, r = document) => r.querySelector(s);
const MAP = $('#map'),
  PANEL = $('#panel');
// Despachador de clics del panel: un solo listener sobre PANEL. onClick(selector, (el, e) => …) registra un manejador que
// corre cuando el clic cae dentro de `selector` (el = e.target.closest(selector)). Cada manejador es independiente y corren
// todos los que coincidan, en el orden en que se registraron. Los manejadores con varias ramas que dependen del `return`
// entre ellas siguen con su propio PANEL.addEventListener('click', …).
const clickRules = [];
const onClick = (selector, fn) => {
  clickRules.push([selector, fn]);
};
PANEL.addEventListener('click', e => {
  for (const [selector, fn] of clickRules) {
    const el = e.target.closest(selector);
    if (!el) continue;
    try {
      fn(el, e);
    } catch (err) {
      queueMicrotask(() => {
        throw err;
      });
    } // un manejador roto no deja sin clic a los demás
  }
});
// Botón de «dos clics para confirmar»: el primer clic lo arma (clase `armed` + `label`) y devuelve false; el segundo, mientras
// siga armado, devuelve true y quien llama ejecuta la acción. Pasado `ms` se desarma solo: `restore` es el texto con que
// vuelve (por defecto el que tenía) o una función que lo repinta. El temporal queda en btn._t por si hay que cancelarlo.
function armed(btn, label, ms = 3000, restore) {
  if (btn.classList.contains('armed')) return true;
  const prev = btn.innerHTML; // keeps an inline icon
  btn.classList.add('armed');
  btn.textContent = label;
  btn._t = setTimeout(() => {
    btn.classList.remove('armed');
    if (typeof restore === 'function') restore();
    else if (restore != null) btn.textContent = restore;
    else btn.innerHTML = prev;
  }, ms);
  return false;
}
// Fechas en español, un formato por función. `extra` agrega o cambia campos (p. ej. {weekday: 'short'}, {hour: 'numeric'}).
const fmtWhen = (t, extra) =>
  new Date(t).toLocaleString('es', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', ...extra }); // 3 may, 14:05
const fmtTime = (t, extra) => new Date(t).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit', ...extra }); // 14:05
const fmtDay = (t, opts = { day: 'numeric', month: 'short' }) => new Date(t).toLocaleDateString('es', opts); // 3 may
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
// Interface icon from the sprite in index.html (#i-<name>). Decorative unless `label` is given.
const icon = (name, label) =>
  label
    ? `<svg class="ic" role="img" aria-label="${esc(label)}"><use href="#i-${name}"/></svg>`
    : `<svg class="ic" aria-hidden="true"><use href="#i-${name}"/></svg>`;
// Placeholder bars (shimmer) for a panel that is still loading: roughly the height of the final content, so it does not jump.
const skeleton = (n = 4, cls = '') =>
  `<span class="skl-wrap" aria-hidden="true">${Array.from({ length: n }, () => `<i class="skl ${cls}"></i>`).join('')}</span>`;
const COLORS = ROBOT_COLORS; // web/robot-art.js
const STATE_LABEL = {
  idle: 'en espera',
  walking: 'llegando',
  working: 'trabajando',
  delegating: 'con subagentes',
  input: 'te necesita',
  done: 'terminó'
};
// Una sola etiqueta por estado para tarjeta, ventana y tarjeta flotante.
// Un robot de tarea libre que terminó sigue vivo esperando tu siguiente orden; uno de skill espera que lo despidas.
// En espera: terminó su turno pero dejó algo corriendo de fondo (una shell que vigila un CI, un Monitor, un despertador
// de /loop o un cron). No está LISTO: cuando eso termine, sigue solo.
// A robot out of quota that waits for the renewal is also «en espera» (amber, never grey).
const onHold = d => !d.spawnReq && !d.consoleLost && (!!d.limit?.waiting || (d.state === 'done' && d.bg?.length > 0));
const BG_KIND = { shell: 'shell de fondo', monitor: 'monitor', despertador: 'despertador', cron: 'tarea programada' };
const holdText = d => {
  if (d.limit?.waiting) return limitText(d);
  const e = d.bg[0];
  return `${e.what} (${BG_KIND[e.kind] || e.kind}${d.bg.length > 1 ? ` y ${d.bg.length - 1} más` : ''})`;
};
// «Sin cuota» (the account ran out): d.limit comes from the daemon while the robot has not moved on or resumed.
const limitText = d => {
  const l = d.limit;
  const what = l.kind === 'week' ? 'límite semanal' : 'límite de 5 horas';
  const back = l.until ? `vuelve ${fmtWhen(l.until, { weekday: 'short' })}` : l.resetsText ? `se renueva ${l.resetsText}` : 'hasta que se renueve';
  return `Sin cuota en ${l.account} (${what}): ${l.waiting ? `en espera, ${back}` : l.pending ? 'elige qué hacer' : back}`;
};
const stateLabel = d =>
  d.limit
    ? 'Sin cuota'
    : onHold(d)
      ? 'en espera'
      : d.state === 'done'
        ? d.kind === 'libre'
          ? 'esperando orden'
          : 'terminó'
        : STATE_LABEL[d.state] || d.state;
// Resúmenes de una línea (burbuja, tarjeta): sin símbolos de Markdown. La conversación completa sí se formatea.
// Claude Code envuelve lo que pegas en su consola en <pasted_content id="…">…</pasted_content id="…">. No es HTML
// válido: el Markdown mostraba el cierre como texto y se comía el formato del primer párrafo. Se quita la envoltura.
const PASTE_TAG = /<\\?\/?pasted_content(?:\s+id=["']?[\w-]*["']?)?\s*>/gi;
const hasPaste = s => PASTE_TAG.test(String(s ?? '')) && !(PASTE_TAG.lastIndex = 0);
const unwrapPaste = s =>
  String(s ?? '')
    .replace(PASTE_TAG, '')
    .replace(/^\s*\n/, '')
    .replace(/\n\s*$/, '');
const plainMd = s =>
  unwrapPaste(s)
    .replace(/```[\w-]*\n?/g, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|[\s(])[*_]([^*_\s][^*_]*?)[*_](?=[\s).,;:!?]|$)/g, '$1$2')
    .replace(/`+/g, '')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
    .replace(/\s*\n+\s*/g, ' ')
    .replace(/\*\*/g, '')
    .trim();
const CY = 35.5,
  CX = 77;
// Coordenadas: x en % del ancho; y en "unidades" donde el mapa base (2 filas de escritorios) mide 100.
// Cada fila extra suma ROW_H unidades: el mapa crece hacia abajo y py() convierte unidades a % de su altura.
const COLS = 4,
  ROW_H = 26,
  BASE_ROWS = 2;
// Salas temporales de rutinas: debajo de los escritorios, una por rutina con robots en la oficina.
const ROOM_COLS = 6,
  SEAT_ROW_H = 17,
  ROOM_X = 3,
  ROOM_W = 69,
  RIGHT_LANE = 74.5;
// Plantas que aparecen al crecer la oficina (renderGrowth). Van aquí arriba porque layout() las ubica al arrancar.
const GROW_AT = [10, 40, 120, 300]; // tareas en la semana de la cuota
// [nivel desde el que aparece, x, y, ancho, alto, ¿sigue a las filas extra de escritorios?, clase extra]
const GROW_PLANTS = [
  [1, 51.6, 20.5, 1.7, 4.5],
  [1, 3.2, 20, 1.7, 4.5],
  [2, 57.5, 27.6, 1.9, 5],
  [2, 95.4, 56, 1.9, 5],
  [2, 31.5, 91.6, 1.9, 5, true],
  [3, 45.4, 91.6, 1.9, 5, true],
  [3, 3.2, 90.6, 2.4, 6.4, true, 'big'],
  [3, 79.2, 56, 1.9, 5],
  [4, 72.4, 89.6, 2.8, 7.4, true, 'big'],
  [4, 96, 89, 2.4, 6.4, true, 'big']
];
const geo = { rows: BASE_ROWS, H: 100, rooms: [], roomOrder: [], roomEls: new Map(), sig: '' };
const extra = () => geo.H - 100;
const py = y => (y / geo.H) * 100 + '%';
const door = () => ({ x: 40, y: 99 + extra() });
const coordDrop = () => ({ x: 86, y: 92 + extra() });
const deskPos = i => ({ x: 5 + (i % COLS) * 18, y: 43 + Math.floor(i / COLS) * ROW_H });
// Lugares de los subagentes alrededor del robot: dos a los lados y cinco debajo.
// Subagentes alrededor de su robot: a los lados, en su pasillo. Nunca más abajo de ~2,5 unidades: ahí empieza la fila
// de escritorios siguiente y se le subían a los monitores. Los que no caben se cuentan en «+N».
const MINI_SLOTS = [
  [-4.8, 0],
  [4.8, 0],
  [-7.6, -3.4],
  [7.6, -3.4],
  [-7.4, 2.4],
  [7.4, 2.4]
];

const st = {
  robots: new Map(),
  pins: [],
  side: null,
  jump: null,
  inbox: [],
  door: [],
  fame: null,
  routines: [],
  salas: [],
  view: null,
  config: {},
  selected: null,
  att: {},
  weeks: [],
  claude: null,
  claudeLoading: false,
  claudeError: ''
};
const ATTACH_MAX = 20 * 1024 * 1024;
const brk = { bots: new Map() }; // robots de la sala de descanso (solo animación)

/* ---------- cuentas de Claude ---------- */
// The «Cuenta» selector only exists when the office knows more than one Claude account (`office cuenta add`).
// '' = principal; 'auto' = the daemon picks the account with the most free weekly quota when the robot is launched.
const hasAccounts = () => (st.config?.accounts?.length || 0) > 1;
const accountLabel = id => (st.config?.accounts || []).find(a => a.id === id)?.nombre || id;
function accountField(id, label) {
  if (!hasAccounts()) return '';
  const others = st.config.accounts
    .filter(a => !a.principal)
    .map(a => `<option value="${esc(a.id)}">${esc(a.nombre)}</option>`)
    .join('');
  return `<div class="field"><label for="${id}">${label}</label><select id="${id}"><option value="">Por defecto (cuenta activa: ${esc(accountLabel(st.config.activeAccount || 'principal'))})</option><option value="principal">Principal (siempre ~/.claude)</option>${others}<option value="auto">Automática (la de más cuota libre)</option></select></div>`;
}
