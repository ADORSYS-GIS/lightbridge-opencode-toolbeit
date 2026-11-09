// Vitest setup file for the credential-bearing packages (ADR-0022).
//
// Credentials now default to the durable OS state dir (`~/Library/Application
// Support`, `$XDG_STATE_HOME`, `%LOCALAPPDATA%`). A test that forgets to inject
// a directory must NEVER land in the developer's real login state, so every
// test worker gets a throwaway home, and the env roots that override it are
// cleared. Tests that need a specific root still inject it explicitly.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "vitest-home-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.LOCALAPPDATA = join(home, "AppData", "Local");
delete process.env.XDG_STATE_HOME;
delete process.env.XDG_CACHE_HOME;
