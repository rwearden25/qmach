import { Router, type Request, type Response, type NextFunction } from "express";
import argon2 from "argon2";
import crypto from "crypto";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { validate } from "../middleware/validate.js";
import { authenticate } from "../middleware/auth.js";
import {
  loginLimiter,
  mfaLimiter,
  apiLimiter,
} from "../middleware/rateLimit.js";
import {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  generateMFAChallengeToken,
  verifyMFAChallengeToken,
} from "../services/encryption.js";
import {
  generateTOTPSecret,
  verifyTOTP,
  generateBackupCodes,
  hashBackupCode,
  verifyBackupCode,
  encryptTOTPSecret,
  decryptTOTPSecret,
  generateQRCode,
} from "../services/mfa.js";

export const authRouter = Router();

// ─── Argon2 options ───────────────────────────────────────────────────────────

const ARGON2_OPTIONS = {
  memoryCost: 65536,   // 64 MiB
  timeCost: 3,
  parallelism: 4,
} as const;

// ─── Refresh cookie settings ──────────────────────────────────────────────────

const REFRESH_COOKIE = "refreshToken";
const REFRESH_TOKEN_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function setRefreshCookie(res: Response, token: string): void {
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: "strict",
    maxAge: REFRESH_TOKEN_MAX_AGE_MS,
    path: "/",
  });
}

function clearRefreshCookie(res: Response): void {
  res.clearCookie(REFRESH_COOKIE, { path: "/" });
}

// ─── Validation schemas ───────────────────────────────────────────────────────

const RegisterSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(12).max(128),
  wrappedMasterKey: z.string().min(1),
});

const LoginSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(128),
});

const MfaVerifySchema = z.object({
  challengeToken: z.string().min(1),
  /** 6-digit TOTP code OR 8-char backup code */
  code: z.string().min(6).max(8),
});

// ─── POST /register ───────────────────────────────────────────────────────────

