/* ---------- mensajes de un robot: fijar para enviar y pasar a otro robot ---------- */
// Cada globo sabe de qué conversación viene (data-src del log) y su posición (data-i).
function entryOf(el) {
  const row = el.closest('[data-i]'),
    box = el.closest('[data-src]');
  if (!row || !box) return null;
  const i = +row.dataset.i,
    src = box.dataset.src;
  if (src === '@arch') {
    const a = st.archView,
      l = a?.log[i];
    return l ? { robot: a.name, text: l.text, at: l.at, title: a.title } : null;
  }
  if (src.startsWith('@sala:')) {
    const s = st.salas.find(x => x.id === src.slice(6)),
      m = s?.thread[i];
    return m ? { robot: m.from, text: m.text, at: m.at, title: `Sala «${s.name}»` } : null;
  }
  const a = st.robots.get(src),
    l = a?.log[i];
  return l ? { robot: src, text: l.text, at: l.at, title: titleOf(a.data) } : null;
}
const pinKey = p => `${p.robot}|${p.at}`;
const pinOf = e => e && st.pins.find(p => pinKey(p) === pinKey(e));
function markPins(root = document) {
  root.querySelectorAll('[data-pin]').forEach(b => {
    const on = !!pinOf(entryOf(b));
    b.classList.toggle('on', on);
    b.title = on ? 'Quitar de «Para enviar»' : 'Guardar en «Para enviar» para pegarlo después';
  });
}
function renderPinsBadge() {
  const n = st.pins.length,
    b = $('#pins-n');
  b.textContent = n;
  b.hidden = !n;
}
document.addEventListener('click', async e => {
  const b = e.target.closest('[data-pin]');
  if (!b) return;
  const en = entryOf(b);
  if (!en) return;
  const p = pinOf(en);
  try {
    if (p) await api('DELETE', `/api/pins/${p.id}`);
    else {
      await api('POST', '/api/pins', { robot: en.robot, title: en.title, at: en.at, text: unwrapPaste(en.text) });
      toast('Guardado en «Para enviar» (tecla P)');
    }
  } catch {
    /* toast ya mostrado */
  }
});
function pinsPanel() {
  const list = st.pins.slice().reverse();
  const row = p => {
    const live = st.robots.has(p.robot);
    return `<div class="lg agent has-av pin-item" style="--c:${avColor(p.robot)}"><span class="w">${avatarOf(p.robot)}${esc(p.robot)}${p.title ? ` · ${esc(p.title)}` : ''} · ${hhmm(p.at)}${live ? '' : ' · ya se fue'}</span>
      <span class="lg-acts"><button type="button" class="cp-btn" data-copy="msg" title="Copiar con formato de chat (Google Chat, Slack)">📋 Copiar</button>${live ? `<button type="button" class="cp-btn" data-pin-go="${esc(p.id)}" title="Abrir la conversación en este mensaje">Ver</button>` : ''}<button type="button" class="cp-btn" data-pin-done="${esc(p.id)}" title="Ya lo enviaste: lo quita de la lista">✓ Enviado</button></span>
      <div class="x md-chat">${copyable(mdHtml(p.text))}</div></div>`;
  };
  return `<div class="dlg-head"><h3>📌 Para enviar <small>${list.length || ''}</small></h3><p>Mensajes que guardaste con 📌 para pegarlos en Google Chat o Slack. Se quedan aunque el robot se vaya; marca «✓ Enviado» cuando ya los mandaste.</p></div>
    <div class="log pins-log" id="pins-log">${list.length ? list.map(row).join('') : '<div class="lg sys"><span class="x">No hay nada guardado. Pasa el mouse por un mensaje de un robot y toca 📌.</span></div>'}</div>`;
}
document.addEventListener('click', async e => {
  const done = e.target.closest('[data-pin-done]');
  if (done) {
    try {
      await api('DELETE', `/api/pins/${done.dataset.pinDone}`);
    } catch {
      /* toast ya mostrado */
    }
    return;
  }
  const go = e.target.closest('[data-pin-go]');
  if (!go) return;
  const p = st.pins.find(x => x.id === go.dataset.pinGo),
    a = p && st.robots.get(p.robot);
  if (!a) return toast('Ese robot ya no está en la oficina');
  const i = a.log.findIndex(l => l.at === p.at);
  st.jump = { sel: p.robot, i };
  select(p.robot);
});

