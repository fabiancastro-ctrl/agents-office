/* ---------- robots ---------- */
function createRobot(d, fromSnapshot) {
  const el = document.createElement('div');
  el.className = 'robot';
  el.dataset.name = d.name;
  el.tabIndex = 0;
  el.setAttribute('role', 'button');
  el.setAttribute('aria-label', `Robot ${d.name}`);
  // Cada robot arranca sus animaciones desfasado y a su propio ritmo, para que no se muevan en sincronía.
  el.style.setProperty('--d', `-${(Math.random() * 3).toFixed(2)}s`);
  el.style.setProperty('--d2', `-${(Math.random() * 5).toFixed(2)}s`);
  el.style.setProperty('--sp', (0.85 + Math.random() * 0.3).toFixed(2));
  el.innerHTML = `<i class="shadow"></i><i class="jet" aria-hidden="true"></i><i class="lap" aria-hidden="true"></i><i class="cup" aria-hidden="true"></i><i class="loopb" aria-hidden="true">⟳</i><i class="medal" aria-hidden="true"></i><div class="bubble" hidden></div><div class="sign"></div><div class="carry" hidden></div>${robotSVG(COLORS[d.color % COLORS.length], lookOf(d.name, d.place, d))}<div class="nm">${esc(d.name)}</div><button class="kill-x" type="button" title="Dar de baja" aria-label="Dar de baja a ${esc(d.name)}">×</button>`;
  MAP.appendChild(el);
  const a = {
    data: d,
    el,
    bubble: el.querySelector('.bubble'),
    sign: el.querySelector('.sign'),
    carry: el.querySelector('.carry'),
    pos: door(),
    queueSlot: null,
    q: Promise.resolve(),
    subEls: new Map(),
    log: d.log || [],
    lastBubble: ''
  };
  st.robots.set(d.name, a);
  const fromBreak = takeFromBreak(d.name);
  if (fromSnapshot) placeAt(a, seatOf(d.place));
  else {
    a.transit = true;
    placeAt(a, st.view && d.place.sala === st.view ? salaEntry() : fromBreak || door());
    queue(a, () => walkTo(a, seatOf(d.place)));
  }
  return a;
}

const artSig = d =>
  JSON.stringify([d.color, d.look || null, d.crown || 0, d.skill || d.request?.skill || '', d.place?.type, d.place?.sala]);
function upsert(d, fromSnapshot = false) {
  layout(d.place); // agrega una fila de escritorios o la sala de su rutina si este robot la necesita
  let a = st.robots.get(d.name);
  const prevPlace = a?.data.place;
  if (a && st.ready) soundOn(a.data, d); // W · campanita si pasa a esperarte
  if (st.view && d.place?.sala === st.view && a?.data.state !== d.state) refreshBoardSoon();
  if (!a) a = createRobot(d, fromSnapshot);
  else if (prevPlace && !samePlace(prevPlace, d.place)) {
    vacate(prevPlace, a);
    a.transit = true; // se ve caminando aunque vaya a una sala (o salga de ella)
    const wasHidden = a.el.classList.contains('offview'); // si llega a la sala que estás viendo, entra por su puerta
    queue(a, () => {
      if (st.view && wasHidden) placeAt(a, salaEntry());
      return walkTo(a, restPos(a));
    });
  }
  if (d.log) a.log = d.log;
  a.data = { ...d, log: undefined };
  layout(); // ya con su lugar nuevo: corrige «N robots» de su sala (si nada cambió de tamaño, no recoloca nada)
  const sig = artSig(d);
  if (a.artSig !== undefined && a.artSig !== sig)
    a.el
      .querySelector(':scope > svg')
      ?.replaceWith(
        Object.assign(document.createElement('template'), {
          innerHTML: robotSVG(COLORS[d.color % COLORS.length], lookOf(d.name, d.place, d))
        }).content.firstElementChild
      );
  a.artSig = sig;
  paint(a);
  tickWaiting();
  renderSalaChips();
  if (st.selected === d.name) schedulePanel();
  if (st.side === d.name) renderSide();
  if (hover.name === d.name) renderHover();
  renderMeta();
}

