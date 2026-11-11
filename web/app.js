// Oficina de Agentes: dibuja el estado que empuja el daemon y manda tus acciones por la API.
(() => {
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
const geo = {rows: BASE_ROWS, H: 100, rooms: [], roomOrder: [], roomEls: new Map(), sig: ''};
const extra = () => geo.H - 100;
const py = y => (y / geo.H * 100) + '%';
const door = () => ({x: 40, y: 99 + extra()});
const coordDrop = () => ({x: 86, y: 92 + extra()});
const deskPos = i => ({x: 5 + (i % COLS) * 18, y: 43 + Math.floor(i / COLS) * ROW_H});
// Lugares de los subagentes alrededor del robot: dos a los lados y cinco debajo.
const MINI_SLOTS = [[-4.8, 0], [4.8, 0], [-6.6, 6], [-3.3, 6], [0, 6], [3.3, 6], [6.6, 6]];

const st = {robots: new Map(), inbox: [], routines: [], salas: [], config: {}, selected: null, att: {}, weeks: [], claude: null, claudeLoading: false, claudeError: ''};
const ATTACH_MAX = 20 * 1024 * 1024;
const brk = {bots: new Map()}; // robots de la sala de descanso (solo animación)

/* ---------- dibujo ---------- */
// lookOf y robotSVG viven en web/robot-art.js (se comparten con el edificio).
$('#me').innerHTML = `<svg viewBox="0 0 40 48" aria-hidden="true"><circle cx="20" cy="13" r="9" fill="#e7c9a5"/><path d="M11 12a9 9 0 0118 0c-3-3-12-3-18 0z" fill="#3b2c22"/><rect x="8" y="24" width="24" height="20" rx="8" fill="#f3b74f"/></svg>`;

const deskEls = [];
function ensureDesks(n) {
  while (deskEls.length < n) {
    const i = deskEls.length;
    const el = document.createElement('div');
    el.className = 'desk'; el.dataset.desk = i;
    // Silla y algún objeto (taza o planta) para que los escritorios no sean todos iguales.
    const item = i % 3 === 1 ? '<i class="mug"></i>' : i % 4 === 2 ? '<i class="dplant"></i>' : '';
    el.innerHTML = `<i class="chair"></i><div class="mon"><i></i></div><div class="mon m2"><i></i></div><div class="kb"></div><i class="mpad"></i><i class="mouse"></i>${item}<div class="paper" hidden></div><span class="dn">${String(i + 1).padStart(2, '0')}</span>`;
    MAP.appendChild(el);
    deskEls.push({el, paper: el.querySelector('.paper')});
  }
}

function setRect(el, x, y, w, h) {
  if (!el) return;
  el.style.left = x + '%'; el.style.top = py(y);
  if (w != null) el.style.width = w + '%';
  if (h != null) el.style.height = (h / geo.H * 100) + '%';
}

const samePlace = (p, q) => p.type === q.type && p.idx === q.idx && p.room === q.room && p.slot === q.slot;

// Calcula filas de escritorios y salas de rutina (incoming = lugar que se va a ocupar) y, si cambian,
// recoloca salas, escritorios y robots con la nueva altura del mapa.
function layout(incoming) {
  const places = [...st.robots.values()].map(a => a.data.place);
  if (incoming) places.push(incoming);
  const used = places.filter(p => p.type !== 'room').map(p => p.idx);
  const rows = Math.max(BASE_ROWS, Math.ceil((Math.max(-1, ...used) + 1) / COLS));
  const byRoom = new Map();
  for (const p of places) {
    if (p.type !== 'room') continue;
    const r = byRoom.get(p.room) || {id: p.room, name: p.name, sala: p.sala, maxSlot: -1, n: 0};
    r.maxSlot = Math.max(r.maxSlot, p.slot); r.n++;
    byRoom.set(p.room, r);
  }
  // Orden estable: una sala no cambia de lugar mientras exista.
  geo.roomOrder = [...geo.roomOrder.filter(id => byRoom.has(id)), ...[...byRoom.keys()].filter(id => !geo.roomOrder.includes(id))];
  const specs = geo.roomOrder.map(id => ({...byRoom.get(id), seatRows: Math.max(1, Math.ceil((byRoom.get(id).maxSlot + 1) / ROOM_COLS))}));
  for (const sp of specs) { const re = geo.roomEls.get(sp.id); if (re) re.el.querySelector('small').textContent = `${sp.n} robot${sp.n === 1 ? '' : 's'}`; }
  const sig = rows + '|' + specs.map(sp => sp.id + ':' + sp.seatRows).join(',');
  if (sig === geo.sig) return;
  geo.sig = sig;
  geo.rows = rows;
  let y = 43 + rows * ROW_H;
  geo.rooms = specs.map(sp => { const boxH = 6 + sp.seatRows * SEAT_ROW_H; const r = {...sp, top: y, boxH, h: boxH + 6}; y += r.h; return r; });
  geo.H = y + 5;
  const e = extra();
  MAP.style.aspectRatio = `16 / ${(10 * geo.H / 100).toFixed(3)}`;
  setRect($('.room.r-break'), 2, 3, 52, 30);
  setRect($('.deco.sofa'), 4.5, 7.5, 15, 5);
  setRect($('.deco.sofa.s2'), 27, 7.5, 15, 5);
  setRect($('.deco.btable'), 9.5, 21, 12, 4);
  setRect($('.deco.bcoffee'), 49, 6.5, 2.8, 8);
  setRect($('.deco.pingpong'), 32, 20.5, 15, 4.5);
  setRect($('.room.r-cron'), 56, 3, 20, 30);
  setRect($('.room.r-war'), 78, 3, 20, 59);
  setRect($('#room-open'), 2, 38, 74, 59 + e);
  setRect($('#room-coord'), 78, 66 + e, 20, 31);
  setRect($('#inbox'), 80, 76 + e, 7, 8);
  setRect($('#alarm'), 88.1, 77 + e, 2.2, null);
  setRect($('#me'), 91, 74 + e, 5, 11);
  setRect($('.door'), 36, 97.2 + e, 8, 2.8);
  document.querySelectorAll('.win').forEach((w, k) => setRect(w, 18.6 + k * 18, 37.1, 4.2, 1.8)); // en los huecos entre escritorios
  setRect($('.deco.plant.p1'), 2.9, 27.8, 1.7, 4.5);
  setRect($('.deco.coffee'), 54.25, 27.5, 1.5, 5.5);
  setRect($('.deco.plant.p2'), 76.15, 28.5, 1.7, 4.5);
  ensureDesks(rows * COLS);
  // Mesas un poco más chicas que su lugar (13 × 10): mismo centro y mismo borde de abajo, así los robots no se mueven.
  deskEls.forEach((d, i) => { const p = deskPos(i); setRect(d.el, p.x + 1, p.y + 1.5, null, 8.5); d.el.hidden = i >= rows * COLS; });
  drawRooms();
  for (const x of brk.bots.values()) if (!x.el.classList.contains('moving')) placeAt(x, x.pos);
  for (const a of st.robots.values()) {
    if (a.el.classList.contains('moving')) { a.el.style.transition = 'none'; a.el.style.top = py(a.pos.y); void a.el.offsetWidth; }
    else placeAt(a, restPos(a));
    paintSubs(a);
    paint(a);
  }
}

function drawRooms() {
  for (const [id, re] of geo.roomEls) {
    if (geo.rooms.some(r => r.id === id)) continue;
    re.el.remove(); re.seats.forEach(x => x.el.remove());
    geo.roomEls.delete(id);
  }
  for (const r of geo.rooms) {
    let re = geo.roomEls.get(r.id);
    if (!re) {
      const el = document.createElement('div');
      // Sala temporal de una rutina o de una sala de épica: el clic abre su panel.
      el.className = r.sala ? 'room r-rt r-sala' : 'room r-rt';
      if (r.sala) el.dataset.sala = r.sala; else el.dataset.room = 'cron';
      el.innerHTML = `<div class="room-h"><span>${r.sala ? 'Sala' : 'Rutina'} «${esc(r.name)}»</span><small>${r.n} robot${r.n === 1 ? '' : 's'}</small></div>`;
      MAP.appendChild(el);
      geo.roomEls.set(r.id, re = {el, seats: []});
    }
    setRect(re.el, ROOM_X - 1, r.top + 1, ROOM_W + 2, r.boxH);
    while (re.seats.length < r.seatRows * ROOM_COLS) {
      const el = document.createElement('div');
      el.className = 'rdesk';
      el.innerHTML = '<div class="paper" hidden></div>';
      MAP.appendChild(el);
      re.seats.push({el, paper: el.firstChild});
    }
    while (re.seats.length > r.seatRows * ROOM_COLS) re.seats.pop().el.remove();
    re.seats.forEach((d, j) => { const p = roomSeat(r, j); setRect(d.el, p.x - 3.5, p.y - 15, 7, 4); });
  }
}

const roomSeat = (r, j) => ({x: ROOM_X + ROOM_W * ((j % ROOM_COLS) + 0.5) / ROOM_COLS, y: r.top + 1 + 7 + Math.floor(j / ROOM_COLS) * SEAT_ROW_H + 15});
function seatOf(place) {
  if (!place) return door();
  if (place.type === 'room') { const r = geo.rooms.find(x => x.id === place.room); return r ? roomSeat(r, place.slot) : door(); }
  const d = deskPos(place.idx); return {x: d.x + 6.5, y: d.y + 19};
}
function deskFor(place) {
  if (place.type !== 'room') return deskEls[place.idx];
  return geo.roomEls.get(place.room)?.seats[place.slot];
}
// Fila frente a tu escritorio para los que llevan 3 min esperando respuesta; si se llena, sigue por el pasillo derecho.
const queuePos = k => k < 3 ? {x: 94 - k * 6.4, y: 95 + extra()} : {x: RIGHT_LANE, y: 95 + extra() - (k - 2) * 8};
const restPos = a => a.queueSlot != null ? queuePos(a.queueSlot) : seatOf(a.data.place);

// Franjas horizontales del mapa: una por fila de escritorios y una por sala de rutina, cada una con su pasillo
// debajo (el de la ultima pasa junto a la puerta y la bandeja). Los pasillos verticales van entre columnas.
const AISLE_COLS = [20.5, 38.5, 56.5, 74];
function bands() {
  const b = [];
  for (let r = 0; r < geo.rows; r++) b.push({top: 43 + r * ROW_H, aisle: 65 + r * ROW_H});
  for (const rm of geo.rooms) b.push({top: rm.top, aisle: rm.top + rm.h - 2, room: true});
  b[b.length - 1].aisle = geo.H - 5;
  return b;
}
function bandIndex(b, y) { let i = 0; while (i < b.length - 1 && y >= b[i + 1].top) i++; return i; }
function route(f, t) {
  if (Math.hypot(f.x - t.x, f.y - t.y) < 2) return [t];
  if (f.y > 37 && t.y > 37) {
    const b = bands(), i1 = bandIndex(b, f.y), i2 = bandIndex(b, t.y);
    const a1 = b[i1].aisle, a2 = b[i2].aisle;
    const pts = [{x: f.x, y: a1}];
    if (i1 !== i2) {
      // Las salas de rutina ocupan casi todo el ancho: para cruzarlas se usa el pasillo derecho.
      const crossesRoom = b.slice(Math.min(i1, i2) + 1, Math.max(i1, i2) + 1).some(x => x.room);
      const mid = (f.x + t.x) / 2;
      const vx = crossesRoom ? RIGHT_LANE : AISLE_COLS.reduce((best, x) => (Math.abs(x - mid) < Math.abs(best - mid) ? x : best));
      pts.push({x: vx, y: a1}, {x: vx, y: a2});
    }
    pts.push({x: t.x, y: a2}, t);
    return pts.filter((p, i) => i === 0 ? Math.hypot(p.x - f.x, p.y - f.y) > 0.3 : Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y) > 0.3);
  }
  // Dentro de una misma sala de arriba (p. ej. la de descanso): directo.
  if (f.y <= 37 && t.y <= 37 && Math.abs(f.x - t.x) < 24 && sameTopRoom(f.x, t.x)) return [t];
  // De la zona de escritorios a las salas de arriba (o al revés): por su pasillo, luego un pasillo vertical
  // (el derecho si hay salas de rutina en medio) y después el pasillo superior.
  if (f.y > 37 || t.y > 37) {
    const low = f.y > 37 ? f : t, high = f.y > 37 ? t : f;
    const b = bands(), i = bandIndex(b, low.y);
    const vx = b.slice(0, i + 1).some(x => x.room) ? RIGHT_LANE : AISLE_COLS.reduce((best, x) => (Math.abs(x - low.x) < Math.abs(best - low.x) ? x : best));
    const pts = [{x: low.x, y: b[i].aisle}, {x: vx, y: b[i].aisle}, {x: vx, y: CY}, {x: high.x, y: CY}, high];
    return f.y > 37 ? pts : [...pts.reverse().slice(1), t];
  }
  // Fuera de la zona de escritorios (salas de arriba): pasillo superior.
  const fr = f.x > 76.5, tr = t.x > 76.5;
  if (!fr && !tr) return [{x: f.x, y: CY}, {x: t.x, y: CY}, t];
  if (!fr && tr) return [{x: f.x, y: CY}, {x: CX, y: CY}, {x: CX, y: t.y}, t];
  if (fr && !tr) return [{x: CX, y: f.y}, {x: CX, y: CY}, {x: t.x, y: CY}, t];
  return [{x: CX, y: f.y}, {x: CX, y: t.y}, t];
}
const TOP_ROOMS = [[2, 54], [56, 76], [78, 98]];
const sameTopRoom = (x1, x2) => TOP_ROOMS.some(([l, r]) => x1 >= l && x1 <= r && x2 >= l && x2 <= r);
function placeAt(a, p) {
  a.el.style.transition = 'none';
  a.el.style.left = p.x + '%'; a.el.style.top = py(p.y); a.el.style.zIndex = Math.round(p.y * 10);
  a.pos = {...p};
  void a.el.offsetWidth; // fija la posicion inicial antes de que empiece una transicion
}
async function walkTo(a, dest) {
  a.el.classList.add('moving');
  for (const p of route(a.pos, dest)) {
    const ms = Math.max(200, Math.hypot(p.x - a.pos.x, p.y - a.pos.y) * 30);
    void a.el.offsetWidth; // sin este reflow el navegador junta el cambio y el robot "salta"
    a.el.style.transition = `left ${ms}ms linear, top ${ms}ms linear`;
    a.el.style.left = p.x + '%'; a.el.style.top = py(p.y);
    a.el.style.zIndex = Math.round(Math.max(p.y, a.pos.y) * 10);
    a.el.dataset.dir = p.x < a.pos.x - 0.2 ? 'l' : p.x > a.pos.x + 0.2 ? 'r' : '';
    a.pos = {...p};
    await new Promise(r => setTimeout(r, ms));
  }
  a.el.classList.remove('moving');
  delete a.el.dataset.dir;
  const puff = document.createElement('i');
  puff.className = 'puff';
  a.el.appendChild(puff);
  setTimeout(() => puff.remove(), 600);
}
layout();
// Las ventanas y la luz del mapa siguen la hora real.
function timeOfDay() {
  const h = new Date().getHours();
  MAP.dataset.tod = h < 6 || h >= 20 ? 'night' : h < 10 ? 'morning' : h < 17 ? 'day' : 'evening';
}
timeOfDay();
setInterval(timeOfDay, 5 * 60e3);
const queue = (a, fn) => (a.q = a.q.then(fn).catch(() => {}));

/* ---------- robots ---------- */
function createRobot(d, fromSnapshot) {
  const el = document.createElement('div');
  el.className = 'robot'; el.dataset.name = d.name; el.tabIndex = 0; el.setAttribute('role', 'button');
  el.setAttribute('aria-label', `Robot ${d.name}`);
  // Cada robot arranca sus animaciones desfasado y a su propio ritmo, para que no se muevan en sincronía.
  el.style.setProperty('--d', `-${(Math.random() * 3).toFixed(2)}s`);
  el.style.setProperty('--d2', `-${(Math.random() * 5).toFixed(2)}s`);
  el.style.setProperty('--sp', (0.85 + Math.random() * 0.3).toFixed(2));
  el.innerHTML = `<i class="shadow"></i><div class="bubble" hidden></div><div class="sign"></div><div class="carry" hidden></div>${robotSVG(COLORS[d.color % 8], lookOf(d.name, d.place))}<div class="nm">${esc(d.name)}</div><button class="kill-x" type="button" title="Dar de baja" aria-label="Dar de baja a ${esc(d.name)}">×</button>`;
  MAP.appendChild(el);
  const a = {data: d, el, bubble: el.querySelector('.bubble'), sign: el.querySelector('.sign'), carry: el.querySelector('.carry'),
    pos: door(), queueSlot: null, q: Promise.resolve(), subEls: new Map(), log: d.log || [], lastBubble: ''};
  st.robots.set(d.name, a);
  const fromBreak = takeFromBreak(d.name);
  if (fromSnapshot) placeAt(a, seatOf(d.place));
  else { placeAt(a, fromBreak || door()); queue(a, () => walkTo(a, seatOf(d.place))); }
  return a;
}

function upsert(d, fromSnapshot = false) {
  layout(d.place); // agrega una fila de escritorios o la sala de su rutina si este robot la necesita
  let a = st.robots.get(d.name);
  const prevPlace = a?.data.place;
  if (!a) a = createRobot(d, fromSnapshot);
  else if (prevPlace && !samePlace(prevPlace, d.place)) {
    vacate(prevPlace, a);
    queue(a, () => walkTo(a, restPos(a)));
  }
  if (d.log) a.log = d.log;
  a.data = {...d, log: undefined};
  paint(a);
  tickWaiting();
  renderSalaChips();
  if (st.selected === d.name) schedulePanel();
  if (hover.name === d.name) renderHover();
  renderMeta();
}

function vacate(place, a) {
  const desk = deskFor(place);
  if (desk) { desk.el.classList.remove('on', 'deleg'); desk.paper.hidden = true; }
  for (const el of a.subEls.values()) el.remove();
  a.subEls.clear();
  a.extraEl?.remove(); a.extraEl = null;
}

// Qué animación toca según lo que hace el robot (la hoja de estilos muestra la utilería de cada una).
function toolClass(d) {
  if (d.state === 'delegating') return 't-agent';
  if (d.state !== 'working' && d.state !== 'walking') return '';
  const t = d.tool || '';
  if (!t) return 't-think';
  if (t === 'Agent' || t === 'Task') return 't-agent';
  if (t === 'Bash') {
    // Las búsquedas y lecturas también pasan por Bash: se anima según el primer comando.
    const cmd = String(d.activity || '').replace(/^Bash:?\s*\$?\s*/, '');
    if (/\b(gh|curl|wget)\b/.test(cmd)) return 't-web';
    if (/^(grep|rg|find|fd|ls|tree)\b/.test(cmd)) return 't-grep';
    if (/^(cat|head|tail|less|wc|sed -n)\b/.test(cmd)) return 't-read';
    return 't-bash';
  }
  if (['Read', 'NotebookRead', 'Skill'].includes(t)) return 't-read';
  if (['Grep', 'Glob', 'LS'].includes(t)) return 't-grep';
  if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(t)) return 't-write';
  if (/^(Web|mcp__)/.test(t)) return 't-web';
  return 't-bash';
}

// Read o Grep duran menos de un segundo: cada animación de herramienta se mantiene al menos 1,5 s
// antes de volver a «pensando», para que alcance a verse.
const TOOL_MIN_MS = 1500;
function shownTool(a) {
  const want = toolClass(a.data), now = Date.now();
  if (want === 't-think' && a.toolCls && a.toolCls !== 't-think' && now < a.toolUntil) {
    clearTimeout(a.toolTimer);
    a.toolTimer = setTimeout(() => paint(a), a.toolUntil - now);
    return a.toolCls;
  }
  if (want !== a.toolCls) { a.toolCls = want; a.toolUntil = now + TOOL_MIN_MS; }
  return want;
}

