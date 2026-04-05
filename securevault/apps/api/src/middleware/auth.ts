import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

// ─── Extended Request Interface ───────────────────────────────────────────────

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userId?: string;
    }
  }
}

export interface AuthenticatedRequest extends Request {
  userId: string;
}

// ─── JWT Payload ──────────────────────────────────────────────────────────────

interface AccessTokenPayload {
  sub: string;
  mfaVerified: boolean;
  iat: number;
  exp: number;
}

// ─── Key helper ───────────────────────────────────────────────────────────────

function getPublicKey(): string {
  const key = process.env["JWT_PUBLIC_KEY"];
  if (!key) throw new Error("JWT_PUBLIC_KEY environment variable is not set");
  // Support both raw PEM and base64-encoded PEM
  return key.includes("-----") ? key : Buffer.from(key, "base64").toString("utf8");
}

// ─── Token extraction ─────────────────────────────────────────────────────────

function extractBearer(req: Request): string | null {
  const header = req.headers["authorization"];
  if (!header || !header.startsWith("Bearer ")) return null;
  const token = header.slice(7).trim();
  return token.length > 0 ? token : null;
}

// ─── Core verification ────────────────────────────────────────────────────────

function verifyAccessToken(token: string): AccessTokenPayload {
  return jwt.verify(token, getPublicKey(), {
    algorithms: ["RS256"],
  }) as AccessTokenPayload;
}

// ─── authenticate middleware (required) ──────────────────────────────────────

/**
 * Requires a valid RS256 Bearer token with mfaVerified=true.
 * Attaches req.userId on success; returns 401 otherwise.
 */
export function authenticate(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const token = extractBearer(req);
  if (!token) {
    res.status(401).json({ error: "Missing or malformed Authorization header" });
    return;
  }

  let payload: AccessTokenPayload;
  try {
    payload = verifyAccessToken(token);
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      res.status(401).json({ error: "Access token expired" });
    } else {
      res.status(401).json({ error: "Invalid access token" });
    }
    return;
  }

  if (!payload.mfaVerified) {
    res.status(401).json({ error: "MFA verification required" });
    return;
  }

  req.userId = payload.sub;
  next();
}

// ─── optionalAuth middleware ──────────────────────────────────────────────────

/**
 * Attempts to verify a Bearer token if present.
 * Sets req.userId when a valid, MFA-verified token is found; never rejects the request.
 */
export function optionalAuth(
  req: Request,
  _res: Response,
  next: NextFunction
): void {
  const token = extractBearer(req);
  if (!token) {
    next();
    return;
  }

  try {
    const payload = verifyAccessToken(token);
    if (payload.mfaVerified) {
      req.userId = payload.sub;
    }
  } catch {
    // Silently ignore invalid / expired tokens in optional mode
  }

  next();
}
