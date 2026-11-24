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
const CY = 35.5;
// Coordenadas: x en % del ancho; y en "unidades" donde el mapa base (2 filas de escritorios) mide 100.
// Cada fila extra suma ROW_H unidades: el mapa crece hacia abajo y py() convierte unidades a % de su altura.
const COLS = 4,
  ROW_H = 26,
  BASE_ROWS = 2,
  COL_DX = 16.2; // distancia entre columnas de escritorios
// Oficina a la izquierda, pasillo en medio y la columna de salas (epicas y rutinas) a la derecha.
const OFFICE_R = 67.5, // borde derecho de la oficina
  CORR = { x: 68, w: 6, c: 70.8 }, // pasillo: borde izquierdo, ancho y carril por donde caminan los robots
  SALA_COL = { x: 74.4, w: 24.1, top: 9 }, // columna de salas
  SALA_DOOR_X = 72.8, // donde el robot espera frente a la puerta de su sala (dentro del pasillo)
  SALA_MAX_SLOTS = 6, // cuartos de la columna: de salas y rutinas, el último puede ser «+N más»
  SALA_GAP = 1.4,
  SALA_ROOM_H = 15, // alto de un cuarto con equipo (compacto: la puerta mide lo que un robot)
  SALA_FREE_H = 11; // un cuarto libre es más bajo