function vacate(place, a) {
  const desk = deskFor(place);
  if (desk) {
    desk.el.classList.remove('on', 'deleg', 'occ');
    desk.paper.hidden = true;
    desk.el.dataset.cl = 0;
    desk.el.title = '';
    desk.el.classList.remove('noted');
  }
  for (const el of a.subEls.values()) el.remove();
  a.subEls.clear();
  a.extraEl?.remove();
  a.extraEl = null;
}

// Qué animación toca según lo que hace el robot (la hoja de estilos muestra la utilería de cada una).
function toolClass(d) {
  if (d.state === 'delegating') return 't-agent';
  if (d.state !== 'working' && d.state !== 'walking') return '';
  const t = d.tool || '';
  if (!t) return 't-think';
  if (t === 'Agent' || t === 'Task') return 't-agent';
  if (t === 'Bash') {
    // Las búsquedas y lecturas también pasan por Bash: se anima según el primer comando.
    const cmd = String(d.activity || '').replace(/^Bash:?\s*\$?\s*/, '');
    if (/\b(gh|curl|wget)\b/.test(cmd)) return 't-web';
    if (/^(grep|rg|find|fd|ls|tree)\b/.test(cmd)) return 't-grep';
    if (/^(cat|head|tail|less|wc|sed -n)\b/.test(cmd)) return 't-read';
    return 't-bash';
  }
  if (['Read', 'NotebookRead', 'Skill'].includes(t)) return 't-read';
  if (['Grep', 'Glob', 'LS'].includes(t)) return 't-grep';
  if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(t)) return 't-write';
  if (/^(Web|mcp__)/.test(t)) return 't-web';
  return 't-bash';
}

// Read o Grep duran menos de un segundo: cada animación de herramienta se mantiene al menos 1,5 s
// antes de volver a «pensando», para que alcance a verse.
const TOOL_MIN_MS = 1500;
function shownTool(a) {
  const want = toolClass(a.data),
    now = Date.now();
  if (want === 't-think' && a.toolCls && a.toolCls !== 't-think' && now < a.toolUntil) {
    clearTimeout(a.toolTimer);
    a.toolTimer = setTimeout(() => paint(a), a.toolUntil - now);
    return a.toolCls;
  }
  if (want !== a.toolCls) {
    a.toolCls = want;
    a.toolUntil = now + TOOL_MIN_MS;
  }
  return want;
}

