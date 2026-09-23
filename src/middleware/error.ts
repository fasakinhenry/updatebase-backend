import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import mongoose from "mongoose";
import { AppError } from "../utils/errors";
import { logger } from "../config/logger";
import { isProduction } from "../config/env";

export function notFoundHandler(req: Request, res: Response) {
  res.status(404).json({
    error: {
      code: "route_not_found",
      message: `no route for ${req.method} ${req.path}`,
    },
  });
}

/** turns everything that can go wrong into the one error envelope. */
export function errorHandler(
  error: unknown,
  req: Request,
  res: Response,
  // express only treats this as an error handler when it takes four arguments
  _next: NextFunction,
) {
  if (error instanceof AppError) {
    if (!error.expected) {
      logger.error({ err: error, path: req.path }, "unexpected app error");
    }
    res.status(error.status).json({
      error: { code: error.code, message: error.message, details: error.details },
    });
    return;
  }

  if (error instanceof ZodError) {
    res.status(422).json({
      error: {
        code: "validation_failed",
        message: "some of those details are not quite right",
        details: error.issues.map((issue) => ({
          field: issue.path.join("."),
          message: issue.message,
        })),
      },
    });
    return;
  }

  // a duplicate key is a user facing conflict, not a server fault
  if (
    error instanceof mongoose.mongo.MongoServerError &&
    error.code === 11000
  ) {
    const field = Object.keys(error.keyPattern ?? {})[0] ?? "value";
    res.status(409).json({
      error: {
        code: "already_taken",
        message: `that ${field} is already taken`,
        details: { field },
      },
    });
    return;
  }

  if (error instanceof mongoose.Error.CastError) {
    res.status(400).json({
      error: { code: "bad_identifier", message: "that identifier is not valid" },
    });
    return;
  }

  logger.error({ err: error, path: req.path, method: req.method }, "unhandled error");

  res.status(500).json({
    error: {
      code: "internal_error",
      message: "something broke on our side. try again in a moment.",
      // a stack in production would leak internals to anyone who can trigger it
      ...(isProduction ? {} : { details: String(error) }),
    },
  });
}
