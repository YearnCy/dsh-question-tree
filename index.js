/**
 * Host half of the standalone bundle; the Client module owns everything.
 *
 * No tools, no prompt text, no session events — the plugin is browser-only, so
 * it costs nothing per request and cannot disturb the agent loop.
 */
export function apply() {}
