/* ---------- cola de los que te esperan ---------- */
// By priority (p0, p1, normal), then from the one waiting longest to the most recent. S jumps to the next one;
// after approving or denying with A/D it moves on by itself.
const waitingList = () =>
  [...st.robots.values()]
    .map(a => a.data)
    .filter(d => d.state === 'input' || d.spawnReq)
    .sort((x, y) => prioRank(x.priority) - prioRank(y.priority) || (Date.parse(x.inputAt || '') || 0) - (Date.parse(y.inputAt || '') || 0))
    .map(d => d.name);
function nextWaiting(from) {
  const l = waitingList();
  if (!l.length) return null;
  const i = l.indexOf(from);
  return i < 0 ? l[0] : l.length > 1 ? l[(i + 1) % l.length] : null;
}
function goNextWaiting() {
  const n = nextWaiting(st.selected);
  if (n) select(n);
  else toast(waitingList().length ? 'Es el único que te espera' : 'Nadie te está esperando');
}
function queueBar(d) {
  const l = waitingList(),
    others = l.filter(n => n !== d.name).length;
  if (!others) return '';
  const pos = l.indexOf(d.name);
  return `<div class="qbar" id="qbar"><b>${pos >= 0 ? `${pos + 1} de ${l.length}` : `${others}`}</b> ${pos >= 0 ? 'te esperan' : others === 1 ? 'robot más te espera' : 'robots más te esperan'}<span class="qk"><kbd>A</kbd> aprobar · <kbd>D</kbd> denegar · <kbd>S</kbd> siguiente</span>${repeatedPermButton(d)}<button type="button" class="btn sm" data-act="qnext">Siguiente ›</button></div>`;
}
// Same pending permission (same tool and same command or path, as described by the daemon) in 2 or more robots.
const permKeyOf = d => d.hold?.tool || (d.needsPermission && d.state === 'input' ? d.activity : '') || '';
const repeatedPerm = d => {
  const key = permKeyOf(d);
  if (!key) return [];
  const same = [...st.robots.values()].map(a => a.data).filter(x => permKeyOf(x) === key);
  return same.length > 1 ? same : [];
};
const repeatedPermButton = d => {
  const n = repeatedPerm(d).length;
  return n
    ? `<button type="button" class="btn sm" data-act="perm-all" data-n="${n}" title="Aprueba el mismo permiso en los ${n} robots que lo piden: ${esc(permKeyOf(d))}">Aprobar en todos (${n})</button>`
    : '';
};
async function decide(d, allow) {
  if (d.spawnReq) {
    await decideSpawn(d, allow);
    return true;
  }
  if (d.hold) await api('POST', `/api/decision/${d.hold.id}`, { decision: allow ? 'allow' : 'deny' });
  else if (d.needsPermission) await api('POST', `/api/robots/${d.name}/permission`, { decision: allow ? 'approve' : 'reject' });
  else return false;
  return true;
}

