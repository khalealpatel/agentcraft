// `suzy.mjs notify`: tell the founder, on the Mac, the moment a lane needs him.
//
// It only follows the mirror event log (<home>/mirror/events.jsonl) and never touches the hook.
// What counts as "waiting" is not decided here: every event goes through stats.mjs's session
// reducer, and a lane has started waiting when the session's openWait goes from none to something
// (a Stop, an unanswered AskUser* call, a Notification: tools/mirror/stats.mjs, one rule set, so
// the numbers, the nameplate and the notification cannot disagree). The log is read through the
// same cursor and rotation code the Foreman uses (tail.mjs). Output goes to `deliver`, which is
// `osascript` on macOS and a printed line anywhere else or with --dry-run.
import { execFile } from 'node:child_process';
import { addEvent, inferLane, isEvent, newSession } from './stats.mjs';
import { readLines } from './tail.mjs';

export const NOTIFY_TITLE = 'Suzy lane waiting';
export const PR_TITLE = 'Suzy lane PR';
export const LAUNCH_LABEL = 'dev.agentcraft.suzy-notify';
/** sessions kept in memory: a notify running for weeks forgets the oldest quiet ones */
const MAX_SESSIONS = 400;

/** The reason shown after "needs you", from the kind of wait (stats.mjs openWait.kind). */
export function reasonText(kind) {
  switch (kind) {
    case 'ask_user_question':
    case 'elicitation_dialog':
      return 'asked a question';
    case 'turn_end':
      return 'finished its turn';
    case 'permission_prompt':
      return 'needs permission';
    case 'idle_prompt':
      return 'is waiting for your next message';
    default:
      return 'needs your attention';
  }
}

/**
 * The decision logic, pure: feed it hook events in log order and it returns the notifications each
 * one raises ([] for most). `all` includes lanes with no lane ID (labelled repo @ branch).
 */
export function createNotifyState({ all = false } = {}) {
  /** sid -> { s: session state, since: the wait already notified, pr: PR already notified } */
  const sessions = new Map();

  const laneOf = (rec) => {
    const s = rec.s;
    const lane = s.lane || inferLane(s, [...sessions.values()].map((r) => r.s));
    if (lane) return lane;
    return all ? `${s.repo || 'lane'} @ ${s.branch || 'unknown'}` : null;
  };

  function feed(e) {
    if (!isEvent(e)) return [];
    let rec = sessions.get(e.sid);
    if (!rec) {
      rec = { s: newSession(e), since: null, pr: false };
      sessions.set(e.sid, rec);
    }
    addEvent(rec.s, e);
    const out = [];
    const lane = laneOf(rec);
    const open = rec.s.openWait;
    if (!open) rec.since = null;
    else if (rec.since !== open.since) {
      rec.since = open.since;
      if (lane) out.push({ type: 'waiting', lane, kind: open.kind, title: NOTIFY_TITLE, body: `${lane} needs you (${reasonText(open.kind)})` });
    }
    if (!rec.pr && rec.s.pr !== null) {
      rec.pr = true;
      if (lane) out.push({ type: 'pr', lane, kind: 'pr', title: PR_TITLE, body: `${lane} opened a PR` });
    }
    if (sessions.size > MAX_SESSIONS) prune();
    return out;
  }

  function prune() {
    const old = [...sessions.entries()].sort((a, b) => a[1].s.last - b[1].s.last).slice(0, sessions.size - MAX_SESSIONS);
    for (const [sid] of old) sessions.delete(sid);
  }

  /** Lanes whose session is waiting right now (what `notify` says when it starts). */
  const waitingNow = () => [...sessions.values()]
    .filter((r) => r.s.openWait && !r.s.ended)
    .flatMap((r) => { const lane = laneOf(r); return lane ? [{ lane, kind: r.s.openWait.kind, since: r.s.openWait.since }] : []; });

  return { feed, waitingNow, size: () => sessions.size };
}

// ---------------------------------------------------------------------------------------------
// delivery
// ---------------------------------------------------------------------------------------------

/** AppleScript string contents: backslash and double quote escaped, newlines flattened. */
export const escapeAppleScript = (s) => String(s).replace(/[\r\n]+/g, ' ').replace(/\\/g, '\\\\').replace(/"/g, '\\"');

/** Arguments for `osascript` (no shell: execFile gets this array as it is). */
export function osascriptArgs(title, body) {
  return ['-e', `display notification "${escapeAppleScript(body)}" with title "${escapeAppleScript(title)}"`];
}

/** Only macOS shows notifications, and --dry-run never does. */
export const shouldDeliver = ({ platform = process.platform, dryRun = false } = {}) => platform === 'darwin' && !dryRun;

/** Show one notification with osascript. Fire and forget: a failure is reported, never fatal. */
export function osascriptDeliver(title, body, { onError = () => {} } = {}) {
  execFile('osascript', osascriptArgs(title, body), { timeout: 10_000 }, (err) => {
    if (err) onError(err);
  });
}

// ---------------------------------------------------------------------------------------------
// following the log
// ---------------------------------------------------------------------------------------------

/**
 * Follow the mirror log. The history already in the log is read first and is silent (it is not
 * news); `waitingNow` says who is waiting at that moment. Then every `pollMs` the new lines go
 * through the state machine and each notification goes to `deliver(title, body, item)`.
 */
export function watchEvents({ dir, pollMs = 1000, all = false, deliver = () => {}, onError = () => {} }) {
  const state = createNotifyState({ all });
  let cursor;
  const read = (silent) => {
    let got;
    try {
      got = readLines(dir, cursor);
    } catch (err) {
      onError(err);
      return 0;
    }
    cursor = got.cursor;
    let sent = 0;
    for (const line of got.lines) {
      let e;
      try {
        e = JSON.parse(line);
      } catch {
        continue; // a torn or hand-written line
      }
      for (const n of state.feed(e)) {
        if (silent) continue;
        sent++;
        try {
          deliver(n.title, n.body, n);
        } catch (err) {
          onError(err);
        }
      }
    }
    return sent;
  };
  read(true);
  const waitingNow = state.waitingNow();
  const timer = setInterval(() => read(false), pollMs); // keeps the command alive; stop() ends it
  return {
    waitingNow,
    poll: () => read(false),
    stop: () => clearInterval(timer),
    state,
  };
}
