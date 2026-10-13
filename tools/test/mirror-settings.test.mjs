// node --test tools/test   (or: npm test --prefix tools)
// `suzy.mjs mirror install|uninstall|test`: merging into Claude Code settings that already hold
// Suzy-style hooks, byte-for-byte uninstall, the --apply TTY guard. Every run uses a temp HOME;
// nothing here reads or writes the real ~/.claude.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { claudeSettingsFile, hookCommand, hooksBlock, installHooks, isOurs, restoreBytes, uninstallHooks } from '../lib/mirror-settings.mjs';
import { HOOK_EVENTS } from '../mirror/lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SUZY = path.resolve(here, '..', 'suzy.mjs');
const HOOK = path.resolve(here, '..', 'mirror', 'hook.mjs');
const FIXTURE = fs.readFileSync(path.join(here, 'fixtures', 'claude-settings.suzy.json'), 'utf8');
const CMD = hookCommand('/opt/node/bin/node', '/Users/me/agentcraft/tools/mirror/hook.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-settings-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('the block: all hook events, async command handlers pointing at the absolute hook path', () => {
  const block = hooksBlock(hookCommand(process.execPath, HOOK));
  assert.deepEqual(Object.keys(block.hooks), HOOK_EVENTS);
  assert.equal(HOOK_EVENTS.length, 9); // the 8 lane events plus PostToolUseFailure (failed commands land there)
  for (const groups of Object.values(block.hooks)) {
    assert.equal(groups.length, 1);
    const [h] = groups[0].hooks;
    assert.deepEqual(h, { type: 'command', command: `"${process.execPath}" "${HOOK}"`, async: true, timeout: 10 });
    assert.ok(path.isAbsolute(HOOK) && isOurs(h));
  }
});

test('install merges into Suzy-style hooks without changing, removing or reordering any of them', () => {
  const before = JSON.parse(FIXTURE);
  const res = installHooks(FIXTURE, CMD);
  assert.equal(res.changed, true);
  assert.equal(res.added, HOOK_EVENTS.length);
  const after = JSON.parse(res.text);
  // every other key untouched, in order
  assert.deepEqual(Object.keys(after), Object.keys(before));
  for (const k of Object.keys(before)) if (k !== 'hooks') assert.deepEqual(after[k], before[k]);
  // every existing event keeps its groups first, unchanged; ours is appended last
  for (const [event, groups] of Object.entries(before.hooks)) {
    assert.deepEqual(after.hooks[event].slice(0, groups.length), groups, event);
    assert.equal(after.hooks[event].length, groups.length + 1);
  }
  assert.deepEqual(Object.keys(after.hooks).slice(0, Object.keys(before.hooks).length), Object.keys(before.hooks));
  for (const event of HOOK_EVENTS) assert.ok(after.hooks[event].at(-1).hooks.every(isOurs), event);
  assert.ok(res.text.endsWith('}\n'));
});

test('install is idempotent, and a moved Node is updated in place', () => {
  const once = installHooks(FIXTURE, CMD).text;
  const twice = installHooks(once, CMD);
  assert.deepEqual([twice.changed, twice.text], [false, once]);
  const moved = installHooks(once, hookCommand('/usr/local/bin/node', '/Users/me/agentcraft/tools/mirror/hook.mjs'));
  assert.deepEqual([moved.changed, moved.added, moved.updated], [true, 0, HOOK_EVENTS.length]);
  const all = Object.values(JSON.parse(moved.text).hooks).flat().flatMap((g) => g.hooks).filter(isOurs);
  assert.equal(all.length, HOOK_EVENTS.length);
  assert.ok(all.every((h) => h.command.startsWith('"/usr/local/bin/node"')));
});

