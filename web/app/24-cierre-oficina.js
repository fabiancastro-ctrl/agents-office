/* ---------- 1 · cierre del día ---------- */
// Todo lo que queda abierto en una sola vista, armada con lo que la oficina ya sabe (no le pregunta nada a Claude):
// quién te espera, quién terminó hace rato, documentos sin leer, salas en curso, encargos en la puerta y mensajes por
// enviar. Desde aquí se despide o se abre cada cosa.
const cierreUi = { armed: false, t: 0 };
function cierrePanel() {
  const ds = [...st.robots.values()].map(a => a.data);
  const ago = iso => {
    const t = Date.parse(iso || '');
    return t ? fmtDur(Date.now() - t) : '–';
  };
  const busyKids = d => (d.kids || []).some(k => k.state === 'queued' || (k.name && !st.robots.get(k.name)?.data.reported));
  const need = ds.filter(d => d.state === 'input' || d.spawnReq || d.consoleLost);
  const hold = ds.filter(onHold);
  const done = ds.filter(d => d.state === 'done' && !d.spawnReq && !d.consoleLost && !onHold(d));
  const canGo = done.filter(d => !busyKids(d));
  const work = ds.filter(d => ['working', 'delegating', 'walking'].includes(d.state));
  const salasOpen = st.salas.map(s => ({ s, p: salaProgress(s), n: salaRobots(s.id).length }));
  const row = (d, extra, acts) =>
    `<div class="item cz-row"><div class="meta-i"><b>${esc(d.name)}</b><div>${esc(titleOf(d) || d.label)}${extra ? ' · ' + extra : ''}</div></div><div class="row">${acts}</div></div>`;
  const open = d => `<button type="button" class="btn sm" data-cz-open="${esc(d.name)}">Abrir</button>`;
  const sec = (title, n, body, empty) =>
    `<section class="dlg-sec"><h4>${title}${n ? ` <small>${n}</small>` : ''}</h4>${n ? body : `<p class="note">${empty}</p>`}</section>`;
  const unread = unseen(),
    door = st.door.length,
    pinsN = st.pins.length;
  const clear = !need.length && !done.length && !hold.length && !work.length && !st.salas.length && !unread && !door && !pinsN;
  return `<div class="dlg-head"><h3>${icon('moon')} Cierre del día</h3><p>Lo que queda abierto en la oficina, para dejar todo en orden antes de irte. Sale de lo que la oficina ya sabe: no gasta tokens.</p></div>
    ${clear ? '<section class="dlg-sec"><p class="cz-ok">✓ Todo en orden: no queda nada abierto.</p></section>' : ''}
    ${sec(`${icon('hand')} Te esperan`, need.length, `<div class="list">${need.map(d => row(d, d.consoleLost ? 'consola caída' : d.spawnReq ? 'pide robots' : d.ask ? 'te hizo una pregunta' : d.hold || d.needsPermission ? 'pide permiso' : 'espera tu respuesta', `${d.inputAt ? `<span class="pill p-input">${fmtDur(Date.now() - Date.parse(d.inputAt))}</span>` : ''}${open(d)}`)).join('')}</div>`, 'Nadie te espera.')}
    ${sec(
      '✓ Listos',
      done.length,
      `<div class="list">${done.map(d => row(d, `terminó hace ${ago(d.lastEventAt || d.timeline?.at(-1)?.at)}${d.docs.length ? ` · ▤ ${d.docs.length}` : ''}${busyKids(d) ? ' · sus hijos siguen' : ''}`, `${open(d)}${busyKids(d) ? '' : `<button type="button" class="btn sm danger" data-cz-kill="${esc(d.name)}" title="Dar de baja sin resumen (sus documentos pendientes pasan a la bandeja)">Despedir</button>`}`)).join('')}</div>
      ${canGo.length > 1 ? `<div class="row cz-bulk"><button type="button" class="btn sm danger${cierreUi.armed ? ' armed' : ''}" data-cz-killall>${cierreUi.armed ? `¿Seguro? Clic otra vez para despedir a ${canGo.length}` : `${icon('hand')} Despedir a los ${canGo.length} listos`}</button><span class="note">Sin resumen. Los que tienen hijos trabajando se quedan.</span></div>` : ''}`,
      'Nadie terminó y quedó esperando.'
    )}
    ${sec(`${icon('hourglass')} En espera`, hold.length, `<div class="list">${hold.map(d => row(d, esc(holdText(d)), open(d))).join('')}</div><p class="note">Dejaron algo corriendo de fondo (una shell, un monitor, un despertador): siguen solos cuando eso termine.</p>`, 'Nadie dejó tareas de fondo corriendo.')}
    ${sec(`${icon('gear')} Siguen trabajando`, work.length, `<p class="note">${work.map(d => `<b>${esc(d.name)}</b>${d.repo ? ` (${icon('branch')} ${esc(d.repo)})` : ''}`).join(' · ')} — seguirán aunque cierres la página.</p>`, 'Nadie está trabajando.')}
    ${sec(`${icon('door')} Salas en curso`, salasOpen.length, `<div class="list">${salasOpen.map(({ s, p, n }) => `<div class="item cz-row"><div class="meta-i"><b>${esc(s.name)}</b><div>${n} robot${n === 1 ? '' : 's'}${p ? ` · ${p.ok}/${p.n} entregaron` : ''}${s.done ? ' · ✓ terminó' : ''}${s.notes?.length ? ` · ${icon('pin')} ${s.notes.length} nota${s.notes.length === 1 ? '' : 's'} tuya${s.notes.length === 1 ? '' : 's'}` : ''}</div></div><div class="row"><button type="button" class="btn sm" data-cz-sala="${esc(s.id)}">Entrar</button></div></div>`).join('')}</div>`, 'No hay salas abiertas.')}
    <section class="dlg-sec"><h4>${icon('inbox')} Pendientes tuyos</h4><div class="cz-mini">
      <button type="button" class="btn sm" data-cz-go="@inbox" ${unread ? '' : 'disabled'}>Bandeja: ${unread} sin leer</button>
      <button type="button" class="btn sm" data-cz-go="@pins" ${pinsN ? '' : 'disabled'}>${icon('pin')} Para enviar: ${pinsN}</button>
      <button type="button" class="btn sm" data-cz-door ${door ? '' : 'disabled'}>${icon('door')} En la puerta: ${door}</button>
    </div></section>`;
}
PANEL.addEventListener('click', async e => {
  if (st.selected !== '@cierre') return;
  const o = e.target.closest('[data-cz-open]');
  if (o) return select(o.dataset.czOpen);
  const g = e.target.closest('[data-cz-go]');
  if (g) return select(g.dataset.czGo);
  if (e.target.closest('[data-cz-door]')) return $('#btn-door').click();
  const sl = e.target.closest('[data-cz-sala]');
  if (sl) {
    select(null);
    return enterSala(sl.dataset.czSala);
  }
  const k = e.target.closest('[data-cz-kill]');
  if (k) {
    k.disabled = true;
    try {
      await api('DELETE', `/api/robots/${k.dataset.czKill}`);
      toast(`Despedí a ${k.dataset.czKill}`);
    } catch {
      k.disabled = false;
    }
    return;
  }
  const all = e.target.closest('[data-cz-killall]');
  if (all) {
    if (!cierreUi.armed) {
      cierreUi.armed = true;
      clearTimeout(cierreUi.t);
      cierreUi.t = setTimeout(() => {
        cierreUi.armed = false;
        if (st.selected === '@cierre') renderPanel();
      }, 3000);
      return renderPanel();
    }
    cierreUi.armed = false;
    all.disabled = true;
    const ds = [...st.robots.values()].map(a => a.data);
    const go = ds.filter(
      d =>
        d.state === 'done' &&
        !d.spawnReq &&
        !d.consoleLost &&
        !onHold(d) &&
        !(d.kids || []).some(k2 => k2.state === 'queued' || (k2.name && !st.robots.get(k2.name)?.data.reported))
    );
    let n = 0;
    for (const d of go) {
      try {
        await api('DELETE', `/api/robots/${d.name}`);
        n++;
      } catch {
        /* toast ya mostrado */
      }
    }
    toast(`Despedí a ${n} robot${n === 1 ? '' : 's'}. ¡Buen cierre!`);
  }
});
$('#btn-cierre').addEventListener('click', () => select('@cierre'));

