import type { Request, Response, NextFunction } from "express";
import type { ZodSchema, ZodError } from "zod";

// ─── Types ────────────────────────────────────────────────────────────────────

export type ValidationSource = "body" | "params" | "query";

interface SanitizedIssue {
  field: string;
  message: string;
}

// ─── Error sanitiser ──────────────────────────────────────────────────────────

/**
 * Converts a ZodError into a flat list of {field, message} pairs.
 *
 * Deliberately omits received values, union discriminant details, and any
 * other information that could expose internal schema structure.
 */
function sanitiseZodError(error: ZodError): SanitizedIssue[] {
  return error.issues.map((issue) => ({
    field: issue.path.join(".") || "_root",
    message: issue.message,
  }));
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Returns an Express middleware that validates `req[source]` against `schema`.
 *
 * On success the parsed (coerced / transformed) data is written back to
 * `req[source]` so downstream handlers receive strongly-typed, validated input.
 *
 * On failure responds with HTTP 400 and sanitised error messages — internal
 * schema details are never exposed to the caller.
 */
export function validate<T>(
  schema: ZodSchema<T>,
  source: ValidationSource
): (req: Request, res: Response, next: NextFunction) => void {
  return function validationMiddleware(
    req: Request,
    res: Response,
    next: NextFunction
  ): void {
    const result = schema.safeParse(req[source]);

    if (!result.success) {
      const issues = sanitiseZodError(result.error);
      res.status(400).json({
        error: "Validation failed",
        issues,
      });
      return;
    }

    // Write coerced/transformed data back so downstream handlers get typed input
    (req as Record<string, unknown>)[source] = result.data;
    next();
  };
}
