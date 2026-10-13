// `suzy.mjs mirror install|uninstall`: add or remove the mirror hook in Claude Code's user settings
// (~/.claude/settings.json). Pure functions on the file's text, so tests run on fixtures and the
// founder's real file is only ever written by `--apply` from an interactive terminal.
import os from 'node:os';
import path from 'node:path';
import { HOOK_EVENTS } from '../mirror/lib.mjs';

/** Our entries are recognised by the hook's path, wherever the checkout lives. */
const OURS = /(^|[\\/"'\s])tools[\\/]mirror[\\/]hook\.mjs(["'\s]|$)/;

export function claudeSettingsFile(env = process.env) {
  const dir = env.CLAUDE_CONFIG_DIR ? path.resolve(env.CLAUDE_CONFIG_DIR) : path.join(env.HOME || os.homedir(), '.claude');
  return path.join(dir, 'settings.json');
}

const q = (s) => `"${String(s).replace(/(["\\$`])/g, '\\$1')}"`;

/** The hook command: this Node (absolute, so a GUI-launched Claude Code finds it) and the hook. */
export function hookCommand(nodePath, hookPath) {
  return `${q(nodePath)} ${q(hookPath)}`;
}

/** One handler: async (never blocks a lane), a timeout in seconds as a backstop. */
export function hookHandler(command) {
  return { type: 'command', command, async: true, timeout: 10 };
}

/** The exact block `install` merges: every mirror event, one handler each. */
export function hooksBlock(command) {
  return { hooks: Object.fromEntries(HOOK_EVENTS.map((e) => [e, [{ hooks: [hookHandler(command)] }]])) };
}

export const isOurs = (h) => !!h && typeof h === 'object' && h.type === 'command' && typeof h.command === 'string' && OURS.test(h.command);

function parse(text) {
  if (text === undefined || !text.trim()) return {};
  let v;
  try {
    v = JSON.parse(text);
  } catch (e) {
    throw new Error(`settings.json is not valid JSON (${e.message}); fix it first, nothing was changed`);
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('settings.json is not a JSON object; nothing was changed');
  if (v.hooks !== undefined && (!v.hooks || typeof v.hooks !== 'object' || Array.isArray(v.hooks))) throw new Error('settings.json "hooks" is not an object; nothing was changed');
  return v;
}

/** Same layout as the file had: its indent and its trailing newline. */
function format(value, original) {
  const indent = /^([ \t]+)"/m.exec(original ?? '')?.[1] ?? '  ';
  const nl = original === undefined || original === '' || original.endsWith('\n') ? '\n' : '';
  return JSON.stringify(value, null, indent) + nl;
}

/**
 * Merge our hook into the settings text. Existing hooks are never removed or reordered: our group is
 * appended to each event's list, or our handler's command is updated in place if it is already there.
 */
export function installHooks(text, command) {
  const settings = parse(text);
  const before = JSON.stringify(settings);
  settings.hooks ??= {};
  let added = 0;
  let updated = 0;
  for (const event of HOOK_EVENTS) {
    const groups = (settings.hooks[event] ??= []);
    if (!Array.isArray(groups)) throw new Error(`settings.json hooks.${event} is not a list; nothing was changed`);
    const mine = groups.flatMap((g) => (Array.isArray(g?.hooks) ? g.hooks.filter(isOurs) : []));
    if (!mine.length) {
      groups.push({ hooks: [hookHandler(command)] });
      added++;
      continue;
    }
    for (const h of mine) {
      const want = hookHandler(command);
      if (h.command !== want.command || h.async !== true || h.timeout !== want.timeout) {
        Object.assign(h, want);
        updated++;
      }
    }
  }
  const changed = JSON.stringify(settings) !== before;
  return { text: changed ? format(settings, text) : text, changed, added, updated };
}

/** Remove only our handlers (and groups or event lists that held nothing else). */
export function uninstallHooks(text) {
  const settings = parse(text);
  let removed = 0;
  const hooks = settings.hooks;
  if (hooks) {
    for (const event of Object.keys(hooks)) {
      const groups = hooks[event];
      if (!Array.isArray(groups)) continue;
      const kept = [];
      for (const g of groups) {
        if (!Array.isArray(g?.hooks) || !g.hooks.some(isOurs)) {
          kept.push(g);
          continue;
        }
        const rest = g.hooks.filter((h) => !isOurs(h));
        removed += g.hooks.length - rest.length;
        if (rest.length) kept.push({ ...g, hooks: rest });
      }
      if (kept.length) hooks[event] = kept;
      else if (groups.length) delete hooks[event];
    }
    if (removed && !Object.keys(hooks).length) delete settings.hooks;
  }
  return { text: removed ? format(settings, text) : text, changed: removed > 0, removed };
}

/**
 * After an uninstall: if an install backup holds exactly these settings, its bytes (so a file in any
 * layout comes back byte for byte); otherwise the formatted text.
 */
export function restoreBytes(text, backups) {
  let want;
  try {
    want = JSON.stringify(JSON.parse(text));
  } catch {
    return text;
  }
  for (const b of backups) {
    try {
      if (JSON.stringify(JSON.parse(b)) === want) return b;
    } catch {
      /* not JSON: not a candidate */
    }
  }
  return text;
}

export function applyRefusal(isTTY) {
  return isTTY ? undefined : 'refused: --apply edits your Claude Code settings and only runs from an interactive terminal. Run it yourself.';
}