test('uninstall restores the original byte for byte (and leaves non-mirror hooks alone)', () => {
  const installed = installHooks(FIXTURE, CMD).text;
  const res = uninstallHooks(installed);
  assert.equal(res.removed, HOOK_EVENTS.length);
  assert.equal(res.text, FIXTURE);
  assert.deepEqual(uninstallHooks(FIXTURE), { text: FIXTURE, changed: false, removed: 0 });
  // other layouts: tabs and no trailing newline survive; a file with no hooks gets none back
  for (const original of [JSON.stringify(JSON.parse(FIXTURE), null, '\t'), JSON.stringify({ model: 'opus' }, null, 4) + '\n', '{}\n']) {
    assert.equal(uninstallHooks(installHooks(original, CMD).text).text, original);
  }
  // any layout at all: the install backup's bytes come back
  const compact = JSON.stringify(JSON.parse(FIXTURE));
  const roundTrip = uninstallHooks(installHooks(compact, CMD).text).text;
  assert.notEqual(roundTrip, compact);
  assert.equal(restoreBytes(roundTrip, ['{"other": 1}', compact]), compact);
});

test('refuses settings it cannot merge safely', () => {
  assert.throws(() => installHooks('{ "hooks": [] }', CMD), /"hooks" is not an object/);
  assert.throws(() => installHooks('{ // comment\n}', CMD), /not valid JSON/);
  assert.throws(() => installHooks('{"hooks": {"Stop": {}}}', CMD), /hooks.Stop is not a list/);
  assert.equal(installHooks(undefined, CMD).changed, true);
});

// ---------------------------------------------------------------------------------------------
// the CLI, against a temp HOME
// ---------------------------------------------------------------------------------------------

let n = 0;
function home(settings) {
  const h = path.join(tmp, `home-${++n}`);
  fs.mkdirSync(path.join(h, '.claude'), { recursive: true });
  if (settings !== undefined) fs.writeFileSync(path.join(h, '.claude', 'settings.json'), settings);
  return h;
}
const envFor = (h) => {
  const env = { ...process.env, HOME: h, AGENTCRAFT_HOME: path.join(h, '.agentcraft') };
  delete env.CLAUDE_CONFIG_DIR;
  return env;
};
function suzy(h, ...args) {
  const r = spawnSync(process.execPath, [SUZY, ...args], { env: envFor(h), encoding: 'utf8' });
  return { code: r.status, out: r.stdout + r.stderr };
}
/** Run under a pseudo-terminal (`script`), the way the founder runs --apply. */
const SCRIPT = process.platform === 'darwin' ? ['-q', '/dev/null'] : process.platform === 'linux' ? null : undefined;
// script(1) needs a stdin it can read terminal settings from or ignore: /dev/null, not a pipe
const stdio = () => [fs.openSync('/dev/null', 'r'), 'pipe', 'pipe'];
const scriptArgs = (argv) => (process.platform === 'darwin' ? [...SCRIPT, ...argv] : ['-qec', argv.map((a) => `'${a}'`).join(' '), '/dev/null']);
function suzyTTY(h, ...args) {
  const r = spawnSync('script', scriptArgs([process.execPath, SUZY, ...args]), { env: envFor(h), encoding: 'utf8', stdio: stdio() });
  return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
}
const hasScript = SCRIPT !== undefined && /TTY/.test(spawnSync('script', scriptArgs(['sh', '-c', 'test -t 0 && test -t 1 && echo TTY']), { encoding: 'utf8', stdio: stdio() }).stdout ?? '');

test('settings path: $HOME/.claude, or CLAUDE_CONFIG_DIR', () => {
  assert.equal(claudeSettingsFile({ HOME: '/h' }), path.join('/h', '.claude', 'settings.json'));
  assert.equal(claudeSettingsFile({ HOME: '/h', CLAUDE_CONFIG_DIR: '/c' }), path.join('/c', 'settings.json'));
});

