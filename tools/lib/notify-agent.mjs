// `suzy.mjs notify install | uninstall`: a launchd agent that runs `suzy.mjs notify` at login.
// Pure functions for the file's path and text, so tests run on a temp HOME and never go near the
// real ~/Library; the only side effects (writing the plist, launchctl) live in suzy.mjs and are
// only reached by --apply from an interactive terminal on macOS.
import os from 'node:os';
import path from 'node:path';
import { LAUNCH_LABEL } from '../mirror/notify.mjs';

export const AGENT_LABEL = LAUNCH_LABEL;

/** ~/Library/LaunchAgents/dev.agentcraft.suzy-notify.plist (under $HOME, so a temp HOME is a temp Library). */
export function launchAgentFile(env = process.env) {
  return path.join(env.HOME || os.homedir(), 'Library', 'LaunchAgents', `${AGENT_LABEL}.plist`);
}

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The launchd job: this Node (absolute, so launchd finds it), the launcher, `notify`, at login, restarted if it crashes. */
export function plistText({ node, script, home, log }) {
  const args = [node, script, 'notify', '--home', home];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(AGENT_LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${xml(a)}</string>`).join('\n')}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${xml(log)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(log)}</string>
</dict>
</plist>
`;
}

/** Why --apply must not run, or undefined. It writes under ~/Library and loads a login item: a person does that. */
export function agentApplyRefusal(isTTY) {
  return isTTY ? undefined : 'refused: --apply adds (or removes) a login item under ~/Library/LaunchAgents and only runs from an interactive terminal. Run it yourself.';
}
