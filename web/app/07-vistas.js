/* ---------- vista 2.5D (opcional) ---------- */
// El mismo plano inclinado en perspectiva: el piso se acuesta, las paredes se levantan y los robots quedan de pie
// mirando a la cámara. Es solo CSS (clase .iso en el contenedor). Por defecto 2D; cada quien elige con el botón.
function setView(iso) {
  $('.map-wrap').classList.toggle('iso', iso);
  $('#btn-view').setAttribute('aria-pressed', String(iso));
  prefSet('mapView', iso ? 'iso' : '2d');
}
$('#btn-view').addEventListener('click', () => {
  setZoom(1);
  setView(!$('.map-wrap').classList.contains('iso'));
});
// Estilo de la oficina (lo guarda el daemon en la configuración de esta oficina). «Moderna» es el de siempre.
function placeTDeco(e = extra()) {
  const box = $('#tdeco'),
    t = $('.map-wrap').dataset.mt || 'moderna',
    list = TDECO[t] || [];
  if (box.dataset.t !== t) {
    box.dataset.t = t;
    box.innerHTML = list.map(([cls]) => `<i class="${cls}"></i>`).join('');
  }
  list.forEach(([, x, y, w, h, low], k) => setRect(box.children[k], x, y + (low ? e : 0), w, h));
}
// Decoración que crece con el trabajo: en cada nivel aparecen plantas nuevas en la sala de escritorios (y las de siempre
// crecen y florecen), un trofeo cada 10 tareas en tu escritorio y la pizarra de la sala de descanso con lo terminado hoy.
// Una «tarea» es cada vez que un robot termina lo que le pediste (cada respuesta final de su turno).
function placeGrowth(e) {
  const box = $('#growth');
  if (box.children.length !== GROW_PLANTS.length)
    box.innerHTML = GROW_PLANTS.map(([lvl, , , , , , cls]) => `<i class="deco plant gp gl-${lvl}${cls ? ' ' + cls : ''}"></i>`).join('');
  GROW_PLANTS.forEach(([, x, y, w, h, low], k) => setRect(box.children[k], x, y + (low ? e : 0), w, h));
}
// Materas de la semana: cada renovación de la cuota trae otro color de matera.
const POTS = ['#8a5a3c', '#b4563f', '#3f6f8a', '#6b5a9a', '#c08a3e', '#4f7a55', '#9a4f6b'];
const growUi = { lvl: null, timer: 0 };
function setGrowLevel(lvl) {
  for (let i = 0; i <= 4; i++) MAP.classList.toggle(`grow-${i}`, i === lvl);
  growUi.lvl = lvl;
}
// Reloj de pared con la cuenta regresiva a la renovación de tu cuota semanal (cuando también se cambian las materas).
// Las manecillas marcan la hora real; abajo, cuánto falta. No gasta cuota: la fecha sale de /usage (config.json).
function renderClock() {
  const box = $('#qclock'),
    to = st.config?.stats?.weekTo;
  box.hidden = !to;
  if (!to) return;
  const now = new Date(),
    left = Math.max(0, to - now.getTime());
  const d = Math.floor(left / 86400e3),
    h = Math.floor((left % 86400e3) / 3600e3),
    mi = Math.floor((left % 3600e3) / 60e3);
  const txt = d ? `${d} d ${h} h` : h ? `${h} h ${mi} min` : `${mi} min`;
  const short = d ? `${d}d ${h}h` : h ? `${h}h ${mi}m` : `${mi}m`; // corto: cabe bajo el reloj sin salirse de tu escritorio
  const hr = ((now.getHours() % 12) + now.getMinutes() / 60) * 30,
    mn = now.getMinutes() * 6;
  const soon = left < 3600e3;
  const html = `<svg viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="18" class="qc-face"/>${Array.from({ length: 12 }, (_, k) => `<line x1="20" y1="4" x2="20" y2="${k % 3 ? 6 : 7.5}" transform="rotate(${k * 30} 20 20)" class="qc-tick"/>`).join('')}<line x1="20" y1="20" x2="20" y2="11" class="qc-h" transform="rotate(${hr} 20 20)"/><line x1="20" y1="20" x2="20" y2="7" class="qc-m" transform="rotate(${mn} 20 20)"/><circle cx="20" cy="20" r="1.6" class="qc-c"/></svg><b>${short}</b><small>CUOTA</small>`;
  if (box._html !== html) {
    box._html = html;
    box.innerHTML = html;
  }
  box.classList.toggle('soon', soon);
  box.title = `Tu cuota semanal se renueva el ${new Date(to).toLocaleString('es', { weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit' })}: faltan ${txt}. Ese momento también se cambian las materas.`;
}
setInterval(renderClock, 30e3);
// Cafetera de la sala de descanso: la jarra muestra cuánto queda de tu cuota semanal (de /usage, releído cada hora;
// no gasta tokens). Llena al empezar la semana, ámbar con poco, vacía y en rojo cerca del límite.
function renderCoffee() {
  const el = $('#bcoffee'),
    s = st.config?.stats || {};
  // With several accounts the pot shows the active account (the one new launches use) and fills or empties when it
  // changes; a click opens the menu to pick it.
  const act = hasAccounts() ? st.config.activeAccount || 'principal' : '';
  const pct = act ? (st.config.accounts.find(a => a.id === act)?.weekPct ?? null) : s.quotaPct;
  el.classList.toggle('unknown', pct == null);
  let tag = el.querySelector('.cacct');
  if (act && !tag) el.insertAdjacentHTML('beforeend', '<b class="cacct" aria-hidden="true"></b>');
  tag = el.querySelector('.cacct');
  if (tag) {
    tag.hidden = !act;
    tag.textContent = act ? accountLabel(act).slice(0, 1).toUpperCase() : '';
  }
  el.setAttribute('aria-label', act ? `Cafetera: cuenta activa ${accountLabel(act)}. Abre el menú de cuentas.` : 'Cafetera');
  const actTxt = act ? ` Cuenta activa: ${accountLabel(act)} (clic para cambiarla).` : '';
  if (pct == null) {
    el.title = `Cafetera: abre «Uso Claude» una vez y la jarra mostrará cuánto te queda de la cuota semanal.${actTxt}`;
    return;
  }
  const left = Math.max(0, 100 - pct);
  el.style.setProperty('--lvl', `${left}%`);
  el.classList.toggle('low', left <= 30 && left > 10);
  el.classList.toggle('empty', left <= 10);
  const at = s.quotaAt ? fmtTime(s.quotaAt) : '';
  el.title = `Cafetera: queda ${left} % de la cuota semanal${act ? ` de la cuenta ${accountLabel(act)}` : ''} (usado ${pct} %${at && !act ? `, medido a las ${at}` : ''}). Se vuelve a llenar cuando se renueva la cuota.${actTxt}`;
}
function renderGrowth() {
  renderClock();
  renderCoffee();
  const s = st.config?.stats || { total: 0, reviews: 0, today: 0 };
  const week = s.week ?? s.total;
  const lvl = GROW_AT.filter(n => week >= n).length;
  const pot = n => POTS[((n % POTS.length) + POTS.length) % POTS.length];
  if (!MAP.classList.contains('repotting')) MAP.style.setProperty('--pot', pot(s.pot || 0));
  // Se renovó la cuota: cambio de materas (una vez por renovación y por navegador). Las plantas de la semana que se va
  // se marchitan, las materas se cambian y lo de siempre vuelve a brotar chiquito.
  let seen = null;
  try {
    seen = localStorage.getItem('office.repotSeen');
  } catch {
    /* sin almacenamiento */
  }
  const fresh = s.repotAt && s.repotAt !== seen && Date.now() - Date.parse(s.repotAt) < 3 * 86400e3;
  if (fresh) {
    try {
      localStorage.setItem('office.repotSeen', s.repotAt);
    } catch {
      /* sin almacenamiento */
    }
    const was = growUi.lvl ?? 4; // al abrir la página no se sabe cómo estaban: se muestran crecidas y se marchitan
    clearTimeout(growUi.timer);
    setGrowLevel(Math.max(was, lvl));
    MAP.classList.add('repotting');
    MAP.style.setProperty('--pot', pot((s.pot || 0) - 1)); // se marchitan en la matera de la semana que se va
    toast('Se renovó tu cuota semanal: cambié las materas. Las plantas vuelven a crecer con el trabajo de esta semana.', 'sprout');
    growUi.timer = setTimeout(() => {
      setGrowLevel(lvl);
      MAP.style.setProperty('--pot', pot(s.pot || 0));
      MAP.classList.add('repot-new');
    }, 1700);
    setTimeout(() => MAP.classList.remove('repotting', 'repot-new'), 4200);
  } else if (!MAP.classList.contains('repotting')) setGrowLevel(lvl);
  const n = Math.floor(s.total / 10),
    shown = Math.min(n, 4); // the shelf ends at the filing cabinet: more than 4 go in «+N»
  const tr = $('#trophies');
  tr.innerHTML =
    Array.from({ length: shown }, (_, i) => `<i class="cup${i % 3 === 2 ? ' big' : ''}"></i>`).join('') +
    (n > shown ? `<b>+${n - shown}</b>` : '');
  tr.title = n ? `${n} trofeo${n === 1 ? '' : 's'}: uno cada 10 tareas terminadas (${s.total} en total)` : '';
  tr.hidden = !n;
  // O · Pizarra de la semana: una barra por día de la semana de la cuota (hoy resaltado) y el número de hoy.
  const days = s.days || [],
    top = Math.max(1, ...days.map(x => x.n)),
    todayKey = new Date().toLocaleDateString('sv');
  const DOW = ['D', 'L', 'M', 'M', 'J', 'V', 'S'];
  const bars = days
    .map(x => {
      const dt = new Date(x.day + 'T12:00:00');
      const future = x.day > todayKey;
      return `<i class="tb-bar${x.day === todayKey ? ' hoy' : ''}${future ? ' fut' : ''}" style="--h:${future ? 0 : Math.max(4, Math.round((x.n * 100) / top))}%" title="${dt.toLocaleDateString('es', { weekday: 'long', day: 'numeric' })}: ${x.n} tarea${x.n === 1 ? '' : 's'}"><u>${DOW[dt.getDay()]}</u></i>`;
    })
    .join('');
  $('#tboard').innerHTML = days.length
    ? `<small>HOY <b>${s.today}</b></small><span class="tb-bars">${bars}</span>`
    : `<small>HOY</small><b>${s.today}</b><small>tareas</small>`;
  const next = GROW_AT[lvl];
  const until = s.weekTo ? fmtWhen(s.weekTo, { weekday: 'short', hour: 'numeric' }) : '';
  $('#tboard').title =
    `Plantas nivel ${lvl} de 4 · ${week} tareas esta semana de la cuota${next ? ` · el siguiente nivel (más plantas) llega a las ${next}` : ' · nivel máximo'}${until ? ` · se cambian las materas al renovarse la cuota (${until})` : ''}. Hoy: ${s.today}. En total: ${s.total} (los trofeos cuentan el total).`;
}
// 9 · Muro de la fama (menú «Más»): los últimos 4 empleados de la semana, cada uno en su cuadro.
$('#btn-fama').addEventListener('click', () => select('@fama'));
const famaUi = { weeks: null };
function famaPanel() {
  const w = famaUi.weeks;
  const d = t => fmtDay(t);
  const frames = !w
    ? '<p class="muted">Calculando…</p>'
    : w
        .map(x =>
          x.name
            ? `<figure class="fame-f${x.current ? ' cur' : ''}"><small>${x.current ? 'ESTA SEMANA' : `${d(x.from)} – ${d(x.to)}`}</small><span class="fame-face">${robotHead(COLORS[(x.color || 0) % COLORS.length], lookOf(x.name, null, { look: x.look }))}</span><b>${esc(x.name)}</b><i>${fmtTok(x.tokens)} tokens</i>${x.title ? `<em>📌 ${esc(x.title)}</em>` : ''}<span class="fame-st">${x.present ? 'sigue en la oficina' : 'ya se fue'}</span></figure>`
            : `<figure class="fame-f empty"><small>${d(x.from)} – ${d(x.to)}</small><span class="fame-face">—</span><b>Nadie</b><i>sin gasto</i></figure>`
        )
        .join('');
  return `<div class="dlg-head"><h3>🏆 Muro de la fama</h3><p>El robot que más tokens gastó en cada semana de tu cuota (con sus subagentes), las últimas 4. Sale de los transcripts: no gasta cuota.</p></div><div class="fame-wall">${frames}</div>`;
}
async function loadFama() {
  try {
    famaUi.weeks = (await (await fetch('/api/fama')).json()).weeks;
  } catch {
    famaUi.weeks = [];
  }
  if (st.selected === '@fama') renderPanel();
}

