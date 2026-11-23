// Oficina de Agentes · carpeta de trabajo y configuración de la oficina.
// Parte de daemon/daemon.mjs, que carga los módulos de daemon/lib/ en orden y arranca la oficina.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CONFIG_FILE, LEGACY_RUNS, ROOT, RUNS, saveJson, WORKSPACE } from './base.mjs';
import { listSkills } from './tmux.mjs';

/* ---------- carpeta de trabajo ---------- */
const expandHome = p =>
  String(p || '')
    .trim()
    .replace(/^~(?=$|\/)/, os.homedir());

function initialWorkspace() {
  if (process.env.OFFICE_WORKSPACE) return path.resolve(expandHome(process.env.OFFICE_WORKSPACE));
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')).workspace || null;
  } catch {
    /* sin config */
  }
  // Instalaciones de antes de esta opción: ya tenían estado y usaban la carpeta de dos niveles arriba.
  if (LEGACY_RUNS && fs.existsSync(path.join(RUNS, 'office-state.json'))) return saveWorkspace(path.resolve(ROOT, '../..'));
  return null;
}
function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
}
function saveConfig(patch) {
  saveJson(CONFIG_FILE, { ...readConfig(), ...patch }, { pretty: true });
}
function saveWorkspace(ws) {
  saveConfig({ workspace: ws });
  return ws;
}
// Nombre de la oficina: solo estético, para distinguir varias oficinas (una por workspace) en el navegador.
const OFFICE_NAME_MAX = 40;
let officeName = String(readConfig().name || '').slice(0, OFFICE_NAME_MAX);
const setOfficeName = v => {
  officeName = v;
};

// Claude Code pide confirmar la confianza la primera vez que se abre en una carpeta (o en una superior);
// mientras no se acepte, un robot quedaría detenido en esa pregunta.
function trustAccepted(ws) {
  let projects = {};
  try {
    projects = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8')).projects || {};
  } catch {
    return null;
  }
  for (let d = ws; ; d = path.dirname(d)) {
    if (projects[d]?.hasTrustDialogAccepted) return true;
    if (d === path.dirname(d)) return false;
  }
}

function workspaceInfo(raw) {
  const ws = path.resolve(expandHome(raw));
  const st = fs.statSync(ws, { throwIfNoEntry: false });
  const info = { path: ws, exists: !!st, isDir: !!st?.isDirectory() };
  if (!info.isDir) return info;
  info.claudeMd = fs.existsSync(path.join(ws, 'CLAUDE.md'));
  info.projectSkills = listSkills(ws).length - listSkills(os.tmpdir()).length; // sin contar las de ~/.claude
  info.trusted = trustAccepted(ws);
  info.insideOffice = ws === ROOT || ws.startsWith(ROOT + path.sep);
  return info;
}

function setupView() {
  return { workspace: WORKSPACE, fromEnv: !!process.env.OFFICE_WORKSPACE, suggestion: path.resolve(ROOT, '../..') };
}

export { initialWorkspace, OFFICE_NAME_MAX, officeName, readConfig, saveConfig, saveWorkspace, setOfficeName, setupView, workspaceInfo };