// Burbujas que se pisan: la de más a la derecha sube un piso (hasta 3). Se recalcula al mostrar/ocultar
// una burbuja y cada 700 ms mientras haya 2 o más visibles, porque los robots caminan.
let bubbleRaf = 0;
function declutterBubbles() {
  if (bubbleRaf) return;
  bubbleRaf = requestAnimationFrame(() => {
    bubbleRaf = 0;
    const list = [...MAP.querySelectorAll('.bubble:not([hidden])')];
    list.forEach(b => b.style.removeProperty('--by'));
    if (list.length < 2) return;
    const boxes = list.map(b => ({b, r: b.getBoundingClientRect()})).sort((x, y) => x.r.left - y.r.left);
    const placed = [];
    for (const {b, r} of boxes) {
      let up = 0;
      for (let floor = 0; floor < 3; floor++) {
        const top = r.top - up, bottom = r.bottom - up;
        if (!placed.some(p => r.left < p.right + 2 && r.right > p.left - 2 && top < p.bottom + 2 && bottom > p.top - 2)) break;
        up += r.height + 4;
      }
      if (up) b.style.setProperty('--by', up + 'px');
      placed.push({left: r.left, right: r.right, top: r.top - up, bottom: r.bottom - up});
    }
  });
}
setInterval(() => { if (MAP.querySelectorAll('.bubble:not([hidden])').length > 1) declutterBubbles(); }, 700);

function paint(a) {
  const d = a.data;
  const shownState = d.state === 'walking' ? 'working' : d.state;
  const keep = ['moving', 'dance', 'impatient'].filter(c => a.el.classList.contains(c));
  a.el.className = ['robot', `st-${shownState}`, shownTool(a), d.critical > 0 && d.state === 'done' ? 'crit' : '', ...keep, st.selected === d.name ? 'sel' : '', cardUi.hl === d.name ? 'hl' : ''].filter(Boolean).join(' ');
  a.sign.textContent = d.state === 'done' ? (d.critical > 0 ? `⚠ ${d.critical} crítico${d.critical === 1 ? '' : 's'}` : 'LISTO') : d.state === 'input' ? (d.inputAt ? `? ${fmtWait(Date.now() - Date.parse(d.inputAt))}` : '?') : '';
  const text = d.state === 'input' && (d.needsPermission || d.hold) ? 'Necesito permiso' : plainMd(d.bubble);
  if (text && text !== a.lastBubble) {
    a.lastBubble = text;
    a.bubble.textContent = text; a.bubble.title = text; a.bubble.hidden = false;
    clearTimeout(a.bt); a.bt = setTimeout(() => { a.bubble.hidden = true; declutterBubbles(); }, d.state === 'input' ? 12000 : 5000);
    declutterBubbles();
  }
  const busy = d.state === 'working' || d.state === 'delegating';
  const desk = deskFor(d.place);
  const pend = d.docs.filter(x => !x.delivered).length;
  if (desk) {
    desk.el.classList.toggle('on', busy);
    desk.el.classList.toggle('deleg', d.state === 'delegating');
    desk.paper.hidden = !pend;
    desk.paper.dataset.count = pend > 1 ? pend : '';
  }
  paintSubs(a);
}

function paintSubs(a) {
  const d = a.data, seat = seatOf(d.place);
  const running = [];
  d.subs.forEach((s, k) => {
    let el = a.subEls.get(k);
    if (s.status === 'running') {
      running.push(k);
      if (!el) {
        el = document.createElement('div');
        el.className = 'mini';
        el.innerHTML = `${robotSVG('#a99cf2')}<div class="lbl">${esc(shortType(s.type))}</div>`;
        MAP.appendChild(el);
        a.subEls.set(k, el);
      }
      el.title = `${s.type}${s.desc ? ' · ' + s.desc : ''}${s.activity ? '\n' + s.activity : ''}`;
    } else if (el) {
      a.subEls.delete(k);
      el.classList.add('fin');
      setTimeout(() => el.classList.add('out'), 900);
      setTimeout(() => el.remove(), 1500);
    }
  });
  running.forEach((k, i) => {
    const el = a.subEls.get(k);
    if (i >= MINI_SLOTS.length) { el.hidden = true; return; }
    const [dx, dy] = MINI_SLOTS[i];
    el.hidden = false;
    el.style.left = (seat.x + dx) + '%'; el.style.top = py(seat.y + dy);
    el.style.zIndex = Math.round((seat.y + dy) * 10);
  });
  const extra = running.length - MINI_SLOTS.length;
  if (extra > 0) {
    if (!a.extraEl) { a.extraEl = document.createElement('div'); a.extraEl.className = 'extra'; MAP.appendChild(a.extraEl); }
    a.extraEl.textContent = `+${extra}`;
    a.extraEl.style.left = (seat.x + 9.2) + '%'; a.extraEl.style.top = py(seat.y + 5);
  } else if (a.extraEl) { a.extraEl.remove(); a.extraEl = null; }
}
const shortType = t => String(t || 'agente').replace('general-purpose', 'general').replace(/^.*:/, '').toUpperCase().slice(0, 10);

/* ---------- espera de respuesta ---------- */
// Un robot que te hace una pregunta muestra cuánto lleva esperando; a los 2 min baila para llamar la atención
// y a los 3 min hace fila frente a tu escritorio (en orden de llegada). Al responderle vuelve a su lugar.
const WAIT_DANCE_MS = 2 * 60e3, WAIT_QUEUE_MS = 3 * 60e3;
const fmtWait = ms => { const t = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };
function tickWaiting() {
  const nowMs = Date.now();
  const line = [];
  for (const a of st.robots.values()) {
    const since = a.data.state === 'input' && a.data.inputAt ? Date.parse(a.data.inputAt) : null;
    const ms = since ? nowMs - since : 0;
    if (since) a.sign.textContent = `? ${fmtWait(ms)}`;
    a.el.classList.toggle('dance', !!since && ms >= WAIT_DANCE_MS);
    a.el.classList.toggle('impatient', !!since && ms >= 60e3);
    if (since && ms >= WAIT_QUEUE_MS) line.push([since, a]);
  }
  line.sort((x, y) => x[0] - y[0]);
  const inLine = new Set(line.map(([, a]) => a));
  for (const a of st.robots.values()) {
    if (a.queueSlot == null || inLine.has(a)) continue;
    a.queueSlot = null;
    queue(a, () => walkTo(a, restPos(a)));
  }
  line.forEach(([, a], k) => {
    if (a.queueSlot === k) return;
    if (a.queueSlot == null) toast(`${a.data.name} lleva 3 min esperando tu respuesta y se puso en la fila`);
    a.queueSlot = k;
    queue(a, () => walkTo(a, restPos(a)));
  });
  $('#room-coord .room-h small').textContent = line.length ? `${line.length} en fila` : 'coordinador';
  document.querySelectorAll('[data-since]').forEach(el => { el.textContent = fmtWait(nowMs - Date.parse(el.dataset.since)); });
}
setInterval(tickWaiting, 1000);

function onDeliver(name, items) {
  const a = st.robots.get(name);
  const n = items.length;
  const what = n === 1 ? items[0].path.split('/').pop() : `${n} documentos`;
  const crit = items.reduce((k, i) => k + (i.critical || 0), 0);
  if (!a) { toast(`${name} entregó ${what}`); pulseInbox(); celebrate(items); return; }
  queue(a, async () => {
    a.carry.hidden = false;
    a.carry.dataset.count = n > 1 ? n : '';
    await walkTo(a, coordDrop());
    a.carry.hidden = true;
    pulseInbox();
    celebrate(items);
    toast(crit ? `⚠ ${name} entregó ${what} con ${crit} hallazgo${crit === 1 ? '' : 's'} crítico${crit === 1 ? '' : 's'}` : `${name} entregó ${what} en tu bandeja`);
    if (st.robots.has(name)) await walkTo(a, restPos(a));
  });
}
const inboxShown = () => st.inboxTemp ? st.inbox : st.inbox.filter(i => !isTempDoc(i.path));
const unseen = () => inboxShown().filter(i => i.status !== 'visto').length;
function renderInboxBadge() {
  const n = unseen();
  $('#inbox-n').textContent = n;
  $('#inbox').classList.toggle('has-new', n > 0);
  // La luz roja sigue encendida mientras haya un review con críticos sin ver; se apaga al abrirlo o marcarlo visto.
  const crit = st.inbox.filter(i => i.status !== 'visto' && i.critical > 0).reduce((k, i) => k + i.critical, 0);
  $('#alarm').hidden = !crit;
  $('#alarm').title = crit ? `${crit} hallazgo${crit === 1 ? '' : 's'} crítico${crit === 1 ? '' : 's'} sin ver en tu bandeja` : '';
  $('#room-coord').classList.toggle('alert', crit > 0);
}
// Entrega sin críticos: confeti sobre la bandeja. Con críticos no hay fiesta: destella la luz roja.
function celebrate(items) {
  if (items.some(i => i.critical > 0)) {
    const al = $('#alarm');
    al.classList.remove('flash'); void al.offsetWidth; al.classList.add('flash');
    return;
  }
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const box = $('#inbox');
  const colors = ['#f3b74f', '#5fd4c4', '#ef7f8a', '#a99cf2', '#8fd06a', '#fff3c4'];
  for (let k = 0; k < 26; k++) {
    const c = document.createElement('i');
    c.className = 'confetti';
    const ang = -Math.PI / 2 + (Math.random() - .5) * 2.4, dist = 30 + Math.random() * 45;
    c.style.cssText = `--dx:${Math.cos(ang) * dist}px;--dy:${Math.sin(ang) * dist}px;--r:${(Math.random() - .5) * 900}deg;--t:${.9 + Math.random() * .6}s;background:${colors[k % colors.length]}`;
    box.appendChild(c);
    setTimeout(() => c.remove(), 1700);
  }
}
function pulseInbox() {
  const el = $('#inbox');
  el.classList.remove('pulse'); void el.offsetWidth; el.classList.add('pulse');
}

function onLeft(name) {
  const a = st.robots.get(name);
  if (!a) return;
  vacate(a.data.place, a);
  st.robots.delete(name);
  queue(a, async () => { a.el.classList.remove('sel'); await walkTo(a, door()); a.el.remove(); layout(); });
  paneCache.delete(name);
  if (st.selected === name) { select(null); toast(`${name} salió de la oficina.`); }
  renderSalaChips();
  if (st.selected?.startsWith('@sala:')) schedulePanel();
  renderMeta();
}

/* ---------- conexión ---------- */
function connect() {
  const es = new EventSource('/api/events');
  es.onopen = () => { const c = $('#conn'); c.textContent = 'conectado'; c.className = 'tag ok'; };
  es.onerror = () => { const c = $('#conn'); c.textContent = 'sin conexión, reintentando'; c.className = 'tag bad'; };
  es.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.type === 'snapshot') {
      for (const a of st.robots.values()) { vacate(a.data.place, a); a.el.remove(); }
      st.robots.clear();
      st.config = m.config; st.inbox = m.inbox; st.routines = m.routines || []; st.salas = m.salas || []; st.favorites = m.favorites || [];
      setSetup(m.setup);
      renderInboxBadge();
      m.robots.forEach(r => upsert(r, true));
      layout();
      PANEL.dataset.view = ''; // tras reconectar, repintado completo (el log pudo cambiar)
      renderRoutineChips(); renderSalaChips(); renderMeta(); renderPanel();
      notif.known = null; st.ready = true; // el siguiente checkAlerts toma esto como punto de partida
    } else if (m.type === 'robot') upsert(m.robot);
    else if (m.type === 'setup') onSetupSaved(m);
    else if (m.type === 'config') { st.config = m.config; renderMeta(); if (st.selected === '@new') schedulePanel(); }
    else if (m.type === 'salas') { st.salas = m.salas; renderSalaChips(); if (st.selected === '@war' || st.selected?.startsWith('@sala:')) schedulePanel(); }
    else if (m.type === 'routines') { st.routines = m.routines; renderRoutineChips(); renderMeta(); if (st.selected === '@cron') schedulePanel(); }
    else if (m.type === 'log') {
      const a = st.robots.get(m.name);
      if (a) { a.log.push(m.entry); if (st.selected === m.name) appendLog(m.entry, a); }
    } else if (m.type === 'deliver') onDeliver(m.name, m.items);
    else if (m.type === 'inbox') { st.inbox = m.inbox; renderInboxBadge(); renderMeta(); if (st.selected === '@inbox') schedulePanel(); }
    else if (m.type === 'left') onLeft(m.name);
    else if (m.type === 'favorites') { st.favorites = m.favorites; if (st.selected === '@new') schedulePanel(); }
  };
}

async function api(method, url, body) {
  const res = await fetch(url, {method, headers: {'Content-Type': 'application/json'}, body: body ? JSON.stringify(body) : undefined});
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { toast(data.error || `Error ${res.status}`); throw new Error(data.error); }
  return data;
}

function toast(msg) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => t.hidden = true, 4500); }

/* ---------- rutinas ---------- */
function routineProgress(rt) {
  const left = Math.max(0, rt.nextAt - Date.now());
  return {left, p: rt.paused ? 0 : 1 - left / (rt.everyMin * 60000)};
}
const fmtLeft = ms => { const s = Math.ceil(ms / 1000); return s >= 60 ? `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s` : `${s} s`; };
function routineStatus(rt) {
  if (rt.running) return 'revisando ahora…';
  if (rt.paused) return 'en pausa';
  return `próximo chequeo en ${fmtLeft(routineProgress(rt).left)}`;
}
function lastRunText(rt) {
  const l = rt.lastRun;
  if (!l) return 'Todavía no ha revisado.';
  const t = new Date(l.at).toTimeString().slice(0, 5);
  if (l.error) return `${t} · Error: ${l.error}`;
  const base = `${t} · ${l.open} PRs abiertos · ${l.changed} nuevos o con commits nuevos · ${l.dispatched} robots lanzados`;
  return l.pending ? `${base} · ${l.pending} pendientes (${l.note})` : l.note ? `${t} · ${l.note}` : base;
}
function renderRoutineChips() {
  const active = st.routines.filter(r => !r.paused).length;
  $('#rt-count').textContent = `${active} activa${active === 1 ? '' : 's'}`;
  $('#rt-chips').innerHTML = st.routines.slice(0, 4).map(rt => `<div class="rchip"><div class="ring ${rt.paused ? 'paused' : ''} ${rt.running ? 'running' : ''}" data-ring="${rt.id}"></div><span>${esc(rt.name)}<br><small data-next="${rt.id}"></small></span></div>`).join('') || '<div class="room-b">Sin rutinas. Clic para crear una.</div>';
  tickRoutines();
}
function tickRoutines() {
  for (const rt of st.routines) {
    document.querySelectorAll(`[data-ring="${rt.id}"]`).forEach(el => el.style.setProperty('--p', routineProgress(rt).p));
    document.querySelectorAll(`[data-next="${rt.id}"]`).forEach(el => { el.textContent = routineStatus(rt); });
  }
}
setInterval(tickRoutines, 1000);

function routineSummary(rt) {
  if (rt.type === 'agenda') {
    return [`Tarea programada · cada ${rt.everyMin} min · ${rt.runs} ejecuciones${rt.delegate ? ' · puede delegar en otros robots' : ''}`,
      `→ ${rt.text}`, `Memoria: ${rt.memory}`];
  }
  const s = rt.source;
  const where = s.scope === 'org' ? `toda ${s.owner}` : s.repo;
  const action = rt.action.kind === 'skill' ? `/${rt.action.skill} ${rt.action.args}` : `Tarea libre: ${rt.action.text}`;
  return [`Vigila PRs en ${where}${s.query ? ` · filtro «${s.query}»` : ''} · cada ${rt.everyMin} min${rt.includeDrafts ? ' · incluye drafts' : ''}`,
    `→ ${action}`, ...(rt.extra ? [`Instrucciones: ${rt.extra}`] : [])];
}

function cronPanel() {
  const cards = st.routines.map(rt => `<div class="rt-card">
      <div class="top-r"><div class="ring ${rt.paused ? 'paused' : ''} ${rt.running ? 'running' : ''}" data-ring="${rt.id}"></div><b>${esc(rt.name)}</b></div>
      ${routineSummary(rt).map(l => `<div class="sub-h">${esc(l)}</div>`).join('')}
      <div class="sub-h ${rt.lastRun?.error ? 'rt-err' : ''}">${esc(lastRunText(rt))}</div>
      <div class="sub-h" data-next="${rt.id}"></div>
      <div class="row"><button class="btn sm" data-rt="run" data-id="${rt.id}" ${rt.running ? 'disabled' : ''}>Revisar ahora</button><button class="btn sm" data-rt="pause" data-id="${rt.id}">${rt.paused ? 'Reanudar' : 'Pausar'}</button><button class="btn sm danger" data-rt="delete" data-id="${rt.id}">Eliminar</button></div>
    </div>`).join('');
  return `<div class="dlg-head"><h3>Rutinas</h3><p><b>Vigilar PRs</b> revisa con <code>gh</code> y solo despierta a un robot por cada PR nuevo o con commits nuevos: sin cambios no gasta cuota. <b>Tarea programada</b> lanza un robot con tus instrucciones en cada ejecución.</p></div>
    ${cards ? `<section class="dlg-sec"><h4>Rutinas creadas</h4><div class="rt-grid">${cards}</div></section>` : ''}
    <form class="dlg-sec" id="rt-form">
      <h4>Nueva rutina</h4>
      <div class="fgrid">
        <div class="seg full" role="radiogroup" aria-label="Tipo de rutina">
          <label><input type="radio" name="rttype" id="rt-type-watch" value="watch" checked>Vigilar PRs</label>
          <label><input type="radio" name="rttype" id="rt-type-agenda" value="agenda">Tarea programada</label>
        </div>
        <div class="field"><label for="rt-name">Nombre</label><input id="rt-name" placeholder="se genera solo"></div>
        <div class="field"><label for="rt-every">Cada cuántos minutos</label><input id="rt-every" type="number" min="1" max="1440" value="30"></div>
        <div class="field"><label for="rt-mode">Permisos de los robots</label><select id="rt-mode"><option value="">Heredar tu modo</option><option value="default">Preguntar (default)</option><option value="acceptEdits">Aceptar ediciones</option><option value="plan">Solo planear</option></select></div>

        <div class="fgrid full" id="g-watch">
          <div class="field"><label for="rt-where">Dónde buscar</label><select id="rt-where"><option value="repo">En un repositorio</option><option value="org">En toda la organización</option></select></div>
          <div class="field" id="f-rt-repo"><label for="rt-repo">Repositorio (owner/nombre)</label><input id="rt-repo" placeholder="DROPI-SAS/dropi-specs" autocomplete="off"></div>
          <div class="field" id="f-rt-owner" hidden><label for="rt-owner">Organización</label><input id="rt-owner" value="DROPI-SAS" autocomplete="off"></div>
          <div class="field"><label for="rt-query">Filtro de GitHub (opcional)</label><input id="rt-query" placeholder="author:karol · label:hotfix" autocomplete="off"></div>
          <div class="field span2"><label for="rt-scope">Qué PRs</label><select id="rt-scope"><option value="new">Solo los que se abran o cambien desde ahora</option><option value="all">También los que ya están abiertos</option></select></div>
          <label class="check field-check"><input type="checkbox" id="rt-drafts"> Incluir PRs en draft</label>
          <div class="seg full" role="radiogroup" aria-label="Qué hace el robot con cada PR">
            <label><input type="radio" name="rtkind" id="rt-kind-skill" value="skill" checked>Skill por cada PR</label>
            <label><input type="radio" name="rtkind" id="rt-kind-libre" value="libre">Tarea libre por cada PR</label>
          </div>
          <div class="field" id="f-rt-skill"><label for="rt-skill">Skill</label><input id="rt-skill" list="skills-list" value="pr-review" autocomplete="off"></div>
          <div class="field span2" id="f-rt-args"><label for="rt-args">Argumentos</label><input id="rt-args" value="{url}"></div>
          <div class="field full" id="f-rt-text" hidden><label for="rt-text">Qué hacer con cada PR</label><textarea id="rt-text" rows="3">Revisa el PR {url} ({title}) de {author} y dime en 5 líneas si está listo para aprobar. No publiques nada.</textarea></div>
          <div class="field full"><label for="rt-extra">Instrucciones adicionales (opcional)</label><textarea id="rt-extra" rows="2" placeholder="Ej.: no publiques en el PR; si hay críticos, deja el resumen en la bandeja"></textarea></div>
          <div class="note full">Variables: <code>{url}</code> <code>{number}</code> <code>{repo}</code> <code>{head}</code> <code>{base}</code> <code>{title}</code> <code>{author}</code> <code>{local}</code> (carpeta del repo en tu workspace). Para /review-deep: <code>{local} origin/{base} origin/{head}</code>.</div>
        </div>

        <div class="fgrid full" id="g-agenda" hidden>
          <div class="field full"><label for="rt-agenda">Instrucciones</label><textarea id="rt-agenda" rows="5" placeholder="Ej.: busca los PRs abiertos de karol en DROPI-SAS y pásale a otro robot un /review-deep por cada uno que no hayas procesado"></textarea></div>
          <label class="check full"><input type="checkbox" id="rt-delegate" checked> Puede pasarle trabajo a otros robots de la oficina</label>
          <div class="note full">Cada ejecución gasta cuota aunque no haya nada nuevo. El robot recibe un archivo de memoria para recordar lo que hizo antes. Si la ejecución anterior sigue en la oficina, se salta la siguiente.</div>
        </div>
      </div>
      <div class="dlg-foot">
        <div class="row"><button class="btn sm" type="button" data-preset="author">Ejemplo: PRs de una persona → /review-deep</button><button class="btn sm" type="button" data-preset="agenda">Ejemplo: tarea programada que delega</button></div>
        <button class="btn primary">Crear rutina</button>
      </div>
    </form>`;
}

