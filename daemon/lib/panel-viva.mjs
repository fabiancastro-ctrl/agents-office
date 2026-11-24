// Oficina de Agentes · is the robot's console really running claude? Pure decision on what tmux reports for its window.
// A window can outlive claude: the pane is dead (remain-on-exit) or a shell is left in the foreground. The real console
// runs `env … claude`, whose pane_current_command is the claude binary (its version number, e.g. «2.1.331», or «claude»/«node»).
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'fish', 'ksh', 'csh', 'tcsh', 'login']);
const SHELL_STREAK = 2; // a foreground shell must be seen on this many consecutive checks before the console counts as lost

// pane: { dead: '0'|'1', command: string } from `#{pane_dead}` and `#{pane_current_command}`.
// Returns 'alive', 'dead' (pane_dead) or 'shell' (a shell in the foreground). `scriptBin` skips the shell test: a claude
// that is itself a shell script (the test fake) legitimately shows as a shell.
function paneVerdict(pane, { scriptBin = false } = {}) {
  if (!pane) return 'alive'; // unknown: never mark lost from missing data
  if (String(pane.dead) === '1') return 'dead';
  const cmd = String(pane.command || '')
    .trim()
    .replace(/^-/, '') // login shells show as «-zsh»
    .toLowerCase();
  if (!scriptBin && SHELLS.has(cmd)) return 'shell';
  return 'alive';
}

// Parses `list-panes -F '#{window_name}\t#{pane_dead}\t#{pane_current_command}'` into Map(window -> pane). The first
// pane of a window wins.
function parsePanes(stdout) {
  const m = new Map();
  for (const line of String(stdout || '').split('\n')) {
    const [name, dead, command] = line.split('\t');
    if (name && !m.has(name)) m.set(name, { dead, command: command ?? '' });
  }
  return m;
}

export { paneVerdict, parsePanes, SHELL_STREAK };