// Burbujas que se pisan: la de más a la derecha sube un piso (hasta 3). Se recalcula al mostrar/ocultar
// una burbuja y cada 700 ms mientras haya 2 o más visibles, porque los robots caminan.
let bubbleRaf = 0;
function declutterBubbles() {
  if (bubbleRaf) return;
  bubbleRaf = requestAnimationFrame(() => {
    bubbleRaf = 0;
    const list = [...MAP.querySelectorAll('.bubble:not([hidden])')].filter(b => !b.closest('.offview') && b.offsetParent); // los que no se ven no empujan
    list.forEach(b => {
      b.style.transition = 'none';
      b.style.removeProperty('--by');
      b.closest('.robot')?.classList.remove('bub-flip');
    }); // sin transición: se mide donde queda, no a mitad de camino
    // Un globo que se sale por un costado del mapa (robot pegado al borde, letra grande) se corre hacia adentro; la
    // flecha sigue apuntando al robot.
    const wrap = MAP.closest('.map-wrap') || MAP,
      wr = wrap.getBoundingClientRect(),
      mr = MAP.getBoundingClientRect();
    let minX = Math.max(wr.left, mr.left) + 4;
    const maxX = Math.min(wr.right, mr.right) - 4;
    const sb = st.view && MAP.querySelector('.sala-board');
    if (sb) minX = Math.max(minX, sb.getBoundingClientRect().right + 4); // en la sala, nunca encima del tablero
    // En la sala, cada globo cabe en el espacio entre dos puestos vecinos de la mesa: así no chocan de lado (el texto
    // se corta con «…» y completo se ve al pasar el mouse).
    for (const b of list) {
      b.style.removeProperty('--bx');
      const r = b.getBoundingClientRect(),
        k = b.offsetWidth ? r.width / b.offsetWidth : 1;
      const dx = r.left < minX ? minX - r.left : r.right > maxX ? maxX - r.right : 0;
      if (dx && r.width < maxX - minX) b.style.setProperty('--bx', Math.round(dx / k) + 'px');
    }
    list.forEach(b => b.classList.remove('crowded'));
    if (list.length < 2) {
      list.forEach(b => {
        b.style.transition = '';
      });
      return;
    }
    // En una sala los globos no pueden tapar la cabecera (título y botones) ni salirse por abajo: los de la fila de
    // arriba suben hasta la cabecera y los de abajo (globo bajo el nombre) bajan hasta el borde de la sala. Si no
    // caben, se corren de lado; si tampoco, se esconde el más viejo (al pasar el mouse por el robot se ve igual).
    const sala = st.view && MAP.querySelector('.r-sala.in-sala'),
      hd = sala?.querySelector('.room-h');
    const lim = sala ? { top: (hd || sala).getBoundingClientRect().bottom + 3, bottom: sala.getBoundingClientRect().bottom - 3 } : null;
    const boxes = list
      .map(b => ({
        b,
        r: b.getBoundingClientRect(),
        dir: b.closest('.robot')?.classList.contains('bub-below') ? 1 : -1,
        at: +b.dataset.at || 0
      }))
      .sort((x, y) => (sala ? y.at - x.at : x.r.left - y.r.left)); // en la sala, los más nuevos se acomodan primero
    const placed = [];
    const hits = (l, r, t, bt) => placed.some(p => l < p.right + 8 && r > p.left - 8 && t < p.bottom + 3 && bt > p.top - 3); // con aire
    const inside = (t, bt, l, r) => !lim || (t >= lim.top && bt <= lim.bottom && l >= minX && r <= maxX);
    for (const { b, r, dir } of boxes) {
      let off = 0,
        dx = 0,
        ok = false;
      for (let floor = 0; floor < 3; floor++) {
        const t = r.top + dir * off,
          bt = r.bottom + dir * off;
        if (!inside(t, bt, r.left, r.right)) break;
        if (!hits(r.left, r.right, t, bt)) {
          ok = true;
          break;
        }
        off += r.height + 4;
      }
      if (!ok && lim) {
        // de lado, a la altura de siempre
        off = 0;
        for (const shift of [0.6, -0.6, 1.1, -1.1].map(f => Math.round(f * r.width))) {
          if (inside(r.top, r.bottom, r.left + shift, r.right + shift) && !hits(r.left + shift, r.right + shift, r.top, r.bottom)) {
            dx = shift;
            ok = true;
            break;
          }
        }
      }
      let rr = r;
      if (!ok && lim && dir === -1) {
        // fila de arriba sin lugar: el globo pasa debajo del robot (sobre la mesa)
        const bot = b.closest('.robot');
        bot.classList.add('bub-flip');
        rr = b.getBoundingClientRect();
        off = 0;
        dx = 0;
        for (let floor = 0; floor < 3 && !ok; floor++) {
          const t = rr.top + off,
            bt = rr.bottom + off;
          if (!inside(t, bt, rr.left, rr.right)) break;
          if (!hits(rr.left, rr.right, t, bt)) ok = true;
          else off += rr.height + 4;
        }
        if (ok) {
          const k = b.offsetWidth ? rr.width / b.offsetWidth : 1;
          if (off) b.style.setProperty('--by', Math.round(off / k) + 'px');
          placed.push({ left: rr.left, right: rr.right, top: rr.top + off, bottom: rr.bottom + off });
          continue;
        }
        bot.classList.remove('bub-flip');
        rr = r;
      }
      if (!ok && lim) {
        b.classList.add('crowded');
        continue;
      }
      const k = b.offsetWidth ? r.width / b.offsetWidth : 1;
      if (off) b.style.setProperty('--by', Math.round(off / k) + 'px');
      if (dx) b.style.setProperty('--bx', Math.round((parseFloat(b.style.getPropertyValue('--bx')) || 0) + dx / k) + 'px');
      placed.push({ left: r.left + dx, right: r.right + dx, top: r.top + dir * off, bottom: r.bottom + dir * off });
    }
    void MAP.offsetWidth;
    list.forEach(b => {
      b.style.transition = '';
    }); // ya en su lugar: vuelve la transición
  });
}
setInterval(() => {
  if (MAP.querySelectorAll('.robot:not(.offview) .bubble:not([hidden])').length) declutterBubbles();
}, 700);

