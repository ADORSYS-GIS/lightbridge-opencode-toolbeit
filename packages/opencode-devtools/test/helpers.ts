import { DEVTOOLS_TOOLS } from "../src/catalog.js";
import { buildContext } from "../src/context.js";
import type { NeutralResult, ToolContext } from "../src/tool-spec.js";
import type { ResolvedDevtoolsOptions } from "../src/types.js";

export const FIXED_NOW = new Date("2026-06-18T12:00:00.000Z");

export function options(overrides: Partial<ResolvedDevtoolsOptions> = {}): ResolvedDevtoolsOptions {
  return {
    enabled: true,
    groups: ["math", "codec", "crypto", "datetime", "convert", "http"],
    http: { allowPrivateNetwork: false, timeoutMs: 1000 },
    ...overrides
  };
}

/** A deterministic context: fixed clock, constant randomness, injectable fetch. */
export function ctx(overrides: Partial<Omit<ToolContext, "options">> = {}): ToolContext {
  return buildContext(options(), {
    now: () => FIXED_NOW,
    randomBytes: (n: number) => Buffer.alloc(n, 7),
    ...overrides
  });
}

/**
 * Find a catalog tool by name and run its handler. Always async so a handler
 * that throws synchronously surfaces as a rejected promise (for `.rejects`).
 */
export async function run(
  name: string,
  args: Record<string, unknown>,
  context: ToolContext = ctx()
): Promise<NeutralResult> {
  const spec = DEVTOOLS_TOOLS.find((t) => t.name === name);
  if (!spec) {
    throw new Error(`no such tool: ${name}`);
  }
  return spec.handler(args, context);
}