/* ---------- 3 · salud, 4 · limpieza y 7 · respaldo ---------- */
const oficinaUi = { h: null, loading: false, err: '', cleanArmed: false, imp: null };
async function loadSalud() {
  oficinaUi.loading = true;
  oficinaUi.err = '';
  try {
    oficinaUi.h = await api('GET', '/api/salud');
  } catch (e) {
    oficinaUi.err = e.message || 'No pude leer la salud de la oficina.';
  }
  oficinaUi.loading = false;
  syncSaludChip();
  if (st.selected === '@oficina') renderPanel();
}
const fmtBytesW = n =>
  n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n >= 1e3 ? `${Math.round(n / 1e3)} KB` : `${n} B`;
function syncSaludChip() {
  const b = $('#btn-salud'),
    h = oficinaUi.h;
  if (!b || !h) return;
  const bad = h.checks.filter(c => !c.ok).length;
  b.classList.toggle('warn', !!bad);
  $('#btn-more')?.classList.toggle('warn', !!bad); // the dot on «☰ Más» tells there is something in Salud
  b.innerHTML = `${icon('pulse')} ${bad ? `Salud · ${bad} aviso${bad === 1 ? '' : 's'}` : 'Salud'}`;
}
function oficinaPanel() {
  const h = oficinaUi.h;
  if (!h) return `<div class="dlg-head"><h3>${icon('pulse')} Oficina</h3></div><p>${oficinaUi.err ? esc(oficinaUi.err) : `<span aria-busy="true" aria-label="Revisando">${skeleton(6)}</span>`}</p>`;
  const up = fmtDur(h.daemon.upMs);
  const checks = h.checks
    .map(
      c =>
        `<div class="hl-row ${c.ok ? 'ok' : 'bad'}"><i>${c.ok ? '✓' : '!'}</i><div><b>${esc(c.label)}</b><span>${esc(c.detail)}</span>${c.fix ? `<small>${esc(c.fix)}</small>` : ''}</div></div>`
    )
    .join('');
  const bots = h.robots.length
    ? `<table class="usage hl-bots"><thead><tr><th>Robot</th><th>Estado</th><th>Último hook</th><th>Consola</th></tr></thead><tbody>${h.robots.map(r => `<tr><td>${esc(r.name)}</td><td>${esc(STATE_LABEL[r.state] || r.state)}</td><td>${r.lastEventAt ? `hace ${esc(fmtDur(Date.now() - Date.parse(r.lastEventAt)))}` : '–'}</td><td>${r.console ? '✓' : '⚠ sin consola'}</td></tr>`).join('')}</tbody></table>`
    : '';
  const kinds = {};
  for (const c of h.candidates) {
    const k = (kinds[c.kind] ||= { n: 0, size: 0 });
    k.n++;
    k.size += c.size;
  }
  const cand = Object.entries(kinds)
    .map(([k, v]) => `<li><b>${esc(k)}</b>: ${v.n} · ${fmtBytesW(v.size)}</li>`)
    .join('');
  const c = h.clean || {};
  const imp = oficinaUi.imp;
  return `<div class="dlg-head"><h3>${icon('pulse')} Oficina</h3><p>Salud, limpieza y respaldo de esta oficina. Nada de esto gasta tokens: lee archivos y tmux, sin abrir /usage ni escribirle a los robots.</p></div>
    <section class="dlg-sec"><div class="row between"><h4>Salud</h4><button type="button" class="btn sm" data-of="recheck" ${oficinaUi.loading ? 'disabled' : ''}>${oficinaUi.loading ? 'Revisando…' : 'Revisar otra vez'}</button></div>
      <div class="hl-list">${checks}</div>${bots}
      <p class="note">Daemon pid ${h.daemon.pid} · puerto ${h.daemon.port} · Node ${esc(h.daemon.node)} · encendido hace ${esc(up)} · datos en <code>${esc(h.daemon.data)}</code></p></section>
    <section class="dlg-sec"><h4>Limpieza</h4>
      <p>La carpeta de datos ocupa <b>${fmtBytesW(h.total)}</b>. ${h.freeable ? `Con más de <b>${c.days}</b> días se pueden llevar a la Papelera <b>${fmtBytesW(h.freeable)}</b>:` : `No hay nada de más de ${c.days} días para limpiar.`}</p>
      ${cand ? `<ul class="cl-list">${cand}</ul>` : ''}
      <div class="row cl-row"><label>Más viejo que <select id="cl-days" data-of="days">${(c.options || [3, 7, 14, 30]).map(d => `<option value="${d}"${d === c.days ? ' selected' : ''}>${d} días</option>`).join('')}</select></label>
        <label class="check"><input type="checkbox" id="cl-auto" data-of="auto"${c.auto ? ' checked' : ''}> Limpiar sola una vez por semana</label>
        <button type="button" class="btn sm danger${oficinaUi.cleanArmed ? ' armed' : ''}" data-of="clean" ${h.freeable ? '' : 'disabled'}>${oficinaUi.cleanArmed ? '¿Seguro? Clic otra vez' : `${icon('broom')} Limpiar ahora`}</button></div>
      <p class="note">Va a la Papelera (se recupera de ahí). Nunca toca lo de hoy, lo de un robot que está en la oficina, las salas abiertas o archivadas, tus rutinas ni tus estadísticas. De los eventos crudos se guarda antes lo que arma el uso por semana.${c.last ? ` Última limpieza: ${esc(new Date(c.last).toLocaleString('es'))} (${c.lastMoved || 0} elementos, ${fmtBytesW(c.lastBytes || 0)}).` : ''}</p></section>
    <section class="dlg-sec"><h4>Respaldo</h4>
      <p>Guarda en un archivo tus rutinas, encargos frecuentes, mensajes «para enviar», el nombre, estilo y tope de la oficina y la apariencia de los robots que están ahora. Sirve para pasarlos a otro computador o a otra oficina.</p>
      <div class="row"><a class="btn sm" href="/api/respaldo" download>${icon('down')} Descargar respaldo</a><label class="btn sm" for="bk-file">${icon('up')} Importar respaldo…</label><input type="file" id="bk-file" accept=".json,application/json" hidden></div>
      ${
        imp
          ? `<div class="bk-imp"><p><b>${esc(imp.file)}</b> (de ${esc(new Date(imp.data.at).toLocaleString('es'))}): ${imp.data.routines?.length || 0} rutinas · ${imp.data.favorites?.length || 0} frecuentes · ${imp.data.pins?.length || 0} para enviar · ${Object.keys(imp.data.looks || {}).length} apariencias.</p>
        <div class="cz-mini">${[
          ['routines', 'Rutinas (llegan en pausa)'],
          ['favorites', 'Encargos frecuentes'],
          ['pins', 'Para enviar'],
          ['office', 'Nombre, estilo y tope'],
          ['looks', 'Apariencias (robots con el mismo nombre)']
        ]
          .map(([k, l]) => `<label class="check"><input type="checkbox" name="bk-part" value="${k}" checked> ${l}</label>`)
          .join('')}</div>
        <div class="row"><button type="button" class="btn sm primary" data-of="import">Importar</button><button type="button" class="btn sm ghost" data-of="import-cancel">Cancelar</button></div>
        <p class="note">Se suma a lo que ya tienes: no borra ni reemplaza nada.</p></div>`
          : ''
      }</section>`;
}
PANEL.addEventListener('click', async e => {
  if (st.selected !== '@oficina') return;
  const b = e.target.closest('[data-of]');
  if (!b || b.tagName === 'SELECT' || b.tagName === 'INPUT') return;
  const act = b.dataset.of;
  if (act === 'recheck') return loadSalud();
  if (act === 'clean') {
    if (!oficinaUi.cleanArmed) {
      oficinaUi.cleanArmed = true;
      renderPanel();
      setTimeout(() => {
        oficinaUi.cleanArmed = false;
        if (st.selected === '@oficina') renderPanel();
      }, 3000);
      return;
    }
    oficinaUi.cleanArmed = false;
    b.disabled = true;
    try {
      const r = await api('POST', '/api/limpieza', { run: true, days: Number($('#cl-days').value) });
      toast(
        `Llevé ${r.moved} elemento${r.moved === 1 ? '' : 's'} a la Papelera (${fmtBytesW(r.bytes)}).${r.errors.length ? ` ${r.errors.length} no se pudieron mover.` : ''}`,
        'broom'
      );
    } catch {
      /* toast ya mostrado */
    }
    return loadSalud();
  }
  if (act === 'import-cancel') {
    oficinaUi.imp = null;
    return renderPanel();
  }
  if (act === 'import') {
    const parts = [...PANEL.querySelectorAll('input[name=bk-part]:checked')].map(x => x.value);
    if (!parts.length) return toast('Marca al menos una parte para importar.');
    b.disabled = true;
    try {
      const r = await api('POST', '/api/respaldo', { data: oficinaUi.imp.data, parts });
      toast(
        `Importé ${r.routines} rutina${r.routines === 1 ? '' : 's'}, ${r.favorites} frecuente${r.favorites === 1 ? '' : 's'}, ${r.pins} para enviar${r.office ? ', la oficina' : ''} y ${r.looks} apariencia${r.looks === 1 ? '' : 's'}.`
      );
      oficinaUi.imp = null;
      renderPanel();
    } catch {
      b.disabled = false;
    }
  }
});
PANEL.addEventListener('change', async e => {
  if (st.selected !== '@oficina') return;
  if (e.target.id === 'cl-days' || e.target.id === 'cl-auto') {
    try {
      await api('POST', '/api/limpieza', { days: Number($('#cl-days').value), auto: $('#cl-auto').checked });
    } catch {
      /* toast ya mostrado */
    }
    return loadSalud();
  }
  if (e.target.id === 'bk-file') {
    const f = e.target.files?.[0];
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      if (data?.app !== 'agent-office') throw new Error();
      oficinaUi.imp = { file: f.name, data };
      renderPanel();
    } catch {
      toast('Ese archivo no es un respaldo de la oficina.');
    }
    e.target.value = '';
  }
});
$('#btn-salud').addEventListener('click', () => select('@oficina'));
setTimeout(loadSalud, 4000); // al abrir la página, para el aviso del botón; después cada 10 min
setInterval(() => {
  if (!document.hidden) loadSalud();
}, 600e3);