function setMapTheme(t) {
  t = TDECO[t] ? t : 'moderna';
  $('.map-wrap').dataset.mt = t;
  placeTDeco();
  $('#map-theme').value = t;
}
$('#map-theme').addEventListener('change', async e => {
  const t = e.target.value;
  setMapTheme(t);
  try {
    await api('POST', '/api/config', { mapTheme: t });
  } catch {
    setMapTheme(st.config.mapTheme || 'moderna');
  }
});
// Vista compacta: sin mapa; las tarjetas pasan a columnas (te necesitan · trabajando · listos).
function setCompact(on) {
  document.body.classList.toggle('compact', on);
  $('#btn-compact').setAttribute('aria-pressed', String(on));
  $('#btn-view').closest('.vm-row').hidden = on; // 2.5D makes no sense without the map
  prefSet('compact', on ? '1' : '0');
  $('#minimap')._html = null;
  scheduleCards();
  if (!on) layout();
}
$('#btn-compact').addEventListener('click', () => setCompact(!document.body.classList.contains('compact')));
setView(prefGet('mapView', '2d') === 'iso');
setCompact(prefGet('compact', '0') === '1');
// Tema claro u oscuro (oscuro por defecto). El mapa queda de noche en los dos: es la ilustración de la oficina.
function setTheme(light) {
  document.documentElement.dataset.theme = light ? 'light' : 'dark';
  $('#btn-theme').setAttribute('aria-pressed', String(!light));
  prefSet('theme', light ? 'light' : 'dark');
}
$('#btn-theme').addEventListener('click', () => setTheme(document.documentElement.dataset.theme !== 'light'));
setTheme(prefGet('theme', 'dark') === 'light');

// Hora corta (14:05) para el chat, el buscador y los mensajes fijados.
const hhmm = t => fmtTime(t);

// El tiempo de cada tarjeta avanza solo; los tokens de la semana y la cuota se refrescan cada 5 min.
setInterval(
  () =>
    document.querySelectorAll('#cards [data-start]').forEach(el => {
      if (el.dataset.start) el.textContent = fmtDur(Date.now() - Date.parse(el.dataset.start));
    }),
  20000
);
