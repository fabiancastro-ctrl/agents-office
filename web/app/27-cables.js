/* ---------- red cable between robots that clash ---------- */
// A thin dotted red line joins two robots that edited the same file (d.clashes, computed by the daemon). It lives in an SVG
// over the map, follows the robots while they walk (offsetLeft/offsetTop track the CSS transition) and is only drawn when
// both robots are visible in the current view. On by default; switched off from the «⚙ Ajustes» menu.
const cables = { on: prefGet('cables', '1') === '1', lines: new Map(), raf: 0 };
const cablesSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
cablesSvg.id = 'cables';
cablesSvg.setAttribute('aria-hidden', 'true');
MAP.appendChild(cablesSvg);

// pair key «a|b» → files both edited
function cablePairs() {
  const pairs = new Map();
  for (const a of st.robots.values()) {
    for (const c of a.data.clashes || []) {
      for (const other of c.with) {
        const key = [a.data.name, other].sort().join('|');
        const files = pairs.get(key) || new Set();
        files.add(c.file);
        pairs.set(key, files);
      }
    }
  }
  return pairs;
}
const cableCenter = a => ({ x: a.el.offsetLeft, y: a.el.offsetTop - a.el.offsetHeight / 2 }); // the robot is anchored by its feet
const cableVisible = a => !!a && !a.el.classList.contains('offview');

function drawCables() {
  cables.raf = 0;
  const pairs = cables.on ? cablePairs() : new Map();
  for (const [key, line] of cables.lines)
    if (!pairs.has(key)) {
      line.remove();
      cables.lines.delete(key);
    }
  for (const [key, files] of pairs) {
    const [n1, n2] = key.split('|'),
      a = st.robots.get(n1),
      b = st.robots.get(n2);
    let line = cables.lines.get(key);
    if (!cableVisible(a) || !cableVisible(b)) {
      if (line) line.style.display = 'none';
      continue;
    }
    if (!line) {
      line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.appendChild(document.createElementNS('http://www.w3.org/2000/svg', 'title'));
      cablesSvg.appendChild(line);
      cables.lines.set(key, line);
    }
    const p = cableCenter(a),
      q = cableCenter(b);
    line.style.display = '';
    line.setAttribute('x1', p.x);
    line.setAttribute('y1', p.y);
    line.setAttribute('x2', q.x);
    line.setAttribute('y2', q.y);
    line.dataset.pair = key;
    const tip = `${n1} y ${n2} editaron:\n${[...files].map(shownPath).join('\n')}`;
    if (line.firstChild.textContent !== tip) line.firstChild.textContent = tip;
  }
  if (pairs.size && !document.hidden) cables.raf = requestAnimationFrame(drawCables); // keep following walking robots
}
const cablesKick = () => {
  if (!cables.raf) cables.raf = requestAnimationFrame(drawCables);
};
setInterval(cablesKick, 1000); // picks up new clashes and view changes; the frame loop stops itself when there are none
document.addEventListener('visibilitychange', cablesKick);

function setCables(on) {
  cables.on = on;
  $('#btn-cables').setAttribute('aria-pressed', String(on));
  $('#btn-cables').classList.toggle('on', on);
  $('#btn-cables').textContent = on ? 'Visibles' : 'Ocultos';
  cablesKick();
}
setCables(cables.on);
$('#btn-cables').addEventListener('click', () => {
  setCables(!cables.on);
  prefSet('cables', cables.on ? '1' : '0');
});
