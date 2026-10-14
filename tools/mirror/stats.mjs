// Mirror lane telemetry: per-lane numbers from the hook's events (<home>/mirror/events.jsonl).
//
// Two layers, both dependency free:
//   * a per-session reducer (newSession, addEvent): plain JSON state, so the Foreman's mirror backend
//     can keep it incrementally, and `suzy.mjs stats` can fold a whole log through the same code;
//   * mergeLane / computeLanes: sessions that carry the same lane ID become one lane.
// Everything above readEvents and writeLanesCache is a pure function of its arguments.
//
// The metrics (see docs/suzy/STUDIO-README.md, "Numbers"):
//   wall      first to last event of the lane
//   waited    each Notification opens a wait, closed by the session's next non-Notification event
//   idle      no events for over 10 min while not waiting (a running tool is not idle)
//   active    wall minus the closed waits minus idle
import fs from 'node:fs';
import path from 'node:path';
import { EVENTS_FILE, HOOK_EVENTS, ensureMirrorDir } from './lib.mjs';

export const IDLE_MS = 10 * 60_000;
export const LANES_FILE = 'lanes.json';
/** distinct files and distinct test commands a session keeps (a lane that touches more keeps counting calls) */
export const MAX_FILES = 200;
export const MAX_TEST_CMDS = 100;
export const TOP_FILES = 10;

const MIN = 60_000;
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'NotebookRead']);
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
const BASH_TOOLS = new Set(['Bash', 'PowerShell']);

export function classifyTool(name) {
  if (READ_TOOLS.has(name)) return 'read';
  if (EDIT_TOOLS.has(name)) return 'edit';
  if (BASH_TOOLS.has(name)) return 'bash';
  return 'other';
}

