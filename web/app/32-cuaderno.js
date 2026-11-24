/* ---------- «Cuaderno»: la memoria compartida de la oficina ---------- */
// Panel @cuaderno (menú «Más»): Notas (buscador y filtro por tema o alcance), Propuestas (las que mandan los robots y tú
// apruebas, editas o descartas) y Por revisar (notas con la fecha de `revisar:` vencida). Nada en el mapa. Los avisos
// llegan por el evento {type:'memoria'}; el contador de propuestas sale en la entrada del menú.
const cuad = { tab: 'notas', q: '', filtro: '', notas: null, propuestas: null, edit: null };
const cuadNorm = s =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
// The raw note (what the edit box shows and the API stores) rebuilt from its fields.
const cuadText = n =>
  `---\ntitulo: ${n.titulo}\ntema: ${n.tema}\nalcance: ${n.alcance}\nautor: ${n.autor}\ncreada: ${n.creada}\nrevisar: ${n.revisar}\n---\n${n.cuerpo}\n`;

function renderCuadBadge() {
  const n = st.memoria?.propuestas || 0;
  const b = $('#cuad-n');
  if (!b) return;
  b.textContent = n;
  b.hidden = !n;
}
function onMemoria(m) {
  const before = st.memoria?.propuestas || 0;
  st.memoria = m;
  renderCuadBadge();
  if (m.propuestas > before)
    toast(`Hay ${m.propuestas} nota${m.propuestas === 1 ? '' : 's'} propuesta${m.propuestas === 1 ? '' : 's'} en el cuaderno`, 'notebook');
  if (st.selected === '@cuaderno') loadCuaderno();
}
async function loadCuaderno() {
  try {
    const [n, p] = await Promise.all([api('GET', '/api/memoria/notas'), api('GET', '/api/memoria/propuestas')]);
    cuad.notas = n.notas;
    cuad.propuestas = p.propuestas;
  } catch {
    /* toast ya mostrado */
  }
  if (st.selected === '@cuaderno') renderPanel();
}

const cuadMeta = n =>
  `<div class="pathx">${n.tema ? `${esc(n.tema)} · ` : ''}${esc(n.alcance)}${n.autor ? ` · ${esc(n.autor)}` : ''}${n.revisar ? ` · revisar ${esc(n.revisar)}` : ''}${n.lecturas ? ` · leída ${n.lecturas} ${n.lecturas === 1 ? 'vez' : 'veces'}` : ''}</div>`;
const cuadDue = n => (n.vencida ? ` <span class="tagx cu-due">${icon('hourglass')} por revisar</span>` : '');

// One row: a primary button and the rest under «⋯», like the inbox. While it is being edited, a text box replaces the body.
function cuadRow(n, kind) {
  const id = esc(n.id);
  if (cuad.edit && cuad.edit.kind === kind && cuad.edit.id === n.id)
    return `<div class="inbox-item new cu-edit"><div class="meta-i"><b>${esc(n.titulo)}</b>
      <label class="note" for="cu-edit">Texto completo de la nota (encabezado y cuerpo)</label>
      <textarea id="cu-edit" rows="10" spellcheck="false">${esc(cuad.edit.texto)}</textarea></div>
      <div class="row inbox-acts"><button type="button" class="btn sm primary" data-cu="save" data-kind="${kind}" data-id="${id}">${kind === 'propuesta' ? 'Aprobar con estos cambios' : 'Guardar'}</button><button type="button" class="btn sm" data-cu="cancel">Cancelar</button></div></div>`;
  const body = `<div class="cu-body md-chat">${mdHtml(n.cuerpo)}</div>`;
  const more = (...items) =>
    `<details class="pm"><summary class="btn sm ghost" title="Más acciones" aria-label="Más acciones de ${esc(n.titulo)}">⋯</summary><div class="pm-list" role="menu">${items
      .map(([a, l]) => `<button type="button" class="mi" role="menuitem" data-cu="${a}" data-kind="${kind}" data-id="${id}">${l}</button>`)
      .join('')}</div></details>`;
  const head = `<b>${esc(n.titulo)}</b>${cuadDue(n)}`;
  if (kind === 'propuesta')
    return `<div class="inbox-item new"><div class="meta-i">${head}${cuadMeta(n)}${body}</div><div class="row inbox-acts"><button type="button" class="btn sm primary" data-cu="approve" data-kind="propuesta" data-id="${id}">Aprobar</button>${more(['edit', 'Editar y aprobar'], ['discard', 'Descartar'])}</div></div>`;
  const primary = n.vencida
    ? `<button type="button" class="btn sm primary" data-cu="renew" data-kind="nota" data-id="${id}" title="Sigue siendo cierta: la revisión se corre 3 meses">Renovar</button>`
    : `<button type="button" class="btn sm" data-cu="edit" data-kind="nota" data-id="${id}">Editar</button>`;
  return `<div class="inbox-item${n.vencida ? ' new' : ''}"><div class="meta-i">${head}${cuadMeta(n)}${body}</div><div class="row inbox-acts">${primary}${more(...(n.vencida ? [['edit', 'Editar']] : []), ['remove', 'Archivar (a la Papelera)'])}</div></div>`;
}