// Urgencia de un robot que te espera: 1 recién (ámbar), 2 desde 5 min (naranja), 3 desde 15 min (rojo).
const URG_MS = [5 * 60e3, 15 * 60e3];
function urgency(d) {
  if (d.state !== 'input') return 0;
  const w = Date.now() - (Date.parse(d.inputAt || '') || Date.now());
  return w >= URG_MS[1] ? 3 : w >= URG_MS[0] ? 2 : 1;
}
setInterval(() => {
  for (const a of st.robots.values()) if (a.data.state === 'input' || isStuck(a.data)) paint(a);
}, 30000);

// Model family and a readable name from the transcript's model id («claude-opus-5-5» → Opus 5.5).
function modelInfo(model) {
  const m = String(model || '').toLowerCase(),
    fam = /opus/.test(m) ? 'opus' : /sonnet/.test(m) ? 'sonnet' : /haiku/.test(m) ? 'haiku' : '';
  if (!fam) return { fam: '', name: '' };
  const ver = (m.match(new RegExp(`${fam}-(\\d{1,2}(?:-\\d{1,2})?)(?!\\d)`)) || m.match(/(\d(?:-\d)?)-(?:opus|sonnet|haiku)/) || [])[1];
  return { fam, name: fam[0].toUpperCase() + fam.slice(1) + (ver ? ' ' + ver.replace('-', '.') : '') };
}

