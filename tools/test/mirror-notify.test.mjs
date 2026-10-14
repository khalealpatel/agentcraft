// node --test tools/test   (or: npm test --prefix tools)
// `suzy.mjs notify`: one macOS notification when a lane starts waiting on the founder or opens a PR.
// The decision logic (tools/mirror/notify.mjs) is pure and tested on event lists; the loop and the
// CLI are tested against a temp mirror directory with delivery stubbed or --dry-run. Nothing here
// ever runs osascript or launchctl, and nothing touches the real ~/Library.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  NOTIFY_TITLE, PR_TITLE, LAUNCH_LABEL, createNotifyState, escapeAppleScript, osascriptArgs, reasonText, watchEvents,
} from '../mirror/notify.mjs';
import { appendEvent } from '../mirror/lib.mjs';
import { agentApplyRefusal, launchAgentFile, plistText } from '../lib/notify-agent.mjs';
import { notifyAgent } from '../suzy.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SUZY = path.resolve(HERE, '..', 'suzy.mjs');
const FOUNDER = path.join(HERE, 'fixtures', 'mirror-stats', 'founder-waits.jsonl');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-notify-')));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const fresh = () => {
  const d = path.join(tmp, `d${++n}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
};

const MIN = 60_000;
const T0 = Date.parse('2026-10-14T09:00:00Z');
const A = 'aaaaaaaaaaaaaaaa';
const ev = (at, event, extra = {}, sid = A) => ({ v: 1, ts: T0 + at * MIN, sid, event, repo: 'agentcraft', branch: 'lane-x', ...extra });
const head = (lane, sid = A) => [ev(0, 'SessionStart', {}, sid), ev(0, 'UserPromptSubmit', { first: true, ...(lane ? { lane } : {}) }, sid)];
const feedAll = (events, opts) => {
  const st = createNotifyState(opts);
  return events.flatMap((e) => st.feed(e));
};

test('reasons: a question, a finished turn, a permission', () => {
  assert.equal(reasonText('ask_user_question'), 'asked a question');
  assert.equal(reasonText('elicitation_dialog'), 'asked a question');
  assert.equal(reasonText('turn_end'), 'finished its turn');
  assert.equal(reasonText('permission_prompt'), 'needs permission');
  assert.equal(reasonText('idle_prompt'), 'is waiting for your next message');
  assert.equal(reasonText('something_new'), 'needs your attention');
});

test('a Stop is one "finished its turn" notification, when the lane starts waiting', () => {
  const out = feedAll([...head('VOICE-PROMPT-03'), ev(5, 'Stop')]);
  assert.deepEqual(out, [{ type: 'waiting', lane: 'VOICE-PROMPT-03', kind: 'turn_end', title: NOTIFY_TITLE, body: 'VOICE-PROMPT-03 needs you (finished its turn)' }]);
});

test('an AskUserQuestion notifies once, and the Notification inside it does not notify again', () => {
  const out = feedAll([
    ...head('SMS-CONSENT-02'), ev(2, 'PreToolUse', { tool: 'AskUserQuestion' }), ev(2.1, 'Notification', { kind: 'elicitation_dialog' }),
    ev(3, 'Notification', { kind: 'idle_prompt' }),
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].body, 'SMS-CONSENT-02 needs you (asked a question)');
});

test('a permission prompt notifies; the answer ends it and the next wait notifies again', () => {
  const out = feedAll([
    ...head('P-1'),
    ev(1, 'PreToolUse', { tool: 'Bash', cmd: 'npm install' }), ev(1.1, 'Notification', { kind: 'permission_prompt' }),
    ev(4, 'PostToolUse', { tool: 'Bash', cmd: 'npm install', ok: true }),
    ev(6, 'PreToolUse', { tool: 'Bash', cmd: 'git push' }), ev(6.1, 'Notification', { kind: 'permission_prompt' }),
    ev(8, 'PostToolUse', { tool: 'Bash', cmd: 'git push', ok: true }),
    ev(9, 'Stop'),
  ]);
  assert.deepEqual(out.map((o) => o.body), ['P-1 needs you (needs permission)', 'P-1 needs you (needs permission)', 'P-1 needs you (finished its turn)']);
});

test('at most one notification per wait: a Stop and its idle_prompt nudge are one wait', () => {
  const out = feedAll([...head('O-1'), ev(5, 'Stop'), ev(6, 'Notification', { kind: 'idle_prompt' }), ev(7, 'Notification', { kind: 'idle_prompt' })]);
  assert.equal(out.length, 1);
});

test('an answered wait and a new Stop notify again (one per wait)', () => {
  const out = feedAll([...head('O-2'), ev(5, 'Stop'), ev(30, 'UserPromptSubmit'), ev(35, 'Stop')]);
  assert.equal(out.length, 2);
});

test('a lane opening a PR notifies once, "opened a PR", and its finishing Stop does not notify', () => {
  const out = feedAll([
    ...head('PR-1'),
    ev(1, 'PreToolUse', { tool: 'Bash', cmd: 'gh pr create --base suzy' }),
    ev(1.1, 'PostToolUse', { tool: 'Bash', cmd: 'gh pr create --base suzy', ok: true }),
    ev(2, 'Stop'), ev(3, 'Notification', { kind: 'idle_prompt' }), ev(4, 'SessionEnd'),
  ]);
  assert.deepEqual(out, [{ type: 'pr', lane: 'PR-1', kind: 'pr', title: PR_TITLE, body: 'PR-1 opened a PR' }]);
});

test('a failed gh pr create is not a PR', () => {
  const out = feedAll([
    ...head('PR-2'),
    ev(1, 'PreToolUse', { tool: 'Bash', cmd: 'gh pr create' }),
    ev(1.1, 'PostToolUseFailure', { tool: 'Bash', cmd: 'gh pr create', ok: false, exit: 1 }),
  ]);
  assert.deepEqual(out, []);
});

test('a Stop followed by SessionEnd was still notified at the Stop (nobody could know yet)', () => {
  const out = feedAll([...head('E-1'), ev(5, 'Stop'), ev(6, 'SessionEnd')]);
  assert.equal(out.length, 1);
});

test('lanes with no lane ID are silent unless --all', () => {
  const events = [...head(undefined), ev(5, 'Stop')];
  assert.deepEqual(feedAll(events), []);
  const all = feedAll(events, { all: true });
  assert.equal(all.length, 1);
  assert.equal(all[0].body, 'agentcraft @ lane-x needs you (finished its turn)');
});

test('a resumed session without the brief notifies as the lane it belongs to', () => {
  const B = 'bbbbbbbbbbbbbbbb';
  const out = feedAll([
    ...head('RES-1'), ev(5, 'Stop'), ev(6, 'SessionEnd'),
    ev(600, 'SessionStart', { source: 'resume' }, B), ev(600, 'UserPromptSubmit', { first: true }, B), ev(605, 'Stop', {}, B),
  ]);
  assert.deepEqual(out.map((o) => o.lane), ['RES-1', 'RES-1']);
});

test('two lanes at once notify separately', () => {
  const B = 'bbbbbbbbbbbbbbbb';
  const out = feedAll([...head('L-1'), ...head('L-2', B), ev(3, 'Stop'), ev(4, 'Stop', {}, B)]);
  assert.deepEqual(out.map((o) => o.lane), ['L-1', 'L-2']);
});

test('the founder fixture: replayed event by event, VOICE-PROMPT-03 and SMS-CONSENT-02 each notify at the moment they start waiting', () => {
  const events = fs.readFileSync(FOUNDER, 'utf8').trimEnd().split('\n').map((l) => JSON.parse(l));
  const out = feedAll(events);
  assert.deepEqual(out.map((o) => `${o.type}:${o.body}`), [
    'waiting:VOICE-PROMPT-03 needs you (finished its turn)', // 2026-10-13 16:22 the disk STOP
    'waiting:SMS-CONSENT-02 needs you (needs permission)', // 16:34 the npm install prompt
    'waiting:SMS-CONSENT-02 needs you (asked a question)', // 16:46 the AskUserQuestion box
    'waiting:SMS-CONSENT-02 needs you (finished its turn)', // 10-14 09:13 (SessionEnd follows a minute later)
    'waiting:VOICE-PROMPT-03 needs you (finished its turn)', // 09:14 after "continue"
  ]);
});

// ---------------------------------------------------------------------------------------------
// AppleScript
// ---------------------------------------------------------------------------------------------

test('escapeAppleScript: quotes and backslashes cannot end the string', () => {
  assert.equal(escapeAppleScript('a "b" \\ c'), 'a \\"b\\" \\\\ c');
  assert.equal(escapeAppleScript('line\nbreak'), 'line break');
});

test('osascriptArgs: one -e script, title and body quoted, no shell involved', () => {
  assert.deepEqual(osascriptArgs('Suzy lane waiting', 'X needs you "now"'), ['-e', 'display notification "X needs you \\"now\\"" with title "Suzy lane waiting"']);
});

// ---------------------------------------------------------------------------------------------
// the loop: starts silent (history is not news), then follows the log
// ---------------------------------------------------------------------------------------------

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const write = (dir, e) => appendEvent(dir, e);

test('watchEvents: history is silent, new events notify, a rotation in the middle loses nothing', async () => {
  const dir = fresh();
  for (const e of [...head('H-1'), ev(5, 'Stop')]) write(dir, e); // before notify started: already waiting
  const sent = [];
  const w = watchEvents({ dir, pollMs: 10, deliver: (title, body) => sent.push([title, body]) });
  assert.deepEqual(w.waitingNow.map((x) => x.lane), ['H-1']);
  assert.deepEqual(sent, []);

  write(dir, ev(30, 'UserPromptSubmit'));
  write(dir, ev(31, 'PreToolUse', { tool: 'AskUserQuestion' }));
  w.poll();
  assert.deepEqual(sent, [[NOTIFY_TITLE, 'H-1 needs you (asked a question)']]);

  // the hook rotates the file; the next events are in a new one
  fs.renameSync(path.join(dir, 'events.jsonl'), path.join(dir, 'events.jsonl.1'));
  write(dir, ev(32, 'PostToolUse', { tool: 'AskUserQuestion', ok: true }));
  write(dir, ev(40, 'Stop'));
  w.poll();
  assert.equal(sent.length, 2);
  assert.equal(sent[1][1], 'H-1 needs you (finished its turn)');
  w.poll();
  assert.equal(sent.length, 2); // nothing twice
  w.stop();
});

test('watchEvents: a half-written line is picked up once it is complete; junk lines are skipped', () => {
  const dir = fresh();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'events.jsonl');
  const sent = [];
  const w = watchEvents({ dir, pollMs: 10, deliver: (t, b) => sent.push(b) });
  const lines = [...head('J-1'), ev(2, 'Stop')].map((e) => JSON.stringify(e));
  fs.appendFileSync(file, `not json\n${lines[0]}\n${lines[1]}\n${lines[2].slice(0, 20)}`);
  w.poll();
  assert.deepEqual(sent, []);
  fs.appendFileSync(file, `${lines[2].slice(20)}\n`);
  w.poll();
  assert.deepEqual(sent, ['J-1 needs you (finished its turn)']);
  w.stop();
});

test('watchEvents: a delivery that throws does not stop the loop', () => {
  const dir = fresh();
  write(dir, ev(0, 'SessionStart'));
  let calls = 0;
  const w = watchEvents({ dir, pollMs: 10, deliver: () => { calls++; throw new Error('osascript missing'); } });
  for (const e of [ev(0, 'UserPromptSubmit', { first: true, lane: 'D-1' }), ev(1, 'Stop'), ev(30, 'UserPromptSubmit'), ev(31, 'Stop')]) write(dir, e);
  assert.doesNotThrow(() => w.poll());
  assert.equal(calls, 2);
  w.stop();
});

// ---------------------------------------------------------------------------------------------
// the command
// ---------------------------------------------------------------------------------------------

function runNotify(home, args = []) {
  const child = spawn(process.execPath, [SUZY, 'notify', '--home', home, '--poll-ms', '50', ...args], {
    env: { ...process.env, HOME: home, AGENTCRAFT_HOME: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  child.stdout.on('data', (c) => (out += c));
  child.stderr.on('data', (c) => (err += c));
  const until = async (re, ms = 5000) => {
    const t = Date.now();
    while (!re.test(out)) {
      if (Date.now() - t > ms) throw new Error(`timed out waiting for ${re}; stdout: ${out}; stderr: ${err}`);
      await wait(25);
    }
  };
  const stop = () => new Promise((resolve) => {
    if (child.exitCode !== null) return resolve({ code: child.exitCode, out, err });
    child.once('exit', (code) => resolve({ code, out, err }));
    child.kill('SIGTERM');
  });
  return { child, until, stop, get out() { return out; }, get err() { return err; } };
}

test('notify --dry-run prints what it would show, with the founder fixture\'s lanes', async () => {
  const home = fresh();
  const dir = path.join(home, 'mirror');
  fs.mkdirSync(dir, { recursive: true });
  const r = runNotify(home, ['--dry-run']);
  try {
    await r.until(/watching/);
    for (const l of fs.readFileSync(FOUNDER, 'utf8').trimEnd().split('\n').slice(0, 9)) fs.appendFileSync(path.join(dir, 'events.jsonl'), `${l}\n`);
    await r.until(/finished its turn/);
    assert.match(r.out, /\[dry run\] Suzy lane waiting: VOICE-PROMPT-03 needs you \(finished its turn\)/);
  } finally {
    const res = await r.stop();
    assert.equal(res.code, 0);
  }
});

test('notify prints only (no osascript) when not on macOS', async () => {
  const { shouldDeliver } = await import('../mirror/notify.mjs');
  assert.equal(shouldDeliver({ platform: 'darwin', dryRun: false }), true);
  assert.equal(shouldDeliver({ platform: 'linux', dryRun: false }), false);
  assert.equal(shouldDeliver({ platform: 'win32', dryRun: false }), false);
  assert.equal(shouldDeliver({ platform: 'darwin', dryRun: true }), false);
  assert.equal(LAUNCH_LABEL, 'dev.agentcraft.suzy-notify');
});

// ---------------------------------------------------------------------------------------------
// notify install | uninstall: a temp HOME stands in for ~/Library; launchctl is a stub
// ---------------------------------------------------------------------------------------------

function agentEnv() {
  const home = fresh();
  const calls = [];
  const lines = [];
  const deps = (over = {}) => ({
    env: { HOME: home }, isTTY: true, platform: 'darwin', uid: 501,
    launchctl: (args) => { calls.push(args); return { status: 0 }; },
    out: (l) => lines.push(l),
    ...over,
  });
  return { home, agentHome: path.join(home, '.agentcraft'), calls, lines, deps, file: launchAgentFile({ HOME: home }) };
}

test('the agent file lives under $HOME/Library/LaunchAgents with the dev.agentcraft.suzy-notify label', () => {
  assert.equal(launchAgentFile({ HOME: '/tmp/h' }), '/tmp/h/Library/LaunchAgents/dev.agentcraft.suzy-notify.plist');
});

test('plistText: runs this node on suzy.mjs notify at login, restarts on a crash, logs to a file; XML-escaped', () => {
  const p = plistText({ node: '/opt/node & co/bin/node', script: '/r/tools/suzy.mjs', home: '/h/.agentcraft', log: '/h/.agentcraft/notify.log' });
  assert.match(p, /<key>Label<\/key>\s*<string>dev\.agentcraft\.suzy-notify<\/string>/);
  assert.match(p, /<string>\/opt\/node &amp; co\/bin\/node<\/string>\s*<string>\/r\/tools\/suzy\.mjs<\/string>\s*<string>notify<\/string>\s*<string>--home<\/string>\s*<string>\/h\/\.agentcraft<\/string>/);
  assert.match(p, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(p, /<key>SuccessfulExit<\/key>\s*<false\/>/);
  assert.match(p, /<key>StandardOutPath<\/key>\s*<string>\/h\/\.agentcraft\/notify\.log<\/string>/);
  assert.ok(!p.includes(String.fromCharCode(0x2014)));
});

test('notify install: a dry run by default prints the plan and writes nothing', () => {
  const t = agentEnv();
  const code = notifyAgent({ home: t.agentHome }, false, t.deps());
  assert.equal(code, 0);
  assert.ok(!fs.existsSync(path.join(t.home, 'Library')));
  assert.ok(!fs.existsSync(t.agentHome));
  assert.deepEqual(t.calls, []);
  const text = t.lines.join('\n');
  assert.match(text, /Dry run: this would write that file/);
  assert.match(text, /notify install --apply/);
  assert.ok(text.includes(t.file));
});

test('notify install --apply: writes the plist, loads it with launchctl bootstrap gui/<uid>', () => {
  const t = agentEnv();
  assert.equal(notifyAgent({ home: t.agentHome, apply: true }, false, t.deps()), 0);
  const text = fs.readFileSync(t.file, 'utf8');
  assert.match(text, /<string>notify<\/string>/);
  assert.ok(text.includes(t.agentHome));
  assert.deepEqual(t.calls, [
    ['bootout', 'gui/501/dev.agentcraft.suzy-notify'],
    ['bootstrap', 'gui/501', t.file],
  ]);
  assert.match(t.lines.join('\n'), /running now/);
  // only the temp HOME was touched
  assert.deepEqual(fs.readdirSync(t.home).sort(), ['.agentcraft', 'Library']);
});

test('notify install --apply again: already installed, nothing changes', () => {
  const t = agentEnv();
  notifyAgent({ home: t.agentHome, apply: true }, false, t.deps());
  t.calls.length = 0;
  t.lines.length = 0;
  assert.equal(notifyAgent({ home: t.agentHome, apply: true }, false, t.deps()), 0);
  assert.deepEqual(t.calls, []);
  assert.match(t.lines.join('\n'), /Already installed/);
});

test('notify install --apply refuses without a terminal, and on a machine that is not macOS', () => {
  const t = agentEnv();
  assert.throws(() => notifyAgent({ home: t.agentHome, apply: true }, false, t.deps({ isTTY: false })), /interactive terminal/);
  assert.throws(() => notifyAgent({ home: t.agentHome }, false, t.deps({ platform: 'linux' })), /macOS only/);
  assert.ok(!fs.existsSync(path.join(t.home, 'Library')));
  assert.deepEqual(t.calls, []);
  assert.match(agentApplyRefusal(false), /interactive terminal/);
  assert.equal(agentApplyRefusal(true), undefined);
});

test('notify install --apply still works when launchctl fails: the file is there for the next login', () => {
  const t = agentEnv();
  const deps = t.deps({ launchctl: () => ({ status: 5 }) });
  assert.equal(notifyAgent({ home: t.agentHome, apply: true }, false, deps), 0);
  assert.ok(fs.existsSync(t.file));
  assert.match(t.lines.join('\n'), /starts at your next login/);
});

test('notify uninstall: a dry run keeps the file; --apply stops the agent and removes it', () => {
  const t = agentEnv();
  notifyAgent({ home: t.agentHome, apply: true }, false, t.deps());
  t.calls.length = 0;
  assert.equal(notifyAgent({ home: t.agentHome }, true, t.deps()), 0);
  assert.ok(fs.existsSync(t.file));
  assert.deepEqual(t.calls, []);
  assert.equal(notifyAgent({ home: t.agentHome, apply: true }, true, t.deps()), 0);
  assert.ok(!fs.existsSync(t.file));
  assert.deepEqual(t.calls, [['bootout', 'gui/501/dev.agentcraft.suzy-notify']]);
  t.lines.length = 0;
  assert.equal(notifyAgent({ home: t.agentHome, apply: true }, true, t.deps()), 0);
  assert.match(t.lines.join('\n'), /nothing to remove/);
});

test('the CLI: notify install on this machine is a dry run and exits 0 or 2 (macOS only), never writing', async () => {
  const { spawnSync } = await import('node:child_process');
  const home = fresh();
  const r = spawnSync(process.execPath, [SUZY, 'notify', 'install', '--home', path.join(home, '.agentcraft')], {
    encoding: 'utf8', env: { ...process.env, HOME: home, AGENTCRAFT_HOME: '' },
  });
  assert.equal(r.status, process.platform === 'darwin' ? 0 : 2, r.stderr);
  assert.ok(!fs.existsSync(path.join(home, 'Library')));
  const bad = spawnSync(process.execPath, [SUZY, 'notify', 'frobnicate', '--home', home], { encoding: 'utf8', env: { ...process.env, HOME: home } });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /unknown subcommand/);
  const apply = spawnSync(process.execPath, [SUZY, 'notify', 'install', '--apply', '--home', path.join(home, '.agentcraft')], {
    encoding: 'utf8', env: { ...process.env, HOME: home, AGENTCRAFT_HOME: '' },
  });
  assert.equal(apply.status, 2); // no terminal under test
  assert.ok(!fs.existsSync(path.join(home, 'Library')));
});
