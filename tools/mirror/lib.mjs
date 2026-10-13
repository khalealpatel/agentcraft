// Mirror mode: the parts of the Claude Code hook (hook.mjs) that tests and `suzy.mjs mirror` reuse.
//
// The hook turns one Claude Code hook payload into at most one allowlisted, scrubbed JSON line in
// <AGENTCRAFT_HOME or ~/.agentcraft>/mirror/events.jsonl. It never spawns a process, never touches
// the network, and only ever writes inside that directory. Everything here is synchronous and
// dependency free so the hook stays fast.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const EVENTS_FILE = 'events.jsonl';
/** hook-owned files inside the mirror directory (the Foreman's profile `mirror` shares it) */
export const SCOPE_CACHE_FILE = 'scope-cache.json';
export const SESSIONS_DIR = 'hook-sessions';
export const ROTATE_BYTES = 5 * 1024 * 1024;
export const ROTATE_KEEP = 2;
export const CMD_MAX = 80;

/** Hook events the mirror listens to. PostToolUseFailure is where a failing command (a red test run) lands. */
export const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Notification', 'Stop', 'SubagentStop', 'SessionEnd'];
const NOTIFICATION_TYPES = new Set(['permission_prompt', 'idle_prompt', 'auth_success', 'elicitation_dialog']);

/** Repos the mirror watches: origin URL -> repo name. Anything else is out of scope. */
const SCOPE_RE = /(?:^|[/:])khalealpatel\/(suzy-ai-engine|agentcraft)(?:\.git)?\/?$/i;

export function mirrorDir(env = process.env) {
  const home = env.AGENTCRAFT_HOME ? path.resolve(env.AGENTCRAFT_HOME) : path.join(env.HOME || os.homedir(), '.agentcraft');
  return path.join(home, 'mirror');
}

// ---------------------------------------------------------------------------------------------
// Scrubbing
// ---------------------------------------------------------------------------------------------

const R = '[redacted]';

/** Each rule on its own, so every pattern is tested separately. Order matters: specific before generic. */
export const SCRUB_RULES = [
  { name: 'url-credentials', re: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:'"]+(?::[^\s/@'"]*)?@/gi, to: `$1${R}@` },
  { name: 'authorization-header', re: /\b(Authorization\s*:\s*)[^'"\n]+/gi, to: `$1${R}` },
  { name: 'bearer', re: /\b(Bearer\s+)[^\s'"]+/gi, to: `$1${R}` },
  { name: 'sk-ant', re: /(?<![A-Za-z0-9_])sk-ant-[A-Za-z0-9_-]+/g, to: R },
  { name: 'sk', re: /(?<![A-Za-z0-9_])sk-[A-Za-z0-9_-]+/g, to: R },
  { name: 'github-token', re: /(?<![A-Za-z0-9_])gh[pousr]_[A-Za-z0-9_]+/g, to: R },
  { name: 'slack-token', re: /(?<![A-Za-z0-9_])xox[abp]-[A-Za-z0-9-]+/g, to: R },
  { name: 'aws-key-id', re: /(?<![A-Za-z0-9_])AKIA[0-9A-Z]{8,}/g, to: R },
  { name: 'secret-assignment', re: /\b([A-Za-z0-9_]*_(?:KEY|TOKEN|SECRET)\s*=\s*)("[^"]*"|'[^']*'|[^\s'"]+)/gi, to: `$1${R}` },
  { name: 'password-assignment', re: /\b([A-Za-z0-9_]*PASSWORD\s*=\s*)("[^"]*"|'[^']*'|[^\s'"]+)/gi, to: `$1${R}` },
  { name: 'hex-run', re: /(?<![A-Za-z0-9])[0-9a-fA-F]{32,}(?![A-Za-z0-9])/g, to: R },
  // base64 / base64url runs: mixed case plus a digit, so ordinary words and paths survive
  { name: 'base64-run', re: /[A-Za-z0-9+/_-]{32,}={0,2}/g, to: (m) => (looksLikeSecret(m) ? R : m) },
];

function looksLikeSecret(run) {
  if (!/[0-9]/.test(run) || !/[a-z]/.test(run) || !/[A-Z]/.test(run)) return false;
  // a path (src/agents/MirrorBackend2) has short '/'-separated segments and no '+' or '='
  if (run.includes('/') && !/[+=]/.test(run) && run.split('/').every((s) => s.length < 20)) return false;
  return true;
}

export function scrub(text) {
  let out = String(text);
  for (const r of SCRUB_RULES) out = out.replace(r.re, r.to);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Scope: which Git checkout a cwd belongs to, read straight from .git (never spawns git)
// ---------------------------------------------------------------------------------------------

const readText = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return undefined; } };

