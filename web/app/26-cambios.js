// Cambios de un robot: los archivos que tocó y cómo están en git (sin preguntarle). Se consulta al abrir el bloque y
// con «↻»; el resto del tiempo se dibuja de lo último que trajo. Clic en un archivo → VS Code (diff contra HEAD).
const chg = { open: false, cache: new Map(), loading: new Set() };

const CHG_CLASS = {
  modificado: 'm',
  nuevo: 'n',
  borrado: 'd',
  renombrado: 'm',
  copiado: 'n',
  'en conflicto': 'd',
  'sin cambios pendientes': 'ok'
};
function chgRow(f) {
  const nums =
    f.add != null || f.del != null
      ? `<span class="chg-n">${f.add != null ? `<i class="a">+${f.add}</i>` : ''}${f.del ? `<i class="d">−${f.del}</i>` : ''}</span>`
      : '';
  const tip = f.pending
    ? f.status === 'nuevo'
      ? 'Archivo nuevo: se abre tal cual'
      : 'Abre en VS Code el diff contra el último commit'
    : 'Ya está en un commit (o volvió a como estaba): se abre tal cual';
  return `<button type="button" class="chg-f ${CHG_CLASS[f.status] || 'm'}" data-chg-open="${esc(f.path)}" title="${esc(tip)}\n${esc(f.path)}"><b>${esc(fileName(f.shown))}</b><span class="chg-dir">${esc(f.shown.includes('/') ? f.shown.slice(0, f.shown.lastIndexOf('/')) : '')}</span>${nums}<span class="chg-s">${esc(f.status)}</span></button>`;
}

function changesBlock(d) {
  const c = chg.cache.get(d.name);
  if (!d.files && !(c && c.repos.some(r => r.pending))) return '';
  if (chg.open && !c && !chg.loading.has(d.name)) setTimeout(() => loadChanges(d.name)); // abierto y cambiaste de robot
  let body = '';
  if (chg.loading.has(d.name) && !c) body = '<p class="muted">Consultando git…</p>';
  else if (c) {
    body =
      c.repos
        .map(r => {
          const mine = r.files.length ? r.files.map(chgRow).join('') : '<p class="muted">No editó archivos aquí.</p>';
          const others = r.others.length
            ? `<div class="chg-sep">Otros cambios sin commit en este repo${r.othersMore ? ` (y ${r.othersMore} más)` : ''}</div>${r.others.map(chgRow).join('')}`
            : '';
          return `<div class="chg-repo"><div class="chg-h"><b>${esc(r.name)}</b>${r.branch ? `<code>${esc(r.branch)}</code>` : ''}<small>${r.pending ? `${r.pending} sin commit` : 'todo en commits'}</small></div>${mine}${others}</div>`;
        })
        .join('') +
      (c.outside.length
        ? `<div class="chg-repo"><div class="chg-h"><b>Fuera de git</b></div>${c.outside.map(f => chgRow({ ...f, status: 'fuera de git', pending: false })).join('')}</div>`
        : '') +
      `<small class="muted chg-at">Consultado ${fmtTime(c.at, { second: '2-digit' })}</small>`;
  }
  const pend = c ? c.repos.reduce((n, r) => n + r.files.filter(f => f.pending).length, 0) : null;
  const sum = `🧾 Cambios <small>${d.files} archivo${d.files === 1 ? '' : 's'} tocado${d.files === 1 ? '' : 's'}${pend != null ? ` · ${pend} sin commit` : ''}</small>`;
  return `<details class="rp-block chg" id="chg-box"${chg.open ? ' open' : ''}><summary><h4>${sum}</h4><button type="button" class="btn sm ghost chg-ref" data-chg-refresh title="Vuelve a consultar git">↻</button></summary><div class="chg-list">${body}</div></details>`;
}

async function loadChanges(name) {
  if (chg.loading.has(name)) return;
  chg.loading.add(name);
  schedulePanel();
  try {
    const data = await api('GET', `/api/robots/${encodeURIComponent(name)}/cambios`);
    chg.cache.set(name, { ...data, at: Date.now() });
  } catch {
    /* el robot pudo haberse ido; api() ya avisó */
  } finally {
    chg.loading.delete(name);
    schedulePanel();
  }
}

PANEL.addEventListener(
  'toggle',
  e => {
    if (e.target.id !== 'chg-box') return;
    chg.open = e.target.open;
    if (chg.open && st.robots.has(st.selected)) loadChanges(st.selected);
    schedulePanel();
  },
  true
);

onClick('[data-chg-refresh]', (_, e) => {
  e.preventDefault();
  chg.open = true;
  $('#chg-box', PANEL)?.setAttribute('open', '');
  loadChanges(st.selected);
});
onClick('[data-chg-open]', async f => {
  const r = await api('POST', `/api/robots/${encodeURIComponent(st.selected)}/cambios-abrir`, { path: f.dataset.chgOpen }).catch(
    () => null
  );
  if (r)
    toast(
      r.mode === 'diff' ? 'Abierto en VS Code: el último commit a la izquierda, el archivo de hoy a la derecha' : 'Abierto en el editor'
    );
});

// File clashes: another live robot edited the same file. A warning only; «Entendido» silences it until either edits again.
function clashBox(d) {
  if (!d.clashes?.length) return '';
  const rows = d.clashes
    .map(
      c =>
        `<div class="clash-row"><span>⚠ También editó este archivo: <b title="${esc(c.file)}">${esc(shownPath(c.file))}</b> <small>(${c.with.map(esc).join(', ')})</small></span><button type="button" class="btn sm" data-act="clash-ack" data-file="${esc(c.file)}">Entendido</button></div>`
    )
    .join('');
  return `<div class="alert clash-box" id="clash-box">${rows}</div>`;
}
const shownPath = p => p.split('/').slice(-2).join('/'); // parent folder + file name, enough to recognize it

// Stalled robot (no activity for a while): says since when and offers «Mirar», which opens its tmux window in Terminal.
function stalledBox(d) {
  if (!d.stalled) return '';
  const at = new Date(lastEventMs(d)).toTimeString().slice(0, 5);
  return `<div class="alert stall-box" id="stall-box"><b>💤 Estancado desde las ${at} (${fmtDur(idleMs(d))})</b><span class="note">Sin herramientas, subagentes ni mensajes. Puede estar en un comando largo o colgado: mira su consola.</span><div class="row"><button type="button" class="btn sm" data-act="console">Mirar</button></div></div>`;
}
