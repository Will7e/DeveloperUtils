// ============================================================
// Preview Assets — Loader Selection Regression Tests
// ============================================================
// The bug this file pins: a committed image reaching the JavaScript
// parser, which reported
//
//     vfs:src/assets/Vietnamese-food.webp:1
//     Expected ";" but found "\x14"
//
// Nothing in that message names a webp, an image, or a loader — the
// diagnostic quotes a byte offset inside a PNG/WebP stream. The first
// test is the whole regression; the rest keep the loader table honest in
// both directions (assets must never be source; source must never become
// an asset).

import { describe, expect, it } from "vitest";
import {
  assetMimeType,
  base64ToBytes,
  extensionOf,
  inlineReference,
  textToBase64,
  isAssetPath,
  placeholderBytesFor,
  previewLoaderFor,
  TRANSPARENT_PNG_BYTES,
} from "./assets";

describe("previewLoaderFor", () => {
  it("loads a committed image as bytes, never as JavaScript", () => {
    expect(previewLoaderFor("src/assets/Vietnamese-food.webp")).toBe("dataurl");
    expect(previewLoaderFor("src/assets/logo.png")).toBe("dataurl");
    expect(previewLoaderFor("public/icon.svg")).toBe("dataurl");
  });

  it("carries fonts and media the same way", () => {
    expect(previewLoaderFor("src/fonts/inter.woff2")).toBe("dataurl");
    expect(previewLoaderFor("src/fonts/inter.ttf")).toBe("dataurl");
    expect(previewLoaderFor("public/demo.mp4")).toBe("dataurl");
    expect(previewLoaderFor("public/chime.mp3")).toBe("dataurl");
  });

  it("keeps source on its own loader", () => {
    expect(previewLoaderFor("src/App.tsx")).toBe("tsx");
    expect(previewLoaderFor("src/main.ts")).toBe("ts");
    expect(previewLoaderFor("src/legacy.jsx")).toBe("jsx");
    expect(previewLoaderFor("vite.config.mjs")).toBe("js");
    expect(previewLoaderFor("src/index.css")).toBe("css");
    // CSS Modules: the default export IS the class-name mapping, so the
    // loader has to be the one that builds it.
    expect(previewLoaderFor("src/sections/Hero/Hero.module.css")).toBe("local-css");
    expect(previewLoaderFor("src/styles/admin.module.CSS")).toBe("local-css");
    expect(previewLoaderFor("tsconfig.json")).toBe("json");
  });

  it("reads text formats as text instead of failing inside them", () => {
    expect(previewLoaderFor("README.md")).toBe("text");
    expect(previewLoaderFor("data/notes.txt")).toBe("text");
    expect(previewLoaderFor("deploy.yml")).toBe("text");
    expect(previewLoaderFor(".env")).toBe("text");
    expect(previewLoaderFor(".gitignore")).toBe("text");
    expect(previewLoaderFor("package-lock.json")).toBe("json");
  });

  it("refuses an unknown type by returning null, not by guessing 'js'", () => {
    // The old expression ended in `: "js"`, so this path reached the
    // JavaScript parser and failed with the file's CONTENTS as the error.
    expect(previewLoaderFor("src/wasm/module.wasm")).toBeNull();
    expect(previewLoaderFor("src/db/schema.bin")).toBeNull();
    expect(previewLoaderFor("LICENSE")).toBeNull();
    expect(previewLoaderFor("src/assets/image.webp")).not.toBe("js");
  });

  it("is case-insensitive about extensions", () => {
    expect(previewLoaderFor("src/assets/Photo.WEBP")).toBe("dataurl");
    expect(previewLoaderFor("src/App.TSX")).toBe("tsx");
  });
});

describe("extensionOf", () => {
  it("reads the last segment's extension", () => {
    expect(extensionOf("src/features/chat/preview/assets.ts")).toBe("ts");
    expect(extensionOf("no-extension")).toBe("");
  });

  it("treats a dotfile name as its format", () => {
    expect(extensionOf(".env.local")).toBe("local");
    expect(extensionOf(".gitignore")).toBe("gitignore");
  });
});

