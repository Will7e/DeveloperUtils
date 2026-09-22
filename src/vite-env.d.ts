/// <reference types="vite/client" />

/**
 * Build-time environment the app reads.
 *
 * Declared rather than cast: an environment variable that decides whether the
 * agent can run your project's real commands must not be able to fail as a
 * silent `undefined` — a misspelled `VITE_COMPANION_TOKEN` would read as "no
 * companion is running" with nothing on screen explaining why.
 */
interface ImportMetaEnv {
  /**
   * Origin of the local companion (`npm run companion`).
   *
   * Unset in development, where http://127.0.0.1:5280 is used.
   */
  readonly VITE_COMPANION_ORIGIN?: string;
  /**
   * Pairing token the companion printed at startup.
   *
   * Without it there is simply no companion: `run_command` reports the change
   * as unverified rather than hanging.
   */
  readonly VITE_COMPANION_TOKEN?: string;
}
