import { Router, type Request, type Response, type NextFunction } from "express";
import argon2 from "argon2";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { authenticate } from "../middleware/auth.js";
import { apiLimiter } from "../middleware/rateLimit.js";
import { validate } from "../middleware/validate.js";

export const accountRouter = Router();

// All account routes require a valid, MFA-verified session
accountRouter.use(authenticate);
accountRouter.use(apiLimiter);

// ─── Argon2 options ───────────────────────────────────────────────────────────

const ARGON2_OPTIONS = {
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 4,
} as const;

// ─── Validation schemas ───────────────────────────────────────────────────────

const ChangePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: z.string().min(12).max(128),
  /** Client re-wraps the master key with the new password-derived key */
  newWrappedMasterKey: z.string().min(1),
});

const AuditLogQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

// ─── GET /profile ─────────────────────────────────────────────────────────────

accountRouter.get(
  "/profile",
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const userId = req.userId!;

      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          email: true,
          storageUsed: true,
          storageLimit: true,
          mfaEnabled: true,
          createdAt: true,
        },
      });

      if (!user) {
        res.status(404).json({ error: "User not found" });
        return;
      }

      res.status(200).json({
        user: {
          id: user.id,
          email: user.email,
          storageUsed: user.storageUsed.toString(),
          storageLimit: user.storageLimit.toString(),
          mfaEnabled: user.mfaEnabled,
          createdAt: user.createdAt,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─── PUT /password ────────────────────────────────────────────────────────────

accountRouter.put(
  "/password",
  validate(ChangePasswordSchema, "body"),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const userId = req.userId!;
      const { currentPassword, newPassword, newWrappedMasterKey } =
        req.body as z.infer<typeof ChangePasswordSchema>;

      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (!user) {
        res.status(404).json({ error: "User not found" });
        return;
      }

      // Verify current password
      const valid = await argon2.verify(user.passwordHash, currentPassword);
      if (!valid) {
        res.status(401).json({ error: "Current password is incorrect" });
        return;
      }

      // Hash new password
      const newPasswordHash = await argon2.hash(newPassword, ARGON2_OPTIONS);

      // Update password and the re-wrapped master key in one transaction
      await prisma.$transaction([
        prisma.user.update({
          where: { id: userId },
          data: {
            passwordHash: newPasswordHash,
            wrappedMasterKey: newWrappedMasterKey,
          },
        }),
        prisma.auditLog.create({
          data: {
            userId,
            action: "password_changed",
            ipAddress: req.ip ?? null,
          },
        }),
      ]);

      // Note: in a real implementation the client re-wraps the master key with a
      // key derived from the new password before calling this endpoint. The
      // newWrappedMasterKey above carries that updated ciphertext.

      res.status(200).json({ message: "Password updated successfully" });
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /sessions ────────────────────────────────────────────────────────────

accountRouter.get(
  "/sessions",
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const userId = req.userId!;

      const sessions = await prisma.session.findMany({
        where: { userId, expiresAt: { gt: new Date() } },
        select: {
          id: true,
          deviceInfo: true,
          ipAddress: true,
          mfaVerified: true,
          createdAt: true,
          expiresAt: true,
        },
        orderBy: { createdAt: "desc" },
      });

      res.status(200).json({ sessions });
    } catch (err) {
      next(err);
    }
  }
);

// ─── DELETE /sessions/:id ─────────────────────────────────────────────────────

accountRouter.delete(
  "/sessions/:id",
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const userId = req.userId!;
      const sessionId = (req.params as { id: string }).id;

      // Ensure the session belongs to this user
      const session = await prisma.session.findFirst({
        where: { id: sessionId, userId },
      });

      if (!session) {
        res.status(404).json({ error: "Session not found" });
        return;
      }

      await prisma.$transaction([
        prisma.session.delete({ where: { id: sessionId } }),
        prisma.auditLog.create({
          data: {
            userId,
            action: "session_revoked",
            details: { sessionId },
            ipAddress: req.ip ?? null,
          },
        }),
      ]);

      res.status(204).send();
    } catch (err) {
      next(err);
    }
  }
);

// ─── DELETE /sessions  (revoke all except current) ───────────────────────────

accountRouter.delete(
  "/sessions",
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const userId = req.userId!;

      // Identify the current session via the refresh cookie so we can keep it.
      // If no cookie is present we revoke all sessions.
      const cookies = req.cookies as Record<string, string | undefined>;
      const currentRefreshToken = cookies["refreshToken"];

      let currentSessionId: string | undefined;
      if (currentRefreshToken) {
        const currentSession = await prisma.session.findUnique({
          where: { refreshToken: currentRefreshToken },
          select: { id: true },
        });
        currentSessionId = currentSession?.id;
      }

      const whereClause = currentSessionId
        ? { userId, NOT: { id: currentSessionId } }
        : { userId };

      const { count } = await prisma.session.deleteMany({
        where: whereClause,
      });

      await prisma.auditLog.create({
        data: {
          userId,
          action: "sessions_revoked_all",
          details: { count, keptCurrentSession: !!currentSessionId },
          ipAddress: req.ip ?? null,
        },
      });

      res.status(200).json({ revokedCount: count });
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /audit-log ───────────────────────────────────────────────────────────

accountRouter.get(
  "/audit-log",
  validate(AuditLogQuerySchema, "query"),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const userId = req.userId!;
      const { page, limit } = req.query as unknown as z.infer<
        typeof AuditLogQuerySchema
      >;

      const skip = (page - 1) * limit;

      const [logs, total] = await prisma.$transaction([
        prisma.auditLog.findMany({
          where: { userId },
          orderBy: { createdAt: "desc" },
          take: limit,
          skip,
          select: {
            id: true,
            action: true,
            details: true,
            ipAddress: true,
            createdAt: true,
          },
        }),
        prisma.auditLog.count({ where: { userId } }),
      ]);

      res.status(200).json({
        logs,
        pagination: {
          total,
          page,
          limit,
          totalPages: Math.ceil(total / limit),
        },
      });
    } catch (err) {
      next(err);
    }
  }
);
