import fs from 'node:fs';
import path from 'node:path';
import { NEVER_ALLOW, saveJson, WORKSPACE } from './base.mjs';

/* ---------- «Permitir siempre» ----------
   Turns a permission key from «Uso Claude» («Bash: git status», «Grep») into a Claude Code `permissions.allow` rule and
   adds it to <office workspace>/.claude/settings.local.json. Never touches ~/.claude/settings.json. */

// Tools whose rule needs a path to be safe: the key does not carry one, so no rule is offered.
const PATH_TOOLS = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
// Command prefixes that are never offered as «always», whatever the user waited on.
// The key keeps only the first two words, so interpreters, shells, network and cloud CLIs would become a blank check
// (`node -e`, `bash -c`, `gh pr` → merge, `curl -X` → any request).
const RISKY_PREFIX =
  /^(rm|mv|sudo|dd|chmod|chown|kill|pkill|killall|git push|git reset|git clean|git checkout|git rebase|git branch|git tag|bash|sh|zsh|fish|eval|exec|env|xargs|find|node|deno|bun|npx|pnpx|python\d*(\.\d+)?|ruby|perl|php|osascript|curl|wget|ssh|scp|rsync|nc|gh|aws|gcloud|az|terraform|tofu|kubectl|helm|docker|psql|mysql|redis-cli|launchctl|crontab|open)\b/;
const SAFE_WORD = /^[\w./@=+,:-]+$/;

// → { rule } or { error }
function ruleFor(key) {
  const m = String(key || '').match(/^([\w.-]+)(?::\s*(.*))?$/s);
  if (!m) return { error: 'Ese permiso no se puede convertir en una regla.' };
  const [, tool, rest] = m;
  if (tool === 'Bash') {
    const words = String(rest || '')
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    if (!words.length || !words.every(w => SAFE_WORD.test(w))) return { error: 'Ese comando no se puede convertir en una regla segura.' };
    const cmd = words.join(' ');
    if (RISKY_PREFIX.test(cmd) || NEVER_ALLOW.some(re => re.test(cmd)))
      return { error: `«${cmd}» puede borrar o publicar cosas: no se ofrece como permiso fijo.` };
    return { rule: `Bash(${cmd}:*)` };
  }
  if (PATH_TOOLS.has(tool))
    return { error: `«${tool}» necesita una ruta y el registro no la guarda: agrégala a mano en .claude/settings.local.json.` };
  return { rule: tool };
}

const settingsFile = () => path.join(WORKSPACE, '.claude', 'settings.local.json');

// Adds the rule keeping the rest of the file. Refuses to overwrite a file it cannot parse.
function allowRule(rule) {
  const file = settingsFile();
  let data = {};
  if (fs.existsSync(file)) {
    try {
      data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return { status: 409, error: 'settings.local.json no es un JSON válido: arréglalo a mano antes de agregar la regla.' };
    }
    if (!data || typeof data !== 'object' || Array.isArray(data))
      return { status: 409, error: 'settings.local.json no es un objeto JSON.' };
  }
  if (data.permissions != null && (typeof data.permissions !== 'object' || Array.isArray(data.permissions)))
    return { status: 409, error: 'La clave permissions de settings.local.json no es un objeto.' };
  data.permissions ||= {};
  if (data.permissions.allow != null && !Array.isArray(data.permissions.allow))
    return { status: 409, error: 'permissions.allow de settings.local.json no es una lista.' };
  data.permissions.allow ||= [];
  if (data.permissions.allow.includes(rule)) return { status: 200, added: false, file };
  data.permissions.allow.push(rule);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  saveJson(file, data, { pretty: true, eol: true });
  return { status: 200, added: true, file };
}

export { allowRule, ruleFor, settingsFile };
