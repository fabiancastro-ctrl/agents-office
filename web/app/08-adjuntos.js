/* ---------- adjuntos ---------- */
// Clave 'job' = formulario de nuevo encargo; cualquier otra = nombre del robot (chat).
const attList = key => (st.att[key] ||= []);
const fmtSize = n => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

function trayHtml(key) {
  return attList(key)
    .map(
      (f, i) =>
        `<div class="att">${f.url ? `<img src="${f.url}" alt="">` : `<span class="fi">${esc((f.name.split('.').pop() || 'archivo').slice(0, 4).toUpperCase())}</span>`}<span class="an" title="${esc(f.path)}">${esc(f.name)} · ${fmtSize(f.size)}</span><button type="button" data-unatt="${esc(key)}" data-i="${i}" aria-label="Quitar ${esc(f.name)}">✕</button></div>`
    )
    .join('');
}
function refreshTray(key) {
  const el = document.querySelector(`[data-tray="${CSS.escape(key)}"]`);
  if (el) el.innerHTML = trayHtml(key);
}

async function upload(files, key) {
  for (const file of files) {
    if (file.size > ATTACH_MAX) {
      toast(`${file.name} supera 20 MB.`);
      continue;
    }
    let name = file.name || 'adjunto';
    if (/^image\.(png|jpe?g|gif|webp)$/i.test(name))
      name = `captura-${new Date().toTimeString().slice(0, 8).replace(/:/g, '')}.${name.split('.').pop()}`;
    const scope = key === 'job' ? 'encargos' : key;
    try {
      const res = await fetch(`/api/attachments?scope=${encodeURIComponent(scope)}&name=${encodeURIComponent(name)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: file
      });
      const data = await res.json();
      if (!res.ok) {
        toast(data.error || 'No se pudo subir el archivo.');
        continue;
      }
      attList(key).push({ ...data, url: file.type.startsWith('image/') ? URL.createObjectURL(file) : null });
      refreshTray(key);
    } catch {
      toast('No se pudo subir el archivo.');
    }
  }
}

function attKeyFor(el) {
  if (el.closest('#chat-form')) return st.selected;
  if (el.closest('#job-form')) return 'job';
  return null;
}

PANEL.addEventListener('paste', e => {
  const key = attKeyFor(e.target);
  const files = [...(e.clipboardData?.files || [])];
  if (!key || !files.length) return;
  e.preventDefault();
  upload(files, key);
});
PANEL.addEventListener('dragover', e => {
  const form = e.target.closest('#chat-form, #job-form');
  if (!form || !e.dataTransfer?.types.includes('Files')) return;
  e.preventDefault();
  form.classList.add('dragover');
});
PANEL.addEventListener('dragleave', e => {
  e.target.closest('#chat-form, #job-form')?.classList.remove('dragover');
});
PANEL.addEventListener('drop', e => {
  const form = e.target.closest('#chat-form, #job-form');
  if (!form) return;
  e.preventDefault();
  form.classList.remove('dragover');
  const key = attKeyFor(form);
  if (key) upload([...e.dataTransfer.files], key);
});
PANEL.addEventListener('change', e => {
  if (e.target.matches('input[type=file][data-attfor]')) {
    const key = attKeyFor(e.target);
    if (key) upload([...e.target.files], key);
    e.target.value = '';
  }
});