function paint(a) {
  const d = a.data;
  const mi = modelInfo(d.model);
  if (mi.fam) a.el.dataset.m = mi.fam;
  else delete a.el.dataset.m;
  // Chest LEDs show the context level (see .robot[data-lv] in style.css); unknown context keeps the decorative blink.
  if (d.ctx) a.el.dataset.lv = d.ctx.pct >= 75 ? 3 : d.ctx.pct >= 50 ? 2 : 1;
  else delete a.el.dataset.lv;
  a.el.setAttribute('aria-label', mi.name ? `Robot ${d.name} · ${mi.name}` : `Robot ${d.name}`);
  const shownState = d.state === 'walking' ? 'working' : d.state;
  const keep = ['moving', 'dance', 'impatient'].filter(c => a.el.classList.contains(c));
  const tool = shownTool(a),
    urg = urgency(d);
  // 10 · Antigüedad: medalla de veterano con más de 1 día en la oficina, de oro con más de 7.
  const age = Date.now() - (Date.parse(d.startedAt || '') || Date.now());
  a.el.className = [
    'robot',
    d.parent ? 'flyer' : '',
    d.loop ? 'looping' : '',
    age > 7 * 86400e3 ? 'vet2' : age > 86400e3 ? 'vet1' : '',
    `st-${shownState}`,
    onHold(d) ? 'onhold' : '',
    tool,
    d.critical > 0 && d.state === 'done' ? 'crit' : '',
    isStuck(d) ? 'stuck' : '',
    urg ? `urg-${urg}` : '',
    ...keep,
    st.selected === d.name ? 'sel' : '',
    cardUi.hl === d.name ? 'hl' : '',
    d.spawnReq ? 'spawn' : '',
    isSleepy(d) ? 'sleepy' : '',
    d.consoleLost ? 'lost' : ''
  ]
    .filter(Boolean)
    .join(' ');
  viewClass(a); // después de rearmar las clases: si no, se pierden las de la vista (sala, globo abajo, cartel a la izquierda)
  // Pide robots nuevos: cartel propio (no «LISTO») para que se vea que espera tu aprobación.
  // Al revivirlo: se endereza y los ojos vuelven a encender (solo la primera vez que deja de estar caído).
  if (a.wasLost && !d.consoleLost) {
    a.el.classList.add('poweron');
    setTimeout(() => a.el.classList.remove('poweron'), 1600);
  }
  a.wasLost = !!d.consoleLost;
  a.sign.textContent = d.consoleLost
    ? '💥 se cayó'
    : d.spawnReq
      ? `🤖 ×${d.spawnReq.items.length} ¿los lanzo?`
      : onHold(d)
        ? `⏳${d.bg.length > 1 ? ' ' + d.bg.length : ''}`
        : d.state === 'done'
          ? d.critical > 0
            ? `⚠ ${d.critical} crítico${d.critical === 1 ? '' : 's'}`
            : 'LISTO'
          : d.state === 'input'
            ? d.inputAt
              ? `? ${fmtWait(Date.now() - Date.parse(d.inputAt))}`
              : '?'
            : '';
  const text = d.consoleLost
    ? 'Se cayó mi consola: reanúdame'
    : d.relevoPending
      ? 'Escribo mi relevo y me sigue otro yo'
      : d.summaryPending
        ? 'Escribo mi resumen y me voy'
        : d.spawnReq
          ? `Quiero lanzar ${d.spawnReq.items.length} robot${d.spawnReq.items.length === 1 ? '' : 's'}: apruébalo en mi ventana`
          : d.state === 'input' && (d.needsPermission || d.hold)
            ? 'Necesito permiso'
            : plainMd(d.bubble);
  if (text && text !== a.lastBubble) {
    a.lastBubble = text;
    a.bubble.textContent = text;
    a.bubble.title = text;
    a.bubble.hidden = false;
    a.bubble.dataset.at = Date.now();
    clearTimeout(a.bt);
    a.bt = setTimeout(
      () => {
        a.bubble.hidden = true;
        declutterBubbles();
      },
      d.state === 'input' ? 12000 : 5000
    );
    declutterBubbles();
  }
  const busy = d.state === 'working' || d.state === 'delegating';
  const desk = deskFor(d.place);
  const pend = d.docs.filter(x => !x.delivered).length;
  if (desk) {
    desk.el.classList.toggle('on', busy);
    desk.el.classList.add('occ'); // ocupado: de noche se le prende la lámpara
    desk.el.classList.toggle('deleg', d.state === 'delegating');
    desk.el.dataset.tool = busy ? tool : '';
    // Desorden del escritorio según qué tan lleno tiene el contexto: hojas, tazas y bolas de papel.
    const pct = d.ctx?.pct ?? 0;
    desk.el.dataset.cl = pct >= 75 ? 3 : pct >= 50 ? 2 : pct >= 25 ? 1 : 0;
    desk.el.classList.toggle('noted', !!d.note);
    desk.el.title = d.ctx ? `${d.name} · contexto ${pct}% lleno (${fmtTok(d.ctx.tokens)} de ${fmtTok(d.ctx.window || 200000)} tokens)` : '';
    desk.paper.hidden = !pend;
    desk.paper.dataset.count = pend > 1 ? pend : '';
  }
  paintSubs(a);
}