function cuadernoPanel() {
  const notas = cuad.notas || [],
    props = cuad.propuestas || [],
    due = notas.filter(n => n.vencida);
  const tab = ['notas', 'propuestas', 'revisar'].includes(cuad.tab) ? cuad.tab : 'notas';
  const seg = (v, label, n) =>
    `<label><input type="radio" name="cuadtab" value="${v}" ${tab === v ? 'checked' : ''}>${label} (${n})</label>`;
  let content;
  if (cuad.notas === null) content = `<p aria-busy="true">${skeleton(4)}</p>`;
  else if (tab === 'propuestas')
    content = props.length
      ? props.map(p => cuadRow(p, 'propuesta')).join('')
      : '<p>No hay propuestas. Los robots las mandan con «office memoria proponer» y aquí las apruebas o las descartas.</p>';
  else if (tab === 'revisar') content = due.length ? due.map(n => cuadRow(n, 'nota')).join('') : '<p>Ninguna nota está por revisar.</p>';
  else {
    const temas = [
      ...new Set(
        notas.flatMap(n =>
          n.tema
            .split(',')
            .map(t => t.trim())
            .filter(Boolean)
        )
      )
    ].sort();
    const alcances = [...new Set(notas.map(n => n.alcance))].sort();
    const q = cuadNorm(cuad.q).split(/\s+/).filter(Boolean);
    const f = cuad.filtro;
    const shown = notas.filter(n => {
      if (f.startsWith('tema:') && !n.tema.split(',').some(t => t.trim() === f.slice(5))) return false;
      if (f.startsWith('alcance:') && n.alcance !== f.slice(8)) return false;
      const hay = cuadNorm(`${n.titulo} ${n.tema} ${n.cuerpo}`);
      return q.every(w => hay.includes(w));
    });
    const opt = (v, l) => `<option value="${esc(v)}"${f === v ? ' selected' : ''}>${esc(l)}</option>`;
    content = `<div class="row between ib-filters"><input id="cu-q" type="search" placeholder="Buscar en las notas…" value="${esc(cuad.q)}" aria-label="Buscar en las notas" autocomplete="off">
      <select id="cu-f" aria-label="Filtrar por tema o alcance"><option value="">Todos los temas y alcances</option>${temas.length ? `<optgroup label="Tema">${temas.map(t => opt(`tema:${t}`, t)).join('')}</optgroup>` : ''}${alcances.length ? `<optgroup label="Alcance">${alcances.map(a => opt(`alcance:${a}`, a)).join('')}</optgroup>` : ''}</select></div>
      ${shown.length ? shown.map(n => cuadRow(n, 'nota')).join('') : `<p>${notas.length ? 'Ninguna nota coincide.' : 'El cuaderno está vacío. Cuando apruebes propuestas, aparecen aquí.'}</p>`}`;
  }
  return `<div class="dlg-head"><h3>${icon('notebook')} Cuaderno <small>${notas.length || ''}</small></h3><p>Lo que esta oficina sabe y los robots consultan con «office memoria buscar». Los robots proponen; nada entra sin que lo apruebes. Una nota vence a los 3 meses salvo que la renueves.</p></div>
    <div class="dlg-sec"><div class="seg small" role="radiogroup" aria-label="Sección del cuaderno">${seg('notas', 'Notas', notas.length)}${seg('propuestas', 'Propuestas', props.length)}${seg('revisar', 'Por revisar', due.length)}</div>
    <div class="list">${content}</div></div>`;
}

PANEL.addEventListener('click', async e => {
  if (st.selected !== '@cuaderno') return;
  const b = e.target.closest('[data-cu]');
  if (!b) return;
  const act = b.dataset.cu,
    kind = b.dataset.kind,
    id = b.dataset.id;
  const find = () => (kind === 'propuesta' ? cuad.propuestas : cuad.notas)?.find(n => n.id === id);
  try {
    if (act === 'cancel') cuad.edit = null;
    else if (act === 'edit') {
      const n = find();
      if (n) cuad.edit = { kind, id, texto: cuadText(n) };
    } else if (act === 'save') {
      const texto = $('#cu-edit', PANEL)?.value ?? '';
      if (kind === 'propuesta') await api('POST', `/api/memoria/propuestas/${id}/aprobar`, { texto });
      else await api('PUT', `/api/memoria/notas/${id}`, { texto });
      cuad.edit = null;
      toast(kind === 'propuesta' ? 'Nota aprobada' : 'Nota guardada', 'notebook');
    } else if (act === 'approve') {
      await api('POST', `/api/memoria/propuestas/${id}/aprobar`, {});
      toast('Nota aprobada', 'notebook');
    } else if (act === 'discard') {
      await api('POST', `/api/memoria/propuestas/${id}/descartar`, {});
      toast('Propuesta descartada (está en la Papelera)');
    } else if (act === 'renew') {
      await api('POST', `/api/memoria/notas/${id}/renovar`, {});
      toast('Nota renovada por 3 meses');
    } else if (act === 'remove') {
      await api('DELETE', `/api/memoria/notas/${id}`);
      toast('Nota archivada (está en la Papelera)');
    } else return;
  } catch {
    /* toast ya mostrado */
  }
  if (act === 'cancel' || act === 'edit') return renderPanel();
  loadCuaderno();
});
PANEL.addEventListener('change', e => {
  if (st.selected !== '@cuaderno') return;
  if (e.target.name === 'cuadtab') {
    cuad.tab = e.target.value;
    cuad.edit = null;
    renderPanel();
  } else if (e.target.id === 'cu-f') {
    cuad.filtro = e.target.value;
    renderPanel();
  }
});
PANEL.addEventListener('input', e => {
  if (st.selected !== '@cuaderno' || e.target.id !== 'cu-q') return;
  cuad.q = e.target.value;
  schedulePanel();
});
$('#btn-cuaderno').addEventListener('click', () => select('@cuaderno'));