const PRESETS = {
  author: {'rt-type-watch': true, 'rt-where': 'org', 'rt-owner': 'DROPI-SAS', 'rt-query': 'author:karol', 'rt-scope': 'all', 'rt-kind-skill': true,
    'rt-skill': 'review-deep', 'rt-args': '{local} origin/{base} origin/{head}', 'rt-extra': 'No publiques nada en el PR; deja el reporte en reviews/ como siempre.', 'rt-every': 30},
  agenda: {'rt-type-agenda': true, 'rt-every': 60, 'rt-delegate': true,
    'rt-agenda': 'Busca los PRs abiertos de karol en DROPI-SAS (gh search prs --owner DROPI-SAS --author karol --state open). Por cada uno que no esté en tu memoria con el mismo commit, pásale a otro robot un /review-deep con la ruta local del repo, origin/<base> y origin/<rama>. Anota en la memoria cada PR y commit que delegaste.'}
};
function applyPreset(name) {
  for (const [id, v] of Object.entries(PRESETS[name])) {
    const el = document.getElementById(id); if (!el) continue;
    if (el.type === 'radio' || el.type === 'checkbox') el.checked = !!v; else el.value = v;
  }
  syncKind();
  toast('Ejemplo cargado: cambia el autor por el login de GitHub real antes de crearla.');
}

function renderMeta() {
  renderOfficeName();
  const n = st.robots.size, max = st.config.maxRobots || 3;
  $('#cap-n').textContent = max;
  $('#cap-down').disabled = max <= 1;
  $('#cap-up').disabled = max >= (st.config.maxRobotsLimit || 20);
  const active = [...st.robots.values()].filter(a => a.data.state !== 'done').length;
  $('#meta').textContent = '';
  const done = n - active;
  $('#btn-dismiss').hidden = !done;
  if (!$('#btn-dismiss').classList.contains('armed')) $('#btn-dismiss').textContent = `Despedir terminados (${done})`;
  scheduleCards();
}