/** Same commands the Foreman's mirror backend treats as a test run (foreman/src/agents/mirror MIRROR_TEST_RE). */
const TEST_RE =
  /(^|[\s;&|(])((npm|pnpm|yarn|bun)\s+(run\s+)?test\b|npx\s+(vitest|jest|mocha)\b|vitest\b|jest\b|pytest\b|go\s+test\b|cargo\s+test\b|node\s+--test\b|dotnet\s+test\b|mvn\s+test\b|gradlew?\s+test\b|python\s+-m\s+(pytest|unittest)\b|tsc\b.*--noEmit)|(^|[\s;&|(])(npm|pnpm|yarn)\s+run\s+check\b/;
const PR_RE = /(^|[\s;&|(])gh\s+pr\s+create\b/;
const PUSH_RE = /(^|[\s;&|(])git\s+push\b([^;&|\n]*)/;

export const isTestCommand = (cmd) => typeof cmd === 'string' && TEST_RE.test(cmd);
export const isPrCreate = (cmd) => typeof cmd === 'string' && PR_RE.test(cmd);

/** Does this command push `branch`? A bare `git push` or one naming only a remote pushes the current branch. */
export function pushesBranch(cmd, branch) {
  const m = typeof cmd === 'string' ? PUSH_RE.exec(cmd) : null;
  if (!m) return false;
  const args = m[2].trim().split(/\s+/).filter((a) => a && !a.startsWith('-'));
  if (args.length < 2) return true; // `git push`, `git push origin`
  const spec = args[1].replace(/^\+/, '');
  const dst = spec.includes(':') ? spec.split(':').pop() : spec;
  return dst === 'HEAD' || dst === branch || dst.replace(/^refs\/heads\//, '') === branch;
}

export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '0s';
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h${String(mins % 60).padStart(2, '0')}m`;
}
/** Table cells show zero as 0m, never 0s. */
const dur = (ms) => (ms > 0 ? formatDuration(ms) : '0m');

// ---------------------------------------------------------------------------------------------
// one session
// ---------------------------------------------------------------------------------------------

export const isEvent = (e) =>
  !!e && typeof e === 'object' && typeof e.sid === 'string' && e.sid !== '' && Number.isFinite(e.ts) && HOOK_EVENTS.includes(e.event);

/** Fresh JSON state for the session `e` belongs to. Feed events (including `e`) to addEvent. */
export function newSession(e) {
  return {
    sid: e.sid,
    repo: e.repo ?? '',
    branch: e.branch ?? '',
    lane: null,
    resumed: false,
    model: null,
    first: e.ts,
    last: e.ts,
    n: 0,
    skew: 0,
    calls: { read: 0, edit: 0, bash: 0, other: 0 },
    errors: 0,
    files: {},
    tests: { runs: 0, pass: 0, first: {} },
    pr: null,
    pushed: null,
    waits: { count: 0, ms: 0, longest: 0, byKind: {} },
    openWait: null,
    idle: { count: 0, ms: 0 },
    inFlight: 0,
    ended: false,
  };
}

/**
 * Fold one event into a session (mutates and returns it). Events are applied in file order, which
 * is causal order; a timestamp that goes backwards (clock skew) is clamped to the previous one and
 * counted in `skew`, so no duration is ever negative.
 */
export function addEvent(s, e) {
  let ts = e.ts;
  if (ts < s.last) {
    s.skew++;
    ts = s.last;
  }
  const notification = e.event === 'Notification';

  if (s.openWait && !notification) {
    // the wait ends at the session's next event that is not a Notification
    const d = Math.max(0, ts - s.openWait.since);
    s.waits.ms += d;
    s.waits.longest = Math.max(s.waits.longest, d);
    s.openWait = null;
  } else if (!s.openWait && s.n > 0) {
    const gap = ts - s.last;
    // a tool that was started and has not reported back is running, not idle
    if (gap > IDLE_MS && s.inFlight === 0) {
      s.idle.count++;
      s.idle.ms += gap;
    }
  }

  if (e.repo) s.repo = e.repo;
  if (e.branch) s.branch = e.branch;
  if (e.lane && !s.lane) s.lane = e.lane;

  switch (e.event) {
    case 'SessionStart':
      s.inFlight = 0;
      if (e.model) s.model = e.model;
      if (e.source === 'resume') s.resumed = true;
      break;
    case 'UserPromptSubmit':
    case 'Stop':
      s.inFlight = 0;
      break;
    case 'SessionEnd':
      s.inFlight = 0;
      s.ended = true;
      break;
    case 'PreToolUse':
      s.inFlight++;
      s.calls[classifyTool(e.tool)]++;
      break;
    case 'PostToolUse':
    case 'PostToolUseFailure':
      s.inFlight = Math.max(0, s.inFlight - 1);
      afterTool(s, e);
      break;
    case 'Notification':
      if (e.kind !== 'auth_success' && !s.openWait) {
        s.openWait = { since: ts, kind: e.kind ?? 'unknown' };
        s.waits.count++;
        const k = e.kind ?? 'unknown';
        s.waits.byKind[k] = (s.waits.byKind[k] ?? 0) + 1;
      }
      break;
    default:
      break;
  }

  s.last = ts;
  s.n++;
  return s;
}

function afterTool(s, e) {
  const ok = e.event === 'PostToolUse' && e.ok !== false;
  if (!ok) s.errors++;
  if (ok && EDIT_TOOLS.has(e.tool) && e.file && !e.file.startsWith('[')) {
    if (e.file in s.files || Object.keys(s.files).length < MAX_FILES) s.files[e.file] = (s.files[e.file] ?? 0) + 1;
  }
  if (!BASH_TOOLS.has(e.tool) || typeof e.cmd !== 'string') return;
  if (isTestCommand(e.cmd)) {
    s.tests.runs++;
    if (e.ok !== false && e.event === 'PostToolUse') s.tests.pass++;
    const cmd = e.cmd.replace(/\s+/g, ' ').trim();
    if (!(cmd in s.tests.first) && Object.keys(s.tests.first).length < MAX_TEST_CMDS) s.tests.first[cmd] = e.ok !== false && e.event === 'PostToolUse';
  }
  if (ok && isPrCreate(e.cmd) && !s.pr) s.pr = e.branch ?? s.branch;
  if (ok && pushesBranch(e.cmd, e.branch ?? s.branch) && !s.pushed) s.pushed = e.branch ?? s.branch;
}

/**
 * The lane a resumed session without its own lane ID belongs to: the lane most recently seen on the
 * same repo and branch that started before it. Only a session whose SessionStart said `resume`
 * qualifies; a fresh `claude` on the same branch stays its own (unnamed) lane.
 */
export function inferLane(s, others) {
  if (s.lane || !s.resumed) return undefined;
  let best;
  for (const o of others) {
    if (!o.lane || o.sid === s.sid || o.repo !== s.repo || o.branch !== s.branch || !(o.first < s.first)) continue;
    if (!best || o.last > best.last) best = o;
  }
  return best?.lane;
}

// ---------------------------------------------------------------------------------------------
// one lane
// ---------------------------------------------------------------------------------------------

const overlap = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));

/**
 * Combine the sessions of one lane. `now` only matters for a wait that is still open (the lane's
 * session never wrote again): it is measured up to `now`.
 */
export function mergeLane(sessions, { now = Date.now(), name } = {}) {
  if (!sessions.length) return null;
  const ss = [...sessions].sort((a, b) => a.first - b.first || a.last - b.last || (a.sid < b.sid ? -1 : 1));
  const start = Math.min(...ss.map((s) => s.first));
  const end = Math.max(...ss.map((s) => s.last));
  const waits = { count: 0, ms: 0, longest: 0, byKind: {}, open: null };
  const idle = { count: 0, ms: 0 };
  const closedByNext = [];
  let closedMs = 0;

  ss.forEach((s, i) => {
    waits.count += s.waits.count;
    waits.ms += s.waits.ms;
    closedMs += s.waits.ms;
    waits.longest = Math.max(waits.longest, s.waits.longest);
    for (const [k, v] of Object.entries(s.waits.byKind)) waits.byKind[k] = (waits.byKind[k] ?? 0) + v;
    idle.count += s.idle.count;
    idle.ms += s.idle.ms;
    if (!s.openWait) return;
    // the session never wrote again: the wait ends when the lane's next session starts, else it is open
    const next = ss.slice(i + 1).find((x) => x.first >= s.openWait.since);
    if (next) {
      const d = next.first - s.openWait.since;
      waits.ms += d;
      closedMs += d;
      waits.longest = Math.max(waits.longest, d);
      closedByNext.push([s.openWait.since, next.first]);
    } else {
      const d = Math.max(0, now - s.openWait.since);
      waits.ms += d;
      waits.longest = Math.max(waits.longest, d);
      if (!waits.open || s.openWait.since < waits.open.since) waits.open = { since: s.openWait.since, ms: d, kind: s.openWait.kind };
    }
  });

  // the nights and lunches between sessions
  let reach = ss[0].last;
  for (const s of ss.slice(1)) {
    if (s.first > reach) {
      let gap = s.first - reach;
      for (const [a, b] of closedByNext) gap -= overlap(reach, s.first, a, b);
      if (gap > IDLE_MS) {
        idle.count++;
        idle.ms += gap;
      }
    }
    reach = Math.max(reach, s.last);
  }

  const calls = { total: 0, read: 0, edit: 0, bash: 0, other: 0 };
  const files = new Map();
  const first = new Map();
  let runs = 0;
  let pass = 0;
  let errors = 0;
  let skew = 0;
  let pr = null;
  let pushed = null;
  const models = [];
  for (const s of ss) {
    for (const k of ['read', 'edit', 'bash', 'other']) {
      calls[k] += s.calls[k];
      calls.total += s.calls[k];
    }
    for (const [f, n] of Object.entries(s.files)) files.set(f, (files.get(f) ?? 0) + n);
    for (const [c, ok] of Object.entries(s.tests.first)) if (!first.has(c)) first.set(c, ok);
    runs += s.tests.runs;
    pass += s.tests.pass;
    errors += s.errors;
    skew += s.skew;
    pr ??= s.pr;
    pushed ??= s.pushed;
    if (s.model && !models.includes(s.model)) models.push(s.model);
  }
  const top = [...files.entries()].map(([file, edits]) => ({ file, edits })).sort((a, b) => b.edits - a.edits || (a.file < b.file ? -1 : 1));
  const firstPass = [...first.values()].filter(Boolean).length;
  const lastModel = [...ss].reverse().find((s) => s.model)?.model ?? null;
  const wall = end - start;
  const lane = name ?? ss.find((s) => s.lane)?.lane ?? null;
  const last = ss[ss.length - 1];
  return {
    lane,
    named: !!ss.find((s) => s.lane),
    repo: last.repo,
    branch: last.branch,
    sessions: ss.length,
    sids: ss.map((s) => s.sid),
    start,
    end,
    wall,
    active: Math.max(0, wall - closedMs - idle.ms),
    waits,
    idle,
    calls,
    files: { count: files.size, top: top.slice(0, TOP_FILES) },
    tests: { runs, pass, fail: runs - pass, firstRun: { pass: firstPass, of: first.size, rate: first.size ? firstPass / first.size : null } },
    pr: { opened: pr !== null, pushed: pushed !== null, branch: pr ?? pushed ?? null, any: pr !== null || pushed !== null },
    errors,
    model: lastModel,
    models,
    skew,
    partial: ss.some((s) => s.partial === true),
  };
}

/**
 * Lanes from a list of hook events in file order: sessions grouped by lane ID (not by session),
 * a resumed session without the brief joined to its branch's lane, anything else unnamed-<date>-<n>.
 * Oldest lane first. Junk entries are skipped.
 */
export function computeLanes(events, { now = Date.now() } = {}) {
  const sessions = new Map();
  for (const e of events) {
    if (!isEvent(e)) continue;
    let s = sessions.get(e.sid);
    if (!s) {
      s = newSession(e);
      sessions.set(e.sid, s);
    }
    addEvent(s, e);
  }
  const ordered = [...sessions.values()].sort((a, b) => a.first - b.first || (a.sid < b.sid ? -1 : 1));
  const groups = new Map();
  const perDay = {};
  for (const s of ordered) {
    s.lane ||= inferLane(s, ordered) ?? null;
    let key = s.lane;
    if (!key) {
      const day = new Date(s.first).toISOString().slice(0, 10);
      perDay[day] = (perDay[day] ?? 0) + 1;
      key = `unnamed-${day}-${perDay[day]}`;
    }
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  return [...groups.entries()]
    .map(([name, ss]) => mergeLane(ss, { now, name }))
    .sort((a, b) => a.start - b.start || (a.lane < b.lane ? -1 : 1));
}

// ---------------------------------------------------------------------------------------------
// reading and the cache (the only functions here that touch the disk)
// ---------------------------------------------------------------------------------------------

/** events.jsonl.2, .1, then events.jsonl: oldest first, each file once (de-duplicated by inode). */
export function readEvents(dir) {
  const events = [];
  const files = [];
  const seen = new Set();
  for (const name of [`${EVENTS_FILE}.2`, `${EVENTS_FILE}.1`, EVENTS_FILE]) {
    const file = path.join(dir, name);
    let text;
    try {
      const st = fs.statSync(file);
      if (!st.isFile() || seen.has(`${st.dev}:${st.ino}`)) continue;
      seen.add(`${st.dev}:${st.ino}`);
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    files.push(file);
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        if (isEvent(e)) events.push(e);
      } catch {
        /* a torn or hand-written line */
      }
    }
  }
  return { events, files };
}

/** lanes.json: a cache rebuilt from the events on every run, mode 600, written only if the mirror dir exists. */
export function writeLanesCache(dir, lanes, { now = Date.now(), files = [] } = {}) {
  if (!fs.existsSync(dir)) return undefined;
  try { ensureMirrorDir(dir); } catch { /* keep going: the write below decides */ }
  const file = path.join(dir, LANES_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ v: 1, generatedAt: new Date(now).toISOString(), sources: files.map((f) => path.basename(f)), lanes }, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
  return file;
}

// ---------------------------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------------------------

const utc = (ts) => new Date(ts).toISOString().slice(0, 16).replace('T', ' ');
const stops = (n) => `${n} stop${n === 1 ? '' : 's'}`;
const code = (s) => `\`${String(s).replace(/`/g, "'")}\``;
const cell = (s) => String(s).replace(/\|/g, '\\|');

function span(l) {
  const a = utc(l.start);
  const b = utc(l.end);
  return a.slice(0, 10) === b.slice(0, 10) ? `${a} to ${b.slice(11)} UTC` : `${a} to ${b} UTC`;
}

function waitedText(l) {
  const w = l.waits;
  if (!w.count) return 'none';
  return `${formatDuration(w.ms)} across ${stops(w.count)} (longest ${formatDuration(w.longest)})${w.open ? ', still waiting' : ''}`;
}

const idleText = (l) => (l.idle.count ? `${formatDuration(l.idle.ms)} (${l.idle.count})` : 'none');

function testsText(l) {
  const t = l.tests;
  if (!t.runs) return 'no test runs';
  return `${t.runs} run${t.runs === 1 ? '' : 's'}: ${t.pass} passed, ${t.fail} failed (first run passed ${t.firstRun.pass} of ${t.firstRun.of})`;
}

function prText(l) {
  if (l.pr.opened) return `yes: opened from ${code(l.pr.branch)}`;
  if (l.pr.pushed) return `pushed ${code(l.pr.branch)}, no PR opened`;
  return 'no';
}

function callsText(l) {
  const c = l.calls;
  return `${c.total} (read ${c.read}, edit ${c.edit}, bash ${c.bash}, other ${c.other})`;
}

/** Rows of [label, value] shared by the PR block and the lane note's Numbers section. */
function facts(l) {
  const rows = [
    ['Wall time', `${formatDuration(l.wall)} (${span(l)})`],
    ['Active', formatDuration(l.active)],
    ['Waited on you', waitedText(l)],
    ['Idle gaps', idleText(l)],
    ['Tool calls', callsText(l)],
    ['Files touched', String(l.files.count)],
    ['Tests', testsText(l)],
    ['PR', prText(l)],
    ['Errors', String(l.errors)],
    ['Model', l.model ?? 'not recorded'],
  ];
  if (l.sessions > 1) rows.push(['Sessions', String(l.sessions)]);
  return rows;
}

/** One lane as a markdown block for a PR body. */
export function laneMarkdown(l) {
  return [
    `### Lane numbers: ${l.lane}`,
    '',
    '| Metric | Value |',
    '| --- | --- |',
    ...facts(l).map(([k, v]) => `| ${k} | ${cell(v)} |`),
    ...(l.partial ? ['', '_Counted from the first event this view saw: the lane started before the counter did._'] : []),
  ].join('\n');
}

/** The "Numbers" section of a lane note. */
export function numbersMarkdown(l) {
  const rows = facts(l).map(([k, v]) => `- ${k}: ${v}`);
  const top = l.files.top.slice(0, 5).map((f) => `${f.file} (${f.edits})`);
  if (top.length) rows.splice(6, 0, `- Top files: ${top.join(', ')}`);
  if (l.partial) rows.push('- Note: counted from the first event this view saw (the lane started before the counter did)');
  return ['## Numbers', '', ...rows].join('\n');
}

/** The feed item when a lane's turn ends. `title` replaces the lane ID (an unnamed lane's card title). */
export function finishedLine(l, title) {
  const w = l.waits.count ? `waited on you ${formatDuration(l.waits.ms)} across ${stops(l.waits.count)}` : 'never waited on you';
  const t = l.tests.runs ? `, tests ${l.tests.pass}/${l.tests.runs}` : '';
  return `${title ?? l.lane} finished: ${formatDuration(l.wall - l.idle.ms)}, ${w}${t}`;
}

/** Nameplate activity while a lane waits on you; only the minutes change, so a refresh a minute is plenty. */
export function waitingLabel(ms) {
  return ms < MIN ? 'waiting on you' : `waiting on you ${formatDuration(Math.floor(ms / MIN) * MIN)}`;
}

/** Plain text table for the terminal. */
export function lanesTable(lanes) {
  if (!lanes.length) return 'no lanes in the mirror events for this period';
  const head = ['lane', 'wall', 'active', 'waited', 'stops', 'longest', 'idle', 'tests', 'PR'];
  const rows = lanes.map((l) => [
    l.lane,
    dur(l.wall),
    dur(l.active),
    `${dur(l.waits.ms)}${l.waits.open ? ' (open)' : ''}`,
    String(l.waits.count),
    dur(l.waits.longest),
    l.idle.count ? `${formatDuration(l.idle.ms)} (${l.idle.count})` : '0m',
    `${l.tests.pass}/${l.tests.fail}`,
    l.pr.any ? 'yes' : 'no',
  ]);
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (r) => r.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd();
  return [
    line(head),
    line(widths.map((w) => '-'.repeat(w))),
    ...rows.map(line),
    '',
    'waited = time the lane waited on you; stops = how many times; idle = gaps over 10 min with no events and no wait; tests = passed/failed',
  ].join('\n');
}

/** Every lane as one markdown table. */
export function lanesMarkdown(lanes) {
  if (!lanes.length) return 'No lanes in the mirror events for this period.';
  return [
    '| Lane | Wall | Active | Waited on you | Idle | Tests | PR |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...lanes.map((l) => `| ${cell(l.lane)} | ${dur(l.wall)} | ${dur(l.active)} | ${l.waits.count ? waitedText(l) : '0m'} | ${l.idle.count ? idleText(l) : '0m'} | ${l.tests.pass}/${l.tests.fail} | ${l.pr.any ? 'yes' : 'no'} |`),
  ].join('\n');
}
