import type { Response } from "express";

/**
 * every successful response is `{ data: ... }` and every failure is
 * `{ error: { code, message, details? } }`. the client unwraps `data`
 * automatically, so keeping this consistent is what makes that work.
 */
export function ok<T>(res: Response, data: T, status = 200) {
  return res.status(status).json({ data });
}

export function created<T>(res: Response, data: T) {
  return ok(res, data, 201);
}

export function noContent(res: Response) {
  return res.status(204).end();
}

export interface Paginated<T> {
  items: T[];
  /** opaque cursor for the next page, null when there is nothing more */
  nextCursor: string | null;
}

export function page<T>(res: Response, items: T[], nextCursor: string | null) {
  return ok<Paginated<T>>(res, { items, nextCursor });
}
