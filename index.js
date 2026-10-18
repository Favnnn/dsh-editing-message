/**
 * dsh-editing-message, Host half (dsh v0.2.0-rc.2).
 *
 * The plugin is client-only: every operation (fork a session before a
 * message, prompt the fork, open the fork) goes through the standard Client
 * sessions service (`ctx.sessions.fork` / `session.prompt` / `ctx.uiWorkspace
 * .openSession`). There is no host state, no config schema, no web routes.
 *
 * Fail-safe: `apply` does nothing and cannot throw — the harness boots with
 * or without this half.
 */
export function apply() {}
