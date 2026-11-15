/* ---------- código Konami (↑ ↑ ↓ ↓ ← → ← → B A Espacio): fiesta de 15 s ---------- */
// Va en captura, antes que los atajos: mientras tecleas la secuencia, la B y la A no abren la bandeja ni aprueban.
const KONAMI = ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'b', 'a', ' '];
let kpos = 0, partying = false;
document.addEventListener('keydown', e => {
  if (e.ctrlKey || e.metaKey || e.altKey || e.target.closest?.('input, textarea, select, [contenteditable]')) return;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const inSeq = kpos >= 8; // la B, la A y el Espacio solo se «roban» si ya venías con las flechas
  kpos = k === KONAMI[kpos] ? kpos + 1 : (k === KONAMI[0] ? 1 : 0);
  if (inSeq && kpos > 8) { e.stopImmediatePropagation(); e.preventDefault(); }
  if (kpos === KONAMI.length) { kpos = 0; officeParty(15000); }
}, true);
function officeParty(ms) {
  if (partying) return;
  partying = true;
  MAP.classList.add('party');
  const bots = [...MAP.querySelectorAll('.robot')];
  bots.forEach(el => el.style.setProperty('--pd', `${(-Math.random() * .4).toFixed(2)}s`));
  const fx = document.createElement('div'); fx.className = 'party-fx'; fx.setAttribute('aria-hidden', 'true');
  const COLORS = ['#ffd36b', '#ef7f8a', '#5fcbb9', '#a99cf2', '#7cb6f0', '#b9d06a'];
  fx.innerHTML = '<div class="disco"></div><div class="ball"></div>' + Array.from({length: 70}, () =>
    `<i class="confetti" style="left:${(Math.random() * 100).toFixed(1)}%;background:${COLORS[Math.random() * COLORS.length | 0]};animation-duration:${(2.2 + Math.random() * 2.2).toFixed(2)}s;animation-delay:${(-Math.random() * 4).toFixed(2)}s;--r:${(Math.random() * 720 - 360) | 0}deg"></i>`).join('');
  MAP.appendChild(fx);
  const shout = () => {
    const live = [...MAP.querySelectorAll('.robot')]; if (!live.length) return;
    const el = live[Math.random() * live.length | 0];
    const b = document.createElement('div'); b.className = 'pbub'; b.textContent = ['¡FCP! 🎉', 'FCP 🕺', '¡F-C-P! 🎶', 'FCP ✨'][Math.random() * 4 | 0];
    el.appendChild(b); setTimeout(() => b.remove(), 1500);
  };
  shout(); const iv = setInterval(shout, 700);
  setTimeout(() => {
    clearInterval(iv); fx.remove(); MAP.classList.remove('party');
    MAP.querySelectorAll('.pbub').forEach(b => b.remove());
    bots.forEach(el => el.style.removeProperty('--pd'));
    partying = false;
  }, ms);
}

/* ---------- modo HD ---------- */
// Solo cambia una clase en <html>: las capas HD ya están dibujadas en cada robot (robot-art.js).
function setHd(on) {
  document.documentElement.classList.toggle('hd-on', on);
  $('#btn-hd').setAttribute('aria-pressed', String(on));
  $('#btn-hd').classList.toggle('on', on);
}
setHd(prefGet('hd', '0') === '1');
$('#btn-hd').addEventListener('click', () => { const on = !document.documentElement.classList.contains('hd-on'); setHd(on); prefSet('hd', on ? '1' : '0'); });
document.addEventListener('visibilitychange', () => document.documentElement.classList.toggle('tab-hidden', document.hidden));