describe("asset metadata", () => {
  it("names a MIME type only for browser-native formats", () => {
    expect(assetMimeType("a/b/logo.webp")).toBe("image/webp");
    expect(assetMimeType("a/b/inter.woff2")).toBe("font/woff2");
    expect(assetMimeType("a/b/App.tsx")).toBeNull();
    expect(isAssetPath("a/b/hero.avif")).toBe(true);
    expect(isAssetPath("a/b/hero.ts")).toBe(false);
  });
});

describe("base64 helpers", () => {
  it("decodes a payload to its exact bytes", () => {
    expect([...base64ToBytes("AAECAw==")]).toEqual([0, 1, 2, 3]);
  });

  it("tolerates the newlines GitHub wraps payloads with", () => {
    expect([...base64ToBytes("AAEC\nAw==")]).toEqual([0, 1, 2, 3]);
  });

  it("ships a placeholder that is a real, fully-formed PNG", () => {
    // A blank image is only better than a broken one if it decodes.
    const sig = [...TRANSPARENT_PNG_BYTES.slice(0, 8)];
    expect(sig).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect([...TRANSPARENT_PNG_BYTES.slice(-4)]).toEqual([0xae, 0x42, 0x60, 0x82]); // IEND crc
    // 1×1, 8-bit RGBA
    expect([...TRANSPARENT_PNG_BYTES.slice(16, 26)]).toEqual([
      0, 0, 0, 1, 0, 0, 0, 1, 8, 6,
    ]);
  });

  it("uses a blank image for images and nothing for other assets", () => {
    expect(placeholderBytesFor("src/assets/x.webp")).toBe(TRANSPARENT_PNG_BYTES);
    expect([...placeholderBytesFor("src/fonts/x.woff2")]).toEqual([]);
  });
});

describe("carrying a local reference into a document", () => {
  const providers = (text: string | null = null) => ({
    bytes: async (path: string) =>
      path === "src/logo.png" ? new Uint8Array([0x89, 0x50, 0x4e, 0x47]) : null,
    text: () => text,
  });

  it("carries an image as its own bytes, typed by the file", async () => {
    const url = await inlineReference("src/logo.png", providers());
    expect(url).toBe("data:image/png;base64,iVBORw==");
  });

  it("never returns a blob URL, because a blob belongs to the origin that made it", async () => {
    // The measured failure: a static preview served from its OWN origin could
    // not load `blob:http://localhost:5173/…` — broken images, no styles —
    // while the build reported success. A data URL travels with the document.
    const image = await inlineReference("src/logo.png", providers());
    const style = await inlineReference("src/index.css", providers("body{color:red}"));
    const script = await inlineReference("src/app.js", providers("alert(1)"));
    expect(image).not.toContain("blob:");
    expect(style).toBe(`data:text/css;base64,${textToBase64("body{color:red}")}`);
    expect(script).toBe(`data:text/javascript;base64,${textToBase64("alert(1)")}`);
  });

  it("reports what it could not carry instead of emitting a reference that fails", async () => {
    // No bytes (never fetched, or over the Contents API's 1 MB limit).
    expect(await inlineReference("src/missing.png", providers())).toBeNull();
    // In the tree, but not in the workspace.
    expect(await inlineReference("src/index.css", providers(null))).toBeNull();
  });

  it("carries UTF-8 text without throwing", async () => {
    // btoa alone throws on anything past Latin-1, and this is a document
    // builder: a stylesheet with an emoji in a content property must not
    // fail the build.
    const url = await inlineReference("src/index.css", providers("body::after{content:'🌯'}"));
    expect(url).toMatch(/^data:text\/css;base64,/);
    expect(Buffer.from(url!.split(",")[1]!, "base64").toString("utf8")).toContain("🌯");
  });
});
