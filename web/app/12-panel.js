/* ---------- panel ---------- */
let panelTimer = null,
  paneTimer = null;
const paneCache = new Map();
function schedulePanel() {
  clearTimeout(panelTimer);
  panelTimer = setTimeout(renderPanel, 80);
}
// st.selected: nombre de un robot, una vista ('@new', '@cron', '@inbox', '@git'…) o null (ventana cerrada).
// Los nombres de robot no pueden empezar con '@', asi que no chocan con las vistas.
function select(sel) {
  if (needsSetup()) sel = '@setup';
  st.selected = sel;
  $('#dlg-close').hidden = needsSetup();
  for (const a of st.robots.values()) a.el.classList.toggle('sel', a.data.name === sel);
  document.querySelectorAll('.room').forEach(r => r.classList.toggle('sel', sel === '@' + r.dataset.room));
  scheduleCards();
  renderPanel();
}

// Parcha el DOM existente en vez de reemplazarlo: así la ventana no parpadea con cada evento de los robots
// (se conservan scroll, foco, imágenes y lo escrito). #log y #pane se actualizan aparte, de forma incremental.
const MORPH_SKIP = new Set(['log', 'pane']);
// Un control (botón, enlace o algo clicable con data-pick/data-docpath/…) solo se reutiliza si conserva su acción:
// si no, el elemento que acabas de pulsar podía volverse otro botón mientras el clic seguía su camino (p. ej.
// «🎨 Apariencia» se convertía en «⏰ Despiértame cuando…» y abría Rutinas). Si la acción cambia, se reemplaza.
const CLICKY = new Set(['BUTTON', 'A']);
const actionSig = el =>
  el.nodeType === 1 &&
  (CLICKY.has(el.nodeName) || el.hasAttribute('data-pick') || el.hasAttribute('data-docpath') || el.getAttribute('role') === 'button')
    ? [...el.attributes]
        .filter(a => a.name.startsWith('data-'))
        .map(a => `${a.name}=${a.value}`)
        .sort()
        .join('&')
    : '';
function morph(from, to) {
  let cur = from.firstChild;
  for (const nb of [...to.childNodes]) {
    // Los nodos con id se reutilizan aunque algo se haya insertado antes (p. ej. aparece el bloque de subagentes).
    const byId = nb.nodeType === 1 && nb.id ? [...from.children].find(c => c.id === nb.id) : null;
    const same =
      !byId &&
      cur &&
      cur.nodeType === nb.nodeType &&
      cur.nodeName === nb.nodeName &&
      !cur.id &&
      !(nb.nodeType === 1 && nb.id) &&
      actionSig(cur) === actionSig(nb);
    const na = byId || (same ? cur : null);
    if (!na) {
      from.insertBefore(nb, cur);
      continue;
    }
    if (na !== cur) from.insertBefore(na, cur);
    cur = na.nextSibling;
    if (na.nodeType !== 1) {
      if (na.nodeValue !== nb.nodeValue) na.nodeValue = nb.nodeValue;
      continue;
    }
    for (const { name } of [...na.attributes])
      if (!nb.hasAttribute(name) && name !== 'open' && !(name === 'style' && na.nodeName === 'TEXTAREA')) na.removeAttribute(name); // <details> abierto por ti; el alto de una caja de texto que creció
    for (const { name, value } of [...nb.attributes]) if (na.getAttribute(name) !== value) na.setAttribute(name, value);
    if (!MORPH_SKIP.has(na.id) && !['INPUT', 'TEXTAREA', 'SELECT'].includes(na.nodeName)) morph(na, nb);
  }
  while (cur) {
    const next = cur.nextSibling;
    cur.remove();
    cur = next;
  }
}

