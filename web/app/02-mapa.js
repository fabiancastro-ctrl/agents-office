/* ---------- dibujo ---------- */
// lookOf y robotSVG viven en web/robot-art.js (se comparten con el edificio).
$('#me').innerHTML =
  `<svg viewBox="0 0 40 48" aria-hidden="true"><circle cx="20" cy="13" r="9" fill="#e7c9a5"/><path d="M11 12a9 9 0 0118 0c-3-3-12-3-18 0z" fill="#3b2c22"/><rect x="8" y="24" width="24" height="20" rx="8" fill="#f3b74f"/></svg>`;

const deskEls = [];
function ensureDesks(n) {
  while (deskEls.length < n) {
    const i = deskEls.length;
    const el = document.createElement('div');
    el.className = 'desk';
    el.dataset.desk = i;
    // Silla y algún objeto (taza o planta) para que los escritorios no sean todos iguales.
    const item = i % 3 === 1 ? '<i class="mug"></i>' : i % 4 === 2 ? '<i class="dplant"></i>' : '';
    el.innerHTML = `<i class="ctxm" aria-hidden="true"><b></b></i><i class="chair"></i><div class="mon"><i></i></div><div class="mon m2"><i></i></div><div class="kb"></div><i class="mpad"></i><i class="mouse"></i>${item}<i class="clutter"></i><i class="lampg" aria-hidden="true"></i><i class="dnote" aria-hidden="true"></i><div class="paper" hidden></div><span class="dn">${String(i + 1).padStart(2, '0')}</span>`;
    MAP.appendChild(el);
    deskEls.push({ el, paper: el.querySelector('.paper') });
  }
}

function setRect(el, x, y, w, h) {
  if (!el) return;
  el.style.left = x + '%';
  el.style.top = py(y);
  if (w != null) el.style.width = w + '%';
  if (h != null) el.style.height = (h / geo.H) * 100 + '%';
}

const samePlace = (p, q) => p.type === q.type && p.idx === q.idx && p.room === q.room && p.slot === q.slot;

// Calcula filas de escritorios y salas de rutina (incoming = lugar que se va a ocupar) y, si cambian,
// recoloca salas, escritorios y robots con la nueva altura del mapa.
function layout(incoming) {
  // incoming reserva lugar (filas, asientos) pero no se cuenta como robot: si no, el que llega sale dos veces en «N robots».
  const counted = new Set([...st.robots.values()].map(a => a.data.place));
  const places = [...counted];
  if (incoming) places.push(incoming);
  const used = places.filter(p => p.type !== 'room').map(p => p.idx);
  const rows = Math.max(BASE_ROWS, Math.ceil((Math.max(-1, ...used) + 1) / COLS));
  const byRoom = new Map(),
    v = st.view;
  for (const p of places) {
    if (p.type !== 'room') continue;
    if (v ? p.sala !== v : p.sala) continue; // en la oficina no se dibujan las salas; dentro de una, solo esa
    const r = byRoom.get(p.room) || { id: p.room, name: p.name, sala: p.sala, maxSlot: -1, n: 0 };
    r.maxSlot = Math.max(r.maxSlot, p.slot);
    if (counted.has(p)) r.n++;
    byRoom.set(p.room, r);
  }
  if (v && !byRoom.has(`sala-${v}`))
    byRoom.set(`sala-${v}`, { id: `sala-${v}`, name: st.salas.find(s => s.id === v)?.name || '', sala: v, maxSlot: -1, n: 0 });
  // Orden estable: una sala no cambia de lugar mientras exista.
  geo.roomOrder = [...geo.roomOrder.filter(id => byRoom.has(id)), ...[...byRoom.keys()].filter(id => !geo.roomOrder.includes(id))];
  const specs = geo.roomOrder.map(id => ({
    ...byRoom.get(id),
    seatRows: Math.max(1, Math.ceil((byRoom.get(id).maxSlot + 1) / ROOM_COLS))
  }));
  for (const sp of specs) {
    const re = geo.roomEls.get(sp.id);
    if (re) {
      re.el.querySelector('small').textContent = `${sp.n} robot${sp.n === 1 ? '' : 's'}`;
      re.el.querySelector('.sala-empty')?.toggleAttribute('hidden', sp.n > 0);
    }
  }
  const sig =
    (v ? v + '@' + Math.round((MAP.clientWidth || 0) / 40) : '') +
    '|' +
    rows +
    '|' +
    specs.map(sp => sp.id + ':' + (v ? sp.maxSlot : sp.seatRows)).join(',');
  if (sig === geo.sig) return;
  geo.sig = sig;
  geo.rows = rows;
  // Dentro de una sala el mapa es solo ella, a todo lo ancho; en la oficina, las de rutina debajo de los escritorios.
  let y = 43 + rows * ROW_H;
  if (v) salaGeom(Math.max(0, ...specs.map(sp => sp.maxSlot + 1)));
  geo.rooms = v
    ? specs.map(sp => ({ ...sp, top: 2, boxH: SV.H - 4, h: SV.H - 2 }))
    : specs.map(sp => {
        const boxH = 6 + sp.seatRows * SEAT_ROW_H;
        const r = { ...sp, top: y, boxH, h: boxH + 6 };
        y += r.h;
        return r;
      });
  geo.H = v ? SV.H : y + 5;
  MAP.classList.toggle('sala-view', !!v);
  const e = extra();
  MAP.style.aspectRatio = `16 / ${((10 * geo.H) / 100).toFixed(3)}`;
  setRect($('.room.r-break'), 2, 3, 52, 30);
  setRect($('.deco.sofa'), 4.5, 7.5, 15, 5);
  setRect($('.deco.sofa.s2'), 27, 7.5, 15, 5);
  setRect($('.deco.btable'), 9.5, 21, 12, 4);
  setRect($('.deco.bcoffee'), 49, 6.5, 2.8, 8);
  setRect($('.deco.pingpong'), 32, 20.5, 15, 4.5);
  setRect($('.room.r-cron'), 56, 3, 20, 30);
  setRect($('.room.r-war'), 78, 3, 20, 30); // como Rutinas: las salas se ven en lista (con scroll si son muchas)
  setRect($('#room-open'), 2, 38, 74, 59 + e);
  setRect($('#room-coord'), 78, 38, 20, 59 + e); // tu escritorio, a la par de los escritorios
  setRect($('#inbox'), 80, 76 + e, 7, 8);
  setRect($('#alarm'), 88.1, 77 + e, 2.2, null);
  setRect($('#me'), 91, 74 + e, 5, 11);
  setRect($('#eotm'), 80.2, 44, 11, 20.5); // cuadro del empleado de la semana, colgado arriba en tu escritorio
  setRect($('#qclock'), 92.3, 45.5, 5.2, 12); // reloj de la cuota semanal
  setRect($('.door'), 36, 97.2 + e, 8, 2.8);
  document.querySelectorAll('.win').forEach((w, k) => setRect(w, 18.6 + k * 18, 37.1, 4.2, 1.8)); // en los huecos entre escritorios
  setRect($('.deco.plant.p1'), 2.9, 27.8, 1.7, 4.5);
  setRect($('.deco.coffee'), 54.25, 27.5, 1.5, 5.5);
  setRect($('.deco.plant.p2'), 76.15, 28.5, 1.7, 4.5);
  placeGrowth(e);
  setRect($('#trophies'), 79.6, 89.2 + e); // repisa al pie de tu escritorio, debajo de la bandeja
  setRect($('#archivador'), 87.5, 80.8 + e, 2.8, 8); // archivador: robots despedidos con su resumen
  ensureDesks(rows * COLS);
  // Mesas un poco más chicas que su lugar (13 × 10): mismo centro y mismo borde de abajo, así los robots no se mueven.
  deskEls.forEach((d, i) => {
    const p = deskPos(i);
    setRect(d.el, p.x + 1, p.y + 1.5, null, 8.5);
    d.el.hidden = i >= rows * COLS;
  });
  drawRooms();
  for (const x of brk.bots.values()) if (!x.el.classList.contains('moving')) placeAt(x, x.pos);
  for (const a of st.robots.values()) {
    if (a.el.classList.contains('moving')) {
      a.el.style.transition = 'none';
      a.el.style.top = py(a.pos.y);
      void a.el.offsetWidth;
    } else placeAt(a, restPos(a));
    paintSubs(a);
    paint(a);
  }
}