// Pasar a otro robot: el mensaje va citado, con quién lo dijo, y lo que quieras que haga con él.
document.addEventListener('click', e => {
  const b = e.target.closest('[data-fwd]');
  if (!b) return;
  const row = b.closest('.lg'),
    en = entryOf(b);
  if (!row || !en) return;
  const open = row.querySelector('.fwd');
  if (open) return open.remove();
  const targets = [...st.robots.values()].filter(x => x.data.name !== en.robot);
  if (!targets.length) return toast('No hay otro robot en la oficina a quien pasárselo');
  row.insertAdjacentHTML(
    'beforeend',
    `<form class="fwd" data-fwd-form><label>Pasar a <select>${targets.map(x => `<option value="${esc(x.data.name)}"${st.side === x.data.name ? ' selected' : ''}>${esc(x.data.name)} · ${esc(stateLabel(x.data))}${titleOf(x.data) ? ' · ' + esc(titleOf(x.data).slice(0, 36)) : ''}</option>`).join('')}</select></label>
    <textarea rows="2" data-ac placeholder="Qué quieres que haga con esto (opcional). Ej.: revisa si esto afecta tu PR"></textarea>
    <div class="row"><button class="btn primary sm">Enviar</button><button type="button" class="btn sm" data-fwd-x>Cancelar</button></div></form>`
  );
  row.querySelector('.fwd textarea').focus();
});
document.addEventListener('click', e => {
  if (e.target.closest('[data-fwd-x]')) e.target.closest('.fwd').remove();
});
document.addEventListener(
  'keydown',
  e => {
    if (e.target.closest?.('.fwd') && e.key === 'Escape') {
      e.stopImmediatePropagation();
      e.target.closest('.fwd').remove();
    } else if (e.target.matches?.('.fwd textarea') && e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      e.target.form.requestSubmit();
    }
  },
  true
);
document.addEventListener('submit', async e => {
  if (!e.target.matches('[data-fwd-form]')) return;
  e.preventDefault();
  const f = e.target,
    en = entryOf(f),
    to = f.querySelector('select').value,
    note = f.querySelector('textarea').value.trim();
  if (!en || !to) return;
  const text = `${note || `Te paso este mensaje de ${en.robot} para que lo tengas en cuenta.`}\n\n--- Mensaje de ${en.robot}${en.title ? ` (${en.title})` : ''} ---\n${unwrapPaste(en.text)}`;
  f.querySelector('button').disabled = true;
  try {
    await api('POST', `/api/robots/${to}/say`, { text });
    f.remove();
    toast(`Enviado a ${to}`);
  } catch {
    f.querySelector('button').disabled = false;
  }
});

