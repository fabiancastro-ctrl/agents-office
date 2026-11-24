/* ---------- vida de la oficina: café y cartero ---------- */
// No gastan cuota: son solo animaciones de la página.

// M · Visita al café: un robot con LISTO (o en espera) hace más de 2 min va de vez en cuando a la cafetera de la sala de descanso
// con su taza y vuelve. Si le escribes (deja de estar LISTO) regresa enseguida. Uno a la vez, cada robot cada 12 min.
// In front of the pot (.deco.bcoffee, setRect x 32.4..35.2, y 16..24 in 02-mapa.js): move both together.
const COFFEE_SPOT = { x: 33.4, y: 27 };
const coffee = { last: new Map(), busy: false };
const quietMs = d => Date.now() - (Date.parse(d.lastEventAt || d.timeline?.at(-1)?.at || '') || Date.now()); // sin actividad desde
setInterval(() => {
  if (st.view || document.hidden || coffee.busy) return;
  const now = Date.now();
  const cand = [...st.robots.values()].filter(
    a =>
      a.data.state === 'done' &&
      !a.data.spawnReq &&
      a.data.place.type !== 'room' &&
      a.queueSlot == null &&
      !a.el.classList.contains('moving') &&
      !a.el.classList.contains('offview') &&
      quietMs(a.data) > 2 * 60e3 &&
      now - (coffee.last.get(a.data.name) || 0) > 12 * 60e3
  );
  if (!cand.length || Math.random() < 0.4) return;
  const a = cand[Math.floor(Math.random() * cand.length)];
  coffee.last.set(a.data.name, now);
  coffee.busy = true;
  queue(a, async () => {
    try {
      a.el.classList.add('coffee');
      await walkTo(a, { x: COFFEE_SPOT.x + (Math.random() * 1.2 - 0.6), y: COFFEE_SPOT.y });
      for (let t = 0; t < 12 && a.data.state === 'done' && !st.view; t++) await new Promise(r => setTimeout(r, 500));
      if (st.robots.get(a.data.name) === a) await walkTo(a, restPos(a));
    } finally {
      a.el.classList.remove('coffee');
      coffee.busy = false;
    }
  });
}, 20000);

// N · Cartero: cuando un robot entrega un documento, sale un robotito cartero desde su puesto (o desde su sala) con el
// papel hasta tu bandeja y se va por la puerta. El robot sigue en lo suyo.
async function sendCourier(from, n) {
  if (st.view) {
    pulseInbox();
    return;
  } // dentro de una sala no se ve la bandeja
  const el = document.createElement('div');
  el.className = 'robot courier';
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = `<i class="shadow"></i>${robotSVG('#ef8f7a', { ant: 3, visor: 1, acc: 2 })}<div class="carry"${n > 1 ? ` data-count="${n}"` : ''}></div>`;
  MAP.appendChild(el);
  const c = { el, pos: { ...from } };
  placeAt(c, from);
  try {
    await walkTo(c, coordDrop());
    el.querySelector('.carry').hidden = true;
    pulseInbox();
    SFX.deliver();
    await walkTo(c, door());
  } finally {
    el.remove();
  }
}