function paintSubs(a) {
  const d = a.data,
    seat = seatOf(d.place);
  const running = [];
  d.subs.forEach((s, k) => {
    let el = a.subEls.get(k);
    if (s.status === 'running') {
      running.push(k);
      if (!el) {
        el = document.createElement('div');
        el.className = 'mini';
        el.innerHTML = `${robotSVG('#a99cf2')}<div class="lbl">${esc(shortType(s.type))}</div>`;
        MAP.appendChild(el);
        a.subEls.set(k, el);
      }
      el.title = `${s.type}${s.desc ? ' · ' + s.desc : ''}${s.activity ? '\n' + s.activity : ''}`;
    } else if (el) {
      a.subEls.delete(k);
      el.classList.add('fin');
      setTimeout(() => el.classList.add('out'), 900);
      setTimeout(() => el.remove(), 1500);
    }
  });
  running.forEach((k, i) => {
    const el = a.subEls.get(k);
    if (i >= MINI_SLOTS.length) {
      el.hidden = true;
      return;
    }
    const [dx, dy] = MINI_SLOTS[i];
    el.hidden = false;
    el.style.left = seat.x + dx + '%';
    el.style.top = py(seat.y + dy);
    el.style.zIndex = Math.round((seat.y + dy) * 10);
  });
  const extra = running.length - MINI_SLOTS.length;
  if (extra > 0) {
    if (!a.extraEl) {
      a.extraEl = document.createElement('div');
      a.extraEl.className = 'extra';
      MAP.appendChild(a.extraEl);
    }
    a.extraEl.textContent = `+${extra}`;
    a.extraEl.style.left = seat.x + 9.6 + '%';
    a.extraEl.style.top = py(seat.y - 0.6);
  } else if (a.extraEl) {
    a.extraEl.remove();
    a.extraEl = null;
  }
  viewClass(a);
}
const shortType = t =>
  String(t || 'agente')
    .replace('general-purpose', 'general')
    .replace(/^.*:/, '')
    .toUpperCase()
    .slice(0, 10);

/* ---------- espera de respuesta ---------- */
// Un robot que te hace una pregunta muestra cuánto lleva esperando; a los 2 min baila para llamar la atención
// y a los 3 min hace fila frente a tu escritorio (en orden de llegada). Al responderle vuelve a su lugar.
const WAIT_DANCE_MS = 2 * 60e3,
  WAIT_QUEUE_MS = 3 * 60e3;
const fmtWait = ms => {
  const t = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
};
function tickWaiting() {
  const nowMs = Date.now();
  const line = [];
  for (const a of st.robots.values()) {
    const since = a.data.state === 'input' && a.data.inputAt ? Date.parse(a.data.inputAt) : null;
    const ms = since ? nowMs - since : 0;
    if (since && !a.data.spawnReq) a.sign.textContent = `? ${fmtWait(ms)}`;
    a.el.classList.toggle('dance', !!since && ms >= WAIT_DANCE_MS);
    a.el.classList.toggle('impatient', !!since && ms >= 60e3);
    if (since && ms >= WAIT_QUEUE_MS && !st.view && !a.data.place.sala) line.push([since, a]); // la fila es frente a tu escritorio, en la oficina
  }
  line.sort((x, y) => x[0] - y[0]);
  const inLine = new Set(line.map(([, a]) => a));
  for (const a of st.robots.values()) {
    if (a.queueSlot == null || inLine.has(a)) continue;
    a.queueSlot = null;
    queue(a, () => walkTo(a, restPos(a)));
  }
  line.forEach(([, a], k) => {
    if (a.queueSlot === k) return;
    if (a.queueSlot == null) toast(`${a.data.name} lleva 3 min esperando tu respuesta y se puso en la fila`);
    a.queueSlot = k;
    queue(a, () => walkTo(a, restPos(a)));
  });
  $('#room-coord .room-h small').textContent = line.length ? `${line.length} en fila` : 'coordinador';
  document.querySelectorAll('[data-since]').forEach(el => {
    el.textContent = fmtWait(nowMs - Date.parse(el.dataset.since));
  });
}
setInterval(tickWaiting, 1000);