/* ---------- cajas de texto: crecen solas, autocompletado y editor grande ---------- */
// Crece con lo que escribes hasta casi media pantalla (y se puede estirar con el mouse).
function grow(ta) {
  if (!ta) return;
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight + 2, Math.round(innerHeight * (ta.closest('.bigedit') ? 0.7 : 0.45))) + 'px';
  // La conversación se encoge lo que crece la caja, así el chat sigue cabiendo en la ventana.
  if (ta.id === 'chat-in' || ta.id === 'sala-in') PANEL.style.setProperty('--inh', Math.max(0, ta.offsetHeight - 56) + 'px');
}
// Autocompletado: «/» sugiere skills y comandos de Claude; si no, códigos que la oficina ya vio (tickets, PRs)
// y los repos de tu carpeta de trabajo. ↑ ↓ eligen, Tab o clic aceptan, Esc cierra. Enter sigue enviando.
const CLAUDE_CMDS = [
  ['compact', 'resume la conversación y libera contexto'],
  ['context', 'cuánto contexto lleva usado'],
  ['clear', 'empieza de cero (borra el contexto)'],
  ['model', 'cambia el modelo'],
  ['cost', 'tokens de la sesión'],
  ['memory', 'edita la memoria (CLAUDE.md)'],
  ['review', 'revisa un PR'],
  ['status', 'estado de la sesión'],
  ['usage', 'uso de tu suscripción'],
  ['agents', 'subagentes disponibles'],
  ['init', 'crea un CLAUDE.md'],
  ['help', 'ayuda de Claude Code']
];
const ac = { el: null, ta: null, items: [], i: 0, from: 0, to: 0, skills: [], repos: [], codes: [], codesAt: 0 };
fetch('/api/vocab')
  .then(r => r.json())
  .then(v => {
    ac.repos = v.repos || [];
  })
  .catch(() => {});