function drawRooms() {
  for (const [id, re] of geo.roomEls) {
    if (geo.rooms.some(r => r.id === id)) continue;
    re.el.remove();
    re.seats.forEach(x => x.el.remove());
    re.props?.forEach(x => x.remove());
    geo.roomEls.delete(id);
  }
  for (const r of geo.rooms) {
    let re = geo.roomEls.get(r.id);
    if (!re) {
      const el = document.createElement('div');
      // Sala temporal de una rutina o de una sala de épica: el clic abre su panel.
      if (r.sala && st.view) {
        // dentro de la sala: cabecera con la salida, tablero, mesa común y su puerta
        const s = st.salas.find(x => x.id === r.sala);
        el.className = 'room r-rt r-sala sv in-sala';
        if (Number.isInteger(s?.color)) el.style.setProperty('--sala-c', COLORS[s.color % COLORS.length]); // el piso, del color de quien la armó
        el.innerHTML = `<div class="room-h"><button type="button" class="btn sm" data-sala-exit title="Volver a la oficina (Esc)">← Oficina</button><span title="Sala «${esc(r.name)}»">Sala «${esc(r.name)}»</span><small>${r.n} robot${r.n === 1 ? '' : 's'}</small><button type="button" class="btn sm out-need" data-out-need hidden></button><button type="button" class="btn sm" data-sala-dismiss="${esc(r.sala)}" hidden title="Da de baja (sin resumen) a los hijos que ya entregaron su resultado. Dos clics.">👋 Despedir a los que entregaron</button><button type="button" class="btn sm" data-sala-open="${esc(r.sala)}">Hilo y contexto</button></div>`;
        MAP.appendChild(el);
        const prop = (cls, html, x, y0, w, h) => {
          const p = document.createElement('div');
          p.className = `sv ${cls}`;
          p.innerHTML = html;
          MAP.appendChild(p);
          setRect(p, x, y0, w, h);
          return p;
        };
        const board = prop('sala-board', '', SV.board.x, SV.board.y, SV.board.w, SV.board.h);
        const table = prop(
          'sala-table',
          `<span>${r.n ? '' : 'Nadie trabajando aquí ahora'}</span>`,
          SV.table.x,
          SV.table.y,
          SV.table.w,
          SV.table.h
        );
        table.style.zIndex = Math.round((SV.table.y + SV.table.h / 2) * 10); // los de arriba quedan detrás de la mesa y los de abajo delante
        const dr = prop('sala-door', '<span>PUERTA</span>', SV.door.x - 4, SV.H - 4.2, 8, 2.6);
        // Q · Pizarra en la pared, sobre la mesa: cada mensaje del hilo deja un garabato que se dibuja solo.
        const wb = prop(
          'sala-wb',
          '<b>PIZARRA</b><svg viewBox="0 0 320 60" preserveAspectRatio="none" aria-hidden="true"></svg>',
          51,
          9.9,
          34,
          7.6
        );
        geo.roomEls.set(r.id, (re = { el, seats: [], props: [board, table, dr, wb] }));
        renderBoard();
        renderOutsideNeed();
      } else {
        el.className = 'room r-rt';
        el.dataset.room = 'cron';
        el.innerHTML = `<div class="room-h"><span>Rutina «${esc(r.name)}»</span><small>${r.n} robot${r.n === 1 ? '' : 's'}</small></div>`;
      }
      if (!re) {
        MAP.appendChild(el);
        geo.roomEls.set(r.id, (re = { el, seats: [] }));
      }
    }
    if (re.props) {
      setRect(re.el, 1, r.top + 1, 98, r.boxH);
      const round = SV.mode === 'round';
      re.el.classList.toggle('round', round);
      re.props[1].classList.toggle('round', round);
      if (round) {
        setRect(re.props[1], (RT.cx - RT.a) / RT.xU, (RT.cy - RT.b) / RT.yU, (2 * RT.a) / RT.xU, (2 * RT.b) / RT.yU);
        re.props[1].style.zIndex = roundTableZ();
      } // solo los de arriba quedan detrás; los de los costados, delante
      else {
        setRect(re.props[1], SV.table.x, SV.table.y, SV.table.w, SV.table.h);
        re.props[1].style.zIndex = Math.round((SV.table.y + SV.table.h / 2) * 10);
      }
      setRect(re.props[0], SV.board.x, SV.board.y, SV.board.w, SV.board.h); // el tablero y la puerta siguen el alto de la sala
      setRect(re.props[2], SV.door.x - 4, SV.H - 4.2, 8, 2.6);
      re.props[1].querySelector('span').textContent = r.n ? '' : 'Nadie trabajando aquí ahora';
      // Un portátil por puesto, sobre la mesa frente a su robot: aparece cuando llega y se sienta, y se va con él.
      // Hace de «escritorio» del robot (deskFor): la pantalla se enciende cuando trabaja, como en los escritorios.
      const n = Math.max(6, r.maxSlot + 1),
        tz = Math.round((SV.table.y + SV.table.h / 2) * 10) + 1;
      while (re.seats.length < n) {
        const el = document.createElement('div');
        el.className = 'sv laptop';
        el.innerHTML = '<i class="lid"></i><i class="kbd"></i><div class="paper" hidden></div>';
        MAP.appendChild(el);
        re.seats.push({ el, paper: el.querySelector('.paper') });
      }
      while (re.seats.length > n) re.seats.pop().el.remove();
      // Mesa: arriba se ve la tapa por detrás (el robot la mira desde el otro lado); abajo, la pantalla.
      re.seats.forEach((d, j) => {
        const p = tableSeat(j);
        if (round) {
          const L = RT.laps[j];
          if (!L) return;
          d.el.classList.toggle('front', L.front);
          setRect(d.el, L.x - 1.5, L.y - 1.5, 3, 2.9);
          d.el.style.zIndex = roundTableZ() + 1;
          return;
        }
        d.el.classList.toggle('front', j % 2 === 1);
        setRect(d.el, p.x - 1.5, j % 2 ? SV.table.y + SV.table.h - 4 : SV.table.y + 0.8, 3, 2.9);
        d.el.style.zIndex = tz;
      });
      syncLaptops();
      continue;
    }
    setRect(re.el, ROOM_X - 1, r.top + 1, ROOM_W + 2, r.boxH);
    while (re.seats.length < r.seatRows * ROOM_COLS) {
      const el = document.createElement('div');
      el.className = 'rdesk';
      el.innerHTML = '<div class="paper" hidden></div>';
      MAP.appendChild(el);
      re.seats.push({ el, paper: el.firstChild });
    }
    while (re.seats.length > r.seatRows * ROOM_COLS) re.seats.pop().el.remove();
    re.seats.forEach((d, j) => {
      const p = roomSeat(r, j);
      setRect(d.el, p.x - 3.5, p.y - 15, 7, 4);
    });
  }
}

