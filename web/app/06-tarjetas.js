/* ---------- métricas y tarjetas por robot ---------- */
// El mapa es la vista "viva"; las tarjetas son la vista de gestión: ordenadas por urgencia (primero los que te
// necesitan), una línea por robot trabajando y los terminados plegados, para que con muchos robots no sature.
const CARDS = $('#cards'), KPIS = $('#kpis');
const GROUP_OF = {input: 'need', working: 'work', walking: 'work', delegating: 'work', idle: 'work', done: 'done'};
// Un robot que pide robots nuevos te necesita aunque siga trabajando.
const groupOf = d => d.spawnReq || d.consoleLost ? 'need' : GROUP_OF[d.state] || 'work';
const fmtDur = ms => { const m = Math.max(0, Math.floor(ms / 60000)); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`; };
const tokOf = d => (d.usage?.out || 0) + (d.usage?.in || 0) + (d.usage?.cacheWrite || 0);
// Gasto del robot (lo calcula el daemon cada minuto): su parte del gasto de la OFICINA en la semana de tu cuota (la
// misma del empleado de la semana), no del límite
// de tu suscripción. 🔥 si se disparó (mucho en la última hora o más de la cuarta parte de la semana).
const spendText = d => { const s = d.spend; if (!s?.officeWeek) return '';
  return `${fmtTok(s.week)} desde que se renovó tu cuota (${s.pct} % de la oficina; la misma semana del empleado de la semana) · ${fmtTok(s.hour)} en la última hora${s.hot ? ` · 🔥 se disparó: ${s.hot === 'hour' ? 'mucho en la última hora' : 'más de la cuarta parte de la semana'}` : ''}`; };
const spendChip = d => d.spend?.officeWeek ? `<span class="rc-spend${d.spend.hot ? ' hot' : ''}" title="Gasto: ${esc(spendText(d))}. Es su parte de lo que gastó la oficina, no del límite de tu suscripción.">${d.spend.hot ? '🔥 ' : ''}${d.spend.pct} % sem.</span>` : '';
const runningSubs = d => d.subs.filter(s => s.status !== 'done').length;
const prefGet = (k, def) => { try { return localStorage.getItem('office.' + k) ?? def; } catch { return def; } };
const prefSet = (k, v) => { try { localStorage.setItem('office.' + k, v); } catch { /* sin almacenamiento */ } };
const cardUi = {hl: null, reply: {}, repo: (() => { try { return localStorage.getItem('office.repoFilter') || ''; } catch { return ''; } })()};
let cardsRaf = 0;
// Mini mapa (solo en vista compacta): una tira con los escritorios y quién está en cada uno, con el color de su
// estado; los robots de rutinas y salas van aparte. Clic abre el robot.
function renderMini() {
  const box = $('#minimap');
  if (!document.body.classList.contains('compact')) { if (box.innerHTML) box.innerHTML = ''; return; }
  const at = new Map(), rooms = [];
  for (const a of st.robots.values()) { const p = a.data.place; if (p?.type === 'desk') at.set(p.idx, a.data); else if (p?.type === 'room') rooms.push(a.data); }
  const cell = (d, i) => d
    ? `<button type="button" class="mm-c mm-${d.state}${urgency(d) ? ` urg-${urgency(d)}` : ''}${st.selected === d.name ? ' sel' : ''}" data-mini="${esc(d.name)}" style="--c:${COLORS[d.color % COLORS.length]}" title="${esc(`${d.name} · ${stateLabel(d)}${titleOf(d) ? ' · ' + titleOf(d) : ''}`)}">${robotHead(COLORS[d.color % COLORS.length], lookOf(d.name, d.place, d))}<span>${esc(d.name)}</span></button>`
    : `<span class="mm-c mm-free" title="Escritorio ${String(i + 1).padStart(2, '0')} libre"><i>${String(i + 1).padStart(2, '0')}</i></span>`;
  const n = Math.max(deskEls.length, ...[...at.keys()].map(i => i + 1), 1);
  const html = `<span class="mm-h">Escritorios</span><div class="mm-row">${Array.from({length: n}, (_, i) => cell(at.get(i), i)).join('')}</div>${rooms.length ? `<span class="mm-h">Rutinas y salas</span><div class="mm-row">${rooms.map(d => cell(d)).join('')}</div>` : ''}`;
  if (box._html !== html) { box._html = html; box.innerHTML = html; }
}
$('#minimap').addEventListener('click', e => { const b = e.target.closest('[data-mini]'); if (b) select(b.dataset.mini); });

function scheduleCards() { if (!cardsRaf) cardsRaf = requestAnimationFrame(() => { cardsRaf = 0; renderKpis(); renderCards(); renderMini(); checkAlerts(); }); }

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
const alertOf = d => d.consoleLost ? 'lost' : d.spawnReq ? 'spawn' : d.state === 'input' ? (d.needsPermission || d.hold ? 'perm' : 'ask') : isStuck(d) ? 'stuck' : '';
const ALERT_TXT = {lost: 'se quedó sin consola', spawn: 'quiere lanzar robots nuevos', perm: 'pide permiso', ask: 'tiene una pregunta para ti', stuck: 'lleva más de 10 min sin actividad'};
function updateTitle(n) { document.title = (n ? `(${n}) ` : '') + notif.base; drawFavicon(n); }
// Ícono de la pestaña: la inicial de la oficina y, si alguien te necesita, un círculo rojo con cuántos.
const fav = {hue: 174, letter: 'O', n: -1};
function drawFavicon(n = fav.n) {
  fav.n = n;
  const badge = n > 0 ? `<circle cx="23" cy="9" r="9" fill="#ef4352" stroke="#fff" stroke-width="2"/><text x="23" y="13.2" font-family="Arial,sans-serif" font-size="${n > 9 ? 10 : 12.5}" font-weight="700" text-anchor="middle" fill="#fff">${n > 9 ? '9+' : n}</text>` : '';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="hsl(${fav.hue} 60% 48%)"/><text x="${n > 0 ? 11 : 16}" y="${n > 0 ? 26 : 22.5}" font-family="Arial,sans-serif" font-size="19" font-weight="700" text-anchor="middle" fill="#fff">${fav.letter}</text>${badge}</svg>`;
  $('#favicon').href = 'data:image/svg+xml,' + encodeURIComponent(svg);
}
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

