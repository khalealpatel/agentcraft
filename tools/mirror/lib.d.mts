// Types for the parts of lib.mjs the Foreman's mirror backend imports (foreman/src/agents/mirror).
export declare const EVENTS_FILE: string;
export declare const SCOPE_CACHE_FILE: string;
export declare const SESSIONS_DIR: string;
export declare const HOOK_EVENTS: readonly string[];
export declare function scrub(text: string): string;
export declare function mirrorDir(env?: Record<string, string | undefined>): string;
export interface ScrubRule {
  name: string;
  re: RegExp;
  to: string | ((match: string) => string);
}
export declare const SCRUB_RULES: readonly ScrubRule[];