const roomSeat = (r, j) => ({
  x: ROOM_X + (ROOM_W * ((j % ROOM_COLS) + 0.5)) / ROOM_COLS,
  y: r.top + 1 + 7 + Math.floor(j / ROOM_COLS) * SEAT_ROW_H + 15
});
function seatOf(place) {
  if (!place) return door();
  if (place.sala && !st.view) return salaDoor(place); // en la oficina su sala no se dibuja: camina al cuarto de salas y ahí desaparece
  if (place.sala && place.sala === st.view) return tableSeat(place.slot);
  if (place.type === 'room') {
    const r = geo.rooms.find(x => x.id === place.room);
    return r ? roomSeat(r, place.slot) : door();
  }
  const d = deskPos(place.idx);
  return { x: d.x + 6.5, y: d.y + 19 };
}
function deskFor(place) {
  if (place.type !== 'room') return deskEls[place.idx];
  return geo.roomEls.get(place.room)?.seats[place.slot];
}
// Fila frente a tu escritorio para los que llevan 3 min esperando respuesta; si se llena, sigue por el pasillo derecho.
const queuePos = k => (k < 3 ? { x: 94 - k * 6.4, y: 95 + extra() } : { x: RIGHT_LANE, y: 95 + extra() - (k - 2) * 8 });
const restPos = a => (a.queueSlot != null && !st.view ? queuePos(a.queueSlot) : seatOf(a.data.place));

/* ---------- vista de una sala ---------- */
// Geometría de la sala por dentro (unidades del mapa): tablero a la izquierda, mesa común a la derecha con los robots
// alrededor (mitad arriba, mitad abajo), pasillos por arriba, abajo y a la derecha de la mesa, y la puerta abajo.
const SV = {
  H: 74,
  board: { x: 2.5, y: 10, w: 40, h: 61 },
  table: { x: 47, y: 35, w: 42, h: 11 },
  door: { x: 84, y: 71.5 },
  aisleTop: 20,
  aisleBottom: 64,
  aisleRight: 94,
  mode: 'mesa',
  n: 6
};
// Hasta 6 robots, mesa común. Desde 7, mesa redonda grande (ovalada): los robots alrededor, a la misma distancia uno de
// otro; los de arriba quedan detrás del borde y los de abajo delante. Si son muchos, la mesa crece hacia abajo.
// Los robots miden lo mismo en píxeles en cualquier pantalla: la mesa se calcula en píxeles con el ancho real del mapa.
const MESA_MAX = 6,
  ROBOT_PX = 64,
  NAME_PX = 18,
  SIGN_PX = 24,
  SEAT_GAP_PX = 104; // SEAT_GAP: distancia entre vecinos
