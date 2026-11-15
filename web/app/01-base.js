const $ = (s, r = document) => r.querySelector(s);
const MAP = $('#map'), PANEL = $('#panel');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const COLORS = ROBOT_COLORS; // web/robot-art.js
const STATE_LABEL = {idle: 'en espera', walking: 'llegando', working: 'trabajando', delegating: 'con subagentes', input: 'te necesita', done: 'terminó'};
// Una sola etiqueta por estado para tarjeta, ventana y tarjeta flotante.
// Un robot de tarea libre que terminó sigue vivo esperando tu siguiente orden; uno de skill espera que lo despidas.
const stateLabel = d => d.state === 'done' ? (d.kind === 'libre' ? 'esperando orden' : 'terminó') : STATE_LABEL[d.state] || d.state;
// Resúmenes de una línea (burbuja, tarjeta): sin símbolos de Markdown. La conversación completa sí se formatea.
// Claude Code envuelve lo que pegas en su consola en <pasted_content id="…">…</pasted_content id="…">. No es HTML
// válido: el Markdown mostraba el cierre como texto y se comía el formato del primer párrafo. Se quita la envoltura.
const PASTE_TAG = /<\\?\/?pasted_content(?:\s+id=["']?[\w-]*["']?)?\s*>/gi;
const hasPaste = s => PASTE_TAG.test(String(s ?? '')) && !(PASTE_TAG.lastIndex = 0);
const unwrapPaste = s => String(s ?? '').replace(PASTE_TAG, '').replace(/^\s*\n/, '').replace(/\n\s*$/, '');
const plainMd = s => unwrapPaste(s)
  .replace(/```[\w-]*\n?/g, '').replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  .replace(/(\*\*|__)(.+?)\1/g, '$2').replace(/(^|[\s(])[*_]([^*_\s][^*_]*?)[*_](?=[\s).,;:!?]|$)/g, '$1$2')
  .replace(/`+/g, '').replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '').replace(/\s*\n+\s*/g, ' ').replace(/\*\*/g, '').trim();
const CY = 35.5, CX = 77;
// Coordenadas: x en % del ancho; y en "unidades" donde el mapa base (2 filas de escritorios) mide 100.
// Cada fila extra suma ROW_H unidades: el mapa crece hacia abajo y py() convierte unidades a % de su altura.
const COLS = 4, ROW_H = 26, BASE_ROWS = 2;
// Salas temporales de rutinas: debajo de los escritorios, una por rutina con robots en la oficina.
const ROOM_COLS = 6, SEAT_ROW_H = 17, ROOM_X = 3, ROOM_W = 69, RIGHT_LANE = 74.5;
// Plantas que aparecen al crecer la oficina (renderGrowth). Van aquí arriba porque layout() las ubica al arrancar.
const GROW_AT = [5, 15, 40, 100];
// [nivel desde el que aparece, x, y, ancho, alto, ¿sigue a las filas extra de escritorios?, clase extra]
const GROW_PLANTS = [[1, 51.6, 20.5, 1.7, 4.5], [1, 3.2, 20, 1.7, 4.5], [2, 57.5, 27.6, 1.9, 5], [2, 95.4, 56, 1.9, 5], [2, 31.5, 91.6, 1.9, 5, true],
  [3, 45.4, 91.6, 1.9, 5, true], [3, 3.2, 90.6, 2.4, 6.4, true, 'big'], [3, 79.2, 56, 1.9, 5], [4, 72.4, 89.6, 2.8, 7.4, true, 'big'], [4, 96, 89, 2.4, 6.4, true, 'big']];
const geo = {rows: BASE_ROWS, H: 100, rooms: [], roomOrder: [], roomEls: new Map(), sig: ''};
const extra = () => geo.H - 100;
const py = y => (y / geo.H * 100) + '%';
const door = () => ({x: 40, y: 99 + extra()});
const coordDrop = () => ({x: 86, y: 92 + extra()});
const deskPos = i => ({x: 5 + (i % COLS) * 18, y: 43 + Math.floor(i / COLS) * ROW_H});
// Lugares de los subagentes alrededor del robot: dos a los lados y cinco debajo.
const MINI_SLOTS = [[-4.8, 0], [4.8, 0], [-6.6, 6], [-3.3, 6], [0, 6], [3.3, 6], [6.6, 6]];

const st = {robots: new Map(), pins: [], side: null, jump: null, inbox: [], door: [], routines: [], salas: [], config: {}, selected: null, att: {}, weeks: [], claude: null, claudeLoading: false, claudeError: ''};
const ATTACH_MAX = 20 * 1024 * 1024;
const brk = {bots: new Map()}; // robots de la sala de descanso (solo animación)

