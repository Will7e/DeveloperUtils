// ============================================================
// Web Tool Routes — Mounted Where The Agent Runs
// ============================================================
// The agent's two web tools do not talk to the internet directly. `search_web`
// POSTs to `/api/search` (the provider key is server-side) and `fetch_url`
// relays through `/api/proxy` when CORS refuses the direct read. In production
// those are Vercel edge functions; locally they exist only because a Vite plugin
// implements them.
//
// That is the whole risk this file pins: a route a plugin implements in
// `configureServer` and forgets in `configurePreviewServer` works in
// `npm run dev` and is MISSING in `npm run preview` — which serves the real
// build and is the last place a production-only failure can be caught. The
// agent then reports that it cannot reach the web while the provider key sits
// in .env, and nothing in the message names the missing route.
//
// So: both hooks mount a middleware, and a URL that is not the plugin's own
// falls through to the next handler (the app itself), rather than being eaten.

import { describe, it, expect } from "vitest";
import { apiSearchPlugin } from "../../../../vite-plugin-api-search";
import { apiProxyPlugin } from "../../../../vite-plugin-api-proxy";

type Middleware = (
  req: Record<string, unknown>,
  res: Record<string, unknown>,
  next: () => void
) => unknown;

/** A Vite "server" whose middleware registrations the test can capture */
function fakeServer(): { server: unknown; registered: Middleware[] } {
  const registered: Middleware[] = [];
  return {
    registered,
    server: {
      middlewares: {
        use: (fn: Middleware) => {
          registered.push(fn);
        },
      },
    },
  };
}

/** Resolves a plugin's config the way Vite does, then installs one hook */
function install(
  plugin: { configResolved?: (config: unknown) => void } & Record<string, unknown>,
  hook: "configureServer" | "configurePreviewServer"
): Middleware[] {
  plugin.configResolved?.({ mode: "development", root: process.cwd() });
  const { server, registered } = fakeServer();
  const install = plugin[hook];
  if (typeof install === "function") (install as (s: unknown) => void)(server);
  return registered;
}

const PLUGINS = [
  { name: "search_web", factory: apiSearchPlugin, route: "/api/search" },
  { name: "fetch_url", factory: apiProxyPlugin, route: "/api/proxy" },
] as const;

describe("web tool routes are mounted on every local server", () => {
  for (const { name, factory, route } of PLUGINS) {
    it(`${name}: mounts ${route} on the dev server AND the preview server`, () => {
      const plugin = factory() as unknown as Record<string, unknown> & {
        configResolved?: (config: unknown) => void;
      };
      expect(install(plugin, "configureServer"), "dev server").toHaveLength(1);
      expect(install(plugin, "configurePreviewServer"), "preview server").toHaveLength(1);
    });

    it(`${name}: lets a URL that is not its own through to the app`, async () => {
      const plugin = factory() as unknown as Record<string, unknown> & {
        configResolved?: (config: unknown) => void;
      };
      const [middleware] = install(plugin, "configurePreviewServer");
      expect(middleware, "no middleware installed").toBeTruthy();

      let nexted = false;
      await middleware!(
        { url: "/index.html", method: "GET", headers: {} },
        {
          setHeader: () => undefined,
          end: () => undefined,
        },
        () => {
          nexted = true;
        }
      );
      expect(nexted, "the SPA would stop being served").toBe(true);
    });
  }
});