const RT = { cx: 0, cy: 0, a: 0, b: 0, seats: [], laps: [], xU: 10, yU: 6.25 };
function roundSeats(n, a, b, cx, cy) {
  // en px: n puestos a igual distancia por el contorno, desde arriba al centro
  const pt = t => {
    const c = Math.cos(t),
      s = Math.sin(t);
    return { x: cx + (a + 34) * c, y: cy + b * s + (s < 0 ? (24 + 30 * Math.abs(c)) * s : 50 * s), t };
  }; // arriba: de pie tras el borde con el nombre a la vista (más arriba en las diagonales)
  const N = 720,
    pts = Array.from({ length: N + 1 }, (_, i) => pt(-Math.PI / 2 + (2 * Math.PI * i) / N));
  const acc = [0];
  for (let i = 1; i <= N; i++) acc.push(acc[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  const total = acc[N],
    out = [];
  for (let k = 0, i = 0; k < n; k++) {
    const want = (total * k) / n;
    while (acc[i] < want) i++;
    out.push(pts[i]);
  }
  return { total, out };
}
function salaGeom(n) {
  SV.n = Math.max(MESA_MAX, n);
  SV.mode = n > MESA_MAX ? 'round' : 'mesa';
  const W = MAP.clientWidth || 1000,
    xU = W / 100,
    yU = W * 0.00625; // px por unidad (el mapa es 16:10 por cada 100 de alto)
  RT.xU = xU;
  RT.yU = yU;
  let gapPx = (SV.table.w / Math.ceil(SV.n / 2)) * xU;
  SV.H = 74;
  if (SV.mode === 'round') {
    const left = 44.5 * xU,
      right = 94 * xU,
      a = Math.max(70, (right - left) / 2 - 34 - 78),
      cx = (left + right) / 2; // margen: nombre y cartel no pisan el tablero
    let b = 46,
      r;
    for (; b < 600; b += 6) {
      r = roundSeats(n, a, b, 0, 0);
      if (r.total / n >= SEAT_GAP_PX) break;
    }
    const cy = 19 * yU + SIGN_PX + ROBOT_PX + b + 30; // los de arriba, bajo la pizarra
    Object.assign(RT, { a, b, cx, cy });
    RT.seats = roundSeats(n, a, b, cx, cy).out.map(p => ({ x: p.x / xU, y: p.y / yU, top: Math.sin(p.t) < -0.2 }));
    RT.laps = RT.seats.map((p, k) => {
      const t = roundSeats(n, a, b, cx, cy).out[k].t;
      return { x: (cx + a * 0.8 * Math.cos(t)) / xU, y: (cy + b * 0.8 * Math.sin(t)) / yU, front: Math.sin(t) > 0.2 };
    });
    gapPx = r.total / n;
    SV.H = Math.max(74, (cy + b + 50 + NAME_PX + 14) / yU + 6);
  }
  // Ancho de los nombres y de los globos: lo que mide un puesto.
  MAP.style.setProperty('--sala-nw', Math.max(48, Math.round(Math.min(gapPx, 140) - 8)) + 'px');
  MAP.style.setProperty('--sala-bw', Math.max(56, Math.round(Math.min(gapPx, 214) - 14)) + 'px');
  SV.board.h = SV.H - 13;
  SV.door.y = SV.H - 2.5;
  SV.aisleBottom = SV.H - 10;
}
const roundTableZ = () => Math.round(((RT.cy - RT.b * 0.8) / RT.yU) * 10);
function tableSeat(k = 0) {
  if (SV.mode === 'round') return RT.seats[k] || RT.seats[RT.seats.length - 1] || { x: 70, y: 40 };
  const n = Math.max(6, (geo.rooms[0]?.maxSlot ?? 0) + 1),
    per = Math.ceil(n / 2),
    col = Math.floor(k / 2);
  return { x: SV.table.x + (SV.table.w * (col + 0.5)) / per, y: k % 2 ? SV.table.y + SV.table.h + 12 : SV.table.y - 4 }; // los de arriba, detrás del borde de la mesa con el nombre a la vista
}
const salaEntry = () => ({ ...SV.door });
function syncLaptops() {
  const re = st.view && geo.roomEls.get(`sala-${st.view}`);
  if (!re?.props) return;
  const bots = [...st.robots.values()].filter(x => x.data.place.sala === st.view);
  re.seats.forEach((d, j) => {
    const a = bots.find(x => x.data.place.slot === j);
    d.el.classList.toggle('placed', !!a && !a.el.classList.contains('moving'));
  });
}
// Por los pasillos de la sala: a la fila de abajo directo; a la de arriba rodeando la mesa por la derecha.
function salaRoute(f, t) {
  if (SV.mode === 'round') {
    // rodeando la mesa por fuera, por el lado más corto
    const ang = p => Math.atan2(p.y * RT.yU - RT.cy, p.x * RT.xU - RT.cx);
    const A = RT.a + 34 + 70,
      B = RT.b + 90;
    const out = t => ({
      x: Math.max(44, Math.min(95, (RT.cx + A * Math.cos(t)) / RT.xU)),
      y: Math.max(19, Math.min(SV.H - 3, (RT.cy + B * Math.sin(t)) / RT.yU))
    });
    let t0 = ang(f),
      t1 = ang(t),
      d = t1 - t0;
    if (d > Math.PI) d -= 2 * Math.PI;
    if (d < -Math.PI) d += 2 * Math.PI;
    const steps = Math.max(1, Math.ceil(Math.abs(d) / 0.35)),
      pts = [];
    for (let i = 0; i <= steps; i++) pts.push(out(t0 + (d * i) / steps));
    return [...pts, t];
  }
  const up = p => p.y < SV.table.y;
  const rowY = p => (up(p) ? SV.aisleTop : SV.aisleBottom);
  const pts = [{ x: f.x, y: rowY(f) }];
  if (up(f) !== up(t)) pts.push({ x: SV.aisleRight, y: rowY(f) }, { x: SV.aisleRight, y: rowY(t) });
  pts.push({ x: t.x, y: rowY(t) }, t);
  return pts;
}
// Tablero de la sala: por qué se creó, su CONTEXT.md y las últimas notas del hilo.
const board = { ctx: '', at: 0, for: null, loading: false, noteFor: null, whyOpen: false, depFor: null };
async function loadBoard(force) {
  const s = st.salas.find(x => x.id === st.view);
  if (!s || board.loading || (!force && board.for === s.id && Date.now() - board.at < 15000)) return renderBoard();
  board.loading = true;
  try {
    const doc = await api('GET', `/api/doc?path=${encodeURIComponent(s.context)}`);
    board.ctx = doc.text || '';
  } catch {
    board.ctx = '';
  }
  board.for = s.id;
  board.at = Date.now();
  board.loading = false;
  renderBoard();
}
function renderBoard() {
  const el = MAP.querySelector('.sala-board'),
    s = st.salas.find(x => x.id === st.view);
  if (!el || !s) return;
  if (board.for !== s.id && !board.loading) setTimeout(() => loadBoard(true)); // al recargar ya dentro de la sala
  const why = s.purpose || (s.key ? `Sala de la épica ${s.key}` : 'Sala de épica creada desde la oficina');
  // Botón «Despedir a los que entregaron» de la cabecera: solo si hay hijos que ya entregaron.
  const ready = [...st.robots.values()].filter(a => a.data.place.sala === s.id && a.data.parent && a.data.reported).length;
  const db = MAP.querySelector('[data-sala-dismiss]');
  if (db && !db.classList.contains('armed')) {
    db.hidden = !ready;
    db.textContent = `👋 Despedir a los que entregaron (${ready})`;
  }
  const ctx = board.for === s.id ? board.ctx.replace(/^# .*\n+/, '').replace(/^_Sala creada por la oficina.*_\n+/m, '') : '';
  // Corcho: tus notas (📌, solo para ti) y las últimas 8 del hilo, en una franja que se desplaza: ninguna queda tapada.
  const mine = s.notes || [],
    base = Math.max(0, s.thread.length - 8);
  const notes = s.thread
    .slice(base)
    .map((m, k) => ({ m, i: base + k }))
    .reverse();
  const keep = el.querySelector('.sb-ctx')?.scrollTop || 0,
    keepX = el.querySelector('.sb-notes')?.scrollLeft || 0;
  // Si estabas escribiendo una nota, el tablero se redibuja sin perder lo escrito ni el foco.
  const ta = el.querySelector('.sb-nf textarea'),
    draft = ta ? { v: ta.value, f: document.activeElement === ta, a: ta.selectionStart, b: ta.selectionEnd } : null;
  const prog = salaProgress(s);
  el.innerHTML = `<div class="sb-head"><b>📋 Tablero</b><span><button type="button" class="btn sm ghost" data-sala-note-add ${mine.length >= 4 ? 'disabled title="Ya hay 4 notas tuyas: quita una con su ×"' : 'title="Pega una nota tuya en el tablero: es solo para ti, no se manda a los robots ni gasta tokens"'}>📌 Nota</button> <button type="button" class="btn sm ghost" data-sala-ctx title="Abrir CONTEXT.md completo">Ver todo</button></span></div>
    <div class="sb-why${board.whyOpen ? ' open' : ''}" data-sala-why title="${board.whyOpen ? 'Clic para resumir' : `Por qué se creó esta sala. Clic para verlo completo.`}">${esc(why)}</div>
    ${s.spend && !s.roster?.length ? spendHtml(s) : ''}
    ${board.noteFor === s.id ? `<form class="sb-nf" data-sala-note-form><textarea rows="2" maxlength="240" placeholder="Tu nota (Enter pega, Esc cancela)…"></textarea><button class="btn sm">Pegar</button></form>` : ''}
    ${s.roster?.length ? `<div class="sb-team"><b>Reparto${prog ? ` · ${prog.ok}/${prog.n} entregaron` : ''}</b>${s.spend ? spendHtml(s) : ''}${prog ? `<i class="sb-prog${prog.ok === prog.n ? ' full' : ''}" style="--p:${Math.round((prog.ok * 100) / prog.n)}%"></i>` : ''}<span class="sb-chips">${s.roster.map(memChip).join('')}</span>${depBlock(s)}</div>` : ''}
    <div class="sb-ctx md-chat">${ctx.trim() ? mdHtml(ctx) : '<p class="muted">El contexto se carga…</p>'}</div>
    <div class="sb-notes">${mine.map(n => `<div class="sb-note mine" title="Tu nota (${esc(fmtWhen(n.at, { hour: 'numeric' }))}): solo la ves tú"><button type="button" class="sb-nx" data-sala-note-del="${esc(n.id)}" title="Quitar la nota" aria-label="Quitar la nota">×</button><b>📌 Tú</b>${esc(n.text)}</div>`).join('')}${notes.length ? notes.map(({ m, i }, k) => `<div class="sb-note n${k % 4}${salaMail.flying.has(m.id) ? ' arriving' : ''}" data-mid="${esc(m.id)}" data-note-i="${i}" role="button" tabindex="0" title="${esc(`${m.from} · ${hhmm(m.at)}\n${plainMd(m.text).slice(0, 500)}${m.text.length > 500 ? '…' : ''}\n\nClic: abrir el mensaje completo en el hilo`)}"><b>${esc(m.from)}</b>${esc(plainMd(m.text).slice(0, 160))}</div>`).join('') : mine.length ? '' : '<div class="sb-note n0"><b>Notas</b>Lo que cada robot diga al cerrar su turno se pega aquí.</div>'}</div>`;
  el.querySelector('.sb-ctx').scrollTop = keep;
  el.querySelector('.sb-notes').scrollLeft = keepX;
  const nta = el.querySelector('.sb-nf textarea');
  if (nta && draft) {
    nta.value = draft.v;
    if (draft.f) {
      nta.focus();
      nta.setSelectionRange(draft.a, draft.b);
    }
  } else if (nta && !draft) nta.focus();
  drawDoodles(s);
  flyNewMail(s);
}
// Dependencies inside the room: «⏸ espera a A» on the waiting member and «⏳ N lo esperan» on the one being waited for.
const memChip = e => {
  const wait = e.waits?.length
    ? `<em class="sb-dep" title="Espera la entrega de ${esc(e.waits.join(', '))}">⏸ espera a ${esc(e.waits.join(', '))}</em>`
    : '';
  const blk = e.waitedBy
    ? `<em class="sb-blk" title="Cuello de botella: ${e.waitedBy} robot${e.waitedBy === 1 ? '' : 's'} espera${e.waitedBy === 1 ? '' : 'n'} su entrega">⏳ ${e.waitedBy} lo ${e.waitedBy === 1 ? 'espera' : 'esperan'}</em>`
    : '';
  return `<span class="sb-mem st-${esc(e.state.replace(/\s+/g, '-'))}${e.waits?.length ? ' is-waiting' : ''}${e.waitedBy ? ' is-blocker' : ''}" title="${esc(`${e.name}${e.title ? ' · ' + e.title : ''} · ${e.state}`)}"><i class="sb-dot"></i><code>${esc(e.name)}</code>${wait}${blk}</span>`;
};
// Editor opened from the board: for each member, toggle buttons for the members it waits for.
function depBlock(s) {
  const kids = s.roster.filter(e => !e.owner && e.state !== 'no se lanzó');
  if (kids.length < 2) return '';
  const open = board.depFor === s.id;
  const rows = open
    ? kids
        .map(
          b =>
            `<div class="sb-dr"><code>${esc(b.name)}</code> espera a ${kids
              .filter(a => a.name !== b.name)
              .map(
                a =>
                  `<button type="button" class="btn sm sb-dt${(b.espera || []).includes(a.name) ? ' on' : ''}" data-sala-dep="${esc(b.name)}" data-sala-dep-on="${esc(a.name)}" aria-pressed="${(b.espera || []).includes(a.name)}">${esc(a.name)}</button>`
              )
              .join('')}</div>`
        )
        .join('')
    : '';
  return `<button type="button" class="btn sm ghost sb-depbtn" data-sala-dep-open title="Marca quién espera la entrega de quién. Solo informa: no detiene a nadie.">⏸ Dependencias</button>${rows ? `<div class="sb-deps">${rows}</div>` : ''}`;
}
const spendHtml = s =>
  `<span class="sb-spend" title="Gasto del equipo: lo que gastaron todos los que pasaron por esta sala (padre e hijos, también los que ya se fueron, con sus subagentes) desde que se armó. Entrada + salida + caché escrita, como los KPI. Se recalcula cada minuto y no gasta cuota.">💸 <b>${fmtTok(s.spend)}</b></span>`;
// 3 · Avance del equipo: cuántos hijos ya entregaron su resultado (aunque después los hayas despedido).
function salaProgress(s) {
  const kids = (s.roster || []).filter(e => !e.owner && e.state !== 'no se lanzó');
  return kids.length ? { n: kids.length, ok: kids.filter(e => e.delivered).length } : null;
}
// 6 · Mensajes que viajan: cuando alguien escribe en el hilo de la sala que estás viendo, un sobrecito vuela de él (o
// de la puerta, si escribiste tú o ya no está) al corcho del tablero, y ahí aparece su post-it.
const salaMail = { seen: new Map(), flying: new Set() };
function flyNewMail(s) {
  const seen = salaMail.seen.get(s.id),
    ids = s.thread.map(m => m.id);
  salaMail.seen.set(s.id, new Set(ids));
  if (!seen) return; // primera vez que se dibuja esta sala: nada «nuevo» que volar
  const fresh = s.thread.filter(m => !seen.has(m.id)).slice(-3);
  if (!fresh.length || document.hidden || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const mr = MAP.getBoundingClientRect();
  if (!mr.width) return;
  const pct = r => ({ x: ((r.left + r.width / 2 - mr.left) * 100) / mr.width, y: ((r.top + r.height / 2 - mr.top) * 100) / mr.height });
  fresh.forEach((m, i) => {
    const note = MAP.querySelector(`.sb-note[data-mid="${CSS.escape(m.id)}"]`);
    if (!note) return;
    const bot = st.robots.get(m.from),
      from = bot && !bot.el.classList.contains('offview') ? bot.el.querySelector('svg') || bot.el : MAP.querySelector('.sala-door');
    if (!from) return;
    const a = pct(from.getBoundingClientRect()),
      b = pct(MAP.querySelector(`.sb-note[data-mid="${CSS.escape(m.id)}"]`).getBoundingClientRect());
    const strip = note.parentElement; // la franja se corre para que se vea dónde aterriza
    if (strip && (note.offsetLeft < strip.scrollLeft || note.offsetLeft + note.offsetWidth > strip.scrollLeft + strip.clientWidth))
      strip.scrollLeft = note.offsetLeft - strip.offsetLeft - 4;
    salaMail.flying.add(m.id);
    note.classList.add('arriving');
    const env = document.createElement('div');
    env.className = 'sv sala-mail'; /* sv: en la vista de sala solo se ve lo que la lleva */
    env.textContent = '✉️';
    env.setAttribute('aria-hidden', 'true');
    env.style.left = a.x + '%';
    env.style.top = a.y + '%';
    MAP.appendChild(env);
    const mid = { left: (a.x + b.x) / 2 + '%', top: Math.min(a.y, b.y) - 12 + '%' };
    const anim = env.animate(
      [
        { left: a.x + '%', top: a.y + '%', transform: 'translate(-50%,-50%) scale(.6) rotate(-10deg)', opacity: 0 },
        { offset: 0.12, opacity: 1 },
        { ...mid, transform: 'translate(-50%,-50%) scale(1.15) rotate(8deg)', offset: 0.5 },
        { left: b.x + '%', top: b.y + '%', transform: 'translate(-50%,-50%) scale(.7) rotate(0)', opacity: 1 }
      ],
      { duration: 1100, delay: i * 350, easing: 'ease-in-out', fill: 'backwards' }
    );
    anim.onfinish = () => {
      env.remove();
      salaMail.flying.delete(m.id);
      const n = MAP.querySelector(`.sb-note[data-mid="${CSS.escape(m.id)}"]`);
      if (n) {
        n.classList.remove('arriving');
        n.classList.add('landed');
        setTimeout(() => n.classList.remove('landed'), 700);
      }
    };
  });
}
// Garabatos de la pizarra: uno por mensaje del hilo (los últimos 16), con la forma y el color que salen del id del
// mensaje (siempre el mismo dibujo para el mismo mensaje). Los nuevos se dibujan con una animación de trazo.
const wbDrawn = new Map(); // sala -> ids ya dibujados
function drawDoodles(s) {
  const svg = MAP.querySelector('.sala-wb svg');
  if (!svg) return;
  const msgs = s.thread.slice(-16),
    seen = wbDrawn.get(s.id) || new Set();
  const INK = ['#2c56a8', '#c24b58', '#2f8f5b', '#2a2620', '#b06a10'];
  const hash = t => {
    let h = 2166136261;
    for (const c of String(t)) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
    return h >>> 0;
  };
  const shapes = [
    (x, y, r) => `M${x - 14} ${y + 4}q5 -14 10 0t10 0t10 0`, // ola
    (x, y) => `M${x - 13} ${y - 8}h22v16h-22zM${x - 9} ${y - 3}h14M${x - 9} ${y + 2}h10`, // caja con renglones
    (x, y) => `M${x - 14} ${y + 6}L${x + 10} ${y - 6}M${x + 3} ${y - 8}l7 2l-2 7`, // flecha
    (x, y) => `M${x - 8} ${y}l5 6l11 -14`, // chulo
    (x, y) => `M${x} ${y - 10}l3 7h8l-6 5l2 8l-7 -4l-7 4l2 -8l-6 -5h8z`, // estrella
    (x, y) => `M${x + 11} ${y}a11 9 0 1 1 -1 -3`, // círculo
    (x, y) => `M${x - 14} ${y - 6}h18M${x - 14} ${y}h24M${x - 14} ${y + 6}h12`, // texto
    (x, y) => `M${x - 12} ${y + 8}l7 -10l6 6l6 -12l7 8` // gráfico
  ];
  svg.innerHTML = msgs
    .map((m, i) => {
      const h = hash(m.id || m.at),
        x = 22 + (i % 8) * 39 + (h % 7) - 3,
        y = 17 + Math.floor(i / 8) * 28 + ((h >>> 3) % 5) - 2;
      return `<path d="${shapes[h % shapes.length](x, y)}" stroke="${INK[(h >>> 5) % INK.length]}" pathLength="1" class="${seen.has(m.id) ? '' : 'new'}"><title>${esc(m.from)}: ${esc(plainMd(m.text).slice(0, 80))}</title></path>`;
    })
    .join('');
  for (const m of msgs) seen.add(m.id);
  wbDrawn.set(s.id, seen);
}
setInterval(() => {
  if (st.view) loadBoard();
}, 15000);
// Cambió el estado de alguien de la sala que estás viendo: el «Reparto» del tablero se refresca enseguida.
let boardSoon = 0;
function refreshBoardSoon() {
  clearTimeout(boardSoon);
  boardSoon = setTimeout(() => loadBoard(true), 1200);
}
// Punto dentro del cuarto «Salas de épica» donde entran y salen los robots de las salas (cada uno en su lugar).
const salaDoor = place => ({ x: 82 + ((place.slot || 0) % 4) * 4.5, y: 31 });
// Clic en una sala: el mapa pasa a mostrar solo esa sala con sus robots; «← Oficina» (o Esc) vuelve. Así la oficina
// principal no se llena con los equipos: ahí las salas solo salen en la lista de «Salas», con cuántos robots tienen.
const shownHere = d => (st.view ? d.place.sala === st.view : !d.place.sala);
function viewClass(a) {
  const show = shownHere(a.data) || (!!a.transit && !st.view); // en la oficina se ve mientras camina hacia o desde las salas
  for (const el of [a.el, ...a.subEls.values(), a.extraEl].filter(Boolean)) {
    el.classList.toggle('offview', !show);
    el.classList.toggle('sv', show && !!st.view);
  }
  // En la sala, los de la fila de abajo llevan el globo debajo del nombre: así no tapa la mesa ni los portátiles.
  a.el.classList.toggle('bub-below', !!st.view && SV.mode === 'mesa' && a.data.place?.sala === st.view && a.data.place.slot % 2 === 1);
  // Mesa redonda: en el lado izquierdo el cartel (LISTO, ?) va hacia afuera, así no tapa el nombre del vecino de arriba.
  a.el.classList.toggle(
    'sign-left',
    !!st.view && SV.mode === 'round' && a.data.place?.sala === st.view && tableSeat(a.data.place.slot).x * RT.xU < RT.cx
  );
}
function enterSala(id) {
  if (!st.salas.some(s => s.id === id)) return;
  if (st.selected) select(null);
  st.view = id;
  try {
    history.replaceState(null, '', '#sala=' + id);
  } catch {
    /* sin historial */
  }
  layout();
  loadBoard(true);
}
function leaveSala() {
  if (!st.view) return;
  st.view = null;
  try {
    history.replaceState(null, '', location.pathname + location.search);
  } catch {
    /* sin historial */
  }
  layout();
}

// Franjas horizontales del mapa: una por fila de escritorios y una por sala de rutina, cada una con su pasillo
// debajo (el de la ultima pasa junto a la puerta y la bandeja). Los pasillos verticales van entre columnas.
const AISLE_COLS = [20.5, 38.5, 56.5, 74];
function bands() {
  const b = [];
  for (let r = 0; r < geo.rows; r++) b.push({ top: 43 + r * ROW_H, aisle: 65 + r * ROW_H });
  for (const rm of geo.rooms) b.push({ top: rm.top, aisle: rm.top + rm.h - 2, room: true });
  b[b.length - 1].aisle = geo.H - 5;
  return b;
}
function bandIndex(b, y) {
  let i = 0;
  while (i < b.length - 1 && y >= b[i + 1].top) i++;
  return i;
}
function route(f, t) {
  if (Math.hypot(f.x - t.x, f.y - t.y) < 2) return [t];
  if (f.y > 37 && t.y > 37) {
    const b = bands(),
      i1 = bandIndex(b, f.y),
      i2 = bandIndex(b, t.y);
    const a1 = b[i1].aisle,
      a2 = b[i2].aisle;
    const pts = [{ x: f.x, y: a1 }];
    if (i1 !== i2) {
      // Las salas de rutina ocupan casi todo el ancho: para cruzarlas se usa el pasillo derecho.
      const crossesRoom = b.slice(Math.min(i1, i2) + 1, Math.max(i1, i2) + 1).some(x => x.room);
      const mid = (f.x + t.x) / 2;
      const vx = crossesRoom ? RIGHT_LANE : AISLE_COLS.reduce((best, x) => (Math.abs(x - mid) < Math.abs(best - mid) ? x : best));
      pts.push({ x: vx, y: a1 }, { x: vx, y: a2 });
    }
    pts.push({ x: t.x, y: a2 }, t);
    return pts.filter((p, i) =>
      i === 0 ? Math.hypot(p.x - f.x, p.y - f.y) > 0.3 : Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y) > 0.3
    );
  }
  // Dentro de una misma sala de arriba (p. ej. la de descanso): directo.
  if (f.y <= 37 && t.y <= 37 && Math.abs(f.x - t.x) < 24 && sameTopRoom(f.x, t.x)) return [t];
  // De la zona de escritorios a las salas de arriba (o al revés): por su pasillo, luego un pasillo vertical
  // (el derecho si hay salas de rutina en medio) y después el pasillo superior.
  if (f.y > 37 || t.y > 37) {
    const low = f.y > 37 ? f : t,
      high = f.y > 37 ? t : f;
    const b = bands(),
      i = bandIndex(b, low.y);
    const vx = b.slice(0, i + 1).some(x => x.room)
      ? RIGHT_LANE
      : AISLE_COLS.reduce((best, x) => (Math.abs(x - low.x) < Math.abs(best - low.x) ? x : best));
    const pts = [{ x: low.x, y: b[i].aisle }, { x: vx, y: b[i].aisle }, { x: vx, y: CY }, { x: high.x, y: CY }, high];
    return f.y > 37 ? pts : [...pts.reverse().slice(1), t];
  }
  // Fuera de la zona de escritorios (salas de arriba): pasillo superior.
  const fr = f.x > 76.5,
    tr = t.x > 76.5;
  if (!fr && !tr) return [{ x: f.x, y: CY }, { x: t.x, y: CY }, t];
  if (!fr && tr) return [{ x: f.x, y: CY }, { x: CX, y: CY }, { x: CX, y: t.y }, t];
  if (fr && !tr) return [{ x: CX, y: f.y }, { x: CX, y: CY }, { x: t.x, y: CY }, t];
  return [{ x: CX, y: f.y }, { x: CX, y: t.y }, t];
}
const TOP_ROOMS = [
  [2, 54],
  [56, 76],
  [78, 98]
];
const sameTopRoom = (x1, x2) => TOP_ROOMS.some(([l, r]) => x1 >= l && x1 <= r && x2 >= l && x2 <= r);
function placeAt(a, p) {
  a.el.style.transition = 'none';
  a.el.style.left = p.x + '%';
  a.el.style.top = py(p.y);
  a.el.style.zIndex = Math.round(p.y * 10);
  a.pos = { ...p };
  void a.el.offsetWidth; // fija la posicion inicial antes de que empiece una transicion
}
async function walkTo(a, dest) {
  if (!a.data) {
    if (st.view) placeAt(a, dest);
    else await walkSteps(a, dest);
    return;
  } // los de la sala de descanso no tienen puesto ni sala
  if (st.view && !shownHere(a.data)) {
    placeAt(a, dest);
    return;
  } // dentro de una sala, los de afuera no se ven
  a.transit = true;
  viewClass(a);
  try {
    await walkSteps(a, dest);
  } finally {
    a.transit = false;
    viewClass(a);
  }
}
// Un soplo de la estela donde está ahora el robot (en plena transición: getComputedStyle da la posición actual).
function dropTrail(a) {
  if (!a.el.isConnected || a.el.classList.contains('offview')) return;
  const cs = getComputedStyle(a.el),
    i = document.createElement('i');
  i.className = Math.random() < 0.35 ? 'trail spark' : 'trail';
  i.style.left = cs.left;
  i.style.top = cs.top;
  i.style.zIndex = Math.max(1, (parseInt(a.el.style.zIndex) || 500) - 1);
  i.style.setProperty('--dx', `${(Math.random() * 10 - 5).toFixed(1)}px`);
  MAP.appendChild(i);
  setTimeout(() => i.remove(), 900);
}
async function walkSteps(a, dest) {
  a.el.classList.add('moving');
  // En la sala que estás viendo, el que llega trae su portátil en las manos (el que se va ya lleva su caja).
  a.el.classList.toggle('carry-laptop', !!st.view && a.data?.place?.sala === st.view && !a.el.classList.contains('leaving'));
  syncLaptops();
  // Los hijos flotantes dejan una estela de humo y chispas mientras se mueven (solo si se ven).
  const trail = a.el.classList.contains('flyer') && !a.el.classList.contains('offview') ? setInterval(() => dropTrail(a), 90) : 0;
  for (const p of (st.view ? salaRoute : route)(a.pos, dest)) {
    const ms = Math.max(200, Math.hypot(p.x - a.pos.x, p.y - a.pos.y) * 30);
    void a.el.offsetWidth; // sin este reflow el navegador junta el cambio y el robot "salta"
    a.el.style.transition = `left ${ms}ms linear, top ${ms}ms linear`;
    a.el.style.left = p.x + '%';
    a.el.style.top = py(p.y);
    a.el.style.zIndex = Math.round(Math.max(p.y, a.pos.y) * 10);
    a.el.dataset.dir = p.x < a.pos.x - 0.2 ? 'l' : p.x > a.pos.x + 0.2 ? 'r' : '';
    a.pos = { ...p };
    await new Promise(r => setTimeout(r, ms));
  }
  clearInterval(trail);
  a.el.classList.remove('moving', 'carry-laptop');
  syncLaptops();
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

// Si cambia el ancho de la ventana estando en una sala, la mesa redonda se recalcula (los robots miden lo mismo en px).
let salaResizeT = 0;
window.addEventListener('resize', () => {
  if (!st.view) return;
  clearTimeout(salaResizeT);
  salaResizeT = setTimeout(() => layout(), 250);
});