/** origin's URL from a Git config file (the [remote "origin"] section's url). */
export function originUrl(configText) {
  let inOrigin = false;
  for (const raw of String(configText ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('[')) { inOrigin = /^\[remote\s+"origin"\]$/i.test(line); continue; }
    if (!inOrigin) continue;
    const m = /^url\s*=\s*(.+)$/i.exec(line);
    if (m) return m[1].trim().replace(/^"(.*)"$/, '$1');
  }
  return undefined;
}

export function repoNameFromOrigin(url) {
  return url ? SCOPE_RE.exec(url.trim())?.[1]?.toLowerCase() : undefined;
}

/**
 * The checkout containing `cwd`: its root, the gitdir (a worktree's own), and the common dir that
 * holds config. Follows a `.git` file ("gitdir: ...") and the worktree's `commondir`.
 */
export function findCheckout(cwd) {
  let dir = path.resolve(cwd);
  for (;;) {
    const dotgit = path.join(dir, '.git');
    let st;
    try { st = fs.statSync(dotgit); } catch { st = undefined; }
    if (st?.isDirectory()) return { root: dir, gitDir: dotgit, commonDir: dotgit };
    if (st?.isFile()) {
      const m = /^gitdir:\s*(.+)$/m.exec(readText(dotgit) ?? '');
      if (!m) return undefined;
      const gitDir = path.resolve(dir, m[1].trim());
      const common = readText(path.join(gitDir, 'commondir'))?.trim();
      return { root: dir, gitDir, commonDir: common ? path.resolve(gitDir, common) : gitDir };
    }
    const up = path.dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
}

/** Current branch from HEAD ("ref: refs/heads/x"), or a short sha when detached. */
export function branchOf(gitDir) {
  const head = readText(path.join(gitDir, 'HEAD'))?.trim() ?? '';
  const m = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
  if (m) return m[1];
  return /^[0-9a-f]{7,}$/i.test(head) ? `detached@${head.slice(0, 7)}` : 'unknown';
}

const hashKey = (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 16);

/**
 * Scope for a cwd: { repo, root, gitDir } when it is a Suzy or AgentCraft checkout, else null.
 * Cached per cwd in the mirror dir (keys are hashed, so other projects' paths are never stored).
 */
export function resolveScope(cwd, dir, { cache = true } = {}) {
  const key = hashKey(cwd);
  const cacheFile = path.join(dir, SCOPE_CACHE_FILE);
  let entries = {};
  if (cache) {
    try { entries = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) ?? {}; } catch { entries = {}; }
    const hit = entries[key];
    if (hit === null) return null;
    if (hit && fs.existsSync(path.join(hit.gitDir, 'HEAD'))) return hit;
  }
  const co = findCheckout(cwd);
  const repo = co ? repoNameFromOrigin(originUrl(readText(path.join(co.commonDir, 'config')))) : undefined;
  const scope = repo ? { repo, root: co.root, gitDir: co.gitDir } : null;
  if (cache) {
    const keys = Object.keys(entries);
    if (keys.length >= 200) for (const k of keys.slice(0, keys.length - 199)) delete entries[k];
    entries[key] = scope;
    // out-of-scope cwds never create the mirror dir; they are cached only once it exists
    try {
      if (scope) ensureMirrorDir(dir);
      if (scope || fs.existsSync(dir)) writePrivate(cacheFile, JSON.stringify(entries));
    } catch { /* best effort */ }
  }
  return scope;
}

