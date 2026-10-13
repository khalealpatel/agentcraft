// Java 25 lookup shared by unix.mjs and suzy.mjs: JAVA_HOME first, then the usual JDK paths.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const JDK_CANDIDATES = {
  darwin: ['/opt/homebrew/opt/openjdk@25/libexec/openjdk.jdk/Contents/Home', '/usr/local/opt/openjdk@25/libexec/openjdk.jdk/Contents/Home'],
  linux: ['/usr/lib/jvm/java-25-openjdk', '/usr/lib/jvm/java-25-openjdk-amd64', '/usr/lib/jvm/java-25-openjdk-arm64'],
};
export const JDK_HINT = {
  darwin: 'brew install openjdk@25',
  linux: 'your distribution\'s package manager (Arch: pacman -S jdk25-openjdk), or set JAVA_HOME to a Java 25 JDK',
};

export function javaHome() {
  for (const candidate of [process.env.JAVA_HOME, ...(JDK_CANDIDATES[process.platform] ?? [])]) {
    if (!candidate) continue;
    const java = path.join(candidate, 'bin', 'java');
    if (!fs.existsSync(java)) continue;
    const result = spawnSync(java, ['-version'], { encoding: 'utf8' });
    if (/version "25[.\"]/.test(result.stderr + result.stdout)) return candidate;
  }
  throw new Error(`Java 25 is required. Install it with ${JDK_HINT[process.platform] ?? 'a Java 25 JDK and set JAVA_HOME'}`);
}
