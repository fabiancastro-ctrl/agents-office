/* ---------- conexión ---------- */
function connect() {
  const es = new EventSource('/api/events');
  es.onopen = () => { const c = $('#conn'); c.textContent = 'conectado'; c.className = 'tag ok'; };
  es.onerror = () => { const c = $('#conn'); c.textContent = 'sin conexión, reintentando'; c.className = 'tag bad'; };
  es.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.type === 'snapshot') {
      for (const a of st.robots.values()) { vacate(a.data.place, a); a.el.remove(); }
      st.robots.clear();
      st.config = m.config; setMapTheme(m.config.mapTheme); renderGrowth(); st.inbox = m.inbox; st.routines = m.routines || []; st.salas = m.salas || []; st.favorites = m.favorites || []; st.pins = m.pins || []; renderPinsBadge(); setArchCount(m.archiveCount || 0);
      setSetup(m.setup);
      renderInboxBadge();
      m.robots.forEach(r => upsert(r, true));
      layout();
      PANEL.dataset.view = ''; // tras reconectar, repintado completo (el log pudo cambiar)
      renderRoutineChips(); renderSalaChips(); renderMeta(); renderPanel();
      notif.known = null; st.ready = true; // el siguiente checkAlerts toma esto como punto de partida
    } else if (m.type === 'robot') upsert(m.robot);
    else if (m.type === 'setup') onSetupSaved(m);
    else if (m.type === 'config') { st.config = m.config; setMapTheme(m.config.mapTheme); renderGrowth(); renderMeta(); if (st.selected === '@new') schedulePanel(); }
    else if (m.type === 'salas') { st.salas = m.salas; renderSalaChips(); if (st.selected === '@war' || st.selected?.startsWith('@sala:')) schedulePanel(); }
    else if (m.type === 'routines') { st.routines = m.routines; renderRoutineChips(); renderMeta(); if (st.selected === '@cron') schedulePanel(); }
    else if (m.type === 'log') {
      const a = st.robots.get(m.name);
      if (a) {
        // Llega en orden casi siempre; si es más viejo que el último (el transcript se guarda en tandas), va en su
        // lugar y se repinta esa conversación.
        let k = a.log.length;
        while (k > 0 && a.log[k - 1].at > m.entry.at) k--;
        a.log.splice(k, 0, m.entry);
        const views = [[st.selected === m.name, $('#log', PANEL)], [st.side === m.name, $('#side .sd-log')]];
        for (const [on, lg] of views) {
          if (!on || !lg) continue;
          if (k === a.log.length - 1) { appendLog(m.entry, a, lg); continue; }
          const bottom = lg.scrollTop + lg.clientHeight >= lg.scrollHeight - 30;
          lg.innerHTML = renderLog(a.log, m.name); markPins(lg);
          if (bottom) lg.scrollTop = lg.scrollHeight;
        }
      }
    } else if (m.type === 'deliver') onDeliver(m.name, m.items);
    else if (m.type === 'inbox') { st.inbox = m.inbox; renderInboxBadge(); renderMeta(); if (st.selected === '@inbox') schedulePanel(); }
    else if (m.type === 'left') onLeft(m.name);
    else if (m.type === 'notice') { toast(m.text); if (notif.on) { beep(); if ('Notification' in window && Notification.permission === 'granted') try { new Notification('Oficina de Agentes', {body: m.text}); } catch { /* sin notificación */ } } }
    else if (m.type === 'archive') { setArchCount(m.count); if (st.selected === '@archivo') loadArchivo(); }
    else if (m.type === 'pins') { st.pins = m.pins; renderPinsBadge(); markPins(); if (st.selected === '@pins') schedulePanel(); }
    else if (m.type === 'favorites') { st.favorites = m.favorites; if (st.selected === '@new') schedulePanel(); }
  };
}

async function api(method, url, body) {
  const res = await fetch(url, {method, headers: {'Content-Type': 'application/json'}, body: body ? JSON.stringify(body) : undefined});
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { toast(data.error || `Error ${res.status}`); throw new Error(data.error); }
  return data;
}

function toast(msg) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => t.hidden = true, 4500); }