const KIND_LABEL = {
  user: 'Tú',
  agent: 'Robot',
  tool: 'Herramienta',
  sub: 'Subagente',
  sys: 'Oficina',
  doc: 'Documento',
  bg: 'Aviso de su consola'
};
// Lo que dicen los robots (y tú) viene en Markdown: se muestra con formato (marked + DOMPurify, servidos localmente).
// Herramientas, avisos de la oficina y documentos siguen en texto plano. Se cachea porque el panel se repinta seguido.
const MD_KINDS = new Set(['agent', 'user', 'sub']);
const mdCache = new Map();
function mdHtml(text) {
  let h = mdCache.get(text);
  if (h != null) return h;
  try {
    h = DOMPurify.sanitize(marked.parse(String(text), { gfm: true, breaks: true }), { ADD_ATTR: ['target'] }).replace(
      /<a /g,
      '<a target="_blank" rel="noopener" '
    );
  } catch {
    h = esc(text);
  }
  if (mdCache.size > 600) mdCache.delete(mdCache.keys().next().value);
  mdCache.set(text, h);
  return h;
}
// Herramientas: «agrupadas» (las seguidas en una línea plegable), «todas» (una fila cada una) u «ocultas».
const TOOL_MODES = [
  ['group', 'Agrupadas'],
  ['all', 'Todas'],
  ['hide', 'Ocultas']
];
st.toolMode = TOOL_MODES.some(([k]) => k === prefGet('toolMode', 'group')) ? prefGet('toolMode', 'group') : 'group';
const openTools = new Set(); // grupos que desplegaste (sobreviven a los repintados del panel)
const toolSplit = t => {
  const m = /^([\w.-]+)(?::\s*([\s\S]*))?$/.exec(String(t));
  return m ? [m[1], m[2] || ''] : ['', String(t)];
};
function toolRow(l) {
  const [n, rest] = toolSplit(l.text);
  return `<div class="lg tool"><span class="tn">${esc(n || 'Herramienta')}</span><span class="x" title="${esc(l.text)}">${esc(rest)}</span><time>${hhmm(l.at)}</time></div>`;
}
function toolGroup(run) {
  const k = run[0].at + '|' + run[0].text.slice(0, 40);
  const counts = new Map();
  for (const l of run) {
    const n = toolSplit(l.text)[0] || 'otra';
    counts.set(n, (counts.get(n) || 0) + 1);
  }
  const names = [...counts].map(([n, c]) => (c > 1 ? `${n} ×${c}` : n)).join(' · ');
  const a = hhmm(run[0].at),
    b = hhmm(run[run.length - 1].at);
  return `<details class="lg tg" data-k="${esc(k)}"${openTools.has(k) ? ' open' : ''}><summary><span class="tg-n">${run.length} herramienta${run.length === 1 ? '' : 's'}</span><span class="tg-l">${esc(names)}</span><time>${a === b ? a : `${a}–${b}`}</time></summary><div class="tg-b">${run.map(toolRow).join('')}</div></details>`;
}
const TURN_SEP = '<div class="turn-sep" aria-hidden="true"></div>';
// Avisos de tareas en segundo plano: Claude Code se los manda al robot como si fueran tuyos. Los viejos (antes
// del arreglo del daemon) llegaron como «user» con el XML crudo: se convierten aquí al mismo globo.
function taskNoteWeb(p) {
  const sum = /<summary>([\s\S]*?)<\/summary>/.exec(p)?.[1]?.trim() || '',
    status = /<status>([\s\S]*?)<\/status>/.exec(p)?.[1]?.trim() || '';
  const what = /"([^"]+)"/.exec(sum)?.[1],
    ok = !/fail|error|killed|exit code [1-9]/i.test(sum + ' ' + status);
  return what
    ? `${ok ? '✓ Terminó' : '✗ Falló'}: ${what}${ok ? '' : ` (${status || sum})`}`
    : sum || status || 'Tarea en segundo plano sin detalle';
}
// Copiar: solo en lo que el robot redacta para que lo uses: citas «>», bloques de código y, si separa el
// mensaje con una línea (---), lo que viene después de la línea. Se copia en formato de chat (Google Chat y
// WhatsApp usan *negrita*, _cursiva_, ~tachado~ y ```bloques```), no en Markdown.
const COPY_BTN =
  '<button type="button" class="cp-btn" data-copy title="Copiar con formato de chat (Google Chat, WhatsApp, Slack)">' +
  icon('clip') +
  ' Copiar</button>';
function copyable(h) {
  h = h
    .replace(/<blockquote>/g, `<blockquote class="cp">${COPY_BTN}`)
    .replace(/<pre>/g, `<div class="cp cp-code">${COPY_BTN}<pre>`)
    .replace(/<\/pre>/g, '</pre></div>');
  const parts = h.split(/<hr\s*\/?>/);
  if (parts.length < 2) return h;
  return parts
    .map((p, i) =>
      i === 0 || !p.trim() || /^\s*<(div class="cp cp-code"|blockquote class="cp")>[\s\S]*<\/(div|blockquote)>\s*$/.test(p)
        ? p
        : `<div class="cp cp-sec">${COPY_BTN}${p}</div>`
    )
    .join('<hr>');
}
const mdToChat = t =>
  t
    .replace(/\*\*(.+?)\*\*/g, '*$1*')
    .replace(/__(.+?)__/g, '_$1_')
    .replace(/~~(.+?)~~/g, '~$1~')
    .replace(/^#{1,6}\s+(.+)$/gm, '*$1*')
    .replace(/^(\s*)[-+]\s+/gm, '$1• ')
    .replace(/\[([^\]]+)\]\((\S+?)\)/g, (m, a, u) => (a === u ? u : `${a} (${u})`));
