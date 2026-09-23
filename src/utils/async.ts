import type { NextFunction, Request, Response } from "express";

type Handler<Req extends Request = Request> = (
  req: Req,
  res: Response,
  next: NextFunction,
) => Promise<unknown>;

/**
 * express 5 forwards rejected promises on its own, but wrapping keeps the
 * intent obvious at every route and works the same if that ever changes.
 */
export function asyncHandler<Req extends Request = Request>(handler: Handler<Req>) {
  return (req: Req, res: Response, next: NextFunction) => {
    void Promise.resolve(handler(req, res, next)).catch(next);
  };
}