/* ---------- buscador en todas las conversaciones ---------- */
const searchUi = { q: '', t: 0 };
const norm = s =>
  String(s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
function snippet(text, qn) {
  const plain = plainMd(text),
    i = norm(plain).indexOf(qn);
  if (i < 0) return null;
  const a = Math.max(0, i - 60),
    b = Math.min(plain.length, i + qn.length + 90);
  return `${a ? '…' : ''}${esc(plain.slice(a, i))}<mark>${esc(plain.slice(i, i + qn.length))}</mark>${esc(plain.slice(i + qn.length, b))}${b < plain.length ? '…' : ''}`;
}
function searchResults(q) {
  const qn = norm(q.trim());
  if (qn.length < 2)
    return '<p class="muted">Escribe al menos 2 letras. Busca en lo que dijeron los robots y lo que les escribiste, también en las salas (abiertas y cerradas).</p>';
  const groups = [];
  for (const a of st.robots.values()) {
    const hits = [];
    a.log.forEach((l, i) => {
      if (l.kind === 'tool' || hits.length >= 25) return;
      const sn = snippet(l.text, qn);
      if (sn) hits.push({ i, l, sn });
    });
    if (hits.length)
      groups.push({
        key: a.data.name,
        head: `${robotHead(COLORS[a.data.color % COLORS.length], lookOf(a.data.name, a.data.place, a.data))}<b>${esc(a.data.name)}</b>${titleOf(a.data) ? `<small>${icon('pin')} ${esc(titleOf(a.data))}</small>` : ''}`,
        hits,
        robot: a.data.name
      });
  }
  for (const s of st.salas) {
    const hits = [];
    s.thread.forEach((m, i) => {
      if (hits.length >= 25) return;
      const sn = snippet(m.text, qn);
      if (sn) hits.push({ i, l: { at: m.at, kind: m.from === 'Coordinador' ? 'user' : 'agent', who: m.from }, sn });
    });
    if (hits.length) groups.push({ key: '@sala:' + s.id, head: `<b>Sala «${esc(s.name)}»</b>`, hits });
  }
  if (!groups.length)
    return `<p class="muted">Nada con «${esc(q.trim())}» en las conversaciones de los robots que están en la oficina.</p>`;
  const total = groups.reduce((k, g) => k + g.hits.length, 0);
  return (
    `<p class="muted">${total} resultado${total === 1 ? '' : 's'} en ${groups.length} ${groups.length === 1 ? 'conversación' : 'conversaciones'}</p>` +
    groups
      .map(
        g =>
          `<section class="sr-g"><h4>${g.head}</h4>${g.hits.map(h => `<button type="button" class="sr-hit" data-jump="${esc(g.key)}" data-i="${h.i}"><span class="sr-w">${esc(h.l.who || (h.l.kind === 'user' ? 'Tú' : h.l.kind === 'agent' ? g.robot || '' : KIND_LABEL[h.l.kind] || h.l.kind))} · ${hhmm(h.l.at)}</span><span class="sr-t">${h.sn}</span></button>`).join('')}</section>`
      )
      .join('')
  );
}
function searchPanel() {
  return `<div class="dlg-head"><h3>${icon('search')} Buscar en las conversaciones</h3></div>
    <form class="srch" id="search-form" role="search"><input id="search-in" type="search" placeholder="wallet#32, crítico, el nombre de un PR…" autocomplete="off" spellcheck="false"></form>
    <div class="sr" id="search-res">${searchResults(searchUi.q)}</div>
    <div class="sr" id="search-arch"></div>`;
}
// Robots que ya se fueron: el daemon guarda su resumen al darlos de baja y busca ahí (sin tildes ni mayúsculas).
async function searchArchive() {
  const box = $('#search-arch', PANEL);
  if (!box) return;
  const q = searchUi.q.trim();
  try {
    const r = await (await fetch(q.length >= 2 ? `/api/despedidos?q=${encodeURIComponent(q)}` : '/api/despedidos')).json();
    if ($('#search-arch', PANEL) !== box || searchUi.q.trim() !== q) return;
    const av = a => robotHead(COLORS[(a.color || 0) % COLORS.length], lookOf(a.name, null, { look: a.look }));
    const when = a => fmtWhen(a.leftAt);
    if (!q || q.length < 2) {
      box.innerHTML = r.recent?.length
        ? `<section class="sr-g"><h4>Se fueron hace poco <small>${r.total} en el archivo · ábrelos para ver su resumen o retomarlos</small></h4>${r.recent
            .slice(0, 12)
            .map(
              a =>
                `<button type="button" class="sr-hit" data-arch="${esc(a.id)}"><span class="sr-w">${av(a)}${esc(a.name)} · se fue ${when(a)}</span><span class="sr-t">${esc(a.title || a.label)}${a.note ? ` · ${icon('memo')} ${esc(a.note)}` : ''}</span></button>`
            )
            .join('')}</section>`
        : '';
      return;
    }
    const qn = norm(q);
    box.innerHTML = r.results.length
      ? `<h4 class="sr-sep">Robots que ya se fueron</h4>` +
        r.results
          .map(
            a =>
              `<section class="sr-g"><h4>${av(a)}<b>${esc(a.name)}</b><small>${a.title ? `${icon('pin')} ${esc(a.title)} · ` : ''}se fue ${when(a)}</small></h4>${a.hits.length ? a.hits.map(h => `<button type="button" class="sr-hit" data-arch="${esc(a.id)}" data-i="${h.i}"><span class="sr-w">${esc(h.who || (h.kind === 'user' ? 'Tú' : a.name))} · ${hhmm(h.at)}</span><span class="sr-t">${snippet(h.text, qn) || esc(plainMd(h.text).slice(0, 160))}</span></button>`).join('') : `<button type="button" class="sr-hit" data-arch="${esc(a.id)}"><span class="sr-t">${esc(a.label)}</span></button>`}</section>`
          )
          .join('')
      : '';
  } catch {
    /* sin archivo: solo no se muestra */
  }
  searchClosedSalas(q, box);
}
// Salas cerradas: su hilo y su contexto (los busca el daemon en los archivos). Clic abre el archivo.
async function searchClosedSalas(q, box) {
  if (q.length < 2) return;
  try {
    const r = await (await fetch(`/api/salas-cerradas?q=${encodeURIComponent(q)}`)).json();
    if ($('#search-arch', PANEL) !== box || searchUi.q.trim() !== q || !r.results?.length) return;
    const qn = norm(q),
      when = t => fmtDay(t);
    box.insertAdjacentHTML(
      'beforeend',
      `<h4 class="sr-sep">Salas cerradas</h4>` +
        r.results
          .map(
            s =>
              `<section class="sr-g" style="--c:${Number.isInteger(s.color) ? COLORS[s.color % COLORS.length] : 'var(--war)'}"><h4>${icon('door')} <b>${esc(s.name)}</b><small>cerrada ${when(s.closedAt)}</small></h4>${s.hits.length ? s.hits.map(h => `<button type="button" class="sr-hit" data-docpath="${esc(h.path)}"><span class="sr-w">${h.where === 'hilo' ? `${icon('chat')} ${esc(h.who)}` : `${icon('clip')} contexto`}</span><span class="sr-t">${snippet(h.text, qn) || esc(plainMd(h.text).slice(0, 160))}</span></button>`).join('') + (s.more ? `<small class="muted">y ${s.more} más</small>` : '') : `<button type="button" class="sr-hit" data-docpath="${esc(s.context)}"><span class="sr-t">${esc(s.purpose || 'Abrir su contexto')}</span></button>`}</section>`
          )
          .join('')
    );
  } catch {
    /* sin archivo: solo no se muestra */
  }
}
document.addEventListener('click', async e => {
  const b = e.target.closest('[data-arch]');
  if (!b) return;
  if (st.selected === '@search' || st.selected === '@archivo') st.archFrom = st.selected;
  st.focusRetake = b.hasAttribute('data-retake');
  try {
    const res = await fetch(`/api/despedidos/${b.dataset.arch}`);
    if (!res.ok) return toast('Ese robot ya no está en el archivo');
    st.archView = await res.json();
    if (b.dataset.i != null) st.jump = { sel: '@arch', i: +b.dataset.i };
    PANEL.dataset.view = '';
    select('@arch');
  } catch {
    toast('No se pudo abrir');
  }
});
PANEL.addEventListener('submit', async e => {
  if (e.target.id !== 'retake-form') return;
  e.preventDefault();
  const b = e.target.querySelector('button');
  if (!(await quotaOk(`Vas a lanzar un robot para retomar la tarea de ${st.archView?.name || 'este robot'}.`))) return;
  b.disabled = true;
  try {
    const { name } = await api('POST', `/api/despedidos/${e.target.dataset.archId}/retomar`, { text: $('#retake-in').value });
    toast(`${name} retoma la tarea con el resumen`);
    st.archView = null;
    select(name);
  } catch {
    b.disabled = false;
  }
});
// Archivo: todos los robots despedidos con su super resumen, para verlos o retomar su tarea (archivador del mapa, tecla H).
const archUi = { list: null, q: '' };
function setArchCount(n) {
  const b = $('#arch-n');
  b.textContent = n > 99 ? '99+' : n;
  b.hidden = !n;
}
function archivoPanel() {
  return `<div class="dlg-head"><h3>${icon('archive')} Archivo de despedidos</h3><p>Aquí quedan los robots que despediste con «Despedir con su resumen», con el <b>super resumen</b> que escribieron al irse («Dar de baja» no deja nada). Con «↻ Retomar» entra un robot nuevo solo con ese resumen y lo que le digas. Cada resumen también queda como documento en <code>docs/resumenes-robots/</code> de tu carpeta de trabajo. «Quitar» saca al robot de la lista y manda su resumen a la Papelera, de donde se recupera.</p></div>
    <div class="arch-bar"><input class="arch-q" id="arch-q" type="search" placeholder="Filtrar por nombre, título, nota o resumen…" autocomplete="off"><button type="button" class="btn sm ghost" id="arch-relevos" data-arch-relevos hidden title="Quita de la lista a todos los relevados por contexto (son automáticos: su robot siguió con el mismo nombre y el resumen) y manda sus resúmenes a la Papelera">${icon('broom')} Limpiar relevos</button></div>
    <div class="arch-list" id="arch-list" aria-busy="true">${skeleton(3, 'blk')}</div>
    <section class="dlg-sec"><h4>${icon('door')} Salas cerradas</h4><p class="note">Las salas que cerraste o que se cerraron solas al irse su equipo. Su contexto y su hilo siguen en <code>runs/salas/&lt;id&gt;/</code>.</p><div class="arch-list" id="arch-salas"><p class="muted">Cargando…</p></div></section>`;
}
async function loadArchivo() {
  try {
    archUi.list = (await (await fetch('/api/despedidos?all=1')).json()).recent || [];
  } catch {
    archUi.list = [];
  }
  try {
    archUi.salas = (await (await fetch('/api/salas-cerradas')).json()).salas || [];
  } catch {
    archUi.salas = [];
  }
  drawArchivo();
}
function drawArchivo() {
  const box = $('#arch-list', PANEL);
  if (!box || !archUi.list) return;
  const q = norm(($('#arch-q', PANEL)?.value || '').trim());
  const sb = $('#arch-salas', PANEL);
  if (sb) {
    const ss = (archUi.salas || []).filter(s => !q || norm(`${s.name} ${s.purpose} ${s.owner || ''} ${s.key}`).includes(q));
    const whenS = t => fmtWhen(t);
    sb.innerHTML = !ss.length
      ? `<p class="muted">${archUi.salas?.length ? 'Nada coincide con el filtro.' : 'Todavía no se cierra ninguna sala.'}</p>`
      : ss
          .map(
            s => `<article class="ac-item" style="--c:${Number.isInteger(s.color) ? COLORS[s.color % COLORS.length] : 'var(--war)'}"><div class="ac-h"><b>${esc(s.name)}</b>${s.key ? `<span class="ac-title">${esc(s.key)}</span>` : ''}<small>${esc(s.reason || 'cerrada')} · ${whenS(s.closedAt)}</small></div>
        ${s.purpose ? `<p class="ac-x">${esc(s.purpose)}</p>` : ''}<div class="row"><button type="button" class="btn sm" data-docpath="${esc(s.context)}">${icon('clip')} Contexto</button><button type="button" class="btn sm" data-docpath="${esc(s.threadFile)}">${icon('chat')} Hilo (${s.messages} msj)</button><button type="button" class="btn sm" data-sala-exp="${esc(s.id)}" title="Guarda la sala completa (porqué, reparto, contexto e hilo) en docs/salas/ de tu carpeta de trabajo">${icon('down')} Exportar</button>${s.reopen ? `<button type="button" class="btn sm" data-sala-reopen="${esc(s.id)}" title="La vuelve a abrir con su contexto, su hilo y sus notas; después mudas a los robots desde su ventana («Mudar a una sala»). Ya no se cierra sola.">↩ Reabrir</button>` : ''}<button type="button" class="btn sm ghost" data-sala-del="${esc(s.id)}" title="La quita del archivo y manda su contexto y su hilo a la Papelera (de ahí se recuperan)">${icon('trash')} Borrar</button></div></article>`
          )
          .join('');
  }
  const nRelevos = archUi.list.filter(a => a.relevo).length,
    rb = $('#arch-relevos', PANEL);
  if (rb && !rb.classList.contains('armed')) {
    rb.hidden = !nRelevos;
    rb.innerHTML = `${icon('broom')} Limpiar relevos (${nRelevos})`;
    rb.disabled = false;
  }
  const list = archUi.list.filter(a => !q || norm(`${a.name} ${a.title} ${a.note} ${a.label} ${a.excerpt}`).includes(q));
  const when = t => fmtWhen(t);
  box.innerHTML = !archUi.list.length
    ? '<p class="muted">Todavía no despides a ningún robot. Cuando lo hagas, su resumen queda aquí.</p>'
    : !list.length
      ? '<p class="muted">Nada coincide con el filtro.</p>'
      : list
          .map(
            a => `<article class="ac-item" style="--c:${COLORS[(a.color || 0) % COLORS.length]}"><div class="ac-h">${robotHead(COLORS[(a.color || 0) % COLORS.length], lookOf(a.name, null, { look: a.look }))}<b>${esc(a.name)}</b>${a.title ? `<span class="ac-title">${icon('pin')} ${esc(a.title)}</span>` : ''}<span class="ac-by ${a.summaryBy === 'robot' ? 'r' : ''}">${icon('note')} ${a.summaryBy === 'robot' ? 'resumen del robot' : 'resumen de la oficina'}</span>${a.relevo ? `<span class="ac-by">${icon('repeat')} relevo</span>` : ''}<small>se fue ${when(a.leftAt)}</small></div>
      ${a.note ? `<div class="ac-note">${icon('memo')} ${esc(a.note)}</div>` : ''}<p class="ac-x">${esc(a.excerpt || a.label)}</p>
      <div class="row"><button type="button" class="btn primary sm" data-arch="${esc(a.id)}" data-retake>↻ Retomar</button><button type="button" class="btn sm" data-arch="${esc(a.id)}">Ver resumen</button><button type="button" class="btn sm ghost" data-arch-del="${esc(a.id)}" title="Lo quita de esta lista y manda su resumen a la Papelera (de ahí se recupera)">Quitar</button></div></article>`
          )
          .join('');
}
PANEL.addEventListener('input', e => {
  if (e.target.id === 'arch-q') drawArchivo();
});
PANEL.addEventListener('click', async e => {
  const sx = e.target.closest('[data-sala-exp]');
  if (sx) {
    try {
      const r = await api('POST', `/api/salas-cerradas/${sx.dataset.salaExp}/exportar`);
      toast(`Sala exportada: ${r.shown}`);
      showDoc(r.path);
    } catch {
      /* toast ya mostrado */
    }
    return;
  }
  const so = e.target.closest('[data-sala-reopen]');
  if (so) {
    so.disabled = true;
    try {
      await api('POST', `/api/salas-cerradas/${so.dataset.salaReopen}/reabrir`);
      archUi.salas = (archUi.salas || []).filter(x => x.id !== so.dataset.salaReopen);
      drawArchivo();
      toast('Sala reabierta: múdale robots desde su ventana («Mudar a una sala»).');
    } catch {
      so.disabled = false;
    }
    return;
  }
  const sd = e.target.closest('[data-sala-del]');
  if (sd) {
    // dos clics: el primero arma, el segundo (en 3 s) borra
    const sdHtml = sd.innerHTML;
    if (!armed(sd, '¿Borrar?', 3000, () => (sd.innerHTML = sdHtml))) return;
    sd.disabled = true;
    try {
      const r = await api('DELETE', `/api/salas-cerradas/${sd.dataset.salaDel}`);
      archUi.salas = (archUi.salas || []).filter(x => x.id !== sd.dataset.salaDel);
      drawArchivo();
      toast(r.papelera ? 'Sala borrada: su contexto y su hilo quedaron en la Papelera.' : 'Sala borrada del archivo.');
    } catch {
      sd.disabled = false;
    }
    return;
  }
  const lr = e.target.closest('[data-arch-relevos]');
  if (lr) {
    // dos clics, como «Quitar»
    if (!armed(lr, '¿Limpiar todos los relevos?', 3000, drawArchivo)) return;
    lr.disabled = true;
    lr.classList.remove('armed');
    try {
      const r = await api('POST', '/api/despedidos/limpiar-relevos');
      archUi.list = archUi.list.filter(a => !a.relevo);
      drawArchivo();
      toast(
        r.quitados
          ? `${r.quitados} relevo${r.quitados === 1 ? '' : 's'} quitado${r.quitados === 1 ? '' : 's'}${r.papelera ? `: sus resúmenes quedaron en la Papelera` : ''}.`
          : 'No había relevos en el archivo.'
      );
    } catch {
      drawArchivo();
    }
    return;
  }
  const b = e.target.closest('[data-arch-del]');
  if (!b) return;
  if (!armed(b, '¿Quitar?', 3000, 'Quitar')) return;
  try {
    const r = await api('DELETE', `/api/despedidos/${b.dataset.archDel}`);
    if (r.papelera) toast('Quitado: su resumen quedó en la Papelera.');
  } catch {
    /* toast ya mostrado */
  }
});

// Conversación de un robot que ya se fue (solo lectura): sus mensajes y los tuyos, y sus documentos.
function archPanel(a) {
  if (!a) return '<p class="muted">Abre un robot desde el buscador.</p>';
  const L = lookOf(a.name, null, { look: a.look });
  const when = t => fmtWhen(t);
  return `<div class="ph"><div class="ph-av">${robotHead(COLORS[(a.color || 0) % COLORS.length], L)}</div><div style="min-width:0"><h3>${esc(a.name)} <small class="muted">ya se fue</small></h3>${a.title ? `<div class="rt-title"><b>${icon('pin')} ${esc(a.title)}</b></div>` : ''}${a.note ? `<div class="rt-note"><span>${icon('memo')} ${esc(a.note)}</span></div>` : ''}<div class="sub-h">${esc(a.kind === 'skill' ? a.label : 'Tarea libre · ' + a.label)}</div><div class="origin">${esc(a.origin || '')} · entró ${when(a.startedAt)} · se fue ${when(a.leftAt)}</div></div><button type="button" class="btn sm" data-act="export-arch" title="Guarda su conversación en docs/conversaciones-robots/ (si su transcript sigue en disco, completa; si no, lo que guardó la oficina) con su resumen al final">${icon('down')} Exportar</button><button type="button" class="btn sm" data-act="wake-arch" title="Crea un despertador que retoma esta tarea cuando pase algo (un PR aprobado, un ticket que cambia, una hora)">${icon('clock')} Retomar cuando…</button><button type="button" class="btn sm" data-act="arch-back">← Volver</button></div>
    <div class="rp-grid"><div class="rp-col"><h4>Conversación <small class="muted">(sin herramientas)</small></h4><div class="log" id="arch-log" data-src="@arch" style="--c:${COLORS[(a.color || 0) % COLORS.length]}">${renderLog(a.log, a.name)}</div></div>
    <div class="rp-col"><div class="sumbox lg agent" style="--c:${COLORS[(a.color || 0) % COLORS.length]}"><span class="w">${icon('note')} Super resumen · ${a.summaryBy === 'robot' ? 'lo escribió el robot' : 'lo armó la oficina'}</span><span class="lg-acts">${a.summaryPath ? `<button type="button" class="cp-btn" data-docpath="${esc(a.summaryPath)}" title="${esc(a.summaryPath)}">${icon('doc')} Documento</button>` : ''}<button type="button" class="cp-btn cp-msg" data-copy="msg">${icon('clip')} Copiar</button></span><div class="x md-chat">${mdHtml(a.summary || '_Sin resumen._')}</div></div>
    <form class="rehire" id="retake-form" data-arch-id="${esc(a.id)}"><h4>↻ Retomar con este resumen</h4><p class="note">Entra un robot nuevo solo con este resumen (no con toda su conversación). Si necesita más, se lo das tú o lo busca en los documentos y la memoria.</p><textarea id="retake-in" rows="3" placeholder="Qué cambió o qué sigue. Ej.: Ramiro ya respondió: el stock lo maneja el WMS">${esc(a.note ? `Ya llegó lo que esperabas (${a.note}). ` : '')}</textarea><button class="btn primary sm">Retomar</button></form>
    ${
      a.docs.length
        ? `<h4>Documentos (${a.docs.length})</h4><div class="list doclist">${a.docs
            .slice()
            .reverse()
            .map(
              p =>
                `<div class="item" data-docpath="${esc(p)}" title="${esc(p)}"><div class="meta-i"><b>${esc(fileName(p))}</b><div>${esc(shortPath(p))}</div></div></div>`
            )
            .join('')}</div>`
        : '<p class="muted">No entregó documentos.</p>'
    }</div></div>`;
}
PANEL.addEventListener('input', e => {
  if (e.target.id !== 'search-in') return;
  searchUi.q = e.target.value;
  clearTimeout(searchUi.t);
  searchUi.t = setTimeout(() => {
    const r = $('#search-res', PANEL);
    if (r) r.innerHTML = searchResults(searchUi.q);
    searchArchive();
  }, 160);
});
PANEL.addEventListener('submit', e => {
  if (e.target.id === 'search-form') {
    e.preventDefault();
    $('.sr-hit', PANEL)?.click();
  }
});
document.addEventListener('click', e => {
  const h = e.target.closest('[data-jump]');
  if (!h) return;
  st.jump = { sel: h.dataset.jump, i: +h.dataset.i };
  select(h.dataset.jump);
});
// Tras abrir la conversación: lleva el mensaje al centro y lo resalta un momento.
function doJump() {
  const j = st.jump;
  if (!j || j.sel !== st.selected) return;
  st.jump = null;
  const row = PANEL.querySelector(`[data-src] > [data-i="${j.i}"]`);
  if (!row) return;
  row.scrollIntoView({ block: 'center' });
  row.classList.add('flash');
  setTimeout(() => row.classList.remove('flash'), 2200);
}

/* ---------- conversación al lado ---------- */
// Un segundo robot a la izquierda de la ventana: lees y le escribes sin perder el que tienes abierto.
function renderSide() {
  const card = $('#dlg-card');
  const a = st.side && st.robots.get(st.side);
  const show = !!a && !!st.robots.get(st.selected) && st.side !== st.selected;
  card.classList.toggle('split', show);
  let box = $('#side');
  if (!show) {
    if (box) {
      box.hidden = true;
      box.dataset.robot = '';
    }
    return;
  }
  if (!box) {
    box = document.createElement('aside');
    box.id = 'side';
    box.className = 'side';
    box.setAttribute('aria-label', 'Conversación al lado');
    box.innerHTML = `<div class="sd-h"></div><div class="sd-alert"></div><div class="log sd-log"></div><form class="chat sd-chat" data-side-reply><textarea rows="2" data-ac></textarea><button class="btn primary sm">Enviar</button></form>`;
    card.prepend(box);
  }
  box.hidden = false;
  const d = a.data,
    color = COLORS[d.color % COLORS.length];
  box.querySelector('.sd-h').innerHTML =
    `<span class="sd-av">${robotHead(color, lookOf(d.name, d.place, d))}</span><div class="sd-n"><b>${esc(d.name)}</b>${titleOf(d) ? `<small>${icon('pin')} ${esc(titleOf(d))}</small>` : ''}</div><span class="pill p-${d.state}">${esc(stateLabel(d))}</span><button type="button" class="btn sm ghost" data-side="swap" title="Abrir este en grande y poner el otro al lado">⇄</button><button type="button" class="btn sm ghost" data-side="close" title="Cerrar la conversación de al lado" aria-label="Cerrar">✕</button>`;
  const perm = d.hold || d.needsPermission;
  box.querySelector('.sd-alert').innerHTML = perm
    ? `<div class="alert sm"><b>Pide permiso</b><span class="sub-h">${esc(d.hold ? d.hold.tool : d.activity || '')}</span><div class="row"><button class="btn primary sm" data-side="allow">Aprobar</button><button class="btn danger sm" data-side="deny">Denegar</button></div></div>`
    : d.ask
      ? `<div class="alert sm"><b>Te hizo una pregunta</b><div class="row"><button class="btn sm" data-side="swap">Responder</button></div></div>`
      : '';
  const lg = box.querySelector('.sd-log');
  lg.style.setProperty('--c', color);
  if (box.dataset.robot !== d.name) {
    box.dataset.robot = d.name;
    lg.dataset.src = d.name;
    lg.innerHTML = renderLog(a.log, d.name);
    lg.scrollTop = lg.scrollHeight;
    box.querySelector('textarea').placeholder = `Escríbele a ${d.name}… Enter envía`;
  }
}
function sidePicker(d) {
  const others = [...st.robots.values()].filter(x => x.data.name !== d.name);
  if (!others.length) return '';
  return `<select class="mt-sel sd-pick" id="side-pick" title="Abre otro robot a la izquierda para leer las dos conversaciones a la vez" aria-label="Ver otro robot al lado"><option value="">⇆ Ver al lado…</option>${others.map(x => `<option value="${esc(x.data.name)}"${st.side === x.data.name ? ' selected' : ''}>${esc(x.data.name)}${titleOf(x.data) ? ' · ' + esc(titleOf(x.data).slice(0, 40)) : ''}</option>`).join('')}</select>`;
}
PANEL.addEventListener('change', e => {
  if (e.target.id === 'side-pick') {
    st.side = e.target.value || null;
    renderSide();
  }
});
// Reagrupar: mudar al robot a una sala abierta o devolverlo a un escritorio. Lo de la sala le llega con su próximo mensaje.
function salaPicker(d) {
  const cur = d.place?.sala || '';
  if (!st.salas.length && !cur) return '';
  return `<select class="mt-sel sd-pick" id="sala-pick" title="Muda a este robot a una sala (lo de la sala le llega con tu próximo mensaje, sin gastar un turno) o devuélvelo a un escritorio" aria-label="Sala del robot"><option value=""${cur ? '' : ' selected'}>${cur ? '↩ A un escritorio' : 'Mudar a una sala…'}</option>${st.salas.map(s => `<option value="${esc(s.id)}"${s.id === cur ? ' selected' : ''}>${esc(s.name)}</option>`).join('')}</select>`;
}
PANEL.addEventListener('change', async e => {
  if (e.target.id !== 'sala-pick' || !st.selected) return;
  const sala = e.target.value || null;
  try {
    await api('POST', `/api/robots/${encodeURIComponent(st.selected)}/sala`, { sala });
    toast(sala ? 'Mudado: lo de la sala le llega con tu próximo mensaje.' : 'De vuelta a un escritorio.');
  } catch {
    schedulePanel();
  }
});
$('#dlg-card').addEventListener('click', async e => {
  const b = e.target.closest('[data-side]');
  if (!b) return;
  const act = b.dataset.side,
    d = st.robots.get(st.side)?.data;
  if (act === 'close') {
    st.side = null;
    renderSide();
    return renderPanel();
  }
  if (act === 'swap' && d) {
    const cur = st.selected;
    st.side = cur;
    select(d.name);
    return;
  }
  if ((act === 'allow' || act === 'deny') && d)
    try {
      await decide(d, act === 'allow');
    } catch {
      /* toast ya mostrado */
    }
});
$('#dlg-card').addEventListener('submit', async e => {
  if (!e.target.matches('[data-side-reply]')) return;
  e.preventDefault();
  const ta = e.target.querySelector('textarea'),
    t = ta.value.trim(),
    name = st.side;
  if (!t || !name) return;
  ta.value = '';
  grow(ta);
  try {
    await api('POST', `/api/robots/${name}/say`, { text: t });
  } catch {
    ta.value = t;
  }
});
$('#dlg-card').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey && e.target.closest('[data-side-reply]')) {
    e.preventDefault();
    e.target.form.requestSubmit();
  }
});