test('mirror install: a dry run shows the block and writes nothing; --apply needs a terminal', () => {
  const h = home(FIXTURE);
  const file = path.join(h, '.claude', 'settings.json');
  const dry = suzy(h, 'mirror', 'install');
  assert.equal(dry.code, 0, dry.out);
  assert.match(dry.out, /Dry run: this would add 9 and update 0 mirror hook entries/);
  assert.ok(dry.out.includes(JSON.stringify(hooksBlock(hookCommand(process.execPath, HOOK)), null, 2)));
  assert.ok(dry.out.includes(file));
  assert.equal(fs.readFileSync(file, 'utf8'), FIXTURE);
  const refused = suzy(h, 'mirror', 'install', '--apply');
  assert.equal(refused.code, 2);
  assert.match(refused.out, /only runs from an interactive terminal/);
  assert.equal(fs.readFileSync(file, 'utf8'), FIXTURE);
  assert.deepEqual(fs.readdirSync(path.join(h, '.claude')), ['settings.json']);
});

test('mirror install --apply backs up, merges, is idempotent; uninstall --apply restores byte for byte', { skip: hasScript ? false : 'needs script(1) for a pseudo-terminal' }, () => {
  const h = home(FIXTURE);
  const file = path.join(h, '.claude', 'settings.json');
  const inst = suzyTTY(h, 'mirror', 'install', '--apply');
  assert.equal(inst.code, 0, inst.out);
  assert.match(inst.out, /Done: added 9, updated 0 mirror hook entries/);
  const baks = fs.readdirSync(path.join(h, '.claude')).filter((f) => /^settings\.json\.bak-\d{8}-\d{6}$/.test(f));
  assert.equal(baks.length, 1);
  assert.equal(fs.readFileSync(path.join(h, '.claude', baks[0]), 'utf8'), FIXTURE);
  const installed = fs.readFileSync(file, 'utf8');
  assert.equal(installed, installHooks(FIXTURE, hookCommand(process.execPath, HOOK)).text);

  const again = suzyTTY(h, 'mirror', 'install', '--apply');
  assert.match(again.out, /Already installed: nothing to change/);
  assert.equal(fs.readFileSync(file, 'utf8'), installed);
  assert.equal(fs.readdirSync(path.join(h, '.claude')).filter((f) => f.includes('.bak-')).length, 1);

  const dry = suzy(h, 'mirror', 'uninstall');
  assert.match(dry.out, /Dry run: this would remove 9 mirror hook entries/);
  assert.equal(fs.readFileSync(file, 'utf8'), installed);
  const un = suzyTTY(h, 'mirror', 'uninstall', '--apply');
  assert.equal(un.code, 0, un.out);
  assert.equal(fs.readFileSync(file, 'utf8'), FIXTURE);
});

test('uninstall --apply of a compact file comes back byte for byte through the install backup', { skip: hasScript ? false : 'needs script(1) for a pseudo-terminal' }, () => {
  const compact = JSON.stringify(JSON.parse(FIXTURE));
  const h = home(compact);
  assert.equal(suzyTTY(h, 'mirror', 'install', '--apply').code, 0);
  assert.equal(suzyTTY(h, 'mirror', 'uninstall', '--apply').code, 0);
  assert.equal(fs.readFileSync(path.join(h, '.claude', 'settings.json'), 'utf8'), compact);
});

test('mirror test appends a synthetic session the backend accepts: start, read, edit, test pass, stop', () => {
  const h = home(undefined);
  const r = suzy(h, 'mirror', 'test', '--fast');
  assert.equal(r.code, 0, r.out);
  const file = path.join(h, '.agentcraft', 'mirror', 'events.jsonl');
  const events = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(events.map((e) => `${e.event}${e.tool ? `:${e.tool}` : ''}`), ['SessionStart', 'UserPromptSubmit', 'PreToolUse:Read', 'PostToolUse:Read', 'PreToolUse:Edit', 'PostToolUse:Edit', 'PreToolUse:Bash', 'PostToolUse:Bash', 'Stop']);
  assert.equal(new Set(events.map((e) => e.sid)).size, 1);
  assert.equal(events[1].lane, 'MIRROR-TEST');
  assert.equal(events[7].ok, true);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(path.join(h, '.claude', 'settings.json')), false); // never touched settings
});