const CODE_RE = /\b[A-Z][A-Z0-9]{1,9}-\d{1,6}\b|\b[\w.-]+#\d{1,6}\b/g;
function acCodes() {
  if (Date.now() - ac.codesAt < 15000) return ac.codes;
  const seen = new Map();
  const scan = t => {
    for (const m of String(t || '').matchAll(CODE_RE)) seen.set(m[0], (seen.get(m[0]) || 0) + 1);
  };
  for (const a of st.robots.values()) {
    scan(a.data.title);
    scan(a.data.note);
    scan(a.data.label);
    a.log.slice(-80).forEach(l => l.kind !== 'tool' && scan(l.text));
  }
  for (const s of st.salas) {
    scan(s.name);
    scan(s.key);
  }
  st.pins.forEach(p => scan(p.text));
  ac.codes = [...seen]
    .sort((x, y) => y[1] - x[1])
    .map(([c]) => c)
    .slice(0, 300);
  ac.codesAt = Date.now();
  return ac.codes;
}
function acClose() {
  if (ac.el) ac.el.hidden = true;
  ac.items = [];
  ac.ta = null;
}
function acOpen(ta) {
  const pos = ta.selectionStart,
    before = ta.value.slice(0, pos);
  const m = /(^|[\s(«"'])([/\w.#-]*)$/.exec(before),
    word = m ? m[2] : '';
  let items = [];
  if (word.startsWith('/') && word.indexOf('/', 1) < 0) {
    const q = word.slice(1).toLowerCase();
    items = [...ac.skills.map(sk => ({ v: '/' + sk, d: 'skill' })), ...CLAUDE_CMDS.map(([c, d]) => ({ v: '/' + c, d }))]
      .filter(x => x.v.slice(1).toLowerCase().startsWith(q))
      .slice(0, 9);
  } else if (word.length >= 2) {
    const q = word.toLowerCase();
    const pool = [...acCodes().map(c => ({ v: c, d: /#/.test(c) ? 'PR' : 'ticket' })), ...ac.repos.map(r => ({ v: r, d: 'repo' }))];
    const starts = pool.filter(x => x.v.toLowerCase().startsWith(q)),
      inside = pool.filter(x => !x.v.toLowerCase().startsWith(q) && x.v.toLowerCase().includes(q));
    items = [...starts, ...inside].filter(x => x.v.toLowerCase() !== q).slice(0, 8);
  }
  if (!items.length) return acClose();
  ac.ta = ta;
  ac.items = items;
  ac.i = 0;
  ac.from = pos - word.length;
  ac.to = pos;
  if (!ac.el) {
    ac.el = Object.assign(document.createElement('div'), { className: 'acpop', role: 'listbox' });
    ac.el.addEventListener('mousedown', e => {
      const b = e.target.closest('[data-aci]');
      if (b) {
        e.preventDefault();
        ac.i = +b.dataset.aci;
        acAccept();
      }
    });
    document.body.appendChild(ac.el);
  }
  ac.el.innerHTML = items
    .map(
      (x, k) =>
        `<div class="aci${k === ac.i ? ' on' : ''}" data-aci="${k}" role="option"><b>${esc(x.v)}</b><small>${esc(x.d)}</small></div>`
    )
    .join('');
  const r = ta.getBoundingClientRect();
  Object.assign(ac.el.style, {
    left: Math.max(8, r.left) + 'px',
    bottom: innerHeight - r.top + 4 + 'px',
    width: Math.min(440, Math.max(260, r.width)) + 'px'
  });
  ac.el.hidden = false;
}
function acAccept() {
  const ta = ac.ta,
    x = ac.items[ac.i];
  if (!ta || !x) return acClose();
  const tail = ta.value.slice(ac.to),
    add = x.v + (tail.startsWith(' ') ? '' : ' ');
  ta.value = ta.value.slice(0, ac.from) + add + tail;
  const c = ac.from + add.length;
  ta.setSelectionRange(c, c);
  acClose();
  grow(ta);
  ta.focus();
}
document.addEventListener('input', e => {
  const ta = e.target;
  if (ta.tagName !== 'TEXTAREA') return;
  if (!ta.classList.contains('be-ta')) grow(ta);
  if (ta.matches('[data-ac]')) acOpen(ta);
});
document.addEventListener('focusout', e => {
  if (e.target === ac.ta)
    setTimeout(() => {
      if (document.activeElement !== ac.ta) acClose();
    }, 120);
});
// En captura: con la lista abierta, Tab elige y Esc la cierra (no cierra la ventana). Enter no se toca: envía.
document.addEventListener(
  'keydown',
  e => {
    if (!ac.items.length || e.target !== ac.ta) return;
    if (e.key === 'Enter') return acClose();
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      ac.i = (ac.i + (e.key === 'ArrowDown' ? 1 : -1) + ac.items.length) % ac.items.length;
      ac.el.querySelectorAll('.aci').forEach((d, k) => d.classList.toggle('on', k === ac.i));
    } else if (e.key === 'Tab') acAccept();
    else if (e.key === 'Escape') acClose();
    else return;
    e.preventDefault();
    e.stopImmediatePropagation();
  },
  true
);
// Editor grande: casi pantalla completa para respuestas o contextos largos. Igual que el chat: Enter envía,
// Shift+Enter salto de línea; Esc vuelve sin perder lo escrito.
function bigEdit(src) {
  const form = src.form,
    who = st.robots.get(st.selected)?.data.name;
  const box = document.createElement('div');
  box.className = 'bigedit';
  box.innerHTML = `<div class="be-card" role="dialog" aria-modal="true"><div class="be-h"><b>${who ? `Mensaje para ${esc(who)}` : 'Mensaje'}</b><small class="muted">Enter envía · Shift+Enter salto de línea · Esc vuelve sin perder lo escrito · / comandos</small></div>
    <textarea data-ac class="be-ta"></textarea><div class="row"><button type="button" class="btn primary" data-be="send">Enviar</button><button type="button" class="btn" data-be="back">Volver</button></div></div>`;
  document.body.appendChild(box);
  const ta = box.querySelector('textarea');
  ta.value = src.value;
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
  const done = send => {
    src.value = ta.value;
    box.remove();
    grow(src);
    src.focus();
    if (send && src.value.trim()) form?.requestSubmit();
  };
  box.addEventListener('click', e => {
    const b = e.target.closest('[data-be]');
    if (b) done(b.dataset.be === 'send');
    else if (e.target === box) done(false);
  });
  box.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      done(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      done(false);
    }
  });
}
document.addEventListener('click', e => {
  const b = e.target.closest('[data-bigedit]');
  if (b) {
    const t = document.getElementById(b.dataset.bigedit);
    if (t) bigEdit(t);
  }
});
