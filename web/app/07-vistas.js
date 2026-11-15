/* ---------- vista 2.5D (opcional) ---------- */
// El mismo plano inclinado en perspectiva: el piso se acuesta, las paredes se levantan y los robots quedan de pie
// mirando a la cámara. Es solo CSS (clase .iso en el contenedor). Por defecto 2D; cada quien elige con el botón.
function setView(iso) {
  $('.map-wrap').classList.toggle('iso', iso);
  $('#btn-view').setAttribute('aria-pressed', String(iso));
  $('#btn-view').textContent = iso ? '2D' : '2.5D';
  prefSet('mapView', iso ? 'iso' : '2d');
}
$('#btn-view').addEventListener('click', () => { setZoom(1); setView(!$('.map-wrap').classList.contains('iso')); });
// Estilo de la oficina (lo guarda el daemon en la configuración de esta oficina). «Moderna» es el de siempre.
const TDECO = {
  garaje: '<i class="td-box" style="left:3%;top:89%"></i><i class="td-box" style="left:5.8%;top:89%"></i><i class="td-box" style="left:4.4%;top:84.6%"></i><i class="td-box" style="left:71%;top:90%"></i><i class="td-board" style="left:31%;top:33.4%;width:8%;height:4.2%"></i>',
  nave: '<i class="td-pipe" style="left:3%;top:96.2%;width:72%"></i><i class="td-light" style="left:3.2%;top:39.6%"></i><i class="td-light" style="left:74%;top:39.6%"></i><i class="td-light" style="left:3.2%;top:94%"></i><i class="td-light" style="left:74%;top:94%"></i>',
  biblioteca: '<i class="td-shelf" style="left:3%;top:88.4%;width:13%;height:7%"></i><i class="td-shelf" style="left:61%;top:88.4%;width:13%;height:7%"></i><i class="td-lamp" style="left:18%;top:90%"></i><i class="td-lamp" style="left:58%;top:90%"></i>',
  cafeteria: '<i class="td-bar" style="left:3%;top:90.6%;width:16%;height:4.6%"></i><i class="td-menu" style="left:31%;top:33.2%;width:7%;height:4.4%"></i>'
};
// Decoración que crece con el trabajo: en cada nivel aparecen plantas nuevas (y las de siempre crecen y florecen),
// un trofeo cada 10 tareas en tu escritorio y la pizarra de la sala de descanso con lo terminado hoy.
// Una «tarea» es cada vez que un robot termina lo que le pediste (cada respuesta final de su turno).
function placeGrowth(e) {
  const box = $('#growth');
  if (box.children.length !== GROW_PLANTS.length) box.innerHTML = GROW_PLANTS.map(([lvl, , , , , , cls]) => `<i class="deco plant gp gl-${lvl}${cls ? ' ' + cls : ''}"></i>`).join('');
  GROW_PLANTS.forEach(([, x, y, w, h, low], k) => setRect(box.children[k], x, y + (low ? e : 0), w, h));
}
function renderGrowth() {
  const s = st.config?.stats || {total: 0, reviews: 0, today: 0};
  const lvl = GROW_AT.filter(n => s.total >= n).length;
  for (let i = 0; i <= 4; i++) MAP.classList.toggle(`grow-${i}`, i === lvl);
  const n = Math.floor(s.total / 10), shown = Math.min(n, 6);
  const tr = $('#trophies');
  tr.innerHTML = Array.from({length: shown}, (_, i) => `<i class="cup${i % 3 === 2 ? ' big' : ''}"></i>`).join('') + (n > shown ? `<b>+${n - shown}</b>` : '');
  tr.title = n ? `${n} trofeo${n === 1 ? '' : 's'}: uno cada 10 tareas terminadas (${s.total} en total)` : '';
  tr.hidden = !n;
  $('#tboard').innerHTML = `<small>HOY</small><b>${s.today}</b><small>tareas</small>`;
  const next = GROW_AT[lvl];
  $('#tboard').title = `Oficina nivel ${lvl} de 4 · ${s.total} tareas terminadas en total${next ? ` · el siguiente nivel (más plantas) llega a las ${next}` : ' · nivel máximo'}. Hoy: ${s.today}.`;
}
// Cuadro «Empleado de la semana» en tu escritorio: el robot que más tokens gastó desde que se renovó tu cuota
// semanal (lo calcula el daemon; se reinicia con la cuota). Si está en la oficina lleva corona con fuego (🔥🔥 si
// además es el que más gastó en la sesión actual de 5 h). Clic: abre al robot si sigue en la oficina.
function renderFame() {
  const box = $('#eotm'), em = st.fame?.employee;
  box.hidden = !em;
  if (!em) return;
  const live = st.robots.get(em.name)?.data;
  const crown = live?.crown || 0;
  const look = lookOf(em.name, live?.place || null, live || {look: em.look, crown: 0});
  const html = `<small>EMPLEADO DE LA SEMANA</small><span class="eotm-face">${robotHead(COLORS[(live?.color ?? em.color ?? 0) % 8], look)}</span><b>${esc(em.name)}</b><i>${fmtTok(em.tokens)}</i>`;
  if (box._html !== html) { box._html = html; box.innerHTML = html; }
  const p = st.fame.period, d = t => new Date(t).toLocaleString('es', {weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit'});
  box.title = `👑 Empleado de la semana: ${em.name}${em.title ? ` («${em.title}»)` : ''} · ${em.tokens.toLocaleString('es')} tokens desde ${d(p.from)}.\n`
    + `Se reinicia cuando se renueva tu cuota semanal: ${d(p.to)}${p.known ? '' : ' (aún sin leer /usage: se toma el lunes)'}.\n`
    + (em.present ? `Está en la oficina con la corona ${crown >= 2 ? 'de dos fuegos 🔥🔥: también es el que más gastó en esta sesión de 5 h' : 'de un fuego 🔥'}. Clic para verlo.` : 'Ya no está en la oficina (está en el archivo).');
  box.classList.toggle('live', !!em.present);
}
$('#eotm').addEventListener('click', () => { const n = st.fame?.employee?.name; if (n && st.robots.has(n)) select(n); });

function setMapTheme(t) {
  t = TDECO[t] || t === 'moderna' ? t : 'moderna';
  $('.map-wrap').dataset.mt = t;
  $('#tdeco').innerHTML = TDECO[t] || '';
  $('#map-theme').value = t;
}
$('#map-theme').addEventListener('change', async e => {
  const t = e.target.value; setMapTheme(t);
  try { await api('POST', '/api/config', {mapTheme: t}); } catch { setMapTheme(st.config.mapTheme || 'moderna'); }
});
// Vista compacta: sin mapa; las tarjetas pasan a columnas (te necesitan · trabajando · listos). El aviso
// flotante (toast) vive dentro del mapa: en compacta se muda al cuerpo de la página para seguir viéndose.
function setCompact(on) {
  document.body.classList.toggle('compact', on);
  $('#btn-compact').setAttribute('aria-pressed', String(on));
  $('#btn-compact').textContent = on ? 'Ver mapa' : 'Compacta';
  $('#btn-view').hidden = on;
  const t = $('#toast'); (on ? document.body : MAP).appendChild(t);
  prefSet('compact', on ? '1' : '0');
  $('#minimap')._html = null; scheduleCards();
  if (!on) layout();
}
$('#btn-compact').addEventListener('click', () => setCompact(!document.body.classList.contains('compact')));
setView(prefGet('mapView', '2d') === 'iso');
setCompact(prefGet('compact', '0') === '1');
// Tema claro u oscuro (oscuro por defecto). El mapa queda de noche en los dos: es la ilustración de la oficina.
function setTheme(light) {
  document.documentElement.dataset.theme = light ? 'light' : 'dark';
  $('#btn-theme').textContent = light ? 'tema oscuro' : 'tema claro';
  prefSet('theme', light ? 'light' : 'dark');
}
$('#btn-theme').addEventListener('click', () => setTheme(document.documentElement.dataset.theme !== 'light'));
setTheme(prefGet('theme', 'dark') === 'light');

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
    const cls = ['tl-row', `g-${groupOf(d)}`, cardUi.hl === d.name ? 'hl' : '', st.selected === d.name ? 'sel' : ''].filter(Boolean).join(' ');
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

