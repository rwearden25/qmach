import crypto from "crypto";
import jwt from "jsonwebtoken";

// ─── Public types ─────────────────────────────────────────────────────────────

export interface AccessTokenPayload {
  userId: string;
  mfaVerified: boolean;
}

export interface RefreshTokenPayload {
  userId: string;
  sessionId: string;
}

export interface MFAChallengeTokenPayload {
  userId: string;
}

export interface DecodedAccessToken extends AccessTokenPayload {
  sub: string;
  iat: number;
  exp: number;
}

export interface DecodedRefreshToken extends RefreshTokenPayload {
  sub: string;
  iat: number;
  exp: number;
}

export interface DecodedMFAChallengeToken extends MFAChallengeTokenPayload {
  sub: string;
  iat: number;
  exp: number;
}

export interface KeyPair {
  privateKey: string;
  publicKey: string;
}

// ─── Key helpers ──────────────────────────────────────────────────────────────

function getPrivateKey(): string {
  const key = process.env["JWT_PRIVATE_KEY"];
  if (!key) throw new Error("JWT_PRIVATE_KEY environment variable is not set");
  // Support both raw PEM and base64-encoded PEM
  return key.includes("-----") ? key : Buffer.from(key, "base64").toString("utf8");
}

function getPublicKey(): string {
  const key = process.env["JWT_PUBLIC_KEY"];
  if (!key) throw new Error("JWT_PUBLIC_KEY environment variable is not set");
  return key.includes("-----") ? key : Buffer.from(key, "base64").toString("utf8");
}

// ─── Key pair generation (initial setup utility) ─────────────────────────────

/**
 * Generates a fresh RSA-2048 key pair suitable for RS256 JWT signing.
 * Returns PEM-encoded strings.
 *
 * Call once during initial deployment to populate JWT_PRIVATE_KEY and
 * JWT_PUBLIC_KEY in your environment secrets.
 */
export function generateKeyPair(): KeyPair {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return { privateKey, publicKey };
}

// ─── Access token (15 min) ────────────────────────────────────────────────────

/**
 * Signs a short-lived (15 min) RS256 access token.
 * The `sub` claim holds the userId; `mfaVerified` signals successful MFA.
 */
export function signAccessToken(payload: AccessTokenPayload): string {
  return jwt.sign(
    { mfaVerified: payload.mfaVerified },
    getPrivateKey(),
    {
      algorithm: "RS256",
      subject: payload.userId,
      expiresIn: "15m",
    }
  );
}

/**
 * Verifies an RS256 access token and returns the decoded payload.
 * Throws on expiry, invalid signature, or algorithm mismatch.
 */
export function verifyAccessToken(token: string): DecodedAccessToken {
  const decoded = jwt.verify(token, getPublicKey(), {
    algorithms: ["RS256"],
  }) as DecodedAccessToken;
  decoded.userId = decoded.sub;
  return decoded;
}

// ─── Refresh token (7 days) ───────────────────────────────────────────────────

/**
 * Signs a 7-day RS256 refresh token.
 * Carries `userId` (as `sub`) and `sessionId` so the server can look up the
 * corresponding Session record for rotation and revocation.
 */
export function signRefreshToken(payload: RefreshTokenPayload): string {
  return jwt.sign(
    { sessionId: payload.sessionId },
    getPrivateKey(),
    {
      algorithm: "RS256",
      subject: payload.userId,
      expiresIn: "7d",
    }
  );
}

/**
 * Verifies an RS256 refresh token and returns the decoded payload.
 */
export function verifyRefreshToken(token: string): DecodedRefreshToken {
  const decoded = jwt.verify(token, getPublicKey(), {
    algorithms: ["RS256"],
  }) as DecodedRefreshToken;
  decoded.userId = decoded.sub;
  return decoded;
}

// ─── MFA challenge token (5 min) ─────────────────────────────────────────────

/**
 * Signs a very short-lived (5 min) RS256 token used to carry the user's
 * identity between the POST /login step and the POST /mfa-verify step.
 * Includes a `type` claim to prevent reuse as any other token kind.
 */
export function generateMFAChallengeToken(userId: string): string {
  return jwt.sign(
    { type: "mfa_challenge" },
    getPrivateKey(),
    {
      algorithm: "RS256",
      subject: userId,
      expiresIn: "5m",
    }
  );
}

/**
 * Verifies an MFA challenge token and returns the decoded payload.
 * Throws if the token is invalid, expired, or does not carry type="mfa_challenge".
 */
export function verifyMFAChallengeToken(token: string): DecodedMFAChallengeToken {
  const decoded = jwt.verify(token, getPublicKey(), {
    algorithms: ["RS256"],
  }) as DecodedMFAChallengeToken & { type?: string };

  if (decoded.type !== "mfa_challenge") {
    throw new Error("Token is not an MFA challenge token");
  }

  decoded.userId = decoded.sub;
  return decoded;
}