// ---------------------------------------------------------------------------------------------
// Payload -> event
// ---------------------------------------------------------------------------------------------

/** Lane ID from a firing brief: "# FIRING BRIEF: <ID>" or "Name `<ID>`". */
export function laneId(prompt) {
  const text = String(prompt ?? '');
  const m = /^#\s*FIRING BRIEF:\s*([A-Za-z0-9][A-Za-z0-9._-]{0,47})/m.exec(text) ?? /\bName\s+`([A-Za-z0-9][A-Za-z0-9._-]{0,47})`/.exec(text);
  return m ? m[1] : undefined;
}

const isEnvFile = (p) => { const b = path.basename(p); return /^\.env/i.test(b) && b.toLowerCase() !== '.env.example'; };

/** Repo-relative, forward slashes. Env files and paths outside the checkout are never written. */
export function relFile(file, root) {
  if (typeof file !== 'string' || !file.trim()) return undefined;
  if (isEnvFile(file)) return '[env file]';
  const abs = path.resolve(root, file);
  const rel = path.relative(root, abs);
  if (!rel) return '.';
  if (rel.startsWith('..') || path.isAbsolute(rel)) return '[outside repo]';
  return rel.split(path.sep).join('/');
}

export function shortCommand(cmd) {
  if (typeof cmd !== 'string') return undefined;
  // a command that touches an env file is logged as such, nothing else from it
  if (/(^|[\s/'"=<>])\.env(?!\.example\b)[\w.-]*/i.test(cmd)) return '[env file]';
  return scrub(cmd.replace(/\s+/g, ' ').trim()).slice(0, CMD_MAX);
}

const str = (v) => (typeof v === 'string' && v ? v : undefined);

/**
 * The allowlisted record for one hook payload, or undefined when nothing should be written.
 * `firstPrompt` says whether this is the session's first UserPromptSubmit (lane ID only then).
 */
export function buildEvent(payload, scope, { now = Date.now(), firstPrompt = false } = {}) {
  const event = str(payload?.hook_event_name);
  const sessionId = str(payload?.session_id);
  if (!event || !sessionId || !HOOK_EVENTS.includes(event) || !scope) return undefined;
  const e = { v: 1, ts: now, sid: hashKey(sessionId), event, repo: scope.repo, branch: scrub(branchOf(scope.gitDir)) };
  if (event === 'SessionStart') {
    const model = str(payload.model);
    if (model && /^[\w.[\]:-]{1,64}$/.test(model)) e.model = model;
    if (['startup', 'resume', 'clear', 'compact', 'fork'].includes(payload.source)) e.source = payload.source;
  }
  if (event === 'UserPromptSubmit') {
    e.first = !!firstPrompt;
    if (firstPrompt) {
      const lane = laneId(payload.prompt);
      if (lane) e.lane = scrub(lane);
    }
  }
  if (event === 'PreToolUse' || event === 'PostToolUse' || event === 'PostToolUseFailure') {
    const tool = str(payload.tool_name);
    if (tool) e.tool = scrub(tool).slice(0, 64);
    const input = payload.tool_input && typeof payload.tool_input === 'object' ? payload.tool_input : {};
    const file = relFile(input.file_path ?? input.notebook_path ?? input.path, scope.root);
    if (file) e.file = scrub(file).slice(0, 200);
    const cmd = shortCommand(input.command);
    if (cmd !== undefined && (tool === 'Bash' || tool === 'PowerShell')) e.cmd = cmd;
    if (event === 'PostToolUse') {
      const res = payload.tool_response;
      const code = res && typeof res === 'object' ? (res.exitCode ?? res.exit_code ?? res.returnCode) : undefined;
      const failed = (res && typeof res === 'object' && (res.is_error === true || res.isError === true || res.interrupted === true)) || (Number.isInteger(code) && code !== 0);
      e.ok = !failed;
      if (Number.isInteger(code)) e.exit = code;
    }
    if (event === 'PostToolUseFailure') {
      e.ok = false;
      const code = /\bExit code (\d{1,3})\b/.exec(str(payload.error) ?? '')?.[1];
      if (code !== undefined) e.exit = Number(code);
      if (payload.is_interrupt === true) e.interrupted = true;
    }
  }
  if (event === 'Notification' && NOTIFICATION_TYPES.has(payload.notification_type)) e.kind = payload.notification_type;
  if (event === 'SessionEnd' && ['clear', 'resume', 'logout', 'prompt_input_exit', 'other'].includes(payload.reason)) e.reason = payload.reason;
  return e;
}

// ---------------------------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------------------------

function writePrivate(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function ensureMirrorDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
}

/** Rotate events.jsonl at 5 MB, keeping two old files (.1 newest, .2 oldest). */
export function rotateIfNeeded(dir, maxBytes = ROTATE_BYTES) {
  const file = path.join(dir, EVENTS_FILE);
  let size = 0;
  try { size = fs.statSync(file).size; } catch { return; }
  if (size < maxBytes) return;
  for (let i = ROTATE_KEEP; i >= 1; i--) {
    const from = i === 1 ? file : `${file}.${i - 1}`;
    try { fs.renameSync(from, `${file}.${i}`); } catch { /* another hook rotated it first */ }
  }
}

/** Append one record as a single line (one write, O_APPEND), creating the file 600 and the dir 700. */
export function appendEvent(dir, record, { maxBytes = ROTATE_BYTES } = {}) {
  const file = path.join(dir, EVENTS_FILE);
  if (!fs.existsSync(dir)) ensureMirrorDir(dir);
  rotateIfNeeded(dir, maxBytes);
  const fresh = !fs.existsSync(file);
  if (fresh) ensureMirrorDir(dir);
  const fd = fs.openSync(file, 'a', 0o600);
  try {
    fs.writeSync(fd, `${JSON.stringify(record)}\n`);
    if (fresh) fs.fchmodSync(fd, 0o600);
  } finally {
    fs.closeSync(fd);
  }
}

/** True the first time it is called for a session (a marker file per hashed session id). */
export function claimFirstPrompt(dir, sid) {
  const d = path.join(dir, SESSIONS_DIR);
  try {
    fs.mkdirSync(d, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(d, sid), '', { flag: 'wx', mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

export function forgetSession(dir, sid) {
  try { fs.rmSync(path.join(dir, SESSIONS_DIR, sid), { force: true }); } catch { /* best effort */ }
}

/** The whole hook: payload text in, at most one line appended. Throws only on bugs; the runner swallows everything. */
export function handlePayload(text, { env = process.env, now = Date.now() } = {}) {
  let payload;
  try { payload = JSON.parse(text); } catch { return undefined; }
  if (!payload || typeof payload !== 'object' || typeof payload.cwd !== 'string') return undefined;
  const dir = mirrorDir(env);
  const scope = resolveScope(payload.cwd, dir);
  if (!scope) return undefined;
  const event = payload.hook_event_name;
  const sid = typeof payload.session_id === 'string' && payload.session_id ? hashKey(payload.session_id) : undefined;
  let firstPrompt = false;
  if (event === 'UserPromptSubmit' && sid) {
    if (!fs.existsSync(dir)) ensureMirrorDir(dir);
    firstPrompt = claimFirstPrompt(dir, sid);
  }
  const record = buildEvent(payload, scope, { now, firstPrompt });
  if (!record) return undefined;
  appendEvent(dir, record);
  if (event === 'SessionEnd' && sid) forgetSession(dir, sid);
  return record;
}