/* ---------- métricas y tarjetas por robot ---------- */
// El mapa es la vista "viva"; las tarjetas son la vista de gestión: ordenadas por urgencia (primero los que te
// necesitan), una línea por robot trabajando y los terminados plegados, para que con muchos robots no sature.
const CARDS = $('#cards'), KPIS = $('#kpis');
const GROUP_OF = {input: 'need', working: 'work', walking: 'work', delegating: 'work', idle: 'work', done: 'done'};
const fmtDur = ms => { const m = Math.max(0, Math.floor(ms / 60000)); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`; };
const tokOf = d => (d.usage?.out || 0) + (d.usage?.in || 0) + (d.usage?.cacheWrite || 0);
const runningSubs = d => d.subs.filter(s => s.status !== 'done').length;
const prefGet = (k, def) => { try { return localStorage.getItem('office.' + k) ?? def; } catch { return def; } };
const prefSet = (k, v) => { try { localStorage.setItem('office.' + k, v); } catch { /* sin almacenamiento */ } };
const cardUi = {hl: null, reply: {}};
let cardsRaf = 0;
function scheduleCards() { if (!cardsRaf) cardsRaf = requestAnimationFrame(() => { cardsRaf = 0; renderKpis(); renderCards(); renderTimeline(); checkAlerts(); }); }

/* ---------- robots sin actividad y avisos ---------- */
// Un robot ocupado sin eventos (herramientas, subagentes, mensajes) durante STUCK_MS puede estar colgado o en
// un comando muy largo: no lo damos por trabado, solo lo señalamos para que le eches un ojo.
const STUCK_MS = 10 * 60e3;
const lastEventMs = d => Date.parse(d.lastEventAt || '') || Date.parse(d.timeline?.[d.timeline.length - 1]?.at || '') || Date.parse(d.startedAt || '') || 0;
const idleMs = d => { const t = lastEventMs(d); return t ? Date.now() - t : 0; };
const isStuck = d => (d.state === 'working' || d.state === 'delegating') && !d.needsPermission && !d.hold && idleMs(d) > STUCK_MS;
setInterval(scheduleCards, 30000); // «sin actividad» cambia con el reloj, no con eventos

// Avisos: contador en el título de la pestaña (siempre) y, si los activas, sonido y notificación del sistema.
st.inboxTemp = prefGet('inboxTemp', '0') === '1';
const notif = {on: prefGet('notify', '0') === '1', known: null, ctx: null, base: document.title};
const alertOf = d => d.state === 'input' ? (d.needsPermission || d.hold ? 'perm' : 'ask') : isStuck(d) ? 'stuck' : '';
const ALERT_TXT = {perm: 'pide permiso', ask: 'tiene una pregunta para ti', stuck: 'lleva más de 10 min sin actividad'};
function updateTitle(n) { document.title = (n ? `(${n}) ` : '') + notif.base; }
function checkAlerts() {
  const cur = new Map();
  for (const a of st.robots.values()) { const k = alertOf(a.data); if (k) cur.set(a.data.name, k); }
  updateTitle(cur.size);
  if (!st.ready) return; // el primer estado (al cargar o reconectar) no avisa: ya estaba así
  if (notif.known) for (const [name, k] of cur) if (notif.known.get(name) !== k) fireAlert(name, k);
  notif.known = cur;
}
function beep() {
  try {
    const ctx = notif.ctx ||= new (window.AudioContext || window.webkitAudioContext)();
    [880, 1175].forEach((f, i) => {
      const o = ctx.createOscillator(), g = ctx.createGain(), t = ctx.currentTime + i * 0.16;
      o.type = 'sine'; o.frequency.value = f; o.connect(g); g.connect(ctx.destination);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.12, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
      o.start(t); o.stop(t + 0.15);
    });
  } catch { /* sin audio */ }
}
function fireAlert(name, k) {
  if (!notif.on) return;
  beep();
  if (!('Notification' in window) || Notification.permission !== 'granted' || (!document.hidden && document.hasFocus())) return;
  try {
    const n = new Notification(`${name} ${ALERT_TXT[k]}`, {body: notif.base, tag: 'office-' + name, icon: $('#favicon').href});
    n.onclick = () => { window.focus(); select(name); n.close(); };
  } catch { /* el navegador no deja */ }
}
function syncNotifyBtn() {
  const b = $('#btn-notify');
  b.setAttribute('aria-pressed', String(notif.on));
  b.textContent = notif.on ? 'Avisos: sí' : 'Avisos: no';
}
$('#btn-notify').addEventListener('click', async () => {
  notif.on = !notif.on; prefSet('notify', notif.on ? '1' : '0'); syncNotifyBtn();
  if (!notif.on) return toast('Avisos apagados. El título de la pestaña sigue mostrando cuántos robots te necesitan.');
  beep(); // de paso, el clic desbloquea el audio del navegador
  if ('Notification' in window && Notification.permission === 'default') { try { await Notification.requestPermission(); } catch { /* ignorado */ } }
  toast('Notification' in window && Notification.permission === 'granted'
    ? 'Avisos activos: sonido y notificación cuando un robot te necesite o se quede sin actividad.'
    : 'Avisos activos solo con sonido: el navegador no permite notificaciones para esta página.');
});
syncNotifyBtn();

function renderKpis() {
  const ds = [...st.robots.values()].map(a => a.data);
  const count = g => ds.filter(d => GROUP_OF[d.state] === g).length;
  const need = count('need'), work = count('work'), done = count('done');
  const subs = ds.reduce((k, d) => k + runningSubs(d), 0);
  const live = ds.reduce((k, d) => k + tokOf(d), 0);
  const week = st.weeks[0];
  const weekTok = week ? week.out + week.in + week.cacheWrite : 0;
  const lim = st.claude?.limits?.[0];
  const max = st.config.maxRobots || 3;
  const k = (cls, n, label, extra = '', act = '') => `<button type="button" class="kpi ${cls}"${act ? ` data-kpi="${act}"` : ''}>${extra}<b>${n}</b><span>${label}</span></button>`;
  const html =
    k(`k-work${work ? ' on' : ''}`, `${work}<small>/${max}</small>`, 'trabajando', `<i class="kbar" style="--p:${Math.min(100, work / max * 100)}%"></i>`, 'work') +
    k(`k-need${need ? ' on' : ''}`, need, need === 1 ? 'te necesita' : 'te necesitan', '', 'need') +
    k(`k-subs${subs ? ' on' : ''}`, subs, 'subagentes activos', '', 'work') +
    k(`k-done${done ? ' on' : ''}`, done, done === 1 ? 'listo' : 'listos', '', 'done') +
    k(`k-inbox${unseen() ? ' on' : ''}`, unseen(), 'nuevos en bandeja', '', 'inbox') +
    k('k-tok', fmtTok(live), 'tokens en curso', '', 'usage') +
    k('k-tok', week ? fmtTok(weekTok) : '–', 'tokens esta semana', '', 'usage') +
    (lim ? k(`k-lim${lim.pct >= 90 ? ' hot' : lim.pct >= 70 ? ' warm' : ''}`, `${lim.pct}<small>%</small>`, esc(lim.title).toLowerCase(), `<i class="kbar" style="--p:${Math.min(100, lim.pct)}%"></i>`, 'usage') : '');
  if (KPIS._html !== html) { KPIS._html = html; KPIS.innerHTML = html; }
}

/* ---------- cuestionarios (AskUserQuestion) ---------- */
// Las preguntas con opciones que el robot te hace se responden aquí (tarjeta o panel). «Otra» deja escribir.
function askForm(d, scope) {
  const qs = d.ask.questions;
  const opt = (q, i) => o => `<label class="ask-opt" title="${esc(o.description || '')}"><input type="${q.multiSelect ? 'checkbox' : 'radio'}" name="${scope}-q${i}" value="${esc(o.label)}"><span><b>${esc(o.label)}</b>${o.description && scope === 'p' ? `<small>${esc(o.description)}</small>` : ''}</span></label>`;
  return `<form class="ask ask-${scope}" data-ask="${esc(d.name)}" data-ask-id="${esc(d.ask.id)}">${qs.map((q, i) => `
    <fieldset class="ask-q"><legend>${q.header ? `<i>${esc(q.header)}</i>` : ''}<span>${esc(q.question)}</span>${q.multiSelect ? ' <small>(puedes marcar varias)</small>' : ''}</legend>
      <div class="ask-os">${q.options.map(opt(q, i)).join('')}<label class="ask-opt ask-other"><input type="${q.multiSelect ? 'checkbox' : 'radio'}" name="${scope}-q${i}" value="__other"><input type="text" name="${scope}-q${i}-other" placeholder="Otra respuesta…" autocomplete="off"></label></div>
    </fieldset>`).join('')}
    <div class="row"><button class="btn primary sm">Enviar respuesta${qs.length === 1 ? '' : 's'}</button><button type="button" class="btn sm" data-ask-console title="Suelta las preguntas: su consola muestra el menú de siempre">Responder en la consola</button></div></form>`;
}
document.addEventListener('input', e => {
  const t = e.target; if (!t.matches('form[data-ask] input[type=text]')) return;
  const box = t.closest('label')?.querySelector('input[value="__other"]'); if (box && t.value.trim()) box.checked = true;
});
document.addEventListener('submit', async e => {
  const f = e.target.closest('form[data-ask]'); if (!f) return;
  e.preventDefault();
  const name = f.dataset.ask, d = st.robots.get(name)?.data; if (!d?.ask) return;
  const scope = f.classList.contains('ask-p') ? 'p' : 'c', answers = {};
  for (const [i, q] of d.ask.questions.entries()) {
    const n = `${scope}-q${i}`;
    const vals = [...f.querySelectorAll(`input[name="${n}"]:checked`)].map(x => x.value === '__other' ? f.querySelector(`[name="${n}-other"]`).value.trim() : x.value).filter(Boolean);
    if (!vals.length) { toast(`Falta responder: ${q.header || q.question}`); return f.querySelector(`input[name="${n}"]`)?.focus(); }
    answers[q.question] = vals.join(', ');
  }
  f.querySelectorAll('button').forEach(b => b.disabled = true);
  try { await api('POST', `/api/robots/${name}/ask`, {id: f.dataset.askId, answers}); toast(`Respuestas enviadas a ${name}`); }
  catch { f.querySelectorAll('button').forEach(b => b.disabled = false); }
});
document.addEventListener('click', async e => {
  const b = e.target.closest('[data-ask-console]'); if (!b) return;
  const f = b.closest('form[data-ask]');
  try { await api('POST', `/api/robots/${f.dataset.ask}/ask`, {id: f.dataset.askId, console: true}); toast('Ahora respóndele en su consola («Abrir consola en Terminal»)'); } catch { /* toast ya mostrado */ }
});

function cardHtml(a) {
  const d = a.data, g = GROUP_OF[d.state] || 'work';
  const subs = runningSubs(d), docs = d.docs.length, tok = tokOf(d);
  const pill = d.state === 'input' && d.inputAt
    ? `<span class="pill p-input">espera <b data-since="${esc(d.inputAt)}">${fmtWait(Date.now() - Date.parse(d.inputAt))}</b></span>`
    : `<span class="pill p-${d.state}">${d.state === 'done' && d.critical > 0 ? `⚠ ${d.critical} crítico${d.critical === 1 ? '' : 's'}` : esc(stateLabel(d))}</span>`;
  const perm = d.hold || d.needsPermission;
  const line = d.ask ? `Te hizo ${d.ask.questions.length === 1 ? 'una pregunta' : `${d.ask.questions.length} preguntas`}: ${d.ask.questions.map(q => q.header || q.question).join(' · ')}`
    : d.state === 'input'
    ? (perm ? `Pide permiso: ${d.hold ? d.hold.tool : (d.activity || 'una herramienta')}` : (plainMd(d.bubble) || 'Tiene una pregunta para ti'))
    : d.state === 'done' ? (plainMd(d.bubble) || 'Terminó su turno') : (d.activity || (d.state === 'walking' ? 'Llegando a su escritorio' : 'Pensando…'));
  let actions = '';
  if (d.ask) actions = askForm(d, 'c');
  else if (d.hold) actions = `<button class="btn primary sm" data-card-act="hold-allow">Aprobar</button><button class="btn danger sm" data-card-act="hold-deny">Denegar</button><button class="btn sm" data-card-act="open">Ver</button>`;
  else if (d.needsPermission) actions = `<button class="btn primary sm" data-card-act="perm-approve">Aprobar</button><button class="btn danger sm" data-card-act="perm-reject">Rechazar</button><button class="btn sm" data-card-act="open">Ver consola</button>`;
  else if (d.state === 'input') actions = `<form class="rc-reply" data-card-reply><input id="reply-${esc(d.name)}" placeholder="Responder a ${esc(d.name)}…" autocomplete="off"><button class="btn primary sm">Enviar</button></form>`;
  else if (d.state === 'done') actions = `<button class="btn sm" data-card-act="open">Ver</button><button class="btn sm" data-card-act="again" title="Nuevo encargo con lo mismo">↻ Otro igual</button>${docs ? `<button class="btn sm" data-card-act="docs">Documentos (${docs})</button>` : ''}<button class="btn sm danger" data-card-act="kill">Despedir</button>`;
  const stuck = isStuck(d);
  const cls = ['rc', `g-${g}`, `s-${d.state}`, stuck ? 'stuck' : '', d.state === 'done' && d.critical > 0 ? 'crit' : '', st.selected === d.name ? 'sel' : '', cardUi.hl === d.name ? 'hl' : ''].filter(Boolean).join(' ');
  return `<article class="${cls}" data-card="${esc(d.name)}" id="card-${esc(d.name)}" tabindex="0" style="--c:${COLORS[d.color % 8]}">
    <div class="rc-h"><span class="rc-av">${robotSVG(COLORS[d.color % 8], lookOf(d.name, d.place))}</span>
      <div class="rc-t"><b>${esc(d.name)}</b>${titleOf(d) ? `<span class="rc-title${d.title ? '' : ' auto'}" title="${esc(d.title ? titleOf(d) : `Sugerido: ${titleOf(d)}`)}">📌 ${esc(titleOf(d))}</span>` : ''}<small title="${esc(d.label)}">${esc(d.label)}</small></div>${pill}</div>
    <div class="rc-line ${toolClass(d) || ''}" title="${esc(line)}">${esc(line)}</div>
    <div class="rc-f"><span title="Tiempo desde que entró">⏱ <i data-start="${esc(d.startedAt || '')}">${d.startedAt ? fmtDur(Date.now() - Date.parse(d.startedAt)) : '–'}</i></span>
      ${stuck ? `<span class="rc-stuck" title="Sin herramientas, subagentes ni mensajes desde ${new Date(lastEventMs(d)).toTimeString().slice(0, 5)}. Puede estar en un comando largo o colgado: ábrelo para ver su consola.">⏸ sin actividad ${fmtDur(idleMs(d))}</span>` : ''}
      <span title="Tokens de esta sesión">◆ ${fmtTok(tok)}</span>${subs ? `<span class="rc-subs" title="Subagentes trabajando">⑂ ${subs}</span>` : ''}${docs ? `<span title="Documentos escritos">▤ ${docs}</span>` : ''}</div>
    ${actions ? `<div class="rc-acts">${actions}</div>` : ''}
  </article>`;
}

function renderCards() {
  const all = [...st.robots.values()];
  const by = {need: [], work: [], done: []};
  for (const a of all) by[GROUP_OF[a.data.state] || 'work'].push(a);
  const t = (a, k) => Date.parse(a.data[k] || 0) || 0;
  by.need.sort((x, y) => t(x, 'inputAt') - t(y, 'inputAt')); // el que más lleva esperando, primero
  by.work.sort((x, y) => t(x, 'startedAt') - t(y, 'startedAt'));
  by.done.sort((x, y) => t(y, 'startedAt') - t(x, 'startedAt'));
  // Plegados por defecto; si no hay nadie más en la oficina, abiertos (y lo que elijas se recuerda).
  const doneOpen = prefGet('doneOpen', by.need.length + by.work.length ? '0' : '1') === '1';
  const sec = (key, title, list, hint) => list.length ? `<section class="rc-sec sec-${key}" id="sec-${key}"><h4>${title} <small>${list.length}</small></h4>${list.map(cardHtml).join('')}</section>` : (hint ? `<section class="rc-sec sec-${key}" id="sec-${key}"><h4>${title}</h4><p class="rc-empty">${hint}</p></section>` : '');
  const html = !all.length
    ? `<div class="rc-zero"><b>La oficina está vacía</b><p>Lanza un encargo o haz clic en un robot de la sala de descanso.</p><button class="btn primary" data-card-act="new">Nuevo encargo</button></div>`
    : sec('need', '✋ Te necesitan', by.need, 'Nadie te espera.') + sec('work', '⚙ Trabajando', by.work, '') +
      (by.done.length ? `<details class="rc-sec sec-done" id="sec-done"${doneOpen ? ' open' : ''}><summary><h4>✓ Listos <small>${by.done.length}</small></h4></summary>${by.done.map(cardHtml).join('')}</details>` : '');
  if (CARDS._html === html) return;
  CARDS._html = html;
  const tpl = document.createElement('template'); tpl.innerHTML = html;
  morph(CARDS, tpl.content);
  const det = $('#sec-done', CARDS); if (det) det.open = doneOpen;
}

// Mapa ⇄ tarjetas: pasar el mouse por uno resalta al otro.
function highlight(name) {
  if (cardUi.hl === name) return;
  for (const n of [cardUi.hl, name]) {
    if (!n) continue;
    st.robots.get(n)?.el.classList.toggle('hl', n === name);
    document.getElementById('card-' + n)?.classList.toggle('hl', n === name);
    document.getElementById('tl-' + n)?.classList.toggle('hl', n === name);
  }
  cardUi.hl = name;
}
CARDS.addEventListener('mouseover', e => { const c = e.target.closest('[data-card]'); if (c) highlight(c.dataset.card); });
CARDS.addEventListener('mouseleave', () => highlight(null));
MAP.addEventListener('mouseover', e => { const r = e.target.closest('.robot:not(.on-break)'); highlight(r ? r.dataset.name : null); });
CARDS.addEventListener('toggle', e => { if (e.target.id === 'sec-done') prefSet('doneOpen', e.target.open ? '1' : '0'); }, true);
CARDS.addEventListener('submit', async e => {
  const f = e.target.closest('[data-card-reply]'); if (!f) return;
  e.preventDefault();
  const name = f.closest('[data-card]').dataset.card, inp = f.querySelector('input'), text = inp.value.trim();
  if (!text) return inp.focus();
  f.querySelector('button').disabled = true;
  try { await api('POST', `/api/robots/${name}/say`, {text}); inp.value = ''; toast(`Respuesta enviada a ${name}`); }
  catch { /* toast ya mostrado */ }
  finally { f.querySelector('button').disabled = false; }
});
CARDS.addEventListener('click', async e => {
  if (e.target.closest('input, form')) return;
  const b = e.target.closest('[data-card-act]');
  if (b?.dataset.cardAct === 'new') return select('@new');
  const card = e.target.closest('[data-card]'); if (!card) return;
  const name = card.dataset.card, a = st.robots.get(name);
  if (!b) return select(name);
  try {
    switch (b.dataset.cardAct) {
      case 'open': return select(name);
      case 'again': return a && launchAgain(a.data);
      case 'docs': return a?.data.docs.length && showDoc(a.data.docs[a.data.docs.length - 1].path);
      case 'perm-approve': return await api('POST', `/api/robots/${name}/permission`, {decision: 'approve'});
      case 'perm-reject': return await api('POST', `/api/robots/${name}/permission`, {decision: 'reject'});
      case 'hold-allow': return a?.data.hold && await api('POST', `/api/decision/${a.data.hold.id}`, {decision: 'allow'});
      case 'hold-deny': return a?.data.hold && await api('POST', `/api/decision/${a.data.hold.id}`, {decision: 'deny'});
      case 'kill':
        if (!b.classList.contains('armed')) { b.classList.add('armed'); b.textContent = '¿Seguro?'; setTimeout(() => { b.classList.remove('armed'); b.textContent = 'Despedir'; }, 3000); return; }
        b.disabled = true; return await api('DELETE', `/api/robots/${name}`);
    }
  } catch { /* toast ya mostrado */ }
});
CARDS.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.matches('[data-card]')) select(e.target.dataset.card); });
KPIS.addEventListener('click', e => {
  const k = e.target.closest('[data-kpi]'); if (!k) return;
  const act = k.dataset.kpi;
  if (act === 'inbox') return select('@inbox');
  if (act === 'usage') return $('#btn-usage').click();
  if (act === 'done') { const det = $('#sec-done', CARDS); if (det) { det.open = true; prefSet('doneOpen', '1'); } }
  const sec = $('#sec-' + act, CARDS);
  if (sec) { sec.scrollIntoView({behavior: 'smooth', block: 'nearest'}); sec.classList.remove('flash'); void sec.offsetWidth; sec.classList.add('flash'); }
});
/* ---------- vista 2.5D (opcional) ---------- */
// El mismo plano inclinado en perspectiva: el piso se acuesta, las paredes se levantan y los robots quedan de pie
// mirando a la cámara. Es solo CSS (clase .iso en el contenedor). Por defecto 2D; cada quien elige con el botón.
function setView(iso) {
  $('.map-wrap').classList.toggle('iso', iso);
  $('#btn-view').setAttribute('aria-pressed', String(iso));
  $('#btn-view').textContent = iso ? 'Vista 2D' : 'Vista 2.5D';
  prefSet('mapView', iso ? 'iso' : '2d');
}
$('#btn-view').addEventListener('click', () => setView(!$('.map-wrap').classList.contains('iso')));
setView(prefGet('mapView', '2d') === 'iso');

/* ---------- línea de tiempo ---------- */
// Una franja por robot: el color dice en qué estado estuvo cada tramo (el daemon guarda el historial) y las
// marcas ▤ dicen cuándo escribió un documento. Así se ve el ritmo de cada tarea sin abrirla.
const TL = $('#tl-body');
const TL_CLASS = {walking: 'working', working: 'working', delegating: 'delegating', input: 'input', done: 'done', idle: 'idle'};
const TL_STEPS = [5, 10, 15, 30, 60, 120, 180, 240].map(m => m * 60e3);
const hhmm = t => new Date(t).toLocaleTimeString('es', {hour: '2-digit', minute: '2-digit'});
function tlWindow(nowMs, list) {
  const r = prefGet('tlRange', 'auto');
  if (r !== 'auto') return Number(r) * 3600e3;
  const first = Math.min(nowMs, ...list.map(a => Date.parse(a.data.startedAt) || nowMs));
  return Math.min(12 * 3600e3, Math.max(20 * 60e3, (nowMs - first) * 1.06));
}
function renderTimeline() {
  const nowMs = Date.now();
  const list = [...st.robots.values()].sort((x, y) => (Date.parse(x.data.startedAt) || 0) - (Date.parse(y.data.startedAt) || 0));
  const span = tlWindow(nowMs, list), t0 = nowMs - span;
  const pct = t => ((t - t0) / span * 100).toFixed(3);
  $('#tl-range').querySelectorAll('[data-tl]').forEach(b => b.classList.toggle('on', b.dataset.tl === prefGet('tlRange', 'auto')));
  if (!list.length) { TL.innerHTML = '<p class="tl-empty">Sin robots en la oficina. Cuando lances encargos, aquí verás el ritmo de cada uno.</p>'; return; }
  const step = TL_STEPS.find(s => span / s <= 7) || TL_STEPS[TL_STEPS.length - 1];
  let ticks = '';
  for (let t = Math.ceil(t0 / step) * step; t < nowMs - step * 0.25; t += step) ticks += `<span class="tl-tick" style="left:${pct(t)}%">${hhmm(t)}</span>`;
  const rows = list.map(a => {
    const d = a.data;
    const tl = d.timeline?.length ? d.timeline : [{at: d.startedAt, s: d.state}];
    let segs = '';
    tl.forEach((e, i) => {
      const s = Math.max(Date.parse(e.at), t0), end = i + 1 < tl.length ? Date.parse(tl[i + 1].at) : nowMs;
      if (end <= t0 || end <= s) return;
      const cls = TL_CLASS[e.s] || 'idle';
      segs += `<i class="tl-seg ts-${cls}" style="left:${pct(s)}%;width:${Math.max(0.15, (end - s) / span * 100).toFixed(3)}%" title="${esc(STATE_LABEL[e.s] || e.s)} · ${hhmm(Date.parse(e.at))}–${i + 1 < tl.length ? hhmm(end) : 'ahora'} (${fmtDur(end - Date.parse(e.at))})"></i>`;
    });
    const docs = d.docs.filter(x => Date.parse(x.at) >= t0).map(x => `<b class="tl-doc" style="left:${pct(Date.parse(x.at))}%" title="${esc(x.path.split('/').pop())} · ${hhmm(Date.parse(x.at))}">▤</b>`).join('');
    const cls = ['tl-row', `g-${GROUP_OF[d.state] || 'work'}`, cardUi.hl === d.name ? 'hl' : '', st.selected === d.name ? 'sel' : ''].filter(Boolean).join(' ');
    return `<div class="${cls}" id="tl-${esc(d.name)}" data-card="${esc(d.name)}"><span class="tl-name" style="--c:${COLORS[d.color % 8]}">${esc(d.name)}</span><div class="tl-track">${segs}${docs}</div></div>`;
  }).join('');
  TL.innerHTML = `<div class="tl-axis"><span class="tl-name"></span><div class="tl-track">${ticks}<span class="tl-tick now" style="left:100%">ahora</span></div></div>${rows}`;
}
TL.addEventListener('mouseover', e => { const r = e.target.closest('[data-card]'); highlight(r ? r.dataset.card : null); });
TL.addEventListener('mouseleave', () => highlight(null));
TL.addEventListener('click', e => { const r = e.target.closest('[data-card]'); if (r) select(r.dataset.card); });
$('#tl-range').addEventListener('click', e => { const b = e.target.closest('[data-tl]'); if (b) { prefSet('tlRange', b.dataset.tl); renderTimeline(); } });
setInterval(renderTimeline, 15000);
// El mapa se achica lo justo para que la línea de tiempo quepa en pantalla sin hacer scroll (ver --tl-h en style.css).
new ResizeObserver(([e]) => document.documentElement.style.setProperty('--tl-h', Math.ceil(e.borderBoxSize?.[0]?.blockSize ?? e.target.offsetHeight) + 'px')).observe($('#tl'));

// El tiempo de cada tarjeta avanza solo; los tokens de la semana y la cuota se refrescan cada 5 min.
setInterval(() => document.querySelectorAll('#cards [data-start]').forEach(el => { if (el.dataset.start) el.textContent = fmtDur(Date.now() - Date.parse(el.dataset.start)); }), 20000);

/* ---------- adjuntos ---------- */
// Clave 'job' = formulario de nuevo encargo; cualquier otra = nombre del robot (chat).
const attList = key => (st.att[key] ||= []);
const fmtSize = n => n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;

function trayHtml(key) {
  return attList(key).map((f, i) => `<div class="att">${f.url ? `<img src="${f.url}" alt="">` : `<span class="fi">${esc((f.name.split('.').pop() || 'archivo').slice(0, 4).toUpperCase())}</span>`}<span class="an" title="${esc(f.path)}">${esc(f.name)} · ${fmtSize(f.size)}</span><button type="button" data-unatt="${esc(key)}" data-i="${i}" aria-label="Quitar ${esc(f.name)}">✕</button></div>`).join('');
}
function refreshTray(key) {
  const el = document.querySelector(`[data-tray="${CSS.escape(key)}"]`);
  if (el) el.innerHTML = trayHtml(key);
}

async function upload(files, key) {
  for (const file of files) {
    if (file.size > ATTACH_MAX) { toast(`${file.name} supera 20 MB.`); continue; }
    let name = file.name || 'adjunto';
    if (/^image\.(png|jpe?g|gif|webp)$/i.test(name)) name = `captura-${new Date().toTimeString().slice(0, 8).replace(/:/g, '')}.${name.split('.').pop()}`;
    const scope = key === 'job' ? 'encargos' : key;
    try {
      const res = await fetch(`/api/attachments?scope=${encodeURIComponent(scope)}&name=${encodeURIComponent(name)}`, {method: 'POST', headers: {'Content-Type': 'application/octet-stream'}, body: file});
      const data = await res.json();
      if (!res.ok) { toast(data.error || 'No se pudo subir el archivo.'); continue; }
      attList(key).push({...data, url: file.type.startsWith('image/') ? URL.createObjectURL(file) : null});
      refreshTray(key);
    } catch { toast('No se pudo subir el archivo.'); }
  }
}

function attKeyFor(el) {
  if (el.closest('#chat-form')) return st.selected;
  if (el.closest('#job-form')) return 'job';
  return null;
}

PANEL.addEventListener('paste', e => {
  const key = attKeyFor(e.target);
  const files = [...(e.clipboardData?.files || [])];
  if (!key || !files.length) return;
  e.preventDefault();
  upload(files, key);
});
PANEL.addEventListener('dragover', e => {
  const form = e.target.closest('#chat-form, #job-form');
  if (!form || !e.dataTransfer?.types.includes('Files')) return;
  e.preventDefault();
  form.classList.add('dragover');
});
PANEL.addEventListener('dragleave', e => { e.target.closest('#chat-form, #job-form')?.classList.remove('dragover'); });
PANEL.addEventListener('drop', e => {
  const form = e.target.closest('#chat-form, #job-form');
  if (!form) return;
  e.preventDefault();
  form.classList.remove('dragover');
  const key = attKeyFor(form);
  if (key) upload([...e.dataTransfer.files], key);
});
PANEL.addEventListener('change', e => {
  if (e.target.matches('input[type=file][data-attfor]')) {
    const key = attKeyFor(e.target);
    if (key) upload([...e.target.files], key);
    e.target.value = '';
  }
});

/* ---------- uso y estado de Claude ---------- */
const fmtTok = n => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n);
const weekLabel = w => new Date(w + 'T00:00:00').toLocaleDateString('es', {day: 'numeric', month: 'short'});
const tokLine = w => `salida ${fmtTok(w.out)} · entrada ${fmtTok(w.in)} · caché leída ${fmtTok(w.cacheRead)} · caché escrita ${fmtTok(w.cacheWrite)}`;

async function loadWeeks() {
  try { st.weeks = (await (await fetch('/api/usage')).json()).weeks || []; } catch { return; }
  const cur = st.weeks[0];
  $('#week-chip').textContent = cur ? `semana · ${tokLine(cur)}` : 'semana · sin uso';
  scheduleCards();
  if (st.selected === '@usage') schedulePanel();
}
async function loadClaudeStatus(refresh) {
  st.claudeLoading = true; st.claudeError = '';
  if (st.selected === '@usage') renderPanel();
  try {
    const res = await fetch('/api/claude-status' + (refresh ? '?refresh=1' : ''));
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    st.claude = data;
  } catch (e) { st.claudeError = e.message || 'No se pudo leer /usage.'; }
  st.claudeLoading = false;
  scheduleCards();
  if (st.selected === '@usage') renderPanel();
}

function usagePanel() {
  const c = st.claude;
  const bars = c ? c.limits.map(l => `<div class="lim"><div class="lim-h"><b>${esc(l.title)}</b><span>${l.pct}% usado</span></div>
      <div class="bar"><i style="width:${Math.min(100, l.pct)}%" class="${l.pct >= 90 ? 'hot' : l.pct >= 70 ? 'warm' : ''}"></i></div>
      <div class="note">${esc(l.resets)}</div></div>`).join('') : '';
  const status = st.claudeError ? `<p class="err">${esc(st.claudeError)}</p>`
    : !c ? `<p>${st.claudeLoading ? 'Abriendo /usage en una consola aparte… (la primera vez tarda unos segundos)' : 'Sin datos todavía.'}</p>`
    : `${bars}${c.detail ? `<details><summary>Qué está consumiendo (según Claude)</summary><pre class="term">${esc(c.detail)}</pre></details>` : ''}
       <div class="note">Leído ${new Date(c.at).toLocaleTimeString('es', {hour: '2-digit', minute: '2-digit'})} · consola: tmux attach -t ${esc(st.config.session || 'office')}:_status</div>`;
  const rows = st.weeks.map((w, i) => `<tr${i === 0 ? ' class="cur"' : ''}><td>${i === 0 ? 'Esta semana' : 'Semana del ' + weekLabel(w.week)}</td><td>${w.sessions}</td>
      <td>${w.out.toLocaleString('es')}</td><td>${w.in.toLocaleString('es')}</td><td>${w.cacheRead.toLocaleString('es')}</td><td>${w.cacheWrite.toLocaleString('es')}</td></tr>`).join('');
  return `<div class="dlg-head"><h3>Uso y estado de Claude</h3><p>Los límites de tu suscripción salen de <code>/usage</code>; los tokens, de las sesiones que lanzó la oficina (incluidos sus subagentes).</p></div>
    <div class="dlg-sec">
      <div class="row between"><h4>Límites de tu suscripción</h4><button class="btn sm" data-usage="refresh" ${st.claudeLoading ? 'disabled' : ''}>${st.claudeLoading ? 'Leyendo…' : 'Actualizar'}</button></div>
      ${status}
    </div>
    <div class="dlg-sec">
      <h4>Tokens de la oficina por semana</h4>
      ${rows ? `<div class="tablewrap"><table class="usage"><thead><tr><th>Semana (lun–dom)</th><th>Robots</th><th>Salida</th><th>Entrada</th><th>Caché leída</th><th>Caché escrita</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p>Todavía no hay sesiones registradas.</p>'}
    </div>`;
}
PANEL.addEventListener('click', e => { if (e.target.closest('[data-usage=refresh]')) loadClaudeStatus(true); });
loadWeeks();
setInterval(loadWeeks, 60000);

/* ---------- carpeta de trabajo ---------- */
// En la primera ejecución la oficina no sabe dónde trabajarán los robots: se pide aquí y se guarda en runs/config.json.
const needsSetup = () => !!st.setup && !st.setup.workspace;
function setSetup(setup) {
  st.setup = setup || null;
  const ws = st.setup?.workspace;
  $('#ws-chip').textContent = ws ? `carpeta · ${ws.split('/').pop()}` : 'sin carpeta de trabajo';
  $('#ws-chip').title = ws ? `Carpeta de trabajo: ${ws}. Clic para verla o cambiarla.` : 'Elige la carpeta de trabajo';
  if (needsSetup()) { st.wsDraft ??= st.setup.suggestion; select('@setup'); checkWorkspace(st.wsDraft); }
}
function onSetupSaved(m) {
  const first = needsSetup();
  st.setup = m.setup; setSetup(m.setup); setSkills(m.skills);
  st.wsInfo = null;
  if (st.selected === '@setup') select(null);
  toast(first ? 'Listo: la oficina ya trabaja en ' + m.setup.workspace : 'Carpeta de trabajo cambiada a ' + m.setup.workspace);
  loadWeeks();
}
async function checkWorkspace(p) {
  st.wsDraft = p;
  try { st.wsInfo = await api('POST', '/api/setup/check', {workspace: p}); } catch { st.wsInfo = null; }
  if (st.selected === '@setup') renderPanel();
}

function setupPanel() {
  const s = st.setup || {}, i = st.wsInfo, first = needsSetup();
  const draft = st.wsDraft ?? s.workspace ?? s.suggestion ?? '';
  const ok = (good, text) => `<li class="${good ? 'ok' : 'bad'}">${good ? '✓' : '✗'} ${text}</li>`;
  const note = text => `<li class="note-i">· ${text}</li>`;
  let checks = '';
  if (i) {
    checks = !i.exists ? ok(false, 'La carpeta no existe' + (first ? ' (marca «Crearla si no existe»)' : ''))
      : !i.isDir ? ok(false, 'Esa ruta es un archivo, no una carpeta')
      : i.insideOffice ? ok(false, 'Está dentro de la oficina: elige otra')
      : [ok(true, 'Carpeta encontrada'),
         note(i.claudeMd ? 'Tiene CLAUDE.md: los robots lo leerán' : 'Sin CLAUDE.md (opcional)'),
         note(i.projectSkills > 0 ? `${i.projectSkills} skills del proyecto (.claude/commands y .claude/skills)` : 'Sin skills del proyecto: estarán solo las tuyas de ~/.claude'),
         i.trusted ? ok(true, 'Claude Code ya confía en esta carpeta')
           : `<li class="warn">! Claude Code todavía no confía en esta carpeta: los robots se quedarían en esa pregunta. Ábrela una vez en la terminal, acepta y sal con <code>/exit</code>:<pre class="term">cd "${esc(i.path)}" && claude</pre></li>`].join('');
  }
  const locked = s.fromEnv ? 'La carpeta viene de la variable OFFICE_WORKSPACE: para cambiarla, cámbiala ahí y reinicia la oficina.'
    : !first && st.robots.size ? 'Para cambiarla, da de baja primero a los robots de la oficina.' : '';
  return `<div class="dlg-head"><h3>${first ? 'Elige la carpeta de trabajo' : 'Carpeta de trabajo'}</h3>
      <p>Los robots se abren en esta carpeta: ahí leen y escriben, dejan sus documentos y temporales, y de ahí salen las skills del proyecto (<code>.claude/commands</code>, <code>.claude/skills</code>) y su <code>CLAUDE.md</code>. Tus skills personales de <code>~/.claude</code> también están disponibles.</p></div>
    <form class="dlg-sec" id="setup-form">
      <div class="field"><label for="ws-path">Ruta de la carpeta</label>
        <div class="name-row"><input id="ws-path" value="${esc(draft)}" placeholder="/Users/tu-usuario/dropicode-Diagrams" autocomplete="off" spellcheck="false" ${locked ? 'disabled' : ''}><button type="button" class="btn sm" data-setup="check" ${locked ? 'disabled' : ''}>Verificar</button></div>
      </div>
      ${checks ? `<ul class="checks">${checks}</ul>` : ''}
      ${locked ? `<p class="note">${esc(locked)}</p>` : ''}
      <div class="dlg-foot">
        <label class="chk"><input type="checkbox" id="ws-create" ${locked ? 'disabled' : ''}> Crearla si no existe</label>
        <button class="btn primary" ${locked ? 'disabled' : ''}>${first ? 'Empezar con esta carpeta' : 'Usar esta carpeta'}</button>
      </div>
    </form>`;
}
PANEL.addEventListener('click', e => { if (e.target.closest('[data-setup=check]')) checkWorkspace($('#ws-path').value); });
PANEL.addEventListener('submit', async e => {
  if (e.target.id !== 'setup-form') return;
  e.preventDefault();
  st.wsDraft = $('#ws-path').value;
  try {
    const res = await api('POST', '/api/setup', {workspace: st.wsDraft, create: $('#ws-create').checked});
    if (res.info && !res.info.trusted) toast('Recuerda abrir claude una vez en esa carpeta para aceptar la confianza.');
  } catch { checkWorkspace(st.wsDraft); }
});
$('#ws-chip').addEventListener('click', () => { st.wsDraft = null; st.wsInfo = null; select('@setup'); checkWorkspace(st.setup?.workspace || ''); });

/* ---------- sala de descanso ---------- */
// Pura animación para que la oficina no se vea sola: robots sin consola ni cuota tomando café y charlando.
// Hay más cuando hay poco trabajo; rotan, cambian de lugar y conversan. Un clic en uno abre «Nuevo encargo»
// con su nombre y, al lanzarlo, ese mismo robot sale del descanso hacia su escritorio.
const BREAK_SPOTS = [[6.5, 18], [12.5, 18.6], [18.5, 18], [29.5, 18.6], [35.5, 18], [41.5, 18.6], [50.5, 18.4],
  [7.5, 29.4], [13.5, 30], [19.5, 29.4], [25.5, 30], [29.5, 25.8], [49.5, 25.8]];
const BREAK_TALK = ['¿Alguien vio el pipeline?', 'Café número tres', '¿Hexagonal o clásico?', 'golangci-lint me odia', 'Ese PR tenía 40 archivos', '¿Ya salió dropi-tools nueva?',
  'Hoy reviso en doble pasada', 'Me tocó un hotfix', '¿Quién rompió production?', 'Pausa activa', 'Esperando encargo…', '¿Un ping-pong?', 'Ojo con el %w', 'Nada de ORMs, ¿eh?',
  'Volví de un review-deep', 'Este café está buenísimo', '¿Y los tests?', 'Hoy hay deploy'];
const pick = arr => arr[Math.floor(Math.random() * arr.length)];
const busySpots = () => new Set([...brk.bots.values()].map(x => x.spot));
const spotPos = k => ({x: BREAK_SPOTS[k][0], y: BREAK_SPOTS[k][1]});
function breakTarget() {
  const active = [...st.robots.values()].filter(a => a.data.state !== 'done').length;
  return Math.max(3, Math.min(10, 10 - active));
}
function spawnBreakBot() {
  const free = BREAK_SPOTS.map((_, k) => k).filter(k => !busySpots().has(k));
  if (!free.length) return;
  let name = randomName();
  while (brk.bots.has(name)) name = randomName();
  const el = document.createElement('div');
  el.className = 'robot on-break st-done'; el.dataset.name = name; el.tabIndex = 0; el.setAttribute('role', 'button');
  el.title = `${name} está en descanso. Clic para darle un encargo.`;
  el.style.setProperty('--d', `-${(Math.random() * 3).toFixed(2)}s`);
  el.style.setProperty('--d2', `-${(Math.random() * 5).toFixed(2)}s`);
  el.style.setProperty('--sp', (0.85 + Math.random() * 0.3).toFixed(2));
  el.innerHTML = `<i class="shadow"></i><div class="bubble" hidden></div>${robotSVG(pick(COLORS), lookOf(name))}<div class="nm">${esc(name)}</div>`;
  MAP.appendChild(el);
  const x = {name, el, bubble: el.querySelector('.bubble'), pos: door(), q: Promise.resolve(), spot: pick(free)};
  brk.bots.set(name, x);
  placeAt(x, door());
  queue(x, () => walkTo(x, spotPos(x.spot)));
}
function leaveBreak(x) {
  brk.bots.delete(x.name);
  queue(x, async () => { await walkTo(x, door()); x.el.remove(); });
}
function sayOnBreak(x, text) {
  x.bubble.textContent = text; x.bubble.hidden = false; declutterBubbles();
  clearTimeout(x.bt); x.bt = setTimeout(() => { x.bubble.hidden = true; declutterBubbles(); }, 3800);
}
function tickBreak() {
  const bots = [...brk.bots.values()], target = breakTarget();
  if (bots.length < target) spawnBreakBot();
  else if (bots.length > target) leaveBreak(pick(bots));
  else if (bots.length && Math.random() < 0.15) leaveBreak(pick(bots)); // rotan: uno se va y el próximo tick entra otro
  const idle = [...brk.bots.values()].filter(x => !x.el.classList.contains('moving'));
  if (idle.length && Math.random() < 0.35) {
    const x = pick(idle), free = BREAK_SPOTS.map((_, k) => k).filter(k => !busySpots().has(k));
    if (free.length) { x.spot = pick(free); queue(x, () => walkTo(x, spotPos(x.spot))); }
  }
  if (idle.length && Math.random() < 0.6) {
    const a = pick(idle); sayOnBreak(a, pick(BREAK_TALK));
    const others = idle.filter(o => o !== a);
    if (others.length && Math.random() < 0.6) setTimeout(() => sayOnBreak(pick(others), pick(BREAK_TALK)), 1800);
  }
  $('#break-n').textContent = `${brk.bots.size} en pausa`;
}
setInterval(tickBreak, 6000);
setTimeout(tickBreak, 800);

function assignFromBreak(name) {
  select('@new');
  const input = $('#job-name');
  if (input) { input.value = name; ($('#job-skill') || $('#job-text'))?.focus(); }
  toast(`${name} está listo para un encargo: elige qué hará y pulsa «Invocar robot».`);
}
// Si el nuevo robot se llama como uno del descanso, sale de ahí (en vez de entrar por la puerta).
function takeFromBreak(name) {
  const x = brk.bots.get(name);
  if (!x) return null;
  brk.bots.delete(name);
  x.el.remove();
  return {...x.pos};
}

/* ---------- panel ---------- */
let panelTimer = null, paneTimer = null;
const paneCache = new Map();
function schedulePanel() { clearTimeout(panelTimer); panelTimer = setTimeout(renderPanel, 80); }
// st.selected: nombre de un robot, una vista ('@new', '@cron', '@inbox', '@git'…) o null (ventana cerrada).
// Los nombres de robot no pueden empezar con '@', asi que no chocan con las vistas.
function select(sel) {
  if (needsSetup()) sel = '@setup';
  st.selected = sel;
  $('#dlg-close').hidden = needsSetup();
  for (const a of st.robots.values()) a.el.classList.toggle('sel', a.data.name === sel);
  document.querySelectorAll('.room').forEach(r => r.classList.toggle('sel', sel === '@' + r.dataset.room));
  scheduleCards();
  renderPanel();
}

// Parcha el DOM existente en vez de reemplazarlo: así la ventana no parpadea con cada evento de los robots
// (se conservan scroll, foco, imágenes y lo escrito). #log y #pane se actualizan aparte, de forma incremental.
const MORPH_SKIP = new Set(['log', 'pane']);
function morph(from, to) {
  let cur = from.firstChild;
  for (const nb of [...to.childNodes]) {
    // Los nodos con id se reutilizan aunque algo se haya insertado antes (p. ej. aparece el bloque de subagentes).
    const byId = nb.nodeType === 1 && nb.id ? [...from.children].find(c => c.id === nb.id) : null;
    const same = !byId && cur && cur.nodeType === nb.nodeType && cur.nodeName === nb.nodeName && !cur.id && !(nb.nodeType === 1 && nb.id);
    const na = byId || (same ? cur : null);
    if (!na) { from.insertBefore(nb, cur); continue; }
    if (na !== cur) from.insertBefore(na, cur);
    cur = na.nextSibling;
    if (na.nodeType !== 1) { if (na.nodeValue !== nb.nodeValue) na.nodeValue = nb.nodeValue; continue; }
    for (const {name} of [...na.attributes]) if (!nb.hasAttribute(name) && name !== 'open') na.removeAttribute(name); // <details> abierto por ti
    for (const {name, value} of [...nb.attributes]) if (na.getAttribute(name) !== value) na.setAttribute(name, value);
    if (!MORPH_SKIP.has(na.id) && !['INPUT', 'TEXTAREA', 'SELECT'].includes(na.nodeName)) morph(na, nb);
  }
  while (cur) { const next = cur.nextSibling; cur.remove(); cur = next; }
}

const KIND_LABEL = {user: 'Tú', agent: 'Robot', tool: 'Herramienta', sub: 'Subagente', sys: 'Oficina', doc: 'Documento', bg: 'Aviso de su consola'};
// Lo que dicen los robots (y tú) viene en Markdown: se muestra con formato (marked + DOMPurify, servidos localmente).
// Herramientas, avisos de la oficina y documentos siguen en texto plano. Se cachea porque el panel se repinta seguido.
const MD_KINDS = new Set(['agent', 'user', 'sub']);
const mdCache = new Map();
function mdHtml(text) {
  let h = mdCache.get(text);
  if (h != null) return h;
  try {
    h = DOMPurify.sanitize(marked.parse(String(text), {gfm: true, breaks: true}), {ADD_ATTR: ['target']})
      .replace(/<a /g, '<a target="_blank" rel="noopener" ');
  } catch { h = esc(text); }
  if (mdCache.size > 600) mdCache.delete(mdCache.keys().next().value);
  mdCache.set(text, h);
  return h;
}
// Herramientas: «agrupadas» (las seguidas en una línea plegable), «todas» (una fila cada una) u «ocultas».
const TOOL_MODES = [['group', 'Agrupadas'], ['all', 'Todas'], ['hide', 'Ocultas']];
st.toolMode = TOOL_MODES.some(([k]) => k === prefGet('toolMode', 'group')) ? prefGet('toolMode', 'group') : 'group';
const openTools = new Set(); // grupos que desplegaste (sobreviven a los repintados del panel)
const toolSplit = t => { const m = /^([\w.-]+)(?::\s*([\s\S]*))?$/.exec(String(t)); return m ? [m[1], m[2] || ''] : ['', String(t)]; };
function toolRow(l) {
  const [n, rest] = toolSplit(l.text);
  return `<div class="lg tool"><span class="tn">${esc(n || 'Herramienta')}</span><span class="x" title="${esc(l.text)}">${esc(rest)}</span><time>${hhmm(l.at)}</time></div>`;
}
function toolGroup(run) {
  const k = run[0].at + '|' + run[0].text.slice(0, 40);
  const counts = new Map();
  for (const l of run) { const n = toolSplit(l.text)[0] || 'otra'; counts.set(n, (counts.get(n) || 0) + 1); }
  const names = [...counts].map(([n, c]) => c > 1 ? `${n} ×${c}` : n).join(' · ');
  const a = hhmm(run[0].at), b = hhmm(run[run.length - 1].at);
  return `<details class="lg tg" data-k="${esc(k)}"${openTools.has(k) ? ' open' : ''}><summary><span class="tg-n">${run.length} herramienta${run.length === 1 ? '' : 's'}</span><span class="tg-l">${esc(names)}</span><time>${a === b ? a : `${a}–${b}`}</time></summary><div class="tg-b">${run.map(toolRow).join('')}</div></details>`;
}
const TURN_SEP = '<div class="turn-sep" aria-hidden="true"></div>';
// Avisos de tareas en segundo plano: Claude Code se los manda al robot como si fueran tuyos. Los viejos (antes
// del arreglo del daemon) llegaron como «user» con el XML crudo: se convierten aquí al mismo globo.
function taskNoteWeb(p) {
  const sum = /<summary>([\s\S]*?)<\/summary>/.exec(p)?.[1]?.trim() || '', status = /<status>([\s\S]*?)<\/status>/.exec(p)?.[1]?.trim() || '';
  const what = /"([^"]+)"/.exec(sum)?.[1], ok = !/fail|error|killed|exit code [1-9]/i.test(sum + ' ' + status);
  return what ? `${ok ? '✓ Terminó' : '✗ Falló'}: ${what}${ok ? '' : ` (${status || sum})`}` : sum || status || 'Tarea en segundo plano sin detalle';
}
// Copiar: solo en lo que el robot redacta para que lo uses: citas «>», bloques de código y, si separa el
// mensaje con una línea (---), lo que viene después de la línea. Se copia en formato de chat (Google Chat y
// WhatsApp usan *negrita*, _cursiva_, ~tachado~ y ```bloques```), no en Markdown.
const COPY_BTN = '<button type="button" class="cp-btn" data-copy title="Copiar con formato de chat (Google Chat, WhatsApp, Slack)">📋 Copiar</button>';
function copyable(h) {
  h = h.replace(/<blockquote>/g, `<blockquote class="cp">${COPY_BTN}`).replace(/<pre>/g, `<div class="cp cp-code">${COPY_BTN}<pre>`).replace(/<\/pre>/g, '</pre></div>');
  const parts = h.split(/<hr\s*\/?>/);
  if (parts.length < 2) return h;
  return parts.map((p, i) => i === 0 || !p.trim() || /^\s*<(div class="cp cp-code"|blockquote class="cp")>[\s\S]*<\/(div|blockquote)>\s*$/.test(p) ? p : `<div class="cp cp-sec">${COPY_BTN}${p}</div>`).join('<hr>');
}
const mdToChat = t => t.replace(/\*\*(.+?)\*\*/g, '*$1*').replace(/__(.+?)__/g, '_$1_').replace(/~~(.+?)~~/g, '~$1~')
  .replace(/^#{1,6}\s+(.+)$/gm, '*$1*').replace(/^(\s*)[-+]\s+/gm, '$1• ').replace(/\[([^\]]+)\]\((\S+?)\)/g, (m, a, u) => a === u ? u : `${a} (${u})`);
function toChat(root) {
  const mark = (m, s) => { const t = s.trim(); return t ? s.replace(t, m + t + m) : s; };
  const walk = n => {
    if (n.nodeType === 3) return n.nodeValue.replace(/\n/g, ' ');
    if (n.nodeType !== 1 || n.classList.contains('cp-btn')) return '';
    const kids = () => [...n.childNodes].map(walk).join(''), t = n.tagName.toLowerCase();
    switch (t) {
      case 'strong': case 'b': return mark('*', kids());
      case 'em': case 'i': return mark('_', kids());
      case 'del': case 's': return mark('~', kids());
      case 'code': return '`' + n.textContent + '`';
      case 'pre': { const code = n.querySelector('code'), raw = (code || n).textContent.replace(/\n$/, ''); return /language-(?!markdown|md|text|txt)\w/.test(code?.className || '') ? '```\n' + raw + '\n```\n\n' : mdToChat(raw) + '\n\n'; }
      case 'br': return '\n';
      case 'p': case 'div': return kids().trim() + '\n\n';
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': return '*' + kids().trim() + '*\n\n';
      case 'ul': case 'ol': return [...n.children].map((li, i) => (t === 'ol' ? `${i + 1}. ` : '• ') + walk(li).trim().replace(/\n+/g, '\n   ')).join('\n') + '\n\n';
      case 'a': { const x = kids(), u = n.getAttribute('href'); return u && u !== x ? `${x} (${u})` : x; }
      case 'tr': return [...n.children].map(c => walk(c).trim()).join(' | ') + '\n';
      case 'table': return kids() + '\n';
      case 'input': return n.checked ? '☑ ' : '☐ ';
      default: return kids();
    }
  };
  return walk(root).replace(/[ \t]+\n/g, '\n').replace(/\n (?=\S)/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
async function copyText(t) {
  try { await navigator.clipboard.writeText(t); return true; } catch {
    const ta = Object.assign(document.createElement('textarea'), {value: t}); document.body.appendChild(ta); ta.select();
    const ok = document.execCommand('copy'); ta.remove(); return ok;
  }
}
document.addEventListener('click', async e => {
  const b = e.target.closest('[data-copy]'); if (!b) return;
  if (await copyText(toChat(b.parentElement))) { b.textContent = '✓ Copiado'; b.classList.add('ok'); setTimeout(() => { b.textContent = '📋 Copiar'; b.classList.remove('ok'); }, 1500); }
  else toast('No se pudo copiar: selecciona el texto y usa ⌘C');
});

function logRow(l, robot) {
  if (l.kind === 'tool') return toolRow(l);
  if (l.kind === 'user' && /^\s*<task-notification>/.test(l.text)) l = {...l, kind: 'bg', text: taskNoteWeb(l.text)};
  const t = hhmm(l.at);
  if (l.kind === 'bg') return `<div class="lg bg${/^✗/.test(l.text) ? ' bad' : ''}"><span class="w">Aviso de su consola · tarea en segundo plano · ${t}</span><span class="x">${esc(l.text)}</span></div>`;
  if (l.kind === 'sys') return `<div class="lg sys"><span class="x">${esc(l.text)}</span><time>${t}</time></div>`;
  const md = MD_KINDS.has(l.kind) && window.marked && window.DOMPurify;
  const who = l.who || (l.kind === 'agent' && robot) || KIND_LABEL[l.kind] || l.kind;
  const pasted = hasPaste(l.text) ? ' <i class="pasted">pegado</i>' : '', text = unwrapPaste(l.text);
  const body = md ? (l.kind === 'agent' ? copyable(mdHtml(text)) : mdHtml(text)) : '';
  return `<div class="lg ${l.kind}"><span class="w">${esc(who)} · ${t}${pasted}</span>${md ? `<div class="x md-chat">${body}</div>` : `<span class="x">${esc(text)}</span>`}</div>`;
}
function renderLog(log, robot) {
  const out = []; let run = [];
  const flush = () => { if (run.length) out.push(toolGroup(run)); run = []; };
  for (const l of log) {
    if (l.kind === 'tool') {
      if (st.toolMode === 'group') run.push(l);
      else if (st.toolMode === 'all') out.push(toolRow(l));
      continue;
    }
    flush();
    if (l.kind === 'user' && out.length && !/^\s*<task-notification>/.test(l.text)) out.push(TURN_SEP);
    out.push(logRow(l, robot));
  }
  flush();
  return out.join('');
}
function appendLog(entry, a) {
  const lg = $('#log', PANEL); if (!lg) return;
  const stick = lg.scrollTop + lg.clientHeight >= lg.scrollHeight - 30;
  if (entry.kind === 'tool' && st.toolMode === 'hide') return;
  if (entry.kind === 'tool' && st.toolMode === 'group') {
    let i = a.log.length; while (i > 0 && a.log[i - 1].kind === 'tool') i--;
    const run = a.log.slice(i), last = lg.lastElementChild;
    if (run.length > 1 && last?.classList.contains('tg')) last.outerHTML = toolGroup(run);
    else lg.insertAdjacentHTML('beforeend', toolGroup(run));
  } else {
    if (entry.kind === 'user' && lg.children.length && !/^\s*<task-notification>/.test(entry.text)) lg.insertAdjacentHTML('beforeend', TURN_SEP);
    lg.insertAdjacentHTML('beforeend', logRow(entry, a.data.name));
  }
  if (stick) lg.scrollTop = lg.scrollHeight;
}
PANEL.addEventListener('toggle', e => { const k = e.target.dataset?.k; if (k) e.target.open ? openTools.add(k) : openTools.delete(k); }, true);
PANEL.addEventListener('click', e => {
  const b = e.target.closest('[data-toolmode]'); if (!b) return;
  st.toolMode = b.dataset.toolmode; prefSet('toolMode', st.toolMode);
  const a = st.robots.get(st.selected), lg = $('#log', PANEL);
  if (a && lg) { lg.innerHTML = renderLog(a.log, a.data.name); lg.scrollTop = lg.scrollHeight; }
  renderPanel();
});

// Título del robot: lo pones tú para saber de un vistazo qué hace. Se edita en la cabecera de su panel.
const titleUi = {editing: null};
// El título que pusiste o, si no hay, uno sugerido a partir del encargo (se ve más tenue).
const titleOf = d => d.title || suggestTitle(d.request);
function titleEditor(d) {
  if (titleUi.editing === d.name) return `<form class="rt-title edit" id="title-form" data-robot="${esc(d.name)}"><input id="title-in" maxlength="60" value="${esc(d.title || titleOf(d))}" placeholder="Ej.: Tareas de QA · Revisando wallet#32 Ramiro" autocomplete="off"><button class="btn primary sm">Guardar</button><button type="button" class="btn sm" data-title="cancel">Cancelar</button></form>`;
  const sug = !d.title && titleOf(d);
  return `<div class="rt-title" id="title-view">${d.title ? `<b>📌 ${esc(d.title)}</b>` : sug ? `<b class="auto">📌 ${esc(sug)}</b><small class="muted">sugerido</small><button type="button" class="btn sm ghost" data-title="accept" title="Guardar este título">✓ Usar</button>` : '<span class="muted">Sin título</span>'}<button type="button" class="btn sm ghost" data-title="edit" title="Ponle un título para saber qué hace">${d.title || sug ? '✎ Cambiar' : '✎ Ponle un título'}</button></div>`;
}
PANEL.addEventListener('click', e => {
  const b = e.target.closest('[data-title]'); if (!b) return;
  if (b.dataset.title === 'accept') { const d = st.robots.get(st.selected)?.data; if (d) api('POST', `/api/robots/${d.name}/title`, {title: titleOf(d)}).catch(() => {}); return; }
  titleUi.editing = b.dataset.title === 'edit' ? st.selected : null;
  renderPanel();
  if (titleUi.editing) { const i = $('#title-in'); i?.focus(); i?.select(); }
});
PANEL.addEventListener('keydown', e => { if (e.key === 'Escape' && e.target.id === 'title-in') { e.stopPropagation(); e.preventDefault(); titleUi.editing = null; renderPanel(); } }, true);
PANEL.addEventListener('submit', async e => {
  if (e.target.id !== 'title-form') return;
  e.preventDefault();
  const name = e.target.dataset.robot, title = $('#title-in').value;
  try { await api('POST', `/api/robots/${name}/title`, {title}); titleUi.editing = null; renderPanel(); } catch { /* toast ya mostrado */ }
});

function robotPanel(a) {
  const d = a.data;
  const u = d.usage || {};
  // Subagentes: una fila por cada uno (los que trabajan primero) en una lista con scroll, para que no empuje la consola ni los botones.
  const running = d.subs.filter(s => s.status !== 'done'), finished = d.subs.filter(s => s.status === 'done');
  const subRow = s => `<div class="sub-row${s.status === 'done' ? ' ok' : ''}" title="${esc(s.desc || s.activity || '')}"><i></i><b>${esc(shortType(s.type))}</b><span>${s.status === 'done' ? 'listo' : esc(s.activity || 'trabajando')}</span></div>`;
  const subs = d.subs.length ? `<div class="rp-block"><h4>Subagentes <small>${running.length ? `${running.length} trabajando` : ''}${running.length && finished.length ? ' · ' : ''}${finished.length ? `${finished.length} listo${finished.length === 1 ? '' : 's'}` : ''}</small></h4><div class="subs-list" id="subs-list">${[...running, ...finished].map(subRow).join('')}</div></div>` : '';
  let alert = '';
  if (d.ask) alert = `<div class="alert ask-box" id="rp-alert"><b>Te pregunta</b>${askForm(d, 'p')}</div>`;
  else if (d.hold) alert = `<div class="alert" id="rp-alert"><b>Pide permiso (retenido por la oficina)</b><span class="sub-h">${esc(d.hold.tool)}</span><div class="row"><button class="btn primary sm" data-act="hold-allow">Aprobar</button><button class="btn danger sm" data-act="hold-deny">Denegar</button></div></div>`;
  else if (d.needsPermission) alert = `<div class="alert" id="rp-alert"><b>Pide permiso en su consola</b><span class="note">Aprobar elige la opción resaltada («Yes»). Rechazar cancela con Esc e interrumpe el turno. Mira la consola abajo antes de decidir.</span><div class="row"><button class="btn primary sm" data-act="perm-approve">Aprobar</button><button class="btn danger sm" data-act="perm-reject">Rechazar</button></div></div>`;
  return `
    <div class="ph"><div class="ph-av">${robotSVG(COLORS[d.color % 8], lookOf(d.name, d.place))}</div><div style="min-width:0"><h3>${esc(d.name)}</h3>${titleEditor(d)}<div class="sub-h">${esc(d.kind === 'skill' ? d.label : 'Tarea libre · ' + d.label)}</div><div class="origin">${esc(d.origin || 'Origen desconocido')}</div></div><span class="pill p-${d.state}">${esc(stateLabel(d))}${d.state === 'input' && d.inputAt ? ` · <b data-since="${esc(d.inputAt)}">${fmtWait(Date.now() - Date.parse(d.inputAt))}</b>` : ''}</span></div>
    ${alert}
    <div class="rp-grid" id="rp-grid">
      <div class="rp-col">
        <div class="log-h"><h4>Conversación</h4><span class="tmode" role="group" aria-label="Herramientas en la conversación"><small>Herramientas</small>${TOOL_MODES.map(([k, l]) => `<button type="button" class="${st.toolMode === k ? 'on' : ''}" data-toolmode="${k}" aria-pressed="${st.toolMode === k}">${l}</button>`).join('')}</span></div>
        <div class="log" id="log" style="--c:${COLORS[d.color % 8]}">${renderLog(a.log, d.name)}</div>
        <form class="chat" id="chat-form">
          <textarea id="chat-in" rows="2" placeholder="Escríbele a ${esc(d.name)}… Enter envía, Shift+Enter salto de línea. Pega (Ctrl+V) o arrastra archivos."></textarea><button class="btn primary">Enviar</button>
          <div class="tray" data-tray="${esc(d.name)}">${trayHtml(d.name)}</div>
          <label class="btn sm attach">Adjuntar<input type="file" multiple hidden data-attfor="chat"></label>
        </form>
      </div>
      <div class="rp-col" style="--extra:${(d.subs.length ? 150 : 0) + (d.docs.length ? 205 : 0)}px">
        ${subs}
        ${docsBlock(d)}
        <h4>Consola en vivo</h4>
        <pre class="term" id="pane">${esc(paneCache.get(d.name) ?? 'cargando…')}</pre>
        <div class="row">
          <button class="btn sm" data-act="console">Abrir consola en Terminal</button>
          <button class="btn sm" data-act="again" title="Abre «Nuevo encargo» con lo mismo que le pediste a este robot">↻ Lanzar otro igual</button>
          <button class="btn sm" data-act="fav" title="Guarda este encargo como acceso rápido en «Nuevo encargo»">★ Frecuente</button>
          <button class="btn sm danger" data-act="kill">Dar de baja</button>
        </div>
        <div class="stats">tokens · salida ${u.out ?? 0} · entrada ${u.in ?? 0} · caché leída ${u.cacheRead ?? 0} · caché escrita ${u.cacheWrite ?? 0}${d.permissionMode ? ' · permisos: ' + esc(d.permissionMode) : ''}</div>
        <div class="note">tmux attach -t ${esc(st.config.session || 'office')}:${esc(d.name)} · sesión ${esc(d.sessionId)}</div>
      </div>
    </div>`;
}

function newPanel() {
  const max = st.config.maxRobots || 3;
  const full = st.robots.size >= max;
  const present = [...st.robots.values()];
  return `<div class="dlg-head"><h3>Nuevo encargo</h3><p>Entra un robot por la puerta y abre su consola tmux con <code>claude</code> usando tu suscripción. Al terminar se queda en su escritorio con el cartel LISTO hasta que lo des de baja (✕ sobre el robot o «Despedir terminados»).</p></div>
    <form class="dlg-sec" id="job-form">
      ${st.favorites.length ? `<div class="favs" id="job-favs"><span class="flabel">Frecuentes</span>${st.favorites.map(f => `<span class="fav"><button type="button" data-fav="${esc(f.id)}" title="${esc(f.kind === 'skill' ? `/${f.skill} ${f.args}` : f.text)}">★ ${esc(f.name)}</button><button type="button" class="fav-x" data-fav-del="${esc(f.id)}" aria-label="Quitar ${esc(f.name)} de frecuentes">×</button></span>`).join('')}</div>` : ''}
      <div class="fgrid" id="job-grid">
        <div class="seg span2" role="radiogroup" aria-label="Tipo de encargo">
          <label><input type="radio" name="kind" id="kind-skill" value="skill" checked>Skill</label>
          <label><input type="radio" name="kind" id="kind-libre" value="libre">Tarea libre</label>
        </div>
        <div class="field"><label for="job-name">Nombre del robot (opcional)</label>
          <div class="name-row"><input id="job-name" placeholder="se asigna solo" maxlength="20" autocomplete="off" spellcheck="false"><button type="button" class="btn sm" id="job-name-rand" title="Nombre aleatorio: 6 letras y 2 números">Aleatorio</button></div>
        </div>
        <div class="field full"><label for="job-title">Título (opcional, para saber qué hace)</label><input id="job-title" maxlength="60" placeholder="Ej.: Tareas de QA · Revisando wallet#32 Ramiro" autocomplete="off"></div>
        <div class="field" id="f-skill"><label for="job-skill">Skill</label><input id="job-skill" list="skills-list" placeholder="review-deep" autocomplete="off"></div>
        <div class="field span2" id="f-args"><label for="job-args">Argumentos</label><input id="job-args" placeholder="BFF/bff-integrator origin/production origin/mi-rama --dry-run"></div>
        <div class="field full" id="f-text" hidden><label for="job-text">Qué necesitas</label><textarea id="job-text" rows="5" placeholder="Ej.: revisa por qué falla el pipeline de dropi-atom y explícame la causa sin tocar código"></textarea></div>
        <div class="field full"><span class="flabel">Adjuntos: pega con Ctrl+V o arrastra aquí</span><div class="tray" data-tray="job">${trayHtml('job')}</div></div>
        <div class="field"><label for="job-mode">Permisos</label><select id="job-mode"><option value="">Heredar tu modo</option><option value="default">Preguntar (default)</option><option value="acceptEdits">Aceptar ediciones</option><option value="plan">Solo planear</option></select></div>
      </div>
      <div class="dlg-foot">
        <div class="row"><label class="btn sm attach">Adjuntar archivos<input type="file" multiple hidden data-attfor="job"></label><button type="button" class="btn sm" data-fav-save title="Guarda lo que llenaste como acceso rápido">★ Guardar como frecuente</button></div>
        <div class="row"><span class="stats">${st.robots.size}/${max} robots en la oficina</span><button class="btn primary" ${full ? 'disabled' : ''}>${full ? `Tope de ${max} robots alcanzado` : 'Invocar robot'}</button></div>
      </div>
    </form>
    ${present.length ? `<section class="dlg-sec"><h4>En la oficina</h4><div class="rt-grid">${present.map(a => `<div class="item" data-pick="${esc(a.data.name)}"><div class="meta-i"><b>${esc(a.data.name)}</b><div>${esc(a.data.label)}</div></div><span class="pill p-${a.data.state}">${STATE_LABEL[a.data.state] || a.data.state}</span></div>`).join('')}</div></section>` : ''}`;
}

const fileName = p => String(p).split('/').pop();
// Ruta relativa a la carpeta de trabajo de esta oficina; fuera de ella, con ~ en vez de /Users/<tú>.
const shortPath = p => {
  const s = String(p), ws = st.setup?.workspace;
  if (ws && s.startsWith(ws.replace(/\/$/, '') + '/')) return s.slice(ws.replace(/\/$/, '').length + 1);
  return s.replace(/^.*\/scratchpad\//, '…/scratchpad/').replace(/^\/Users\/[^/]+(?=\/)/, '~');
};
// Archivos de carpetas temporales (borradores, láminas de un deck, scratchpads): ruido en la bandeja salvo que los pidas.
const isTempDoc = p => /^(\/private)?\/(tmp|var\/folders)\//.test(String(p)) || /\/scratchpad\//.test(String(p));

// Documentos de un robot: en su escritorio (sin entregar) o ya en tu bandeja.
function docsBlock(d) {
  if (!d.docs.length) return '';
  const rows = d.docs.slice().reverse().map(x => {
    const status = !x.delivered ? (x.updated ? ['p-input', 'actualizado, en el escritorio'] : ['p-working', 'en el escritorio']) : ['p-done', 'en tu bandeja'];
    return `<div class="item" data-docpath="${esc(x.path)}" title="${esc(x.path)}"><div class="meta-i"><b>${esc(fileName(x.path))}</b><div>${esc(shortPath(x.path))}</div></div><span class="pill ${status[0]}">${status[1]}</span></div>`;
  }).join('');
  return `<div class="rp-block"><h4>Documentos (${d.docs.length})</h4><div class="list doclist" id="doc-list">${rows}</div></div>`;
}

function inboxPanel() {
  const filter = st.inboxFilter || 'nuevos';
  const shown = inboxShown(), temps = st.inbox.length - shown.length;
  const items = filter === 'nuevos' ? shown.filter(i => i.status !== 'visto') : shown;
  const n = unseen();
  const row = i => {
    const isNew = i.status !== 'visto';
    return `<div class="inbox-item ${isNew ? 'new' : ''}">
      <div class="meta-i" data-docpath="${esc(i.path)}" data-docid="${esc(i.id)}" role="button" tabindex="0">
        <b>${esc(fileName(i.path))}</b>${i.critical > 0 ? ` <span class="tagx crit">⚠ ${i.critical} crítico${i.critical === 1 ? '' : 's'}</span>` : ''}${i.updated ? ' <span class="tagx">actualizado</span>' : ''}${isTempDoc(i.path) ? ' <span class="tagx tmp">temporal</span>' : ''}
        <div class="pathx" title="${esc(i.path)}">${esc(shortPath(i.path))} · ${new Date(i.at).toLocaleString('es', {day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit'})}</div>
      </div>
      <div class="row">
        <button class="btn sm" data-inbox="open" data-id="${esc(i.id)}">Ver</button>
        <button class="btn sm" data-inbox="${isNew ? 'seen' : 'unseen'}" data-id="${esc(i.id)}">${isNew ? 'Marcar visto' : 'Marcar nuevo'}</button>
        <button class="btn sm" data-inbox="reveal" data-id="${esc(i.id)}">Finder</button>
        <button class="btn sm danger" data-inbox="archive" data-id="${esc(i.id)}">Archivar</button>
      </div>
    </div>`;
  };
  // Agrupado por robot (el que entregó más reciente primero): cada robot es una tarea distinta.
  const groups = new Map();
  for (const i of items) { if (!groups.has(i.robot)) groups.set(i.robot, []); groups.get(i.robot).push(i); }
  const rows = [...groups].map(([robot, list]) => {
    const live = st.robots.get(robot);
    const nNew = list.filter(i => i.status !== 'visto').length;
    return `<section class="ib-g">
      <div class="ib-gh">${live ? `<span class="ib-av">${robotSVG(COLORS[live.data.color % 8], lookOf(robot, live.data.place))}</span>` : ''}<b>${esc(robot)}</b><span class="ib-lbl" title="${esc(list[0].label)}">${esc(list[0].label)}</span><small>${list.length} doc${list.length === 1 ? '' : 's'}${nNew && filter !== 'nuevos' ? ` · ${nNew} nuevo${nNew === 1 ? '' : 's'}` : ''}${live ? '' : ' · ya se fue'}</small></div>
      ${list.map(row).join('')}
    </section>`;
  }).join('');
  return `<div class="dlg-head"><h3>Tu bandeja</h3><p>Documentos que te entregaron los robots, agrupados por robot. Abrir uno lo marca como visto; archivar lo saca de la lista sin borrar el archivo.</p></div>
    <div class="dlg-sec">
      <div class="row between">
        <div class="seg small" role="radiogroup" aria-label="Filtro">
          <label><input type="radio" name="inboxf" value="nuevos" ${filter === 'nuevos' ? 'checked' : ''}>Nuevos (${n})</label>
          <label><input type="radio" name="inboxf" value="todos" ${filter === 'todos' ? 'checked' : ''}>Todos (${shown.length})</label>
        </div>
        <div class="row">
          ${temps || st.inboxTemp ? `<button class="btn sm" data-inbox="temp" title="Archivos en carpetas temporales (/tmp, scratchpads): borradores, láminas de un deck…">${st.inboxTemp ? 'Ocultar temporales' : `Mostrar temporales (${temps})`}</button>` : ''}
          <button class="btn sm" data-inbox="seen-all" ${n ? '' : 'disabled'}>Marcar todos como vistos</button>
        </div>
      </div>
      <div class="list">${rows || `<p>${filter === 'nuevos' ? 'No tienes documentos nuevos.' : 'La bandeja está vacía.'}${temps && !st.inboxTemp ? ` Hay ${temps} archivo${temps === 1 ? '' : 's'} temporal${temps === 1 ? '' : 'es'} oculto${temps === 1 ? '' : 's'}.` : ''}</p>`}</div>
    </div>`;
}

/* ---------- salas de épica ---------- */
const salaRobots = id => [...st.robots.values()].filter(a => a.data.place.sala === id);
function renderSalaChips() {
  $('#sala-count').textContent = `${st.salas.length} sala${st.salas.length === 1 ? '' : 's'}`;
  $('#sala-chips').innerHTML = st.salas.slice(0, 6).map(s => {
    const n = salaRobots(s.id).length;
    return `<div class="rchip" data-sala="${esc(s.id)}"><i class="dot" style="background:${n ? 'var(--teal)' : 'var(--wall)'}"></i><span>${esc(s.name)}<br><small>${esc(s.key || 'sin clave')} · ${n} robot${n === 1 ? '' : 's'} · ${s.thread.length} msj</small></span></div>`;
  }).join('') || '<div class="room-b">Sin salas. Clic para crear una por épica de Jira.</div>';
}

function salasPanel() {
  const cards = st.salas.map(s => {
    const last = s.thread[s.thread.length - 1];
    return `<div class="rt-card" data-sala="${esc(s.id)}" role="button" tabindex="0" style="cursor:pointer">
      <div class="top-r"><b>${esc(s.name)}</b>${s.key ? `<span class="pill p-idle">${esc(s.key)}</span>` : ''}</div>
      <div class="sub-h">${salaRobots(s.id).length} robots · ${s.thread.length} mensajes · ${s.docs.length} documentos${s.folder ? ' · ' + esc(s.folder) : ''}</div>
      ${last ? `<div class="sub-h">Último: ${esc(last.from)} · ${esc(last.text.slice(0, 120))}</div>` : ''}
    </div>`;
  }).join('');
  return `<div class="dlg-head"><h3>Salas de épica</h3><p>Cada sala agrupa a los robots que trabajan sobre una épica de Jira. Comparten un <code>CONTEXT.md</code> (alcance, decisiones, estado verificado) que leen al entrar y corrigen al aprender algo, y un hilo donde queda lo que cada uno dice al cerrar su turno.</p></div>
    ${cards ? `<section class="dlg-sec"><h4>Salas</h4><div class="rt-grid">${cards}</div></section>` : ''}
    <form class="dlg-sec" id="sala-new">
      <h4>Nueva sala</h4>
      <div class="fgrid">
        <div class="field"><label for="sn-name">Nombre</label><input id="sn-name" placeholder="Wallet hexagonal" maxlength="60"></div>
        <div class="field"><label for="sn-key">Épica o tarea de Jira</label><input id="sn-key" placeholder="TECH-2783" autocomplete="off"></div>
        <div class="field"><label for="sn-folder">Carpeta de documentos (opcional)</label><input id="sn-folder" placeholder="TASK/WALLET" autocomplete="off"></div>
        <div class="field full"><label for="sn-context">Contexto inicial (Markdown, opcional)</label><textarea id="sn-context" rows="6" placeholder="Alcance, decisiones ya tomadas, qué no re-litigar, dónde está el estado. Si lo dejas vacío se crea una plantilla."></textarea></div>
      </div>
      <div class="dlg-foot"><span class="note">Los archivos quedan en <code>agent-office/runs/salas/&lt;id&gt;/</code>.</span><button class="btn primary">Crear sala</button></div>
    </form>`;
}

function salaPanel(s) {
  const present = salaRobots(s.id);
  const thread = s.thread.map(m => logRow({kind: m.from === 'Coordinador' ? 'user' : 'agent', text: m.text, at: m.at, who: m.from})).join('');
  const docs = s.docs.length ? `<h4>Documentos (${s.docs.length})</h4><div class="list doclist">${s.docs.slice().reverse().map(x => `<div class="item" data-docpath="${esc(x.path)}" title="${esc(x.path)}"><div class="meta-i"><b>${esc(fileName(x.path))}</b><div>${esc(x.robot)} · ${esc(shortPath(x.path))}</div></div></div>`).join('')}</div>` : '';
  const max = st.config.maxRobots || 3;
  const active = [...st.robots.values()].filter(a => a.data.state !== 'done').length;
  return `<div class="ph"><div style="min-width:0"><h3>Sala «${esc(s.name)}»</h3><div class="sub-h">${esc(s.key || 'sin clave de Jira')}${s.folder ? ' · documentos en ' + esc(s.folder) : ''}</div></div>
      <div class="row" style="margin-left:auto"><button class="btn sm" data-sala-act="context">Ver CONTEXT.md</button><button class="btn sm" data-sala-act="reveal">Finder</button><button class="btn sm danger" data-sala-act="close" ${present.length ? 'disabled title="Da de baja a sus robots primero"' : ''}>Cerrar sala</button></div></div>
    <div class="rp-grid">
      <div class="rp-col">
        <h4>Hilo de la sala</h4>
        <div class="log" id="sala-log">${thread || '<div class="lg sys"><span class="x">Todavía no hay mensajes. Lo que digan los robots al cerrar cada turno aparece aquí.</span></div>'}</div>
        <form class="chat" id="sala-form">
          <textarea id="sala-in" rows="2" placeholder="Escribe en el hilo… Enter publica, Shift+Enter salto de línea."></textarea><button class="btn primary">Publicar</button>
          <label class="check" style="grid-column:1/-1"><input type="checkbox" id="sala-notify"> Enviárselo también a los ${present.length} robots de la sala (gasta cuota)</label>
        </form>
      </div>
      <div class="rp-col">
        <h4>Robots en la sala</h4>
        ${present.length ? `<div class="list">${present.map(a => `<div class="item" data-pick="${esc(a.data.name)}"><div class="meta-i"><b>${esc(a.data.name)}</b><div>${esc(a.data.label)}</div></div><span class="pill p-${a.data.state}">${STATE_LABEL[a.data.state] || a.data.state}</span></div>`).join('')}</div>` : '<p>Nadie trabajando aquí ahora.</p>'}
        <form class="dlg-sec" id="sala-job">
          <h4>Mandar un robot a la sala</h4>
          <div class="seg" role="radiogroup" aria-label="Tipo de encargo">
            <label><input type="radio" name="skind" id="sk-libre" value="libre" checked>Tarea libre</label>
            <label><input type="radio" name="skind" id="sk-skill-r" value="skill">Skill</label>
          </div>
          <div class="field" id="f-sk-text"><label for="sk-text">Qué necesitas</label><textarea id="sk-text" rows="4" placeholder="Ej.: valida el estado real de la migración contra el contexto y deja el resultado corregido en CONTEXT.md"></textarea></div>
          <div class="field" id="f-sk-skill" hidden><label for="sk-skill">Skill</label><input id="sk-skill" list="skills-list" autocomplete="off"></div>
          <div class="field" id="f-sk-args" hidden><label for="sk-args">Argumentos</label><input id="sk-args"></div>
          <div class="field"><label for="sk-mode">Permisos</label><select id="sk-mode"><option value="">Heredar tu modo</option><option value="default">Preguntar (default)</option><option value="acceptEdits">Aceptar ediciones</option><option value="plan">Solo planear</option></select></div>
          <div class="note">El robot recibe, además del encargo, las rutas de CONTEXT.md, del hilo${s.folder ? ' y de la carpeta de la épica' : ''} con instrucciones de leerlas primero.</div>
          <div class="row between"><span class="stats">${active}/${max} trabajando</span><button class="btn primary" ${active >= max ? 'disabled' : ''}>${active >= max ? `Tope de ${max} alcanzado` : 'Mandar robot'}</button></div>
        </form>
        ${docs}
      </div>
    </div>`;
}


function renderPanel() {
  const keep = {}; const focusId = PANEL.contains(document.activeElement) ? document.activeElement.id : null;
  PANEL.querySelectorAll('input,select,textarea').forEach(el => { if (el.id) keep[el.id] = el.type === 'radio' ? el.checked : el.value; });
  const logEl = $('#log', PANEL); const logScroll = logEl ? logEl.scrollTop : null; const atBottom = logEl ? logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 30 : true;
  const sel = st.selected;
  const a = sel && st.robots.get(sel);
  const sala = sel?.startsWith('@sala:') ? st.salas.find(s => s.id === sel.slice(6)) : null;
  if (sel?.startsWith('@sala:') && !sala) { st.selected = '@war'; return renderPanel(); } // la sala se cerró
  if (!sel || (!a && !sel.startsWith('@'))) {
    st.selected = null;
    clearInterval(paneTimer);
    $('#dialog').hidden = true;
    PANEL.innerHTML = ''; PANEL.dataset.view = '';
    return;
  }
  const wasHidden = $('#dialog').hidden;
  const sameView = !wasHidden && PANEL.dataset.view === sel;
  $('#dialog').hidden = false;
  $('#dlg-card').classList.toggle('wide', sel === '@cron' || sel === '@usage' || sel === '@war');
  $('#dlg-card').classList.toggle('tall', !!a || !!sala);
  const html = a ? robotPanel(a) : sala ? salaPanel(sala) : sel === '@inbox' ? inboxPanel() : sel === '@usage' ? usagePanel() : sel === '@setup' ? setupPanel() : sel === '@cron' ? cronPanel() : sel === '@war' ? salasPanel() : newPanel();
  if (sameView) {
    if (html === PANEL._html) { tickRoutines(); return; }
    const tpl = document.createElement('template'); tpl.innerHTML = html;
    PANEL._html = html;
    const sl = $('#sala-log', PANEL), slBottom = sl && sl.scrollTop + sl.clientHeight >= sl.scrollHeight - 30;
    // La conversación se queda abajo aunque aparezca o se vaya el aviso de permiso (si estabas leyendo arriba, no se mueve).
    const lg0 = $('#log', PANEL), lgTop = lg0?.scrollTop, lgBottom = lg0 && lg0.scrollTop + lg0.clientHeight >= lg0.scrollHeight - 30;
    morph(PANEL, tpl.content);
    if (sl && slBottom) sl.scrollTop = sl.scrollHeight;
    const lg1 = $('#log', PANEL);
    if (lg1 && (lgBottom || lg1 !== lg0)) lg1.scrollTop = lgBottom || lg0 == null ? lg1.scrollHeight : lgTop;
    tickRoutines(); syncKind();
    return;
  }
  clearInterval(paneTimer);
  PANEL.dataset.view = sel; PANEL._html = html;
  PANEL.innerHTML = html;
  if (wasHidden) PANEL.scrollTop = 0;
  tickRoutines();
  Object.entries(keep).forEach(([id, v]) => { const el = document.getElementById(id); if (el && PANEL.contains(el)) { if (el.type === 'radio') el.checked = v; else el.value = v; } });
  if (focusId) document.getElementById(focusId)?.focus();
  const lg = $('#log', PANEL) || $('#sala-log', PANEL); if (lg) lg.scrollTop = atBottom || logScroll == null ? lg.scrollHeight : logScroll;
  syncKind();
  if (a) { refreshPane(a.data.name); paneTimer = setInterval(() => refreshPane(a.data.name), 2000); }
  if (wasHidden) (PANEL.querySelector('#rp-alert input, #chat-in, #job-skill, #job-text, #sala-in, #sn-name') || $('#dlg-close')).focus();
}

async function refreshPane(name) {
  try {
    const res = await fetch(`/api/robots/${name}/pane`);
    if (!res.ok) return;
    const {text} = await res.json();
    const last = text.split('\n').slice(-60).join('\n');
    paneCache.set(name, last);
    const pre = $('#pane', PANEL);
    if (pre && st.selected === name && pre.textContent !== last) { pre.textContent = last; pre.scrollTop = pre.scrollHeight; }
  } catch { /* el robot pudo haberse ido */ }
}

/* ---------- lanzar otro igual y encargos frecuentes ---------- */
st.favorites = [];
function fillJob(req) {
  select('@new');
  const set = (id, v) => { const el = $('#' + id, PANEL); if (el) el.value = v ?? ''; };
  ($(req.kind === 'libre' ? '#kind-libre' : '#kind-skill', PANEL) || {}).checked = true;
  set('job-skill', req.skill ? req.skill : ''); set('job-args', req.args); set('job-text', req.text);
  set('job-mode', req.permissionMode); set('job-title', req.title); set('job-name', '');
  syncKind();
  const focus = req.kind === 'libre' ? $('#job-text', PANEL) : $('#job-args', PANEL);
  focus?.focus(); focus?.setSelectionRange?.(focus.value.length, focus.value.length);
}
const launchAgain = d => fillJob({...d.request, title: d.title});
PANEL.addEventListener('click', async e => {
  const use = e.target.closest('[data-fav]'), del = e.target.closest('[data-fav-del]'), save = e.target.closest('[data-fav-save]');
  if (use) { const f = st.favorites.find(x => x.id === use.dataset.fav); if (f) fillJob(f); return; }
  if (del) { try { await api('DELETE', `/api/favorites/${del.dataset.favDel}`); } catch { /* toast ya mostrado */ } return; }
  if (!save) return;
  const libre = $('#kind-libre', PANEL)?.checked;
  try {
    await api('POST', '/api/favorites', {kind: libre ? 'libre' : 'skill', skill: $('#job-skill').value, args: $('#job-args').value, text: $('#job-text').value, permissionMode: $('#job-mode').value, title: $('#job-title').value});
    toast('Guardado en frecuentes');
  } catch { /* toast ya mostrado */ }
});

function syncKind() {
  const libre = $('#kind-libre', PANEL)?.checked;
  if ($('#f-text', PANEL)) {
    $('#f-text').hidden = !libre; $('#f-skill').hidden = !!libre; $('#f-args').hidden = !!libre;
  }
  if ($('#f-sk-text', PANEL)) {
    const skill = $('#sk-skill-r', PANEL).checked;
    $('#f-sk-text').hidden = skill; $('#f-sk-skill').hidden = !skill; $('#f-sk-args').hidden = !skill;
  }
  const rtLibre = $('#rt-kind-libre', PANEL)?.checked;
  if ($('#f-rt-text', PANEL)) {
    $('#f-rt-text').hidden = !rtLibre; $('#f-rt-skill').hidden = !!rtLibre; $('#f-rt-args').hidden = !!rtLibre;
    const agenda = $('#rt-type-agenda').checked;
    $('#g-agenda').hidden = !agenda; $('#g-watch').hidden = agenda;
    const org = $('#rt-where').value === 'org';
    $('#f-rt-owner').hidden = !org; $('#f-rt-repo').hidden = org;
  }
}

/* ---------- nube al pasar el mouse ---------- */
const hover = {el: document.createElement('div'), name: null, timer: null, line: ''};
hover.el.className = 'hovercard'; hover.el.hidden = true;
MAP.appendChild(hover.el);

// Ultima linea "util" de la consola: se saltan bordes, el prompt y la barra de modo de Claude Code.
const NOISE = /^[\s─━│┃╭╮╰╯┌┐└┘═╌╍┄┈\-_|]*$|^\s*❯|⏵⏵|⏸|\? for shortcuts|esc to interrupt|shift\+tab|mode on|^\s*>\s*$/;
function lastConsoleLine(text) {
  const lines = String(text || '').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trim();
    if (!l || NOISE.test(l)) continue;
    return l.replace(/^[⎿⏺✻✳✶✢·•*]+\s*/, '').slice(0, 110);
  }
  return '';
}

function hoverActivity(d) {
  if (d.ask) return `Te hizo ${d.ask.questions.length === 1 ? 'una pregunta' : `${d.ask.questions.length} preguntas`} con opciones`;
  if (d.needsPermission || d.hold) return 'Esperando tu permiso';
  if (d.state === 'delegating') {
    const running = d.subs.filter(s => s.status === 'running');
    return `Esperando ${running.length} subagente${running.length === 1 ? '' : 's'}${running[0]?.activity ? ' · ' + running[0].activity : ''}`;
  }
  if (d.activity) return d.activity;
  return plainMd(d.bubble) || STATE_LABEL[d.state] || '';
}

function renderHover() {
  const a = st.robots.get(hover.name);
  if (!a) return hideHover();
  const d = a.data;
  const label = stateLabel(d);
  hover.el.innerHTML = `<div class="hc-top"><b>${esc(d.name)}</b><span class="pill p-${d.state}">${esc(label)}</span></div>
    ${titleOf(d) ? `<div class="hc-title${d.title ? '' : ' auto'}">📌 ${esc(titleOf(d))}</div>` : ''}
    <div class="hc-act">${esc(hoverActivity(d).slice(0, 120))}</div>
    ${d.state === 'input' && d.inputAt ? `<div class="hc-wait">Esperando tu respuesta hace <b data-since="${esc(d.inputAt)}">${fmtWait(Date.now() - Date.parse(d.inputAt))}</b></div>` : ''}
    <div class="hc-org">${esc(d.origin || 'Origen desconocido')}</div>
    ${hover.line ? `<div class="hc-con">› ${esc(hover.line)}</div>` : ''}`;
  hover.el.style.left = a.pos.x + '%';
  hover.el.style.top = py(a.pos.y);
  hover.el.classList.toggle('flip', a.pos.y < 30);
  hover.el.hidden = false;
  clampHover();
}
// Robots del borde: la tarjeta se corre hacia adentro para no quedar cortada por el borde del mapa
// (la flecha sigue apuntando al robot). En la vista 2.5D no se toca: allí la rota la perspectiva.
function clampHover() {
  const el = hover.el;
  el.style.setProperty('--hx', '0px');
  if (MAP.closest('.map-wrap')?.classList.contains('iso')) return;
  const r = el.getBoundingClientRect(), m = MAP.getBoundingClientRect(), w = MAP.parentElement.getBoundingClientRect();
  const left = Math.max(m.left, w.left) + 6, right = Math.min(m.right, w.right) - 6;
  const dx = r.left < left ? left - r.left : r.right > right ? right - r.right : 0;
  if (dx) el.style.setProperty('--hx', Math.round(dx) + 'px');
}

async function refreshHoverLine() {
  const name = hover.name; if (!name) return;
  try {
    const res = await fetch(`/api/robots/${name}/pane`);
    if (!res.ok || hover.name !== name) return;
    hover.line = lastConsoleLine((await res.json()).text);
    renderHover();
  } catch { /* el robot pudo irse */ }
}

function showHover(name) {
  if (hover.name === name) return;
  hover.name = name; hover.line = '';
  renderHover();
  refreshHoverLine();
  clearInterval(hover.timer);
  hover.timer = setInterval(refreshHoverLine, 2000);
}
function hideHover() {
  hover.name = null;
  clearInterval(hover.timer);
  hover.el.hidden = true;
}

MAP.addEventListener('mouseover', e => {
  const r = e.target.closest('.robot:not(.on-break)');
  if (r) showHover(r.dataset.name);
});
MAP.addEventListener('mouseout', e => {
  const r = e.target.closest('.robot');
  if (r && !r.contains(e.relatedTarget)) hideHover();
});

/* ---------- eventos ---------- */
// Baja rápida desde el mapa: primer clic arma la ✕ («¿Baja?»), el segundo dentro de 3s la confirma.
async function quickKill(btn, name) {
  if (!btn.classList.contains('armed')) {
    btn.classList.add('armed'); btn.textContent = '¿Baja?';
    clearTimeout(btn._t); btn._t = setTimeout(() => { btn.classList.remove('armed'); btn.textContent = '×'; }, 3000);
    return;
  }
  clearTimeout(btn._t); btn.disabled = true; btn.textContent = '…';
  try { await api('DELETE', `/api/robots/${name}`); } catch { btn.disabled = false; btn.classList.remove('armed'); btn.textContent = '×'; }
}

MAP.addEventListener('click', e => {
  const kx = e.target.closest('.kill-x'); if (kx) { e.stopPropagation(); return quickKill(kx, kx.closest('.robot').dataset.name); }
  const bb = e.target.closest('.robot.on-break'); if (bb) return assignFromBreak(bb.dataset.name);
  const r = e.target.closest('.robot'); if (r) return select(r.dataset.name);
  const dk = e.target.closest('.desk');
  if (dk) { const a = [...st.robots.values()].find(x => x.data.place.idx == dk.dataset.desk); return select(a ? a.data.name : '@new'); }
  const sala = e.target.closest('[data-sala]'); if (sala) return select('@sala:' + sala.dataset.sala);
  const room = e.target.closest('[data-room]'); if (room) select('@' + room.dataset.room);
});
MAP.addEventListener('keydown', e => {
  if ((e.key !== 'Enter' && e.key !== ' ') || !e.target.classList.contains('robot')) return;
  e.preventDefault();
  if (e.target.classList.contains('on-break')) assignFromBreak(e.target.dataset.name); else select(e.target.dataset.name);
});

PANEL.addEventListener('change', e => { if (e.target.name === 'inboxf') { st.inboxFilter = e.target.value; return renderPanel(); } if (['kind', 'rtkind', 'rttype', 'skind'].includes(e.target.name) || e.target.id === 'rt-where') syncKind(); });
PANEL.addEventListener('keydown', e => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.rt-card[data-sala]')) { e.preventDefault(); return select('@sala:' + e.target.dataset.sala); }
  if (e.key === 'Enter' && !e.shiftKey && (e.target.id === 'chat-in' || e.target.id === 'sala-in')) { e.preventDefault(); e.target.form.requestSubmit(); } });
// Nombre aleatorio pronunciable: 6 letras (consonante-vocal) y 2 números, p. ej. «bakuro17».
function randomName() {
  const C = 'bcdfghjklmnprstvz', V = 'aeiou', pick = s => s[Math.floor(Math.random() * s.length)];
  for (let i = 0; i < 20; i++) {
    const n = pick(C) + pick(V) + pick(C) + pick(V) + pick(C) + pick(V) + String(Math.floor(Math.random() * 100)).padStart(2, '0');
    if (!st.robots.has(n)) return n;
  }
  return 'robot' + Date.now() % 1000;
}
PANEL.addEventListener('click', e => { if (e.target.id === 'job-name-rand') { const el = $('#job-name'); el.value = randomName(); el.focus(); } });
// El daemon solo acepta minúsculas, números y guiones: se corrige mientras escribes.
PANEL.addEventListener('input', e => {
  if (e.target.id !== 'job-name') return;
  const v = e.target.value.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  if (v !== e.target.value) e.target.value = v;
});

PANEL.addEventListener('submit', async e => {
  e.preventDefault();
  if (e.target.id === 'job-form') {
    const libre = $('#kind-libre').checked;
    const attachments = attList('job').map(f => f.path);
    const body = libre
      ? {kind: 'libre', text: $('#job-text').value, permissionMode: $('#job-mode').value, name: $('#job-name').value.trim() || undefined, title: $('#job-title').value.trim() || undefined, attachments}
      : {kind: 'skill', skill: $('#job-skill').value, args: $('#job-args').value, permissionMode: $('#job-mode').value, name: $('#job-name').value.trim() || undefined, title: $('#job-title').value.trim() || undefined, attachments};
    body.origin = 'Lanzado por ti desde «Nuevo encargo»';
    try {
      const {name} = await api('POST', '/api/robots', body);
      ['job-text', 'job-args', 'job-name'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
      st.att.job = [];
      select(name);
    } catch { /* toast ya mostrado */ }
  }
  if (e.target.id === 'rt-form') {
    const libre = $('#rt-kind-libre').checked;
    const common = {name: $('#rt-name').value.trim() || undefined, everyMin: Number($('#rt-every').value), permissionMode: $('#rt-mode').value};
    const body = $('#rt-type-agenda').checked
      ? {...common, type: 'agenda', text: $('#rt-agenda').value, delegate: $('#rt-delegate').checked}
      : {...common, type: 'watch',
        source: $('#rt-where').value === 'org'
          ? {scope: 'org', owner: $('#rt-owner').value.trim(), query: $('#rt-query').value.trim()}
          : {scope: 'repo', repo: $('#rt-repo').value.trim(), query: $('#rt-query').value.trim()},
        onlyNew: $('#rt-scope').value === 'new',
        includeDrafts: $('#rt-drafts').checked,
        extra: $('#rt-extra').value,
        action: libre ? {kind: 'libre', text: $('#rt-text').value} : {kind: 'skill', skill: $('#rt-skill').value, args: $('#rt-args').value}};
    try {
      await api('POST', '/api/routines', body);
      ['rt-name', 'rt-repo', 'rt-query', 'rt-extra', 'rt-agenda'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
      toast('Rutina creada. Hace su primera revisión ahora.');
    } catch { /* toast ya mostrado */ }
  }
  if (e.target.id === 'sala-new') {
    try {
      const {id} = await api('POST', '/api/salas', {name: $('#sn-name').value.trim(), key: $('#sn-key').value.trim(), folder: $('#sn-folder').value.trim(), context: $('#sn-context').value});
      ['sn-name', 'sn-key', 'sn-folder', 'sn-context'].forEach(x => { document.getElementById(x).value = ''; });
      select('@sala:' + id);
    } catch { /* toast ya mostrado */ }
  }
  if (e.target.id === 'sala-form') {
    const id = st.selected.slice(6), t = $('#sala-in').value.trim();
    if (!t) return;
    $('#sala-in').value = '';
    try {
      const {notified} = await api('POST', `/api/salas/${id}/hilo`, {text: t, notify: $('#sala-notify').checked});
      if (notified) toast(`Enviado también a ${notified} robot${notified === 1 ? '' : 's'} de la sala.`);
    } catch { $('#sala-in').value = t; }
  }
  if (e.target.id === 'sala-job') {
    const id = st.selected.slice(6), s = st.salas.find(x => x.id === id);
    const skill = $('#sk-skill-r').checked;
    const body = skill ? {kind: 'skill', skill: $('#sk-skill').value, args: $('#sk-args').value} : {kind: 'libre', text: $('#sk-text').value};
    Object.assign(body, {sala: id, permissionMode: $('#sk-mode').value, origin: `Lanzado por ti en la sala «${s?.name || id}»`});
    try {
      const {name} = await api('POST', '/api/robots', body);
      ['sk-text', 'sk-args'].forEach(x => { document.getElementById(x).value = ''; });
      select(name);
    } catch { /* toast ya mostrado */ }
  }
  if (e.target.id === 'chat-form') {
    const name = st.selected;
    const t = $('#chat-in').value.trim();
    const files = attList(name);
    if ((!t && !files.length) || !name) return;
    $('#chat-in').value = '';
    try {
      await api('POST', `/api/robots/${name}/say`, {text: t, attachments: files.map(f => f.path)});
      st.att[name] = [];
      refreshTray(name);
    } catch { $('#chat-in').value = t; }
  }
});
PANEL.addEventListener('click', async e => {
  const pick = e.target.closest('[data-pick]'); if (pick) return select(pick.dataset.pick);
  const sc = e.target.closest('.rt-card[data-sala]'); if (sc) return select('@sala:' + sc.dataset.sala);
  const sa = e.target.closest('[data-sala-act]');
  if (sa) {
    const s = st.salas.find(x => x.id === st.selected?.slice(6)); if (!s) return;
    try {
      if (sa.dataset.salaAct === 'context') return showDoc(s.context);
      if (sa.dataset.salaAct === 'reveal') await api('POST', '/api/reveal', {path: s.context});
      if (sa.dataset.salaAct === 'close' && confirm(`¿Cerrar la sala «${s.name}»? Sus archivos quedan en el disco.`)) { await api('DELETE', `/api/salas/${s.id}`); select('@war'); }
    } catch { /* toast ya mostrado */ }
    return;
  }
  const ib = e.target.closest('[data-inbox]');
  if (ib?.dataset.inbox === 'temp') {
    st.inboxTemp = !st.inboxTemp; prefSet('inboxTemp', st.inboxTemp ? '1' : '0');
    renderInboxBadge(); renderMeta(); return renderPanel();
  }
  if (ib) {
    const id = ib.dataset.id, item = st.inbox.find(x => x.id === id);
    try {
      if (ib.dataset.inbox === 'open' && item) return showDoc(item.path, id);
      if (ib.dataset.inbox === 'seen') await api('POST', `/api/inbox/${id}`, {status: 'visto'});
      if (ib.dataset.inbox === 'unseen') await api('POST', `/api/inbox/${id}`, {status: 'nuevo'});
      if (ib.dataset.inbox === 'reveal' && item) await api('POST', '/api/reveal', {path: item.path});
      if (ib.dataset.inbox === 'archive') await api('DELETE', `/api/inbox/${id}`);
      if (ib.dataset.inbox === 'seen-all') await api('POST', '/api/inbox/seen-all');
    } catch { /* toast ya mostrado */ }
    return;
  }
  const doc = e.target.closest('[data-docpath]'); if (doc) return showDoc(doc.dataset.docpath, doc.dataset.docid);
  const preset = e.target.closest('[data-preset]'); if (preset) return applyPreset(preset.dataset.preset);
  const un = e.target.closest('[data-unatt]');
  if (un) { attList(un.dataset.unatt).splice(Number(un.dataset.i), 1); return refreshTray(un.dataset.unatt); }
  const rb = e.target.closest('[data-rt]');
  if (rb) {
    const id = rb.dataset.id;
    try {
      if (rb.dataset.rt === 'run') await api('POST', `/api/routines/${id}/run`);
      if (rb.dataset.rt === 'pause') await api('POST', `/api/routines/${id}/pause`);
      if (rb.dataset.rt === 'delete' && confirm('¿Eliminar esta rutina? Los robots que ya lanzó siguen trabajando.')) await api('DELETE', `/api/routines/${id}`);
    } catch { /* toast ya mostrado */ }
    return;
  }
  const b = e.target.closest('[data-act]'); if (!b) return;
  const name = st.selected, a = st.robots.get(name);
  try {
    if (b.dataset.act === 'console') await api('POST', `/api/robots/${name}/console`);
    if (b.dataset.act === 'again' && a) return launchAgain(a.data);
    if (b.dataset.act === 'fav' && a) { await api('POST', '/api/favorites', {...a.data.request, title: a.data.title}); toast('Guardado en frecuentes: lo ves arriba de «Nuevo encargo»'); }
    if (b.dataset.act === 'kill') { b.disabled = true; await api('DELETE', `/api/robots/${name}`); }
    if (b.dataset.act === 'perm-approve') await api('POST', `/api/robots/${name}/permission`, {decision: 'approve'});
    if (b.dataset.act === 'perm-reject') await api('POST', `/api/robots/${name}/permission`, {decision: 'reject'});
    if (b.dataset.act === 'hold-allow' && a?.data.hold) await api('POST', `/api/decision/${a.data.hold.id}`, {decision: 'allow'});
    if (b.dataset.act === 'hold-deny' && a?.data.hold) await api('POST', `/api/decision/${a.data.hold.id}`, {decision: 'deny'});
  } catch { /* toast ya mostrado */ }
});
$('#btn-new').addEventListener('click', () => select('@new'));
$('#btn-routine').addEventListener('click', () => select('@cron'));
async function setCap(delta) {
  const next = (st.config.maxRobots || 3) + delta;
  try { await api('POST', '/api/config', {maxRobots: next}); } catch { /* toast ya mostrado */ }
}
$('#cap-down').addEventListener('click', () => setCap(-1));

// Nombre de la oficina (solo estético): va en el encabezado, la pestaña y el ícono, para no confundir oficinas.
const OFFICE_HUES = [174, 38, 352, 250, 98, 205, 300, 18];
function officeHue(name) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return OFFICE_HUES[h % OFFICE_HUES.length];
}
function renderOfficeName() {
  const name = st.config.name || '';
  const btn = $('#office-name');
  if (btn.querySelector('input')) return; // editando: no pisar lo que se escribe
  btn.textContent = name || 'ponle nombre';
  btn.classList.toggle('empty', !name);
  const hue = name ? officeHue(name) : 174;
  btn.style.setProperty('--oh', hue);
  notif.base = name ? `${name} · Oficina de Agentes` : 'Oficina de Agentes';
  updateTitle(notif.known?.size || 0);
  const letter = esc((name || 'O').trim()[0].toUpperCase());
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="hsl(${hue} 60% 48%)"/><text x="16" y="22.5" font-family="Arial,sans-serif" font-size="19" font-weight="700" text-anchor="middle" fill="#fff">${letter}</text></svg>`;
  $('#favicon').href = 'data:image/svg+xml,' + encodeURIComponent(svg);
}
$('#office-name').addEventListener('click', () => {
  const btn = $('#office-name');
  if (btn.querySelector('input')) return;
  const input = document.createElement('input');
  input.maxLength = 40; input.value = st.config.name || ''; input.placeholder = 'ej. Wallet, Reviews…';
  input.setAttribute('aria-label', 'Nombre de la oficina');
  btn.textContent = ''; btn.classList.remove('empty'); btn.appendChild(input); input.focus(); input.select();
  let done = false;
  const finish = async save => {
    if (done) return; done = true;
    const value = input.value.replace(/\s+/g, ' ').trim();
    input.remove();
    if (save && value !== (st.config.name || '')) {
      try { await api('POST', '/api/config', {name: value}); } catch { /* toast ya mostrado */ }
    }
    renderOfficeName();
  };
  input.addEventListener('keydown', e => { if (e.key === 'Enter') finish(true); else if (e.key === 'Escape') finish(false); e.stopPropagation(); });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('click', e => e.stopPropagation());
});
$('#cap-up').addEventListener('click', () => { if ((st.config.maxRobots || 3) >= 3) toast('Más robots a la vez gastan tu cuota más rápido.'); setCap(1); });
$('#btn-inbox').addEventListener('click', () => select('@inbox'));
$('#btn-usage').addEventListener('click', () => { select('@usage'); loadWeeks(); if (!st.claude) loadClaudeStatus(false); });
$('#week-chip').addEventListener('click', () => $('#btn-usage').click());
// Despide a todos los que terminaron; como la ✕ de cada robot, pide un segundo clic para confirmar.
$('#btn-dismiss').addEventListener('click', async () => {
  const b = $('#btn-dismiss');
  const done = [...st.robots.values()].filter(a => a.data.state === 'done').map(a => a.data.name);
  if (!b.classList.contains('armed')) {
    b.classList.add('armed'); b.textContent = `¿Despedir ${done.join(', ')}?`;
    clearTimeout(b._t); b._t = setTimeout(() => { b.classList.remove('armed'); renderMeta(); }, 4000);
    return;
  }
  clearTimeout(b._t); b.classList.remove('armed');
  await Promise.allSettled(done.map(n => api('DELETE', `/api/robots/${n}`)));
  renderMeta();
});
$('#dlg-close').addEventListener('click', () => select(null));
$('#dialog').addEventListener('mousedown', e => { if (e.target.id === 'dialog') select(null); });

let modalPath = null;
async function showDoc(p, inboxId) {
  try {
    const doc = await api('GET', `/api/doc?path=${encodeURIComponent(p)}`);
    modalPath = p;
    $('#modal-title').textContent = doc.path;
    $('#modal-body').textContent = doc.binary ? 'Este tipo de archivo no se puede mostrar aquí. Usa «Mostrar en Finder» para abrirlo.' : doc.text;
    modalMd = !doc.binary && /\.(md|markdown)$/i.test(p) && window.marked && window.DOMPurify ? doc.text : null;
    renderDocBody();
    $('#modal').hidden = false; $('#modal-close').focus();
    // Abrir un documento de la bandeja lo marca como visto.
    const item = st.inbox.find(x => (inboxId ? x.id === inboxId : x.path === p) && x.status !== 'visto');
    if (item) await api('POST', `/api/inbox/${item.id}`, {status: 'visto'});
  } catch { /* toast ya mostrado */ }
}
// Los .md se muestran con formato (marked + DOMPurify, servidos localmente); el botón alterna a texto plano.
let modalMd = null;
const prefersPlain = () => { try { return localStorage.getItem('office.docPlain') === '1'; } catch { return false; } };
function renderDocBody() {
  const formatted = modalMd !== null && !prefersPlain();
  $('#modal-fmt').hidden = modalMd === null;
  $('#modal-fmt').textContent = formatted ? 'Texto plano' : 'Con formato';
  $('#modal-body').hidden = formatted;
  $('#modal-md').hidden = !formatted;
  if (formatted) {
    $('#modal-md').innerHTML = DOMPurify.sanitize(marked.parse(modalMd, {gfm: true}));
    $('#modal-md').querySelectorAll('a[href]').forEach(l => { l.target = '_blank'; l.rel = 'noopener'; });
  }
}
$('#modal-fmt').addEventListener('click', () => { try { localStorage.setItem('office.docPlain', prefersPlain() ? '0' : '1'); } catch {} renderDocBody(); });
$('#modal-reveal').addEventListener('click', () => { if (modalPath) api('POST', '/api/reveal', {path: modalPath}).catch(() => {}); });
$('#modal-close').addEventListener('click', () => $('#modal').hidden = true);
$('#modal').addEventListener('click', e => { if (e.target.id === 'modal') $('#modal').hidden = true; });
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (!$('#keys')?.hidden && $('#keys')) $('#keys').hidden = true;
  else if (!$('#modal').hidden) $('#modal').hidden = true; // primero el documento, luego la ventana
  else if (st.selected) select(null);
});

/* ---------- atajos de teclado ---------- */
// No actúan mientras escribes. J/K recorren los robots en el orden de las tarjetas (primero los que te necesitan).
const KEYS = [['J / K', 'Siguiente / anterior robot'], ['A', 'Aprobar el permiso del robot abierto'], ['R', 'Escribirle al robot abierto'],
  ['N', 'Nuevo encargo'], ['B', 'Bandeja'], ['Esc', 'Cerrar'], ['?', 'Esta ayuda']];
function keysHelp() {
  let box = $('#keys');
  if (!box) {
    box = document.createElement('aside'); box.id = 'keys'; box.hidden = true;
    box.innerHTML = `<div class="aw-h"><b>Atajos de teclado</b><button type="button" class="aw-x" aria-label="Cerrar">×</button></div><dl>${KEYS.map(([k, t]) => `<dt>${k.split(' / ').map(x => `<kbd>${x}</kbd>`).join(' / ')}</dt><dd>${t}</dd>`).join('')}</dl>`;
    box.addEventListener('click', e => { if (e.target.closest('.aw-x')) box.hidden = true; });
    document.body.appendChild(box);
  }
  box.hidden = !box.hidden;
}
document.addEventListener('keydown', async e => {
  if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
  if (e.target.closest?.('input, textarea, select, [contenteditable]')) return;
  const k = e.key.toLowerCase(), a = st.robots.get(st.selected);
  if (k === 'j' || k === 'k') {
    const names = [...CARDS.querySelectorAll('[data-card]')].map(c => c.dataset.card);
    if (!names.length) return;
    const i = names.indexOf(st.selected);
    select(names[i < 0 ? (k === 'j' ? 0 : names.length - 1) : (i + (k === 'j' ? 1 : -1) + names.length) % names.length]);
  } else if (k === 'n') select('@new');
  else if (k === 'b') select('@inbox');
  else if (k === 'r' && a) { e.preventDefault(); $('#chat-in')?.focus(); }
  else if (k === 'a' && a) {
    const d = a.data;
    try {
      if (d.hold) await api('POST', `/api/decision/${d.hold.id}`, {decision: 'allow'});
      else if (d.needsPermission) await api('POST', `/api/robots/${d.name}/permission`, {decision: 'approve'});
      else if (d.ask) return $('#rp-alert input')?.focus();
      else return toast(`${d.name} no está pidiendo permiso`);
      toast(`Aprobado: ${d.name}`);
    } catch { /* toast ya mostrado */ }
  } else if (e.key === '?') keysHelp();
  else return;
  e.preventDefault();
});

const setSkills = skills => { $('#skills-list').innerHTML = (skills || []).map(s => `<option value="${esc(s)}">`).join(''); };
fetch('/api/skills').then(r => r.json()).then(({skills}) => setSkills(skills)).catch(() => {});

renderPanel();
connect();

/* ---------- mientras no estabas ---------- */
// Si sales de la pestaña (u otra ventana tapa la oficina) más de AWAY_MS, al volver ves un solo resumen
// de lo que cambió: quién terminó, quién te necesita, quién entró o se fue y documentos nuevos.
const AWAY_MS = 10 * 60e3;
const away = {since: 0, snap: null, inbox: null};
const needWhat = d => d.ask ? 'te hizo preguntas' : d.hold || d.needsPermission ? 'pide permiso' : 'tiene una pregunta para ti';
function awaySnap() {
  away.since = Date.now();
  away.snap = new Map([...st.robots.values()].map(a => [a.data.name, {state: a.data.state, critical: a.data.critical || 0}]));
  away.inbox = new Set(st.inbox.map(i => i.id));
}
function awayBack(force) {
  if (!away.snap) return;
  const mins = Math.round((Date.now() - away.since) / 60e3), snap = away.snap, seen = away.inbox;
  away.snap = null;
  if (!force && Date.now() - away.since < AWAY_MS) return;
  const items = [];
  for (const a of st.robots.values()) {
    const d = a.data, was = snap.get(d.name);
    const who = `<a data-away="${esc(d.name)}">${esc(d.name)}</a>${d.title ? ` <small>📌 ${esc(d.title)}</small>` : ''}`;
    if (!was) items.push({k: 'new', h: `${who} entró a trabajar`});
    else if (d.state === 'input' && was.state !== 'input') items.push({k: 'need', h: `${who} ${needWhat(d)}`});
    else if (d.state === 'done' && was.state !== 'done') items.push({k: d.critical ? 'crit' : 'done', h: `${who} terminó${d.critical ? ` con ⚠ ${d.critical} crítico${d.critical === 1 ? '' : 's'}` : ''}`});
    else if (isStuck(d) && was.state !== 'input') items.push({k: 'stuck', h: `${who} lleva ${fmtDur(idleMs(d))} sin actividad`});
  }
  for (const name of snap.keys()) if (!st.robots.has(name)) items.push({k: 'gone', h: `${esc(name)} se fue`});
  const docs = st.inbox.filter(i => !seen.has(i.id) && !isTempDoc(i.path)).length;
  if (docs) items.push({k: 'doc', h: `<a data-away="@inbox">${docs} documento${docs === 1 ? '' : 's'} nuevo${docs === 1 ? '' : 's'}</a> en tu bandeja`});
  if (!items.length) return;
  const order = {need: 0, crit: 1, stuck: 2, done: 3, doc: 4, new: 5, gone: 6};
  items.sort((x, y) => order[x.k] - order[y.k]);
  let box = $('#away');
  if (!box) { box = document.createElement('aside'); box.id = 'away'; box.setAttribute('role', 'status'); document.body.appendChild(box); }
  box.innerHTML = `<div class="aw-h"><b>Mientras no estabas</b><small>${mins >= 60 ? `${Math.floor(mins / 60)} h ${mins % 60} min` : `${mins} min`}</small><button type="button" class="aw-x" aria-label="Cerrar">×</button></div>
    <ul>${items.map(i => `<li class="aw-${i.k}">${i.h}</li>`).join('')}</ul>`;
  box.hidden = false;
}
document.addEventListener('visibilitychange', () => document.hidden ? (away.snap || awaySnap()) : awayBack());
window.addEventListener('blur', () => { if (!away.snap) awaySnap(); });
window.addEventListener('focus', () => awayBack());
document.addEventListener('click', e => {
  const box = e.target.closest('#away'); if (!box) return;
  const l = e.target.closest('[data-away]');
  if (l) select(l.dataset.away);
  if (l || e.target.closest('.aw-x')) box.hidden = true;
});
})();
