/* ---------- fixed «waiting for you» bar ---------- */
// One row inside the sticky header: a mini face for each robot that waits for you, in waitingList order, with the
// time it has been waiting (ticked by tickWaiting through data-since) and its p0/p1 mark. Hidden when nobody waits.
function renderNeedBar() {
  const box = $('#needbar');
  if (!box) return;
  const list = waitingList()
    .map(n => st.robots.get(n)?.data)
    .filter(Boolean);
  if (!list.length) {
    if (!box.hidden) {
      box.hidden = true;
      box._html = '';
      box.innerHTML = '';
    }
    return;
  }
  const html =
    `<span class="nb-h">Te necesitan <b>${list.length}</b></span>` +
    list
      .map(
        d =>
          `<button type="button" class="nb-c${d.priority ? ` nb-${d.priority}` : ''}" data-need="${esc(d.name)}" style="--c:${COLORS[d.color % COLORS.length]}" title="${esc(`${d.name}${titleOf(d) ? ' · ' + titleOf(d) : ''} · te espera`)}">${robotHead(COLORS[d.color % COLORS.length], lookOf(d.name, d.place, d))}<span class="nb-n">${esc(d.name)}</span>${d.inputAt ? `<i data-since="${esc(d.inputAt)}">${fmtWait(Date.now() - Date.parse(d.inputAt))}</i>` : ''}${prioTag(d.priority)}</button>`
      )
      .join('');
  if (box._html !== html) {
    box._html = html;
    box.innerHTML = html;
  }
  box.hidden = false;
}
$('#needbar').addEventListener('click', e => {
  const b = e.target.closest('[data-need]');
  if (b) select(b.dataset.need);
});
