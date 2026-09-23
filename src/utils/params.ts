import type { Request } from "express";

/**
 * express 5 types a route param as `string | string[]`, because a pattern can
 * repeat. ours never do, and `validate()` has already parsed them, so this
 * narrows once here instead of casting at every call site.
 */
export function param(req: Request, name: string): string {
  const value = req.params[name];
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}
