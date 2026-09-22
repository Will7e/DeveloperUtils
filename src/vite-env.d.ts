/// <reference types="vite/client" />

/**
 * Build-time environment the app reads.
 *
 * Declared rather than cast: an environment variable that decides whether
 * previews get a real origin must not be able to fail as a silent
 * `undefined` — a misspelled `VITE_PREVIEW_ORIGIN` would fall back to the
 * inline sandbox with nothing but a console line explaining why state keeps
 * resetting.
 */
interface ImportMetaEnv {
  /**
   * Origin of the preview host that serves builds from their own origin.
   *
   * Unset in development, where the local host's default port is used.
   * A deployed build must set it to the hosted origin (which must also be
   * listed in that deployment's `frame-src`), otherwise previews take the
   * inline sandboxed path — isolated, but with in-memory storage.
   */
  readonly VITE_PREVIEW_ORIGIN?: string;
}