// Plantas que aparecen al crecer la oficina (renderGrowth). Van aquí arriba porque layout() las ubica al arrancar.
const GROW_AT = [10, 40, 120, 300]; // tareas en la semana de la cuota
// [nivel desde el que aparece, x, y, ancho, alto, ¿sigue a las filas extra de escritorios?, clase extra]
// Only in the desks room, along its right wall (x ~65, right of the last desk column and above the style props in the
// bottom corner): elsewhere they clashed with the office styles and stood where robots rest.
const GROW_PLANTS = [
  [1, 65.4, 40, 1.9, 5],
  [2, 65.4, 57, 1.9, 5],
  [3, 65.4, 75, 1.9, 5],
  [4, 65.2, 47.5, 2.4, 6.4, false, 'big'],
  [4, 65.2, 65, 2.4, 6.4, false, 'big']
];
// Office styles (selector «Estilo», setMapTheme in 07-vistas.js).
// Each style dresses the same map: CSS restyles floors, walls, furniture, corridor and room signs (style.css,
// «estilos de oficina»), and TDECO adds its own props. Props use map coordinates like setRect: [class, x %, y, width %,
// height (null = the CSS aspect-ratio), anchored to the bottom of the desks room?]. Free spots that stay free with any
// number of robots: the wall of Tu escritorio left of the calendar (W), the bottom corners of the desks room and the gaps
// between desk columns at the bottom (robots stand under their desk, never there).
const TD_WALL = [38.5, 6.5, 7, 15.5];
const TDECO = {
  moderna: [['td-art', ...TD_WALL]],
  garaje: [
    ['td-peg', ...TD_WALL],
    ['td-box', 2.8, 92.2, 2.4, null, true],
    ['td-box', 5.3, 92.2, 2.4, null, true],
    ['td-box', 4.05, 88.4, 2.4, null, true],
    ['td-chest', 62.3, 87.6, 4.2, 8.6, true],
    ['td-drum', 32.6, 89.4, 1.9, 6.8, true],
    ['td-drum d2', 48.6, 89.4, 1.9, 6.8, true]
  ],
  nave: [
    ['td-radar', ...TD_WALL],
    ['td-pipe', 2.6, 95.4, 64.4, 0.9, true],
    ['td-holo', 62.2, 86.4, 4.4, 8.4, true],
    ['td-crate', 2.8, 89, 3.4, 5.8, true],
    ['td-light', 17.3, 92.6, 0.9, null, true],
    ['td-light', 33.5, 92.6, 0.9, null, true],
    ['td-light', 49.7, 92.6, 0.9, null, true]
  ],
  biblioteca: [
    ['td-shelf tall', ...TD_WALL],
    ['td-shelf', 2.6, 87.4, 4.4, 8.6, true],
    ['td-shelf', 62.4, 87.4, 4.6, 8.6, true],
    ['td-globe', 32.8, 89, 2.2, 7, true],
    ['td-lamp', 17.1, 91.6, 1.4, null, true],
    ['td-lamp', 49.5, 91.6, 1.4, null, true]
  ],
  cafeteria: [
    ['td-menu', ...TD_WALL],
    ['td-cake', 2.7, 88.6, 3.6, 7.6, true],
    ['td-bar', 61.6, 90.6, 5.4, 5.2, true],
    ['td-stool', 17.2, 91.8, 1.5, 4.2, true],
    ['td-stool', 49.6, 91.8, 1.5, 4.2, true],
    ['td-stool', 33.2, 91.8, 1.5, 4.2, true]
  ],
  bosque: [
    ['td-view', ...TD_WALL],
    ['td-tree', 2.4, 85.6, 4.2, null, true],
    ['td-tree t2', 63, 86.4, 3.6, null, true],
    ['td-log', 31.8, 93.4, 3.8, 2.6, true],
    ['td-mush', 17.2, 93.6, 1.3, null, true],
    ['td-mush m2', 18.5, 94.4, 0.9, null, true],
    ['td-mush', 49.4, 93.6, 1.3, null, true],
    ['td-fly', 20, 88, null, null, true],
    ['td-fly f2', 45, 90, null, null, true],
    ['td-fly f3', 58, 86, null, null, true],
    ['td-fly f4', 12, 80, null, null, true]
  ],
  playa: [
    ['td-surf', 40.2, 6.4, 3.4, 15.8],
    ['td-palm', 2.4, 82.8, 4.4, null, true],
    ['td-castle', 62.4, 89.6, 4.4, 6.4, true],
    ['td-ball', 17.3, 92.4, 1.6, null, true],
    ['td-crab', 33, 93.6, 2, null, true],
    ['td-ball', 49.6, 92.4, 1.6, null, true]
  ],
  nieve: [
    ['td-fire', ...TD_WALL],
    ['td-snowman', 2.8, 85.2, 3.4, null, true],
    ['td-pine', 62.6, 86, 4.2, null, true],
    ['td-sled', 32.4, 93.2, 3.6, 2.6, true],
    ['td-flake', 17.4, 91.4, null, null, true],
    ['td-flake', 49.7, 91.4, null, null, true]
  ],
  dojo: [
    ['td-scroll', 40, 6, 4.2, 16],
    ['td-bonsai', 2.8, 88.2, 3.8, 7.8, true],
    ['td-lantern', 62.8, 85.6, 3, 10.4, true],
    ['td-chochin', 17.3, 90.8, 1.4, 4.4, true],
    ['td-chochin', 33.3, 90.8, 1.4, 4.4, true],
    ['td-chochin', 49.6, 90.8, 1.4, 4.4, true]
  ],
  arcade: [
    ['td-neon', ...TD_WALL],
    ['td-cab', 2.6, 85.2, 3.4, 10.8, true],
    ['td-cab', 62.8, 85.2, 3.4, 10.8, true],
    ['td-coin', 17.4, 92.2, 1.3, null, true],
    ['td-coin', 33.4, 92.2, 1.3, null, true],
    ['td-coin', 49.7, 92.2, 1.3, null, true]
  ]
};
// colIdx: sala/rutina -> cuarto de la columna (estable mientras exista).
const geo = { rows: BASE_ROWS, H: 100, rooms: [], roomOrder: [], roomEls: new Map(), sig: '', colIdx: new Map(), colSlots: [] };
const extra = () => geo.H - 100;
const py = y => (y / geo.H) * 100 + '%';
const door = () => ({ x: 40, y: 99 + extra() });
const coordDrop = () => ({ x: 42, y: CY });
const deskPos = i => ({ x: 3 + (i % COLS) * COL_DX, y: 43 + Math.floor(i / COLS) * ROW_H });
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
// The account a launch will really use: «Por defecto» ('') follows the active account; 'auto' is decided by the daemon
// at launch time (null here).
const accountFor = pick => (pick === 'auto' ? null : pick || st.config?.activeAccount || 'principal');
// /usage limits of one account from a claude-status reading. Without several accounts there is only one reading.
function limitsOf(c, id) {
  if (!c) return [];
  if (!hasAccounts()) return c.limits || [];
  const acc = (c.accounts || []).find(a => a.id === id);
  return acc ? acc.limits || [] : id === 'principal' ? c.limits || [] : [];
}
// `value` preselects an option; `attrs` is extra markup for the <select> (e.g. a data- attribute); `weekly` adds each account's
// weekly % to its label.
function accountField(id, label, { value = '', attrs = '', weekly = false } = {}) {
  if (!hasAccounts()) return '';
  const pct = a => (weekly ? ` · ${a.weekPct == null ? 'sin lectura' : `${a.weekPct} % semanal`}` : '');
  const sel = v => (value === v ? ' selected' : '');
  const others = st.config.accounts
    .filter(a => !a.principal)
    .map(a => `<option value="${esc(a.id)}"${sel(a.id)}>${esc(a.nombre)}${pct(a)}</option>`)
    .join('');
  const main = st.config.accounts.find(a => a.principal);
  return `<div class="field"><label for="${id}">${label}</label><select id="${id}" ${attrs}><option value=""${sel('')}>Por defecto (cuenta activa: ${esc(accountLabel(st.config.activeAccount || 'principal'))})</option><option value="principal"${sel('principal')}>Principal (siempre ~/.claude)${main ? pct(main) : ''}</option>${others}<option value="auto"${sel('auto')}>Automática (la de más cuota libre)</option></select></div>`;
}
