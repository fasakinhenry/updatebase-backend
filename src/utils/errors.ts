/**
 * one error shape for the whole api. every failure a client can act on is an
 * AppError with a stable machine readable code and a message written for a
 * person, lowercase like the rest of the product.
 */
export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  /** false means this was a bug, not something the caller did wrong */
  readonly expected: boolean;

  constructor(
    status: number,
    code: string,
    message: string,
    options: { details?: unknown; expected?: boolean } = {},
  ) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
    this.details = options.details;
    this.expected = options.expected ?? true;
    Error.captureStackTrace?.(this, AppError);
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new AppError(400, "bad_request", message, { details });

export const unauthorized = (message = "you need to sign in to do that") =>
  new AppError(401, "unauthorized", message);

export const forbidden = (message = "you do not have permission to do that") =>
  new AppError(403, "forbidden", message);

export const notFound = (message = "we could not find that") =>
  new AppError(404, "not_found", message);

export const conflict = (message: string, details?: unknown) =>
  new AppError(409, "conflict", message, { details });

export const unprocessable = (message: string, details?: unknown) =>
  new AppError(422, "unprocessable", message, { details });

export const tooManyRequests = (message = "that was a lot at once, give it a moment") =>
  new AppError(429, "rate_limited", message);

export const internal = (message = "something broke on our side") =>
  new AppError(500, "internal_error", message, { expected: false });

export const serviceUnavailable = (message: string, code = "service_unavailable") =>
  new AppError(503, code, message);
