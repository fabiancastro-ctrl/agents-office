/* ---------- animación al entrar a una sala ---------- */
// Quitar la animación = borrar este archivo, el bloque «sala-anim» de style.css, el interruptor #btn-salaanim de index.html
// y las llamadas salaZoomIn / salaZoomOut de 02-mapa.js. Al entrar, la puerta del cuarto se abre y la vista se acerca a
// ese cuarto (~600 ms) antes de pasar a la vista de la sala; al salir hay una vuelta corta.
const salaAnim = { on: true, busy: false };
function setSalaAnim(on) {
  salaAnim.on = on;
  $('#btn-salaanim').setAttribute('aria-pressed', String(on));
  $('#btn-salaanim').classList.toggle('on', on);
}
setSalaAnim(prefGet('salaAnim', '1') === '1');
$('#btn-salaanim').addEventListener('click', () => {
  setSalaAnim(!salaAnim.on);
  prefSet('salaAnim', salaAnim.on ? '1' : '0');
});
// Where the zoom is aimed at: the room's centre, in map pixels, and how much it takes to fill the map.
function salaZoomTarget(id) {
  const el = MAP.querySelector(`.sroom[data-sala="${CSS.escape(id)}"]`),
    mr = MAP.getBoundingClientRect(),
    r = el?.getBoundingClientRect();
  if (!el || !r.width || !mr.width) return null;
  return { el, x: r.left + r.width / 2 - mr.left, y: r.top + r.height / 2 - mr.top, k: Math.min(5, Math.min(mr.width / r.width, mr.height / r.height) * 0.9) };
}
const salaAnimOk = () =>
  salaAnim.on &&
  !salaAnim.busy &&
  !document.hidden &&
  !matchMedia('(prefers-reduced-motion: reduce)').matches &&
  !WRAP.classList.contains('iso') &&
  zoom.z === 1;
function salaZoomIn(id, go) {
  const t = !st.view && salaAnimOk() && salaZoomTarget(id);
  if (!t) return false;
  salaAnim.busy = true;
  t.el.classList.add('opening'); // the door swings open
  MAP.style.transformOrigin = `${t.x}px ${t.y}px`;
  WRAP.style.overflow = 'hidden';
  const anim = MAP.animate([{ transform: 'scale(1)', opacity: 1 }, { transform: `scale(${t.k.toFixed(2)})`, opacity: 0.25 }], {
    duration: 520,
    delay: 160,
    easing: 'ease-in',
    fill: 'both'
  });
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    t.el.classList.remove('opening');
    go(); // the real thing: the sala view
    anim.cancel();
    MAP.style.transformOrigin = '';
    WRAP.style.overflow = '';
    salaAnim.busy = false;
    MAP.animate([{ opacity: 0.3 }, { opacity: 1 }], { duration: 180 });
  };
  anim.onfinish = finish;
  setTimeout(finish, 900); // if the tab throttles animations
  return true;
}
function salaZoomOut(id) {
  const t = salaAnimOk() && salaZoomTarget(id);
  if (!t) return;
  salaAnim.busy = true;
  MAP.style.transformOrigin = `${t.x}px ${t.y}px`;
  WRAP.style.overflow = 'hidden';
  const anim = MAP.animate([{ transform: `scale(${(t.k * 0.6).toFixed(2)})`, opacity: 0.2 }, { transform: 'scale(1)', opacity: 1 }], {
    duration: 320,
    easing: 'ease-out'
  });
  const end = () => {
    MAP.style.transformOrigin = '';
    WRAP.style.overflow = '';
    salaAnim.busy = false;
  };
  anim.onfinish = end;
  anim.oncancel = end;
}