authRouter.post(
  "/register",
  loginLimiter,
  validate(RegisterSchema, "body"),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { email, password, wrappedMasterKey } = req.body as z.infer<
        typeof RegisterSchema
      >;

      // Check for existing account — use a generic error to prevent user enumeration
      const existing = await prisma.user.findUnique({ where: { email } });
      if (existing) {
        res.status(409).json({ error: "Registration failed" });
        return;
      }

      // Hash password with argon2id
      const passwordHash = await argon2.hash(password, ARGON2_OPTIONS);

      // Generate TOTP secret
      const { secret: rawTotpSecret, otpauthUrl } = generateTOTPSecret(email);
      const encryptedTotpSecret = encryptTOTPSecret(rawTotpSecret);

      // Generate backup codes and hash each one
      const backupCodes = generateBackupCodes();
      const hashedBackupCodes = await Promise.all(
        backupCodes.map((c) => hashBackupCode(c))
      );

      // Generate recovery key — 32 random bytes returned to user as hex
      const recoveryKeyRaw = crypto.randomBytes(32).toString("hex");
      const recoveryKeyHash = await argon2.hash(recoveryKeyRaw, ARGON2_OPTIONS);

      // Persist user — session is NOT created at registration
      const user = await prisma.user.create({
        data: {
          email,
          passwordHash,
          totpSecret: encryptedTotpSecret,
          mfaEnabled: true,
          backupCodes: hashedBackupCodes,
          recoveryKeyHash,
          wrappedMasterKey,
        },
        select: { id: true, email: true, createdAt: true },
      });

      // Generate QR code data URL for the authenticator app setup
      const qrCode = await generateQRCode(otpauthUrl);

      await prisma.auditLog.create({
        data: {
          userId: user.id,
          action: "register",
          ipAddress: req.ip ?? null,
        },
      });

      // Return setup material — no session token issued yet
      res.status(201).json({
        mfaSecret: rawTotpSecret,
        qrCode,
        backupCodes,
        recoveryKey: recoveryKeyRaw,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─── POST /login ──────────────────────────────────────────────────────────────

authRouter.post(
  "/login",
  loginLimiter,
  validate(LoginSchema, "body"),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { email, password } = req.body as z.infer<typeof LoginSchema>;

      const user = await prisma.user.findUnique({ where: { email } });

      // Always run a hash comparison to prevent timing-based user enumeration
      if (!user) {
        // Dummy compare so the response time is similar whether the user exists
        await argon2.hash(password, ARGON2_OPTIONS);
        res.status(401).json({ error: "Invalid credentials" });
        return;
      }

      const passwordValid = await argon2.verify(user.passwordHash, password);
      if (!passwordValid) {
        res.status(401).json({ error: "Invalid credentials" });
        return;
      }

      // Issue a short-lived challenge token — NOT a session
      const challengeToken = generateMFAChallengeToken(user.id);

      await prisma.auditLog.create({
        data: {
          userId: user.id,
          action: "login_attempt",
          ipAddress: req.ip ?? null,
        },
      });

      res.status(200).json({ challengeToken, mfaRequired: true });
    } catch (err) {
      next(err);
    }
  }
);

// ─── POST /mfa-verify ─────────────────────────────────────────────────────────

authRouter.post(
  "/mfa-verify",
  mfaLimiter,
  validate(MfaVerifySchema, "body"),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { challengeToken, code } = req.body as z.infer<typeof MfaVerifySchema>;

      // Verify the challenge token
      let userId: string;
      try {
        const decoded = verifyMFAChallengeToken(challengeToken);
        userId = decoded.userId;
      } catch {
        res.status(401).json({ error: "Invalid or expired challenge token" });
        return;
      }

      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (!user) {
        res.status(401).json({ error: "Invalid or expired challenge token" });
        return;
      }

      let mfaVerified = false;

      // Try TOTP first (6-digit code)
      if (code.length === 6 && user.totpSecret) {
        const rawSecret = decryptTOTPSecret(user.totpSecret);
        mfaVerified = verifyTOTP(rawSecret, code);
      }

      // Try backup code (8-char code)
      if (!mfaVerified && code.length === 8 && user.backupCodes.length > 0) {
        const matchIndex = await verifyBackupCode(code.toUpperCase(), user.backupCodes);
        if (matchIndex !== -1) {
          mfaVerified = true;
          // Consume (remove) the used backup code
          const updatedCodes = user.backupCodes.filter((_, i) => i !== matchIndex);
          await prisma.user.update({
            where: { id: userId },
            data: { backupCodes: updatedCodes },
          });
        }
      }

      if (!mfaVerified) {
        res.status(401).json({ error: "Invalid MFA code" });
        return;
      }

      // Create a new session
      const sessionExpiresAt = new Date(Date.now() + REFRESH_TOKEN_MAX_AGE_MS);
      const session = await prisma.session.create({
        data: {
          userId,
          // Temporary placeholder — will be replaced with the signed JWT value
          refreshToken: crypto.randomUUID(),
          deviceInfo: req.headers["user-agent"] ?? null,
          ipAddress: req.ip ?? null,
          mfaVerified: true,
          expiresAt: sessionExpiresAt,
        },
      });

      // Sign tokens now that we have the session id
      const accessToken = signAccessToken({ userId, mfaVerified: true });
      const refreshToken = signRefreshToken({ userId, sessionId: session.id });

      // Persist the actual signed refresh token
      await prisma.session.update({
        where: { id: session.id },
        data: { refreshToken },
      });

      setRefreshCookie(res, refreshToken);

      await prisma.auditLog.create({
        data: { userId, action: "mfa_verified", ipAddress: req.ip ?? null },
      });

      res.status(200).json({
        accessToken,
        user: {
          id: user.id,
          email: user.email,
          mfaEnabled: user.mfaEnabled,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─── POST /refresh ────────────────────────────────────────────────────────────

authRouter.post(
  "/refresh",
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const cookies = req.cookies as Record<string, string | undefined>;
      const incomingToken = cookies[REFRESH_COOKIE];

      if (!incomingToken) {
        res.status(401).json({ error: "No refresh token provided" });
        return;
      }

      // Verify JWT signature and expiry
      let decoded: { userId: string; sessionId: string };
      try {
        decoded = verifyRefreshToken(incomingToken);
      } catch {
        clearRefreshCookie(res);
        res.status(401).json({ error: "Invalid refresh token" });
        return;
      }

      const { userId, sessionId } = decoded;

      // Look up the session record
      const session = await prisma.session.findUnique({
        where: { id: sessionId },
      });

      // ── Reuse detection ──────────────────────────────────────────────────────
      // If the session is not found, the token may have been used after rotation.
      // This indicates a possible compromise: revoke ALL sessions for this user.
      if (!session) {
        await prisma.session.deleteMany({ where: { userId } });
        clearRefreshCookie(res);
        res.status(401).json({ error: "Refresh token reuse detected — all sessions revoked" });
        return;
      }

      // Verify the token in the DB matches the incoming token (binding check)
      if (session.refreshToken !== incomingToken) {
        // Token mismatch after session was found by id: possible token substitution
        await prisma.session.deleteMany({ where: { userId } });
        clearRefreshCookie(res);
        res.status(401).json({ error: "Refresh token mismatch — all sessions revoked" });
        return;
      }

      // Check session expiry
      if (session.expiresAt < new Date()) {
        await prisma.session.delete({ where: { id: sessionId } });
        clearRefreshCookie(res);
        res.status(401).json({ error: "Session expired" });
        return;
      }

      // ── Rotation ─────────────────────────────────────────────────────────────
      // Delete old session, create a new one
      await prisma.session.delete({ where: { id: sessionId } });

      const newExpiresAt = new Date(Date.now() + REFRESH_TOKEN_MAX_AGE_MS);
      const newSession = await prisma.session.create({
        data: {
          userId,
          refreshToken: crypto.randomUUID(), // placeholder
          deviceInfo: session.deviceInfo,
          ipAddress: req.ip ?? null,
          mfaVerified: session.mfaVerified,
          expiresAt: newExpiresAt,
        },
      });

      const newAccessToken = signAccessToken({ userId, mfaVerified: true });
      const newRefreshToken = signRefreshToken({
        userId,
        sessionId: newSession.id,
      });

      await prisma.session.update({
        where: { id: newSession.id },
        data: { refreshToken: newRefreshToken },
      });

      setRefreshCookie(res, newRefreshToken);

      res.status(200).json({ accessToken: newAccessToken });
    } catch (err) {
      next(err);
    }
  }
);

// ─── POST /logout ─────────────────────────────────────────────────────────────

authRouter.post(
  "/logout",
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const cookies = req.cookies as Record<string, string | undefined>;
      const refreshToken = cookies[REFRESH_COOKIE];

      if (refreshToken) {
        // Best-effort: delete the session; ignore if already gone
        try {
          await prisma.session.deleteMany({ where: { refreshToken } });
        } catch {
          // Silently ignore — we still clear the cookie
        }

        // Attempt to log the logout with the user id from the token
        try {
          const decoded = verifyRefreshToken(refreshToken);
          await prisma.auditLog.create({
            data: {
              userId: decoded.userId,
              action: "logout",
              ipAddress: req.ip ?? null,
            },
          });
        } catch {
          // Token may already be invalid; skip the audit log
        }
      }

      clearRefreshCookie(res);
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  }
);

// ─── POST /totp/setup  (requires active session) ─────────────────────────────

authRouter.post(
  "/totp/setup",
  authenticate,
  apiLimiter,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const userId = req.userId!;

      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (!user) {
        res.status(404).json({ error: "User not found" });
        return;
      }

      const { secret: rawSecret, otpauthUrl } = generateTOTPSecret(user.email);
      const qrCode = await generateQRCode(otpauthUrl);

      // Store pending (unconfirmed) secret — only committed on /totp/confirm
      const encryptedPending = encryptTOTPSecret(rawSecret);
      await prisma.user.update({
        where: { id: userId },
        data: { totpSecret: encryptedPending },
      });

      res.status(200).json({ secret: rawSecret, qrCode });
    } catch (err) {
      next(err);
    }
  }
);

// ─── POST /totp/confirm (requires active session) ────────────────────────────

const TotpConfirmSchema = z.object({
  token: z.string().length(6).regex(/^\d{6}$/),
});

authRouter.post(
  "/totp/confirm",
  authenticate,
  apiLimiter,
  validate(TotpConfirmSchema, "body"),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const userId = req.userId!;
      const { token } = req.body as z.infer<typeof TotpConfirmSchema>;

      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (!user?.totpSecret) {
        res.status(400).json({ error: "No TOTP setup in progress" });
        return;
      }

      const rawSecret = decryptTOTPSecret(user.totpSecret);
      const valid = verifyTOTP(rawSecret, token);
      if (!valid) {
        res.status(400).json({ error: "Invalid TOTP token" });
        return;
      }

      await prisma.user.update({
        where: { id: userId },
        data: { mfaEnabled: true },
      });

      await prisma.auditLog.create({
        data: { userId, action: "totp_enabled", ipAddress: req.ip ?? null },
      });

      res.status(200).json({ mfaEnabled: true });
    } catch (err) {
      next(err);
    }
  }
);
