/* ---------- right column: Robots / Salas / Rutinas tabs ---------- */
// Robots keeps the urgency-ordered cards (06-tarjetas.js). Salas and Rutinas are compact lists: clicking a room enters
// it, clicking a routine opens it. The chosen tab is remembered in localStorage; every tab shows a counter, in amber
// when something in it needs you.
const COL_TABS = ['robots', 'salas', 'rutinas'];
const colUi = { tab: 'robots' };
try {
  const t = localStorage.getItem('office.colTab');
  if (COL_TABS.includes(t)) colUi.tab = t;
} catch {
  /* no storage: the default tab */
}
const COL_PANE = { robots: CARDS, salas: $('#pane-salas'), rutinas: $('#pane-rutinas') };

function setColTab(tab, remember = true) {
  if (!COL_TABS.includes(tab)) return;
  colUi.tab = tab;
  if (remember) {
    try {
      localStorage.setItem('office.colTab', tab);
    } catch {
      /* no storage */
    }
  }
  for (const t of COL_TABS) {
    COL_PANE[t].hidden = t !== tab;
    const b = $('#ctab-' + t);
    b.classList.toggle('on', t === tab);
    b.setAttribute('aria-selected', String(t === tab));
    b.tabIndex = t === tab ? 0 : -1;
  }
}

// A routine «needs you» when its last run failed.
const routineNeeds = rt => !!rt.lastRun?.error;
const routineRank = rt => (rt.fired || rt.doneOnce ? 2 : rt.paused ? 1 : 0);

function salasPaneHtml() {
  const rows = st.salas
    .map(s => {
      const { bots, n, needers, need, done, prog, tone } = salaInfo(s);
      const faces = bots
        .slice(0, 6)
        .map(a => {
          const d = a.data;
          return `<span class="sn-bot${d.state === 'done' ? ' ok' : ''}">${robotHead(COLORS[d.color % COLORS.length], lookOf(d.name, d.place, d))}${d.state === 'done' ? '<b aria-hidden="true">✓</b>' : ''}</span>`;
        })
        .join('');
      const more = n > 6 ? `<span class="sn-more">+${n - 6}</span>` : '';
      const state = need
        ? `${icon('warn')} ${need === 1 ? `${esc(needers[0].name)} ${needWhy(needers[0])}` : `${need} te necesitan`}`
        : done
          ? '✓ terminó'
          : prog
            ? `${prog.ok}/${prog.n} entregaron`
            : n
              ? `${n} robot${n === 1 ? '' : 's'}`
              : 'sin robots';
      return `<div class="sala-row sn-${tone}${st.view === s.id ? ' cur' : ''}" data-sala-go="${esc(s.id)}" role="button" tabindex="0" title="Entrar a la sala${s.owner ? ` · la armó ${esc(s.owner)}` : ' · sala de épica creada por ti'} · ${esc(s.auto ? 'equipo' : s.key || 'sin clave')}"><span class="sala-face">${salaFace(s)}</span><b class="sn-name">${esc(s.name)}</b><span class="sn-state">${state}</span><span class="sn-bots">${faces}${more}</span>${prog ? `<i class="rchip-bar${prog.ok === prog.n ? ' full' : ''}" style="--p:${Math.round((prog.ok * 100) / prog.n)}%" aria-hidden="true"></i>` : ''}</div>`;
    })
    .join('');
  return `${rows || '<p class="rc-empty">Sin salas. Crea una por épica de Jira.</p>'}<button type="button" class="btn sm ghost" data-col-new="salas">+ Nueva sala</button>`;
}
function rutinasPaneHtml() {
  const rows = [...st.routines]
    .sort((a, b) => routineRank(a) - routineRank(b))
    .map(
      rt =>
        `<div class="rt-row${rt.paused ? ' paused' : ''}${routineNeeds(rt) ? ' bad' : ''}" data-rt-go="${esc(rt.id)}" role="button" tabindex="0" title="Abrir la rutina"><div class="ring ${rt.paused ? 'paused' : ''} ${rt.running ? 'running' : ''}" data-ring="${esc(rt.id)}"></div><b class="rr-n">${esc(rt.name)}</b><small data-next="${esc(rt.id)}"></small></div>`
    )
    .join('');
  return `${rows || '<p class="rc-empty">Sin rutinas. Crea una para que la oficina vigile o programe algo por ti.</p>'}<button type="button" class="btn sm ghost" data-col-new="rutinas">+ Nueva rutina</button>`;
}

function renderColumn() {
  for (const [key, html] of [
    ['salas', salasPaneHtml()],
    ['rutinas', rutinasPaneHtml()]
  ]) {
    const box = COL_PANE[key];
    if (box._html !== html) {
      box._html = html;
      box.innerHTML = html;
    }
  }
  tickRoutines(); // fill the freshly drawn rings and «next run» texts
  const set = (key, n, needs) => {
    const b = $('#ct-' + key);
    b.textContent = n || '';
    b.hidden = !n;
    b.classList.toggle('need', !!needs);
  };
  const robots = [...st.robots.values()];
  set(
    'robots',
    robots.length,
    robots.some(a => groupOf(a.data) === 'need')
  );
  set(
    'salas',
    st.salas.length,
    st.salas.some(s => salaInfo(s).need)
  );
  set('rutinas', st.routines.filter(r => !r.paused).length, st.routines.some(routineNeeds));
}

for (const b of document.querySelectorAll('[data-ctab]'))
  b.addEventListener('click', () => {
    setColTab(b.dataset.ctab);
  });
$('.ctabs').addEventListener('keydown', e => {
  const i = COL_TABS.indexOf(colUi.tab),
    step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
  if (!step) return;
  e.preventDefault();
  const next = COL_TABS[(i + step + COL_TABS.length) % COL_TABS.length];
  setColTab(next);
  $('#ctab-' + next).focus();
});

function openRoutine(id) {
  const rt = st.routines.find(x => x.id === id);
  if (!rt) return;
  select('@cron');
  rtUi.edit = id;
  rtUi.preview = '';
  PANEL.dataset.view = '';
  renderPanel();
  fillRoutineForm(rt, false);
  $('#rt-form', PANEL)?.scrollIntoView({ block: 'start' });
}
function colOpen(e) {
  const sala = e.target.closest('[data-sala-go]');
  if (sala) return enterSala(sala.dataset.salaGo);
  const rt = e.target.closest('[data-rt-go]');
  if (rt) return openRoutine(rt.dataset.rtGo);
  const nw = e.target.closest('[data-col-new]');
  if (nw) return select(nw.dataset.colNew === 'salas' ? '@war' : '@cron');
}
for (const pane of [COL_PANE.salas, COL_PANE.rutinas]) {
  pane.addEventListener('click', colOpen);
  pane.addEventListener('keydown', e => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[role=button]')) {
      e.preventDefault();
      colOpen(e);
    }
  });
}
setColTab(colUi.tab, false);
