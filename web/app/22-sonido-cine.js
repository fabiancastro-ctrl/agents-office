/* ---------- W · sonido opcional y X · modo cine ---------- */
// Sin archivos ni tokens: los sonidos se generan con el audio del navegador. Apagado por defecto; se guarda aquí.
const sound = { on: prefGet('sound', '0') === '1', ctx: null };
function tone(notes, type = 'sine', vol = 0.09) {
  if (!sound.on) return;
  try {
    const ctx = (sound.ctx ||= new (window.AudioContext || window.webkitAudioContext)());
    notes.forEach(([f, at, len]) => {
      const o = ctx.createOscillator(),
        g = ctx.createGain(),
        t = ctx.currentTime + at;
      o.type = type;
      o.frequency.value = f;
      o.connect(g);
      g.connect(ctx.destination);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol, t + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t + len);
      o.start(t);
      o.stop(t + len + 0.02);
    });
  } catch {
    /* sin audio */
  }
}
const SFX = {
  deliver: () =>
    tone(
      [
        [660, 0, 0.08],
        [990, 0.05, 0.12]
      ],
      'triangle',
      0.07
    ), // «pop» al llegar un documento a tu bandeja
  need: () => {
    if (!notif.on)
      tone(
        [
          [1318, 0, 0.5],
          [1760, 0.12, 0.6]
        ],
        'sine',
        0.06
      );
  }, // campanita (si «Avisos» ya suena, no repite)
  done: () =>
    tone(
      [
        [523, 0, 0.14],
        [659, 0.12, 0.14],
        [784, 0.24, 0.14],
        [1047, 0.36, 0.35]
      ],
      'triangle',
      0.07
    ) // fanfarria: equipo terminado
};
// Cambios de un robot que suenan: pasa a esperarte (pregunta o permiso) o pide robots.
function soundOn(prev, d) {
  if ((prev.state !== 'input' && d.state === 'input') || (!prev.spawnReq && d.spawnReq)) SFX.need();
}
const soundBtn = document.createElement('button');
soundBtn.className = 'btn sm';
soundBtn.id = 'btn-sound';
soundBtn.type = 'button';
soundBtn.title =
  'Sonidos cortos de la oficina: un «pop» al llegar un documento, una campanita cuando alguien te necesita (si «Avisos» está apagado) y una fanfarria cuando un equipo termina. Se guarda en este navegador.';
const paintSound = () => {
  soundBtn.textContent = sound.on ? '🔊 Sonido' : '🔈 Sonido: no';
  soundBtn.setAttribute('aria-pressed', String(sound.on));
};
paintSound();
soundBtn.addEventListener('click', () => {
  sound.on = !sound.on;
  prefSet('sound', sound.on ? '1' : '0');
  paintSound();
  SFX.deliver();
});
($('#vm-sound') || $('#btn-notify')?.parentElement)?.appendChild(soundBtn); // inside the Settings menu

// X · Modo cine (tecla C): solo el mapa, a pantalla completa, sin barra, métricas ni tarjetas. C o Esc salen.
function cinema(on = !document.body.classList.contains('cine')) {
  document.body.classList.toggle('cine', on);
  if (on) toast('🎬 Modo cine · C o Esc para salir');
  requestAnimationFrame(() => layout());
}
document.addEventListener('keydown', e => {
  if (e.ctrlKey || e.metaKey || e.altKey || e.repeat || e.target.closest?.('input, textarea, select, [contenteditable]')) return;
  if (e.key.toLowerCase() === 'c' && !st.selected) {
    e.preventDefault();
    cinema();
  } else if (e.key === 'Escape' && document.body.classList.contains('cine') && !st.selected) cinema(false);
});

// 6 · Enlaces directos a un robot o a una sala: «🔗 Copiar enlace» y abrirlos aunque la página ya esté abierta.
document.addEventListener('click', async e => {
  const b = e.target.closest('[data-copy-link]');
  if (!b) return;
  const [kind, id] = b.dataset.copyLink.split(':');
  const url = `${location.origin}${location.pathname}#${kind}=${id}`;
  try {
    await navigator.clipboard.writeText(url);
    toast(`Enlace copiado: ${url}`);
  } catch {
    prompt('Copia el enlace:', url);
  }
});
addEventListener('hashchange', () => {
  const r = (location.hash.match(/^#robot=([\w-]+)$/) || [])[1],
    s = (location.hash.match(/^#sala=([\w-]+)$/) || [])[1];
  if (r && st.robots.has(r)) {
    if (st.view && st.robots.get(r).data.place.sala !== st.view) leaveSala();
    select(r);
  } else if (s && s !== st.view) enterSala(s);
});
