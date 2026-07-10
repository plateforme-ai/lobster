import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";

// Global test bootstrap (loaded via `node --test --import ./dist/test/setup.js`).
//
// Tests must never read or write the developer's real `~/.lobster` dir. Any code
// path that resolves the runtime store falls back to `os.homedir()/.lobster` when
// `LOBSTER_DIR` is unset (see store/helpers.ts `getPrefixDir`). Pinning it here to
// a throwaway temp dir guarantees isolation for both in-process tests and any CLI
// subprocess they spawn (those inherit this process's env). Individual tests that
// set their own `LOBSTER_DIR` still win — we only provide the default.
if (!process.env.LOBSTER_DIR || !process.env.LOBSTER_DIR.trim()) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "lobster-home-"));
  process.env.LOBSTER_DIR = dir;
  process.on("exit", () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup; the OS reclaims the temp dir regardless.
    }
  });
}