// 3 · Tiempo esperándote: lo guardado por el daemon (esperas que ya terminaron) más las que siguen abiertas ahora.
function waitDays() {
  const days = (st.config?.stats?.waits || []).map(w => ({...w, by: {...w.by}, kinds: {...w.kinds}}));
  const todayKey = new Date().toLocaleDateString('sv'), today = days.find(w => w.day === todayKey);
  if (today) {
    const start = new Date(todayKey + 'T00:00:00').getTime();
    for (const a of st.robots.values()) {
      const d = a.data; if (d.state !== 'input' || !d.inputAt) continue;
      const ms = Date.now() - Math.max(start, Date.parse(d.inputAt) || Date.now()); if (ms <= 0) continue;
      const kind = d.hold || d.needsPermission ? 'permiso' : d.ask ? 'pregunta' : 'respuesta';
      today.total += ms; today.by[d.name] = (today.by[d.name] || 0) + ms; today.kinds[kind] = (today.kinds[kind] || 0) + ms;
    }
  }
  return {days, today};
}
const WAIT_KINDS = [['permiso', 'permisos'], ['pregunta', 'preguntas'], ['respuesta', 'respuestas']];
const topWaiter = w => Object.entries(w?.by || {}).sort((x, y) => y[1] - x[1])[0];
const fmtDurHtml = ms => { const m = Math.max(0, Math.floor(ms / 60000)); return m < 60 ? `${m}<small>min</small>` : `${Math.floor(m / 60)}<small>h</small>${String(m % 60).padStart(2, '0')}`; };
function waitKpi() {
  const {today} = waitDays(); if (!today) return '';
  const top = topWaiter(today), kinds = WAIT_KINDS.filter(([k]) => today.kinds[k]).map(([k, l]) => `${l}: ${fmtDur(today.kinds[k])}`).join(' · ');
  const title = today.total ? `Tiempo que tus robots pasaron hoy esperándote (permisos, preguntas o tu respuesta).${top ? ` El que más esperó: ${top[0]} (${fmtDur(top[1])}).` : ''}${kinds ? ` ${kinds}.` : ''} Clic: el detalle de la semana.` : 'Hoy ningún robot ha tenido que esperarte. Clic: el detalle de la semana.';
  const hot = today.total >= 3600e3 ? ' hot' : today.total >= 1200e3 ? ' warm' : '';
  return `<button type="button" class="kpi k-wait${today.total ? ' on' : ''}${hot}" data-kpi="usage" title="${esc(title)}"><b>${fmtDurHtml(today.total)}</b><span>esperándote hoy</span></button>`;
}
setInterval(() => { if (!document.hidden) renderKpis(); }, 30e3); // las esperas abiertas siguen sumando
function renderKpis() {
  const ds = [...st.robots.values()].map(a => a.data);
  const count = g => ds.filter(d => groupOf(d) === g).length;
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
    waitKpi() +
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
  const d = a.data, g = groupOf(d);
  const subs = runningSubs(d), docs = d.docs.length, tok = tokOf(d);
  const pill = d.consoleLost ? '<span class="pill p-input">⚠ consola caída</span>'
    : d.spawnReq ? `<span class="pill p-input">pide ${d.spawnReq.items.length} robot${d.spawnReq.items.length === 1 ? '' : 's'}</span>`
    : d.state === 'input' && d.inputAt
    ? `<span class="pill p-input">espera <b data-since="${esc(d.inputAt)}">${fmtWait(Date.now() - Date.parse(d.inputAt))}</b></span>`
    : `<span class="pill p-${d.state}">${d.state === 'done' && d.critical > 0 ? `⚠ ${d.critical} crítico${d.critical === 1 ? '' : 's'}` : esc(stateLabel(d))}</span>`;
  const perm = d.hold || d.needsPermission;
  const line = d.consoleLost ? 'Su consola se cerró (tmux). Su sesión sigue en disco: «Revivir» la abre de nuevo y recuerda todo.'
    : d.spawnReq ? `Quiere lanzar ${d.spawnReq.items.length} robot${d.spawnReq.items.length === 1 ? '' : 's'}: ${d.spawnReq.items.map(i => i.title || plainMd(i.text).slice(0, 40)).join(' · ')}`
    : d.ask ? `Te hizo ${d.ask.questions.length === 1 ? 'una pregunta' : `${d.ask.questions.length} preguntas`}: ${d.ask.questions.map(q => q.header || q.question).join(' · ')}`
    : d.state === 'input'
    ? (perm ? `Pide permiso: ${d.hold ? d.hold.tool : (d.activity || 'una herramienta')}` : (plainMd(d.bubble) || 'Tiene una pregunta para ti'))
    : d.state === 'done' ? (plainMd(d.bubble) || 'Terminó su turno') : (d.activity || (d.state === 'walking' ? 'Llegando a su escritorio' : 'Pensando…'));
  let actions = '';
  if (d.consoleLost) actions = `<button class="btn primary sm" data-card-act="revive">↻ Revivir</button><button class="btn sm" data-card-act="open">Ver</button><button class="btn sm danger" data-card-act="kill">Despedir</button>`;
  else if (d.spawnReq) actions = `<button class="btn primary sm" data-card-act="open">Revisar y lanzar</button>`;
  else if (d.ask) actions = askForm(d, 'c');
  else if (d.hold) actions = `<button class="btn primary sm" data-card-act="hold-allow">Aprobar</button><button class="btn danger sm" data-card-act="hold-deny">Denegar</button><button class="btn sm" data-card-act="open">Ver</button>`;
  else if (d.needsPermission) actions = `<button class="btn primary sm" data-card-act="perm-approve">Aprobar</button><button class="btn danger sm" data-card-act="perm-reject">Rechazar</button><button class="btn sm" data-card-act="open">Ver consola</button>`;
  else if (d.state === 'input') actions = `<form class="rc-reply" data-card-reply><input id="reply-${esc(d.name)}" placeholder="Responder a ${esc(d.name)}…" autocomplete="off"><button class="btn primary sm">Enviar</button></form>`;
  else if (d.state === 'done') actions = `${isSleepy(d) ? `<span class="rc-sleep" title="Sin actividad hace ${fmtDur(sleepMs(d))}. Despídelo con su resumen y retoma la tarea cuando vuelva lo que espera.">💤 ${fmtDur(sleepMs(d))}</span>${canSummary(d) ? '<button class="btn sm" data-card-act="sumkill">📝 Resumen y despedir</button>' : ''}` : ''}${canCompact(d) ? `<button class="btn sm" data-card-act="compact" title="Contexto al ${d.ctx.pct} %">🧹 Compactar</button>` : ''}<button class="btn sm" data-card-act="open">Ver</button><button class="btn sm" data-card-act="again" title="Nuevo encargo con lo mismo">↻ Otro igual</button>${docs ? `<button class="btn sm" data-card-act="docs">Documentos (${docs})</button>` : ''}<button class="btn sm danger" data-card-act="kill">Despedir</button>`;
  const stuck = isStuck(d), urg = urgency(d);
  const cls = ['rc', `g-${g}`, `s-${d.state}`, urg ? `urg-${urg}` : '', stuck ? 'stuck' : '', d.state === 'done' && d.critical > 0 ? 'crit' : '', st.selected === d.name ? 'sel' : '', cardUi.hl === d.name ? 'hl' : ''].filter(Boolean).join(' ');
  return `<article class="${cls}" data-card="${esc(d.name)}" id="card-${esc(d.name)}" tabindex="0" style="--c:${COLORS[d.color % COLORS.length]}">
    <div class="rc-h"><span class="rc-av">${robotSVG(COLORS[d.color % COLORS.length], lookOf(d.name, d.place, d))}</span>
      <div class="rc-t"><b>${esc(d.name)}</b>${titleOf(d) ? `<span class="rc-title${d.title ? '' : ' auto'}" title="${esc(d.title ? titleOf(d) : `Sugerido: ${titleOf(d)}`)}">📌 ${esc(titleOf(d))}</span>` : ''}<small title="${esc(d.label)}">${esc(d.label)}</small>${d.note ? `<span class="rc-note" title="${esc(d.note)}">🗒 ${esc(d.note)}</span>` : ''}</div>${pill}</div>
    <div class="rc-line ${toolClass(d) || ''}" title="${esc(line)}">${esc(line)}</div>
    <div class="rc-f"><span title="Tiempo desde que entró">⏱ <i data-start="${esc(d.startedAt || '')}">${d.startedAt ? fmtDur(Date.now() - Date.parse(d.startedAt)) : '–'}</i></span>
      ${stuck ? `<span class="rc-stuck" title="Sin herramientas, subagentes ni mensajes desde ${new Date(lastEventMs(d)).toTimeString().slice(0, 5)}. Puede estar en un comando largo o colgado: ábrelo para ver su consola.">⏸ sin actividad ${fmtDur(idleMs(d))}</span>` : ''}
      ${d.repo ? `<span class="rc-repo" title="Repo donde trabaja (sale de lo que edita o de la carpeta de su consola)">⎇ ${esc(d.repo)}</span>` : ''}<span title="Tokens de esta sesión">◆ ${fmtTok(tok)}</span>${spendChip(d)}${d.loop ? `<span class="rc-loop" title="Posible bucle: ${esc(d.loop.who)} repitió lo mismo ${d.loop.n} veces seguidas (${esc(d.loop.what)}). Si es una espera a propósito, ignóralo.">⟳ ×${d.loop.n}</span>` : ''}${subs ? `<span class="rc-subs" title="Subagentes trabajando">⑂ ${subs}</span>` : ''}${docs ? `<span title="Documentos escritos">▤ ${docs}</span>` : ''}</div>
    ${actions ? `<div class="rc-acts">${actions}</div>` : ''}
  </article>`;
}