/* ---------- 5 · temporadas ---------- */
// Decoración de la oficina según la fecha (los robots ya se ponen gorro de temporada): luces y arbolito en diciembre,
// calabazas a fines de octubre, confeti en Año Nuevo y globos en el aniversario de la oficina. Solo visual.
function seasonOf(t = new Date()) {
  const m = t.getMonth(),
    d = t.getDate();
  if (m === 11 || (m === 0 && d <= 6)) return m === 0 || d === 31 ? 'nuevo' : 'navidad';
  if (m === 9 && d >= 24) return 'halloween';
  return '';
}
function renderSeason() {
  const forced = (() => {
    try {
      return localStorage.getItem('office.season');
    } catch {
      return null;
    }
  })();
  const born = st.config?.createdAt ? new Date(st.config.createdAt) : null,
    t = new Date();
  const anniv = born && born.getMonth() === t.getMonth() && born.getDate() === t.getDate() && born.getFullYear() < t.getFullYear();
  const s = forced ?? (anniv ? 'aniversario' : seasonOf(t));
  if (MAP.dataset.season === s) return;
  MAP.dataset.season = s;
  MAP.querySelectorAll('.season').forEach(x => x.remove());
  if (!s) return;
  const brk = MAP.querySelector('[data-room=break]');
  const add = (cls, html, host = MAP) => {
    const el = document.createElement('div');
    el.className = 'season ' + cls;
    el.setAttribute('aria-hidden', 'true');
    el.innerHTML = html;
    host.appendChild(el);
    return el;
  };
  if (s === 'navidad' || s === 'nuevo') add('s-lights', Array.from({ length: 28 }, (_, i) => `<i style="--i:${i}"></i>`).join(''));
  if (s === 'navidad' && brk) add('s-tree', '<b>★</b><i></i><i></i><i></i><u></u>', brk);
  if (s === 'nuevo') add('s-confetti', Array.from({ length: 26 }, (_, i) => `<i style="--i:${i};--x:${(i * 37) % 100}%"></i>`).join(''));
  if (s === 'halloween' && brk) add('s-pumpkins', '<i>🎃</i><i>🎃</i><i>🦇</i>', brk);
  if (s === 'aniversario')
    add(
      's-anniv',
      `<span>🎈</span><span>🎂 ${t.getFullYear() - born.getFullYear()} año${t.getFullYear() - born.getFullYear() === 1 ? '' : 's'} de oficina</span><span>🎈</span>`
    );
}
setInterval(renderSeason, 3600e3);
setTimeout(renderSeason, 1500);
