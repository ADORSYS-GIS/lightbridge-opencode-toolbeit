#!/usr/bin/env node
/**
 * Compile one workspace package: `src/**.ts` → `dist/**.{js,js.map,d.ts}`.
 *
 * Emit only — **no type checking**. That is `pnpm typecheck` (`tsc --noEmit`),
 * which every package already declares and CI already runs, so type-checking
 * during the build was always the second of two identical passes.
 *
 * Declarations come from oxc's `isolatedDeclaration`, which derives a `.d.ts`
 * from a single file's syntax without consulting the type checker. That is only
 * sound because `isolatedDeclarations: true` in `tsconfig.base.json` makes the
 * compiler reject any export whose type cannot be determined that way — the
 * typecheck gate is what keeps this honest, not this script.
 *
 * See ADR-0010.
 */
import { isolatedDeclarationSync, transformSync } from "oxc-transform";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { argv, cwd, exit, stderr, stdout } from "node:process";

const packageDir = resolve(argv[2] ?? cwd());
const srcDir = join(packageDir, "src");
const outDir = join(packageDir, "dist");

async function collectSources(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await collectSources(path)));
      continue;
    }
    // Ambient declarations (`*.d.ts`) describe modules that have no
    // implementation here; tsc emits nothing for them and neither do we.
    if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      found.push(path);
    }
  }
  return found;
}

/**
 * Match the source map `tsc` emits, field for field.
 *
 * oxc reports `sources` as an **absolute path on the build machine** and inlines
 * `sourcesContent`. Publishing that would bake someone's home directory into
 * every released tarball and change the artefact's size — neither belongs in a
 * change that is only supposed to make the build faster. Rewriting `sources`
 * relative to the emitted file reproduces what `tsc` has always written.
 */
function toTscMapShape(map, outBase, sourcePath) {
  const { sourcesContent, ...rest } = map;
  return {
    ...rest,
    version: 3,
    file: `${outBase.split("/").pop()}.js`,
    sourceRoot: "",
    sources: [relative(dirname(outBase), sourcePath)],
    names: map.names ?? []
  };
}

async function main() {
  try {
    await stat(srcDir);
  } catch {
    stderr.write(`build-package: no src/ in ${packageDir}\n`);
    exit(1);
  }

  // Start clean so a renamed or deleted source cannot leave a stale artefact
  // behind — tsc overwrites in place and has the same blind spot, but a
  // published package is the wrong place to discover it.
  await rm(outDir, { recursive: true, force: true });

  const sources = await collectSources(srcDir);
  const failures = [];
  let declarations = 0;

  for (const source of sources) {
    const text = await readFile(source, "utf8");
    const rel = relative(srcDir, source).replace(/\.ts$/, "");
    const base = join(outDir, rel);
    await mkdir(dirname(base), { recursive: true });

    const js = transformSync(source, text, { sourcemap: true });
    if (js.errors?.length) {
      failures.push([source, js.errors]);
      continue;
    }
    const fileName = rel.split("/").pop();
    await writeFile(`${base}.js`, `${js.code}\n//# sourceMappingURL=${fileName}.js.map`);
    if (js.map) {
      await writeFile(`${base}.js.map`, JSON.stringify(toTscMapShape(js.map, base, source)));
    }

    const dts = isolatedDeclarationSync(source, text);
    if (dts.errors?.length) {
      failures.push([source, dts.errors]);
      continue;
    }
    await writeFile(`${base}.d.ts`, dts.code);
    declarations += 1;
  }

  if (failures.length > 0) {
    for (const [source, errors] of failures) {
      for (const error of errors) {
        stderr.write(`${relative(packageDir, source)}: ${error.message ?? error}\n`);
      }
    }
    stderr.write(
      "\nDeclaration emit needs an explicit type on every export " +
        "(isolatedDeclarations). Run `pnpm typecheck` for the same errors with " +
        "full context.\n"
    );
    exit(1);
  }

  stdout.write(`built ${sources.length} files, ${declarations} declarations\n`);
}

await main();