// 2 · Filtro por repo: chips arriba de las tarjetas cuando hay robots en más de un repo. Se recuerda en el navegador;
// los robots de otros repos se atenúan en el mapa.
function repoBar(all) {
  const count = new Map();
  for (const a of all) { const r = a.data.repo || ''; count.set(r, (count.get(r) || 0) + 1); }
  const repos = [...count.keys()].filter(Boolean).sort();
  if (cardUi.repo && !count.has(cardUi.repo === '—' ? '' : cardUi.repo)) cardUi.repo = ''; // ese repo ya no tiene robots
  if (repos.length + (count.has('') ? 1 : 0) < 2) { cardUi.repo = ''; return ''; }
  const chip = (v, label, n) => `<button type="button" class="rf-chip${cardUi.repo === v ? ' on' : ''}" data-repo-filter="${esc(v)}" aria-pressed="${cardUi.repo === v}">${esc(label)} <small>${n}</small></button>`;
  return `<div class="repo-bar" role="toolbar" aria-label="Filtrar por repo">${chip('', 'Todos', all.length)}${repos.map(r => chip(r, '⎇ ' + r, count.get(r))).join('')}${count.has('') ? chip('—', 'sin repo', count.get('')) : ''}</div>`;
}
const repoMatch = d => !cardUi.repo || (cardUi.repo === '—' ? !d.repo : d.repo === cardUi.repo);
function dimByRepo() { for (const a of st.robots.values()) a.el.classList.toggle('repo-dim', !repoMatch(a.data)); }
function renderCards() {
  const everyone = [...st.robots.values()];
  const bar = repoBar(everyone);
  const all = everyone.filter(a => repoMatch(a.data));
  dimByRepo();
  const by = {need: [], work: [], done: []};
  for (const a of all) by[groupOf(a.data)].push(a);
  const t = (a, k) => Date.parse(a.data[k] || 0) || 0;
  by.need.sort((x, y) => t(x, 'inputAt') - t(y, 'inputAt')); // el que más lleva esperando, primero
  by.work.sort((x, y) => t(x, 'startedAt') - t(y, 'startedAt'));
  by.done.sort((x, y) => t(y, 'startedAt') - t(x, 'startedAt'));
  // Plegados por defecto; si no hay nadie más en la oficina, abiertos (y lo que elijas se recuerda).
  const doneOpen = prefGet('doneOpen', by.need.length + by.work.length ? '0' : '1') === '1';
  const sec = (key, title, list, hint) => list.length ? `<section class="rc-sec sec-${key}" id="sec-${key}"><h4>${title} <small>${list.length}</small></h4>${list.map(cardHtml).join('')}</section>` : (hint ? `<section class="rc-sec sec-${key}" id="sec-${key}"><h4>${title}</h4><p class="rc-empty">${hint}</p></section>` : '');
  const html = !all.length
    ? `<div class="rc-zero"><b>La oficina está vacía</b><p>Lanza un encargo o haz clic en un robot de la sala de descanso.</p><button class="btn primary" data-card-act="new">Nuevo encargo</button></div>`
    : bar + sec('need', '✋ Te necesitan', by.need, 'Nadie te espera.') + sec('work', '⚙ Trabajando', by.work, '') +
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
  }
  cardUi.hl = name;
}
CARDS.addEventListener('mouseover', e => { const c = e.target.closest('[data-card]'); if (c) highlight(c.dataset.card); });
CARDS.addEventListener('mouseleave', () => highlight(null));
CARDS.addEventListener('click', e => {
  const f = e.target.closest('[data-repo-filter]'); if (!f) return;
  e.stopPropagation();
  cardUi.repo = cardUi.repo === f.dataset.repoFilter ? '' : f.dataset.repoFilter;
  try { localStorage.setItem('office.repoFilter', cardUi.repo); } catch { /* sin almacenamiento */ }
  renderCards();
}, true);
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
      case 'compact': return a && compact(a.data.name);
      case 'revive': return a && revive(a.data.name, b);
      case 'sumkill': return a && sumKill(a.data.name);
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