/* ---------- zoom del mapa y cámara que sigue a un robot ---------- */
// El mapa se escala desde la esquina y el contenedor hace scroll; el punto bajo el mouse queda fijo al acercar.
// Solo en la vista 2D (en 2.5D la perspectiva ya mueve el plano).
const WRAP = MAP.parentElement;
const zoom = {z: 1, follow: null, raf: 0, drag: null, moved: false};
function setZoom(z, cx, cy) {
  z = Math.min(3, Math.max(1, Math.round(z * 100) / 100));
  if (WRAP.classList.contains('iso')) z = 1;
  const old = zoom.z; if (z === old) return;
  cx ??= WRAP.clientWidth / 2; cy ??= WRAP.clientHeight / 2;
  const sx = (WRAP.scrollLeft + cx) / old, sy = (WRAP.scrollTop + cy) / old;
  zoom.z = z;
  WRAP.classList.toggle('zoomed', z > 1);
  MAP.style.transform = z > 1 ? `scale(${z})` : '';
  WRAP.scrollLeft = sx * z - cx; WRAP.scrollTop = sy * z - cy;
  $('#zoom-n').textContent = Math.round(z * 100) + '%';
  if (z === 1) stopFollow();
  if (hover.name) clampHover();
}
$('#zoom-ui').addEventListener('click', e => {
  const b = e.target.closest('[data-zoom]');
  if (b) return b.dataset.zoom === 'in' ? setZoom(zoom.z * 1.35) : b.dataset.zoom === 'out' ? setZoom(zoom.z / 1.35) : setZoom(1);
  if (e.target.closest('[data-unfollow]')) stopFollow();
});
WRAP.addEventListener('wheel', e => {
  if (!(e.ctrlKey || e.metaKey)) { if (zoom.follow && zoom.z > 1) stopFollow(); return; } // rueda sola: scroll normal
  e.preventDefault();
  const r = WRAP.getBoundingClientRect(), dy = Math.max(-60, Math.min(60, e.deltaY));
  setZoom(zoom.z * Math.exp(-dy * 0.006), e.clientX - r.left, e.clientY - r.top);
}, {passive: false});
// Arrastrar el piso con el mouse mueve la vista cuando hay zoom (y deja de seguir al robot).
WRAP.addEventListener('pointerdown', e => {
  if (zoom.z === 1 || e.button !== 0 || e.target.closest('.zoom-ui, button, input, select, textarea')) return;
  zoom.drag = {x: e.clientX, y: e.clientY, sl: WRAP.scrollLeft, st: WRAP.scrollTop}; zoom.moved = false;
});
window.addEventListener('pointermove', e => {
  const d = zoom.drag; if (!d) return;
  const dx = e.clientX - d.x, dy = e.clientY - d.y;
  if (!zoom.moved && Math.hypot(dx, dy) < 5) return;
  if (!zoom.moved) { zoom.moved = true; WRAP.classList.add('dragging'); stopFollow(); }
  WRAP.scrollLeft = d.sl - dx; WRAP.scrollTop = d.st - dy;
});
window.addEventListener('pointerup', () => { zoom.drag = null; WRAP.classList.remove('dragging'); });
// Si arrastraste, el clic de soltar no abre nada.
MAP.addEventListener('click', e => { if (zoom.moved) { zoom.moved = false; e.stopImmediatePropagation(); e.preventDefault(); } }, true);
function follow(name) {
  const a = st.robots.get(name); if (!a) return;
  if (WRAP.classList.contains('iso')) return toast('Seguir a un robot funciona en la vista 2D');
  stopFollow();
  zoom.follow = name; a.el.classList.add('followed');
  if (zoom.z < 2) setZoom(2);
  const f = $('#zoom-follow'); f.innerHTML = `Siguiendo a ${esc(name)} <button type="button" data-unfollow title="Dejar de seguir (Esc)" aria-label="Dejar de seguir">×</button>`; f.hidden = false;
  const tick = () => {
    const r = st.robots.get(zoom.follow); if (!r) return stopFollow();
    const b = r.el.getBoundingClientRect(), w = WRAP.getBoundingClientRect();
    const tx = WRAP.scrollLeft + (b.left + b.width / 2 - w.left) - WRAP.clientWidth / 2;
    const ty = WRAP.scrollTop + (b.top + b.height / 2 - w.top) - WRAP.clientHeight / 2;
    WRAP.scrollLeft += (tx - WRAP.scrollLeft) * .12; WRAP.scrollTop += (ty - WRAP.scrollTop) * .12;
    zoom.raf = requestAnimationFrame(tick);
  };
  zoom.raf = requestAnimationFrame(tick);
}
function stopFollow() {
  cancelAnimationFrame(zoom.raf);
  if (zoom.follow) st.robots.get(zoom.follow)?.el.classList.remove('followed');
  zoom.follow = null; $('#zoom-follow').hidden = true;
}
// Mayús + clic en un robot: la cámara lo sigue (sin abrir su ventana).
MAP.addEventListener('click', e => {
  if (!e.shiftKey) return;
  const r = e.target.closest('.robot:not(.on-break)'); if (!r) return;
  e.stopImmediatePropagation(); follow(r.dataset.name);
}, true);