function onDeliver(name, items) {
  const a = st.robots.get(name);
  const n = items.length;
  const what = n === 1 ? items[0].path.split('/').pop() : `${n} documentos`;
  const crit = items.reduce((k, i) => k + (i.critical || 0), 0);
  if (!a) {
    toast(`${name} entregó ${what}`);
    pulseInbox();
    celebrate(items);
    return;
  }
  // N · Lo lleva un cartero desde su puesto; el robot no se levanta.
  sendCourier(a.el.classList.contains('offview') ? restPos(a) : { ...a.pos }, n).then(() => {
    celebrate(items);
    toast(
      crit
        ? `⚠ ${name} entregó ${what} con ${crit} hallazgo${crit === 1 ? '' : 's'} crítico${crit === 1 ? '' : 's'}`
        : `${name} entregó ${what} en tu bandeja`
    );
  });
}
const inboxShown = () => (st.inboxTemp ? st.inbox : st.inbox.filter(i => !isTempDoc(i.path)));
const unseen = () => inboxShown().filter(i => i.status !== 'visto').length;
function renderInboxBadge() {
  const n = unseen();
  $('#inbox-n').textContent = n;
  $('#inbox-btn-n').textContent = n;
  $('#inbox-btn-n').hidden = !n;
  $('#inbox').classList.toggle('has-new', n > 0);
  // La luz roja sigue encendida mientras haya un review con críticos sin ver; se apaga al abrirlo o marcarlo visto.
  const crit = st.inbox.filter(i => i.status !== 'visto' && i.critical > 0).reduce((k, i) => k + i.critical, 0);
  $('#alarm').hidden = !crit;
  $('#alarm').title = crit ? `${crit} hallazgo${crit === 1 ? '' : 's'} crítico${crit === 1 ? '' : 's'} sin ver en tu bandeja` : '';
  $('#room-coord').classList.toggle('alert', crit > 0);
}
// Entrega sin críticos: confeti sobre la bandeja. Con críticos no hay fiesta: destella la luz roja.
function celebrate(items) {
  if (items.some(i => i.critical > 0)) {
    const al = $('#alarm');
    al.classList.remove('flash');
    void al.offsetWidth;
    al.classList.add('flash');
    return;
  }
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const box = $('#inbox');
  const colors = ['#f3b74f', '#5fd4c4', '#ef7f8a', '#a99cf2', '#8fd06a', '#fff3c4'];
  for (let k = 0; k < 26; k++) {
    const c = document.createElement('i');
    c.className = 'confetti';
    const ang = -Math.PI / 2 + (Math.random() - 0.5) * 2.4,
      dist = 30 + Math.random() * 45;
    c.style.cssText = `--dx:${Math.cos(ang) * dist}px;--dy:${Math.sin(ang) * dist}px;--r:${(Math.random() - 0.5) * 900}deg;--t:${0.9 + Math.random() * 0.6}s;background:${colors[k % colors.length]}`;
    box.appendChild(c);
    setTimeout(() => c.remove(), 1700);
  }
}
function pulseInbox() {
  const el = $('#inbox');
  el.classList.remove('pulse');
  void el.offsetWidth;
  el.classList.add('pulse');
}

function onLeft(name) {
  const a = st.robots.get(name);
  if (!a) return;
  vacate(a.data.place, a);
  st.robots.delete(name);
  // Se va con una caja con sus cosas (planta, taza y papeles), como quien deja la oficina.
  a.transit = true;
  viewClass(a); // si estaba en una sala, sale del cuarto de salas hacia la puerta
  queue(a, async () => {
    a.el.classList.remove('sel');
    a.el.classList.add('leaving');
    a.el.insertAdjacentHTML(
      'beforeend',
      '<div class="lbox" aria-hidden="true"><i class="lb-plant"></i><i class="lb-mug"></i><i class="lb-paper"></i></div>'
    );
    await walkTo(a, st.view && a.data.place.sala === st.view ? salaEntry() : door());
    a.el.remove();
    layout();
  });
  paneCache.delete(name);
  if (st.view && a.data.place?.sala === st.view) refreshBoardSoon();
  if (zoom.follow === name) stopFollow();
  if (st.side === name) {
    st.side = null;
    renderSide();
  }
  if (st.selected === name) {
    select(null);
    toast(`${name} salió de la oficina.`);
  }
  renderSalaChips();
  if (st.selected?.startsWith('@sala:')) schedulePanel();
  renderMeta();
}
