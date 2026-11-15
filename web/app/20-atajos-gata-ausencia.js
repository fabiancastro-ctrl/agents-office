/* ---------- atajos de teclado ---------- */
// No actúan mientras escribes. J/K recorren los robots en el orden de las tarjetas (primero los que te necesitan).
const KEYS = [['J / K', 'Siguiente / anterior robot'], ['S', 'Siguiente robot que te espera'], ['A / D', 'Aprobar / denegar el permiso (y pasa al siguiente que espera)'],
  ['R', 'Escribirle al robot abierto'], ['F', 'Seguir en el mapa al robot abierto'], ['/', 'Buscar en las conversaciones'], ['P', 'Para enviar (mensajes fijados)'], ['H', 'Archivo de despedidos (resúmenes para retomar)'],
  ['+ / − / 0', 'Acercar / alejar / ver todo el mapa'], ['N', 'Nuevo encargo'], ['B', 'Bandeja'], ['Esc', 'Cerrar'], ['?', 'Esta ayuda']];
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
  else if ((k === 'a' || k === 'd') && a) {
    e.preventDefault();
    const d = a.data, allow = k === 'a';
    try {
      if (!await decide(d, allow)) return d.ask ? $('#rp-alert input')?.focus() : toast(`${d.name} no está pidiendo permiso`);
      const nx = nextWaiting(d.name);
      toast(`${allow ? 'Aprobado' : 'Denegado'}: ${d.name}${nx ? ` · sigue ${nx}` : ' · nadie más te espera'}`);
      if (nx && nx !== d.name) setTimeout(() => select(nx), 250);
    } catch { /* toast ya mostrado */ }
  } else if (k === 's') goNextWaiting();
  else if (k === 'f' && a) { select(null); follow(a.data.name); }
  else if (k === 'f' && hover.name) follow(hover.name);
  else if (e.key === '/') { select('@search'); setTimeout(() => $('#search-in')?.focus(), 0); }
  else if (k === 'p') select('@pins');
  else if (k === 'h') select('@archivo');
  else if (e.key === '+' || e.key === '=') setZoom(zoom.z * 1.35);
  else if (e.key === '-' || e.key === '_') setZoom(zoom.z / 1.35);
  else if (e.key === '0') setZoom(1);
  else if (e.key === '?') keysHelp();
  else return;
  e.preventDefault();
});

const setSkills = skills => { ac.skills = skills || []; $('#skills-list').innerHTML = (skills || []).map(s => `<option value="${esc(s)}">`).join(''); };
fetch('/api/skills').then(r => r.json()).then(({skills}) => setSkills(skills)).catch(() => {});

renderPanel();
connect();

/* ---------- la gata de la oficina ---------- */
// Pasea entre los escritorios y la sala de descanso; a veces se sienta y, si un robot lleva mucho trabajando,
// se echa a dormir a su lado. No informa nada: es compañía.
const CAT_SVG = `<svg viewBox="0 0 34 22" aria-hidden="true"><path class="c-tail" d="M28 12q5-1 5-8" stroke="#2b2f38" stroke-width="2.4" fill="none" stroke-linecap="round"/>
  <g class="c-legs" fill="#23262e"><rect class="l1" x="9" y="14" width="2.6" height="7" rx="1"/><rect class="l2" x="13" y="14" width="2.6" height="7" rx="1"/><rect class="l3" x="21" y="14" width="2.6" height="7" rx="1"/><rect class="l4" x="25" y="14" width="2.6" height="7" rx="1"/></g>
  <ellipse cx="18" cy="13" rx="11" ry="5.4" fill="#2b2f38"/><circle cx="7" cy="8.4" r="5" fill="#2b2f38"/><path d="M3.4 5.6l.4-4.6 3.4 3zM7.6 3.8l2.6-3.4.8 4.4z" fill="#2b2f38"/>
  <g class="c-eyes"><circle cx="5.4" cy="8" r=".95" fill="#ffd27a"/><circle cx="8.6" cy="8" r=".95" fill="#ffd27a"/></g><path class="c-shut" d="M4.4 8.4h2M7.6 8.4h2" stroke="#ffd27a" stroke-width=".7"/></svg><b class="zzz">z<i>z</i><i>z</i></b>`;
const cat = {el: Object.assign(document.createElement('div'), {className: 'ocat', innerHTML: CAT_SVG}), x: 40, y: 92, timer: 0};
cat.el.title = 'Michi, la gata de la oficina';
MAP.appendChild(cat.el);
cat.el.style.left = cat.x + '%'; cat.el.style.top = cat.y + '%';
function catGo(x, y, then) {
  const dist = Math.hypot((x - cat.x) * 1.6, y - cat.y), ms = Math.max(800, dist * 110);
  cat.el.classList.remove('sit', 'sleep'); cat.el.classList.add('walk');
  cat.el.classList.toggle('left', x < cat.x);
  cat.el.style.transition = `left ${ms}ms linear, top ${ms}ms linear`;
  cat.el.style.left = x + '%'; cat.el.style.top = y + '%';
  cat.x = x; cat.y = y;
  clearTimeout(cat.timer); cat.timer = setTimeout(() => { cat.el.classList.remove('walk'); then(); }, ms);
}
function catLife() {
  const r = Math.random();
  // ¿Alguien lleva más de 20 min trabajando? Se le echa a dormir al lado.
  const busy = [...st.robots.values()].filter(a => (a.data.state === 'working' || a.data.state === 'delegating') && Date.now() - (Date.parse(a.data.startedAt || '') || Date.now()) > 20 * 60e3);
  if (busy.length && r < .35) {
    const a = busy[Math.random() * busy.length | 0], x = parseFloat(a.el.style.left) + 3.2, y = parseFloat(a.el.style.top) + 1;
    if (Number.isFinite(x) && Number.isFinite(y)) return catGo(Math.min(x, 74), y, () => { cat.el.classList.add('sleep'); cat.timer = setTimeout(catLife, 20000 + Math.random() * 15000); });
  }
  const spot = Math.random() < .7 ? [4 + Math.random() * 70, 44 + Math.random() * 50] : [5 + Math.random() * 46, 12 + Math.random() * 17];
  catGo(spot[0], spot[1], () => { if (Math.random() < .6) cat.el.classList.add('sit'); cat.timer = setTimeout(catLife, 4000 + Math.random() * 8000); });
}
setTimeout(catLife, 3000);

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
