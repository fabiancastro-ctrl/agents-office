/* ---------- sala de descanso ---------- */
// Pura animación para que la oficina no se vea sola: robots sin consola ni cuota tomando café y charlando.
// Hay más cuando hay poco trabajo; rotan, cambian de lugar y conversan. Un clic en uno abre «Nuevo encargo»
// con su nombre y, al lanzarlo, ese mismo robot sale del descanso hacia su escritorio.
const BREAK_SPOTS = [
  [6.5, 18],
  [12.5, 18.6],
  [18.5, 18],
  [24, 18.6],
  [30, 18],
  [36, 18.6],
  [42, 18.2],
  [48, 18.6],
  [54, 18],
  [62, 18.4],
  [7.5, 29.4],
  [13.5, 30],
  [19.5, 29.4],
  [25.5, 30],
  [31, 26.4],
  [44, 29.6],
  [50, 30],
  [56, 29.4]
];
const BREAK_TALK = [
  '¿Alguien vio el pipeline?',
  'Café número tres',
  '¿Hexagonal o clásico?',
  'golangci-lint me odia',
  'Ese PR tenía 40 archivos',
  '¿Ya salió dropi-tools nueva?',
  'Hoy reviso en doble pasada',
  'Me tocó un hotfix',
  '¿Quién rompió production?',
  'Pausa activa',
  'Esperando encargo…',
  '¿Un ping-pong?',
  'Ojo con el %w',
  'Nada de ORMs, ¿eh?',
  'Volví de un review-deep',
  'Este café está buenísimo',
  '¿Y los tests?',
  'Hoy hay deploy'
];
const pick = arr => arr[Math.floor(Math.random() * arr.length)];
const busySpots = () => new Set([...brk.bots.values()].map(x => x.spot));
const spotPos = k => ({ x: BREAK_SPOTS[k][0], y: BREAK_SPOTS[k][1] });
function breakTarget() {
  const active = [...st.robots.values()].filter(a => a.data.state !== 'done').length;
  return Math.max(2, Math.min(7, 7 - active)); // de 2 a 7: más cuando hay poco trabajo, sin llenar la sala
}
function spawnBreakBot() {
  const free = BREAK_SPOTS.map((_, k) => k).filter(k => !busySpots().has(k));
  if (!free.length) return;
  let name = randomName();
  while (brk.bots.has(name)) name = randomName();
  const el = document.createElement('div');
  el.className = 'robot on-break st-done';
  el.dataset.name = name;
  el.tabIndex = 0;
  el.setAttribute('role', 'button');
  el.title = `${name} está en descanso. Clic para darle un encargo.`;
  el.style.setProperty('--d', `-${(Math.random() * 3).toFixed(2)}s`);
  el.style.setProperty('--d2', `-${(Math.random() * 5).toFixed(2)}s`);
  el.style.setProperty('--sp', (0.85 + Math.random() * 0.3).toFixed(2));
  el.innerHTML = `<i class="shadow"></i><div class="bubble" hidden></div>${robotSVG(pick(COLORS), lookOf(name))}<div class="nm">${esc(name)}</div>`;
  MAP.appendChild(el);
  const x = { name, el, bubble: el.querySelector('.bubble'), pos: door(), q: Promise.resolve(), spot: pick(free) };
  brk.bots.set(name, x);
  placeAt(x, door());
  queue(x, () => walkTo(x, spotPos(x.spot)));
}
function leaveBreak(x) {
  brk.bots.delete(x.name);
  queue(x, async () => {
    await walkTo(x, door());
    x.el.remove();
  });
}
function sayOnBreak(x, text) {
  x.bubble.textContent = text;
  x.bubble.hidden = false;
  declutterBubbles();
  clearTimeout(x.bt);
  x.bt = setTimeout(() => {
    x.bubble.hidden = true;
    declutterBubbles();
  }, 3800);
}
function tickBreak() {
  const bots = [...brk.bots.values()],
    target = breakTarget();
  if (bots.length < target) spawnBreakBot();
  else if (bots.length > target) leaveBreak(pick(bots));
  else if (bots.length && Math.random() < 0.15) leaveBreak(pick(bots)); // rotan: uno se va y el próximo tick entra otro
  const idle = [...brk.bots.values()].filter(x => !x.el.classList.contains('moving'));
  if (idle.length && Math.random() < 0.35) {
    const x = pick(idle),
      free = BREAK_SPOTS.map((_, k) => k).filter(k => !busySpots().has(k));
    if (free.length) {
      x.spot = pick(free);
      queue(x, () => walkTo(x, spotPos(x.spot)));
    }
  }
  if (idle.length && Math.random() < 0.6) {
    const a = pick(idle);
    sayOnBreak(a, pick(BREAK_TALK));
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
  if (input) {
    input.value = name;
    ($('#job-skill') || $('#job-text'))?.focus();
  }
  toast(`${name} está listo para un encargo: elige qué hará y pulsa «Invocar robot».`);
}
// Si el nuevo robot se llama como uno del descanso, sale de ahí (en vez de entrar por la puerta).
function takeFromBreak(name) {
  const x = brk.bots.get(name);
  if (!x) return null;
  brk.bots.delete(name);
  x.el.remove();
  return { ...x.pos };
}
