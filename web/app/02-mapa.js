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
    el.innerHTML = `<i class="ctxm" aria-hidden="true"><b></b></i><i class="chair"></i><div class="mon"><i></i></div><div class="mon m2"><i></i></div><div class="kb"></div><i class="mpad"></i><i class="mouse"></i>${item}<i class="clutter"></i><i class="dnote" aria-hidden="true"></i><div class="paper" hidden></div><span class="dn">${String(i + 1).padStart(2, '0')}</span>`;
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
  placeGrowth(e);
  setRect($('#trophies'), 79.6, 89.2 + e); // repisa al pie de tu escritorio, debajo de la bandeja
  setRect($('#archivador'), 88.4, 81.6 + e, 2.8, 8); // archivador: robots despedidos con su resumen
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