function toChat(root) {
  const mark = (m, s) => {
    const t = s.trim();
    return t ? s.replace(t, m + t + m) : s;
  };
  const walk = n => {
    if (n.nodeType === 3) return n.nodeValue.replace(/\n/g, ' ');
    if (n.nodeType !== 1 || n.classList.contains('cp-btn')) return '';
    const kids = () => [...n.childNodes].map(walk).join(''),
      t = n.tagName.toLowerCase();
    switch (t) {
      case 'strong':
      case 'b':
        return mark('*', kids());
      case 'em':
      case 'i':
        return mark('_', kids());
      case 'del':
      case 's':
        return mark('~', kids());
      case 'code':
        return '`' + n.textContent + '`';
      case 'pre': {
        const code = n.querySelector('code'),
          raw = (code || n).textContent.replace(/\n$/, '');
        return /language-(?!markdown|md|text|txt)\w/.test(code?.className || '') ? '```\n' + raw + '\n```\n\n' : mdToChat(raw) + '\n\n';
      }
      case 'br':
        return '\n';
      case 'p':
      case 'div':
        return kids().trim() + '\n\n';
      case 'h1':
      case 'h2':
      case 'h3':
      case 'h4':
      case 'h5':
      case 'h6':
        return '*' + kids().trim() + '*\n\n';
      case 'ul':
      case 'ol':
        return (
          [...n.children].map((li, i) => (t === 'ol' ? `${i + 1}. ` : '• ') + walk(li).trim().replace(/\n+/g, '\n   ')).join('\n') + '\n\n'
        );
      case 'a': {
        const x = kids(),
          u = n.getAttribute('href');
        return u && u !== x ? `${x} (${u})` : x;
      }
      case 'tr':
        return [...n.children].map(c => walk(c).trim()).join(' | ') + '\n';
      case 'table':
        return kids() + '\n';
      case 'input':
        return n.checked ? '☑ ' : '☐ ';
      default:
        return kids();
    }
  };
  return walk(root)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n (?=\S)/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
// Un bloque ``` sin lenguaje (o markdown/texto) suele ser un mensaje que el robot ya escribió en formato de chat
// (*negrita*, •): se pega como texto con formato, no como código. Con lenguaje (sh, go…) es código de verdad.
const isMsgBlock = pre => !/language-(?!markdown|md|text|txt|plaintext)\w/.test(pre.querySelector('code')?.className || '');
// Formato de chat → HTML: *negrita*, _cursiva_, ~tachado~, `código`, enlaces y saltos de línea.
const chatToHtml = t =>
  esc(t)
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/(^|[\s(«"¿¡])\*([^*\n]+?)\*(?=[\s).,;:!?»"]|$)/gm, '$1<b>$2</b>')
    .replace(/(^|[\s(«"¿¡])_([^_\n]+?)_(?=[\s).,;:!?»"]|$)/gm, '$1<i>$2</i>')
    .replace(/(^|[\s(«"¿¡])~([^~\n]+?)~(?=[\s).,;:!?»"]|$)/gm, '$1<s>$2</s>')
    .replace(/https?:\/\/[^\s<)»]+/g, u => `<a href="${u}">${u}</a>`)
    .replace(/\n/g, '<br>');
// HTML limpio del bloque (sin clases, colores ni el botón): listas, negritas, código y enlaces de verdad.
function cleanHtml(root) {
  const KEEP = new Set([
    'P',
    'BR',
    'STRONG',
    'B',
    'EM',
    'I',
    'DEL',
    'S',
    'CODE',
    'PRE',
    'UL',
    'OL',
    'LI',
    'A',
    'BLOCKQUOTE',
    'H1',
    'H2',
    'H3',
    'H4',
    'H5',
    'H6',
    'TABLE',
    'THEAD',
    'TBODY',
    'TR',
    'TH',
    'TD'
  ]);
  const out = n => {
    if (n.nodeType === 3) return esc(n.nodeValue);
    if (n.nodeType !== 1 || n.classList.contains('cp-btn')) return '';
    const inner = [...n.childNodes].map(out).join('');
    if (!KEEP.has(n.tagName)) return inner;
    if (n.tagName === 'PRE' && isMsgBlock(n))
      return `<p>${chatToHtml(mdToChat((n.querySelector('code') || n).textContent.replace(/\n$/, '')))}</p>`;
    const t = n.tagName.toLowerCase(),
      href = t === 'a' ? n.getAttribute('href') : '';
    return t === 'br' ? '<br>' : `<${t}${href ? ` href="${esc(href)}"` : ''}>${inner}</${t}>`;
  };
  return [...root.childNodes].map(out).join('').trim();
}
// Se copian dos versiones: HTML (Google Chat, Slack, correo: listas y enlaces reales) y texto en formato de
// chat (WhatsApp y lo demás). Cada app pega la que entiende.
async function copyBlock(el) {
  const text = toChat(el);
  try {
    if (window.ClipboardItem) {
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/html': new Blob([cleanHtml(el)], { type: 'text/html' }),
          'text/plain': new Blob([text], { type: 'text/plain' })
        })
      ]);
      return true;
    }
  } catch {
    /* sin permiso para HTML: queda el texto */
  }
  return copyText(text);
}
async function copyText(t) {
  try {
    await navigator.clipboard.writeText(t);
    return true;
  } catch {
    const ta = Object.assign(document.createElement('textarea'), { value: t });
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}
document.addEventListener('click', async e => {
  const b = e.target.closest('[data-copy]');
  if (!b) return;
  // «msg»: el mensaje entero del robot (sin los botones de sus bloques); si no, el bloque donde está el botón.
  const target = b.dataset.copy === 'msg' ? b.closest('.lg')?.querySelector('.md-chat') : b.parentElement;
  if (target && (await copyBlock(target))) {
    b.textContent = '✓ Copiado';
    b.classList.add('ok');
    setTimeout(() => {
      b.innerHTML = `${icon('clip')} Copiar`;
      b.classList.remove('ok');
    }, 1500);
  } else toast('No se pudo copiar: selecciona el texto y usa ⌘C');
});

// Avatar del robot en sus globos: su cabeza con su color y accesorio (en salas, el de cada robot que habla).
const avColor = name => {
  const d = st.robots.get(name)?.data;
  return d ? COLORS[d.color % COLORS.length] : COLORS[[...String(name)].reduce((h, c) => h + c.charCodeAt(0), 0) % COLORS.length];
};
const avatarOf = name => (name ? robotHead(avColor(name), lookOf(name, st.robots.get(name)?.data.place, st.robots.get(name)?.data)) : '');
function logRow(l, robot, i, interim) {
  if (l.kind === 'tool') return toolRow(l);
  if (l.kind === 'user' && /^\s*<task-notification>/.test(l.text)) l = { ...l, kind: 'bg', text: taskNoteWeb(l.text) };
  const t = hhmm(l.at);
  if (l.kind === 'bg')
    return `<div class="lg bg${/^✗/.test(l.text) ? ' bad' : ''}"><span class="w">Aviso de su consola · tarea en segundo plano · ${t}</span><span class="x">${esc(l.text)}</span></div>`;
  // Comando en su consola: «!comando» (terminal) o /comando de Claude, y su salida, con estilo de terminal.
  if (l.kind === 'shell')
    return l.cmd
      ? `<div class="lg shell in"><span class="w">Tú en su consola · ${l.slash ? 'comando de Claude' : 'terminal'} · ${t}</span><pre class="x">${l.slash ? '' : '<b>$</b> '}${esc(l.text)}</pre></div>`
      : `<div class="lg shell out${l.err ? ' err' : ''}"><pre class="x">${esc(l.text)}</pre></div>`;
  if (l.kind === 'sys') return `<div class="lg sys"><span class="x">${esc(l.text)}</span><time>${t}</time></div>`;
  const md = MD_KINDS.has(l.kind) && window.marked && window.DOMPurify;
  const who = l.who || (l.kind === 'agent' && robot) || KIND_LABEL[l.kind] || l.kind;
  const pasted = hasPaste(l.text) ? ' <i class="pasted">pegado</i>' : '',
    text = unwrapPaste(l.text);
  const body = md ? (l.kind === 'agent' ? copyable(mdHtml(text)) : mdHtml(text)) : '';
  const av = l.kind === 'agent' ? avatarOf(l.kind === 'agent' && !l.who ? robot : l.who) : '';
  // Office notes to the robot («[Oficina] Resultado de…», relevo, despertador) are long and not yours: one folded line,
  // opened with a click. The open ones survive panel repaints like tool groups (same set, keyed by time).
  if (l.kind === 'user' && /^\s*\[Oficina\]/.test(text)) {
    const k = `ofi:${l.at}`,
      head = text.replace(/^\s*\[Oficina\]\s*/, '').split('\n')[0];
    return `<details class="lg user ofi" data-k="${esc(k)}"${openTools.has(k) ? ' open' : ''}><summary><span class="w">Oficina · ${t}</span><span class="ofi-l">${esc(head)}</span></summary>${md ? `<div class="x md-chat">${body}</div>` : `<span class="x">${esc(text)}</span>`}</details>`;
  }
  const cpAll =
    l.kind === 'agent' && md
      ? `<span class="lg-acts">${i != null ? `<button type="button" class="cp-btn" data-pin aria-label="Guardar en «Para enviar»" title="Guardar en «Para enviar» para pegarlo después">${icon('pin')}</button><button type="button" class="cp-btn" data-fwd title="Pasar este mensaje a otro robot">↪ Pasar</button>` : ''}<button type="button" class="cp-btn cp-msg" data-copy="msg" title="Copiar todo el mensaje con formato de chat (Google Chat, WhatsApp)">${icon('clip')} Copiar</button></span>`
      : '';
  return `<div class="lg ${l.kind}${av ? ' has-av' : ''}${interim ? ' interim' : ''}"${i != null ? ` data-i="${i}"` : ''}${av && l.who ? ` style="--c:${avColor(l.who)}"` : ''}><span class="w">${av}${esc(who)} · ${t}${pasted}</span>${cpAll}${md ? `<div class="x md-chat">${body}</div>` : `<span class="x">${esc(text)}</span>`}</div>`;
}
// Avance o respuesta final: un mensaje del robot al que le siguen herramientas u otro mensaje antes de que le
// vuelvas a escribir es un avance («Ahora reviso…»), no su respuesta. Se muestra chico y tenue; la final, normal.
function interimSet(log) {
  const out = new Set();
  let last = -1;
  log.forEach((l, i) => {
    if (l.kind === 'user') last = -1;
    else if (l.kind === 'agent') {
      if (last >= 0) out.add(last);
      last = i;
    } else if ((l.kind === 'tool' || l.kind === 'sub') && last >= 0) {
      out.add(last);
      last = -1;
    }
  });
  return out;
}
function renderLog(log, robot) {
  const out = [];
  let run = [];
  const interim = interimSet(log);
  const flush = () => {
    if (run.length) out.push(toolGroup(run));
    run = [];
  };
  log.forEach((l, i) => {
    if (l.kind === 'tool') {
      if (st.toolMode === 'group') run.push(l);
      else if (st.toolMode === 'all') out.push(toolRow(l));
      return;
    }
    flush();
    if (l.kind === 'user' && out.length && !/^\s*<task-notification>/.test(l.text)) out.push(TURN_SEP);
    out.push(logRow(l, robot, i, interim.has(i)));
  });
  flush();
  return out.join('');
}
function appendLog(entry, a, lg = $('#log', PANEL)) {
  if (!lg) return;
  if (['agent', 'tool', 'sub'].includes(entry.kind)) {
    // el mensaje anterior del robot en este turno pasa a ser un avance
    for (let row = lg.lastElementChild; row; row = row.previousElementSibling) {
      if (row.classList.contains('user')) break;
      if (row.classList.contains('agent')) {
        row.classList.add('interim');
        break;
      }
    }
  }
  const stick = lg.scrollTop + lg.clientHeight >= lg.scrollHeight - 30;
  if (entry.kind === 'tool' && st.toolMode === 'hide') return;
  if (entry.kind === 'tool' && st.toolMode === 'group') {
    let i = a.log.length;
    while (i > 0 && a.log[i - 1].kind === 'tool') i--;
    const run = a.log.slice(i),
      last = lg.lastElementChild;
    if (run.length > 1 && last?.classList.contains('tg')) last.outerHTML = toolGroup(run);
    else lg.insertAdjacentHTML('beforeend', toolGroup(run));
  } else {
    if (entry.kind === 'user' && lg.children.length && !/^\s*<task-notification>/.test(entry.text))
      lg.insertAdjacentHTML('beforeend', TURN_SEP);
    lg.insertAdjacentHTML('beforeend', logRow(entry, a.data.name, a.log.length - 1));
    if (entry.kind === 'agent') markPins(lg.lastElementChild);
  }
  if (stick) lg.scrollTop = lg.scrollHeight;
}
PANEL.addEventListener(
  'toggle',
  e => {
    const k = e.target.dataset?.k;
    if (k) e.target.open ? openTools.add(k) : openTools.delete(k);
  },
  true
);
onClick('[data-toolmode]', b => {
  st.toolMode = b.dataset.toolmode;
  prefSet('toolMode', st.toolMode);
  const a = st.robots.get(st.selected),
    lg = $('#log', PANEL);
  if (a && lg) {
    lg.innerHTML = renderLog(a.log, a.data.name);
    lg.scrollTop = lg.scrollHeight;
  }
  renderPanel();
});

// Título del robot: lo pones tú para saber de un vistazo qué hace. Se edita en la cabecera de su panel.
const titleUi = { editing: null };
// Apariencia del robot: color, antena, visor y accesorio (se guarda en el daemon; «Restablecer» vuelve al de su nombre).
const lookUi = { open: null };
function lookEditor(d) {
  if (lookUi.open !== d.name)
    return `<button type="button" class="btn sm ghost lk-open" data-look="open" title="Cambiar color, antena, visor y accesorio">${icon('palette')} Apariencia</button>`;
  const L = lookOf(d.name, d.place, d);
  const cyc = (k, n, label, names) =>
    `<span class="lk-c"><small>${label}</small><button type="button" data-look="${k}" data-dir="-1" aria-label="${label} anterior">◀</button><b title="${L[k] + 1} de ${n}">${names ? esc(names[L[k]]) : `${L[k] + 1}/${n}`}</b><button type="button" data-look="${k}" data-dir="1" aria-label="${label} siguiente">▶</button></span>`;
  // Probador: el robot en grande con lo que vas eligiendo; da una vuelta en cada cambio.
  return `<div class="lk" id="look-ed"><span class="lk-prev" title="Así se ve ${esc(d.name)}">${robotSVG(COLORS[d.color % COLORS.length], L)}</span><span class="lk-sw">${COLORS.map((c, i) => `<button type="button" class="${d.color % COLORS.length === i ? 'on' : ''}" style="background:${c}" data-look="color" data-v="${i}" aria-label="Color ${COLOR_NAMES[i] || i + 1}" title="${COLOR_NAMES[i] || ''}"></button>`).join('')}</span>${cyc('ant', ANTENNAS.length, 'Antena')}${cyc('visor', VISORS.length, 'Visor', VISOR_NAMES)}${cyc('acc', HEAD_ACC.length, 'Accesorio', ACC_NAMES)}<button type="button" class="btn sm ghost" data-look="reset">Restablecer</button><button type="button" class="btn sm ghost" data-look="close">Listo</button></div>`;
}
onClick('[data-look]', async b => {
  const d = st.robots.get(st.selected)?.data;
  if (!d) return;
  const k = b.dataset.look;
  if (k === 'open' || k === 'close') {
    lookUi.open = k === 'open' ? d.name : null;
    return renderPanel();
  }
  const L = lookOf(d.name, d.place, d),
    N = { ant: ANTENNAS.length, visor: VISORS.length, acc: HEAD_ACC.length };
  const body = k === 'reset' ? { reset: true } : k === 'color' ? { color: +b.dataset.v } : { [k]: (L[k] + +b.dataset.dir + N[k]) % N[k] };
  // Una vuelta mientras llega el cambio. Con la API de animaciones y no con una clase: al redibujar, el panel
  // sincroniza los atributos y le borraría la clase a mitad del giro.
  $('#look-ed .lk-prev svg', PANEL)?.animate(
    [
      { transform: 'rotateY(0) scale(1)' },
      { transform: 'rotateY(180deg) scale(1.12)', offset: 0.45 },
      { transform: 'rotateY(360deg) scale(1)' }
    ],
    { duration: 550, easing: 'cubic-bezier(.3,1.4,.5,1)' }
  );
  try {
    await api('POST', `/api/robots/${d.name}/look`, body);
  } catch {
    /* toast ya mostrado */
  }
});
// El título que pusiste o, si no hay, uno sugerido a partir del encargo (se ve más tenue).
const titleOf = d => d.title || suggestTitle(d.request);
// Nota tuya pegada al robot: qué está esperando, a quién, qué falta. Se guarda en la oficina y en el archivo.
const noteUi = { editing: null };
function noteEditor(d) {
  if (noteUi.editing === d.name)
    return `<form class="rt-note edit" id="note-form" data-robot="${esc(d.name)}"><input id="note-in" maxlength="300" value="${esc(d.note || '')}" placeholder="Ej.: esperando respuesta de Ramiro sobre el stock" autocomplete="off"><button class="btn primary sm">Guardar</button><button type="button" class="btn sm" data-note="cancel">Cancelar</button></form>`;
  return d.note
    ? `<div class="rt-note" id="note-view"><span>${icon('memo')} ${esc(d.note)}</span><button type="button" class="btn sm ghost" data-note="edit" aria-label="Editar la nota" title="Editar la nota">${icon('note')}</button><button type="button" class="btn sm ghost" data-note="clear" title="Quitar la nota">✕</button></div>`
    : `<button type="button" class="btn sm ghost" id="note-view" data-note="edit" title="Una nota tuya: qué espera, de quién, qué falta">${icon('memo')} Nota</button>`;
}
// Priority in the «waiting for you» queue: p0 (red), p1 (amber) or normal. Set from the window or from the card.
const prioRank = p => (p === 'p0' ? 0 : p === 'p1' ? 1 : 2);
const prioNext = p => (p === 'p0' ? 'normal' : p === 'p1' ? 'p0' : 'p1');
const prioTag = p => (p ? `<span class="prio prio-${p}">${p.toUpperCase()}</span>` : '');
function prioPicker(d) {
  const opt = (v, label) =>
    `<button type="button" class="btn sm prio-opt${(d.priority || 'normal') === v ? ` on prio-${v}` : ''}" data-prio="${v}" aria-pressed="${(d.priority || 'normal') === v}">${label}</button>`;
  return `<span class="prio-pick" title="Prioridad en la cola de los que te esperan: P0 y P1 pasan primero">Prioridad ${opt('normal', 'Normal')}${opt('p1', 'P1')}${opt('p0', 'P0')}</span>`;
}
onClick('[data-prio]', b => {
  const d = st.robots.get(st.selected)?.data;
  if (d) api('POST', `/api/robots/${d.name}/priority`, { priority: b.dataset.prio }).catch(() => {});
});
onClick('[data-note]', b => {
  const d = st.robots.get(st.selected)?.data;
  if (!d) return;
  if (b.dataset.note === 'clear') return void api('POST', `/api/robots/${d.name}/note`, { note: '' }).catch(() => {});
  noteUi.editing = b.dataset.note === 'edit' ? d.name : null;
  renderPanel();
  if (noteUi.editing) {
    const i = $('#note-in');
    i?.focus();
    i?.select();
  }
});
PANEL.addEventListener(
  'keydown',
  e => {
    if (e.key === 'Escape' && e.target.id === 'note-in') {
      e.stopPropagation();
      e.preventDefault();
      noteUi.editing = null;
      renderPanel();
    }
  },
  true
);
PANEL.addEventListener('submit', async e => {
  if (e.target.id !== 'note-form') return;
  e.preventDefault();
  try {
    await api('POST', `/api/robots/${e.target.dataset.robot}/note`, { note: $('#note-in').value });
    noteUi.editing = null;
    renderPanel();
  } catch {
    /* toast ya mostrado */
  }
});
// Contexto casi lleno (75 %+): un botón le manda /compact sin abrir su consola. Solo cuando no está en medio de algo.
const canCompact = d => (d.ctx?.pct ?? 0) >= 75 && (d.state === 'done' || (d.state === 'input' && !d.needsPermission && !d.hold && !d.ask));
async function compact(name) {
  try {
    await api('POST', `/api/robots/${name}/say`, { text: '/compact' });
    toast(`${name} está compactando su contexto`);
  } catch {
    /* toast ya mostrado */
  }
}
// Dormido: listo y sin actividad hace más de 2 h (por lo general espera algo de afuera). Se sugiere despedirlo:
// «📝 Despedir con su resumen» guarda un super resumen y con él otro robot retoma la tarea cuando vuelva lo que esperaba.
const canSummary = d => !d.summaryPending && (d.state === 'done' || (d.state === 'input' && !d.needsPermission && !d.hold && !d.ask));
// Frío (más que la caché de su conversación sin actividad): el resumen lo arma la oficina sin despertarlo (sin tokens).
// El mismo umbral que isCold en daemon/lib/estado.mjs.
const COLD_MS = 55 * 60e3;
const isCold = d => Date.now() - (Date.parse(d.lastEventAt || d.startedAt || '') || Date.now()) > COLD_MS;
async function sumKill(name) {
  try {
    const r = await api('POST', `/api/robots/${name}/despedir-con-resumen`);
    toast(
      r.by === 'oficina'
        ? `${name} se fue: llevaba más de una hora quieto, así que la oficina armó su resumen sin despertarlo (sin gastar tokens)`
        : `${name} está escribiendo su resumen; al terminar se va`
    );
  } catch {
    /* toast ya mostrado */
  }
}
// Relevo por contexto: con mucho contexto la oficina ofrece «🔁 Relevar» (escribe su resumen y sigue otro robot con su
// mismo nombre y solo ese resumen) o «Seguir así» (no vuelve a ofrecer hasta que suba 100 k más).
const relevoLabel = d => `${icon('repeat')} Relevar (${Math.round(d.relevo.tokens / 1000)} k)`;
const relevoBtns = (d, card) =>
  d.relevo && !d.relevoPending && canSummary(d)
    ? `<button class="btn sm primary" data-${card ? 'card-' : ''}act="relevar" title="Mucho contexto: cada turno lo relee entero. Escribe su resumen, se va y entra otro robot con su mismo nombre que sigue solo con ese resumen.">${relevoLabel(d)}</button><button class="btn sm" data-${card ? 'card-' : ''}act="seguir-sin-relevo" title="No vuelve a ofrecer el relevo hasta que el contexto suba 100 k más">Seguir así</button>`
    : '';
async function relevar(name) {
  try {
    await api('POST', `/api/robots/${name}/relevar`);
    toast(`${name} escribe su relevo; sigue otro robot con su mismo nombre`);
  } catch {
    /* toast ya mostrado */
  }
}
async function seguirSinRelevo(name) {
  try {
    await api('POST', `/api/robots/${name}/seguir-sin-relevo`);
  } catch {
    /* toast ya mostrado */
  }
}
async function revive(name, btn) {
  if (btn) btn.disabled = true;
  try {
    await api('POST', `/api/robots/${name}/revivir`);
    toast(`${name} se reanudó con su misma sesión`);
  } catch {
    if (btn) btn.disabled = false;
  }
}
const SLEEP_MS = 2 * 3600e3;
const sleepMs = d =>
  d.state === 'done' && !d.spawnReq && !onHold(d)
    ? Date.now() - (Date.parse(d.lastEventAt || d.timeline?.at(-1)?.at || '') || Date.now())
    : 0;
const isSleepy = d => sleepMs(d) >= SLEEP_MS;

function titleEditor(d) {
  if (titleUi.editing === d.name)
    return `<form class="rt-title edit" id="title-form" data-robot="${esc(d.name)}"><input id="title-in" maxlength="60" value="${esc(d.title || titleOf(d))}" placeholder="Ej.: Tareas de QA · Revisando wallet#32 Ramiro" autocomplete="off"><button class="btn primary sm">Guardar</button><button type="button" class="btn sm" data-title="cancel">Cancelar</button></form>`;
  const sug = !d.title && titleOf(d);
  return `<div class="rt-title" id="title-view">${d.title ? `<b>${icon('pin')} ${esc(d.title)}</b>` : sug ? `<b class="auto">${icon('pin')} ${esc(sug)}</b><small class="muted">sugerido</small><button type="button" class="btn sm ghost" data-title="accept" title="Guardar este título">✓ Usar</button>` : '<span class="muted">Sin título</span>'}<button type="button" class="btn sm ghost" data-title="edit" title="Ponle un título para saber qué hace">${icon('note')} ${d.title || sug ? 'Cambiar' : 'Ponle un título'}</button></div>`;
}
onClick('[data-title]', b => {
  if (b.dataset.title === 'accept') {
    const d = st.robots.get(st.selected)?.data;
    if (d) api('POST', `/api/robots/${d.name}/title`, { title: titleOf(d) }).catch(() => {});
    return;
  }
  titleUi.editing = b.dataset.title === 'edit' ? st.selected : null;
  renderPanel();
  if (titleUi.editing) {
    const i = $('#title-in');
    i?.focus();
    i?.select();
  }
});
PANEL.addEventListener(
  'keydown',
  e => {
    if (e.key === 'Escape' && e.target.id === 'title-in') {
      e.stopPropagation();
      e.preventDefault();
      titleUi.editing = null;
      renderPanel();
    }
  },
  true
);
PANEL.addEventListener('submit', async e => {
  if (e.target.id !== 'title-form') return;
  e.preventDefault();
  const name = e.target.dataset.robot,
    title = $('#title-in').value;
  try {
    await api('POST', `/api/robots/${name}/title`, { title });
    titleUi.editing = null;
    renderPanel();
  } catch {
    /* toast ya mostrado */
  }
});
