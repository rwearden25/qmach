import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import multer from "multer";
import { v4 as uuidv4 } from "uuid";
import { prisma } from "../lib/prisma.js";
import {
  uploadBlob,
  downloadBlob,
  deleteBlob,
  StorageError,
} from "../services/storage.js";
import { computeHash } from "../services/integrity.js";

// ─── Router ───────────────────────────────────────────────────────────────────

export const filesRouter = Router();

// ─── Multer: store upload in memory, 5 GB limit ───────────────────────────────

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 * 1024 }, // 5 GB
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function userId(req: Request): string {
  return (req as Request & { userId: string }).userId;
}

// ─── Zod Schemas ──────────────────────────────────────────────────────────────

const ListQuerySchema = z.object({
  folderId: z.string().optional(),
  includeDeleted: z
    .string()
    .optional()
    .transform((v) => v === "true"),
  search: z.string().optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(200).default(50),
});

const ShareSchema = z.object({
  wrappedFileKey: z.string().min(1),
  accessLevel: z.enum(["view", "download"]).default("view"),
  expiresAt: z.string().datetime().optional(),
  maxAccesses: z.number().int().positive().optional(),
  sharedWithEmail: z.string().email().optional(),
});

// ─── POST /upload ─────────────────────────────────────────────────────────────
//
// Accept multipart/form-data. Fields:
//   encryptedBlob      (file field)
//   encryptedName      (text)
//   encryptedMimeType  (text)
//   encryptedSize      (text)
//   wrappedFileKey     (text)
//   plaintextHash      (text)
//   ciphertextHash     (text)
//   folderId           (text, optional)

filesRouter.post(
  "/upload",
  upload.single("encryptedBlob"),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const uid = userId(req);

      if (!req.file) {
        res.status(400).json({ error: "encryptedBlob file field is required" });
        return;
      }

      // Validate text fields
      const BodySchema = z.object({
        encryptedName: z.string().min(1),
        encryptedMimeType: z.string().min(1),
        encryptedSize: z.string().min(1),
        wrappedFileKey: z.string().min(1),
        plaintextHash: z.string().min(1),
        ciphertextHash: z.string().min(1),
        folderId: z.string().optional(),
      });

      const body = BodySchema.safeParse(req.body);
      if (!body.success) {
        res.status(400).json({ error: "Invalid request", issues: body.error.issues });
        return;
      }

      const {
        encryptedName,
        encryptedMimeType,
        encryptedSize,
        wrappedFileKey,
        plaintextHash,
        ciphertextHash,
        folderId,
      } = body.data;

      // Verify folder ownership when provided
      if (folderId) {
        const folder = await prisma.folder.findFirst({
          where: { id: folderId, userId: uid },
        });
        if (!folder) {
          res.status(404).json({ error: "Folder not found" });
          return;
        }
      }

      // Verify ciphertextHash matches the uploaded blob
      const uploadedData = req.file.buffer;
      const actualHash = await computeHash(uploadedData);
      if (actualHash !== ciphertextHash) {
        res
          .status(422)
          .json({ error: "ciphertextHash does not match uploaded blob" });
        return;
      }

      // Check storage limit
      const user = await prisma.user.findUnique({
        where: { id: uid },
        select: { storageUsed: true, storageLimit: true },
      });
      if (!user) {
        res.status(404).json({ error: "User not found" });
        return;
      }

      const newSize = BigInt(uploadedData.length);
      if (user.storageUsed + newSize > user.storageLimit) {
        res.status(413).json({ error: "Storage limit exceeded" });
        return;
      }

      // Upload to S3
      const blobKey = `${uid}/${uuidv4()}`;
      try {
        await uploadBlob(blobKey, uploadedData, uploadedData.length);
      } catch (err) {
        if (err instanceof StorageError) {
          console.error("[files] upload to S3 failed:", err.message);
          res.status(502).json({ error: "Failed to store file" });
          return;
        }
        throw err;
      }

      // Persist File record and update storageUsed atomically
      const [file] = await prisma.$transaction([
        prisma.file.create({
          data: {
            userId: uid,
            folderId: folderId ?? null,
            encryptedName,
            encryptedMimeType,
            encryptedSize,
            blobKey,
            wrappedFileKey,
            plaintextHash,
            ciphertextHash,
            sizeBytes: newSize,
          },
          select: {
            id: true,
            encryptedName: true,
            encryptedMimeType: true,
            encryptedSize: true,
            sizeBytes: true,
            wrappedFileKey: true,
            plaintextHash: true,
            ciphertextHash: true,
            version: true,
            folderId: true,
            createdAt: true,
            updatedAt: true,
          },
        }),
        prisma.user.update({
          where: { id: uid },
          data: { storageUsed: { increment: newSize } },
        }),
      ]);

      await prisma.auditLog.create({
        data: {
          userId: uid,
          action: "file_upload",
          details: { fileId: file.id, sizeBytes: newSize.toString() },
          ipAddress: req.ip,
        },
      });

      res.status(201).json({ file });
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET / ────────────────────────────────────────────────────────────────────
//
// List files for authenticated user with optional filtering and pagination.

filesRouter.get(
  "/",
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const uid = userId(req);
      const query = ListQuerySchema.safeParse(req.query);
      if (!query.success) {
        res.status(400).json({ error: "Invalid query parameters", issues: query.error.issues });
        return;
      }

      const { folderId, includeDeleted, search, page, limit } = query.data;
      const skip = (page - 1) * limit;

      const where = {
        userId: uid,
        ...(folderId !== undefined ? { folderId } : {}),
        ...(includeDeleted ? {} : { isDeleted: false }),
        ...(search
          ? { encryptedName: { contains: search, mode: "insensitive" as const } }
          : {}),
      };

      const [files, total] = await prisma.$transaction([
        prisma.file.findMany({
          where,
          orderBy: { createdAt: "desc" },
          skip,
          take: limit,
          select: {
            id: true,
            encryptedName: true,
            encryptedMimeType: true,
            encryptedSize: true,
            sizeBytes: true,
            wrappedFileKey: true,
            plaintextHash: true,
            version: true,
            isDeleted: true,
            deletedAt: true,
            folderId: true,
            createdAt: true,
            updatedAt: true,
          },
        }),
        prisma.file.count({ where }),
      ]);

      res.status(200).json({
        files,
        pagination: { total, page, limit, pages: Math.ceil(total / limit) },
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /storage ─────────────────────────────────────────────────────────────

filesRouter.get(
  "/storage",
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const uid = userId(req);

      const user = await prisma.user.findUnique({
        where: { id: uid },
        select: { storageUsed: true, storageLimit: true },
      });

      if (!user) {
        res.status(404).json({ error: "User not found" });
        return;
      }

      res.status(200).json({
        storageUsed: user.storageUsed.toString(),
        storageLimit: user.storageLimit.toString(),
        availableBytes: (user.storageLimit - user.storageUsed).toString(),
        usagePercent: Number(
          ((user.storageUsed * 10000n) / user.storageLimit) / 100n
        ),
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /shared/:shareId ─────────────────────────────────────────────────────
//
// Access a shared file. Validates the share token, streams the blob, returns
// the wrappedFileKey alongside the encrypted data.

filesRouter.get(
  "/shared/:shareId",
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { shareId } = req.params as { shareId: string };

      const share = await prisma.fileShare.findUnique({
        where: { id: shareId },
        include: { file: { select: { blobKey: true, isDeleted: true } } },
      });

      if (!share || share.file.isDeleted) {
        res.status(404).json({ error: "Share not found" });
        return;
      }

      // Check expiry
      if (share.expiresAt && share.expiresAt < new Date()) {
        res.status(410).json({ error: "Share link has expired" });
        return;
      }

      // Check max accesses
      if (share.maxAccesses !== null && share.accessCount >= share.maxAccesses) {
        res.status(410).json({ error: "Share link access limit reached" });
        return;
      }

      // Increment access count
      await prisma.fileShare.update({
        where: { id: shareId },
        data: { accessCount: { increment: 1 } },
      });

      // Stream blob from S3
      let stream;
      try {
        stream = await downloadBlob(share.file.blobKey);
      } catch (err) {
        if (err instanceof StorageError) {
          console.error("[files] download from S3 failed:", err.message);
          res.status(502).json({ error: "Failed to retrieve file" });
          return;
        }
        throw err;
      }

      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="encrypted-file"`
      );
      res.setHeader("X-Wrapped-File-Key", share.wrappedFileKey);
      res.setHeader("X-Access-Level", share.accessLevel);

      stream.pipe(res);
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /:id/download ────────────────────────────────────────────────────────
//
// Stream encrypted blob directly to client.

filesRouter.get(
  "/:id/download",
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const uid = userId(req);
      const { id } = req.params as { id: string };

      const file = await prisma.file.findFirst({
        where: { id, userId: uid, isDeleted: false },
        select: { blobKey: true, encryptedName: true },
      });

      if (!file) {
        res.status(404).json({ error: "File not found" });
        return;
      }

      let stream;
      try {
        stream = await downloadBlob(file.blobKey);
      } catch (err) {
        if (err instanceof StorageError) {
          console.error("[files] download from S3 failed:", err.message);
          res.status(502).json({ error: "Failed to retrieve file" });
          return;
        }
        throw err;
      }

      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="encrypted-file"`
      );

      await prisma.auditLog.create({
        data: {
          userId: uid,
          action: "file_download",
          details: { fileId: id },
          ipAddress: req.ip,
        },
      });

      stream.pipe(res);
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /:id/versions ────────────────────────────────────────────────────────

filesRouter.get(
  "/:id/versions",
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const uid = userId(req);
      const { id } = req.params as { id: string };

      const file = await prisma.file.findFirst({
        where: { id, userId: uid },
        select: { id: true },
      });

      if (!file) {
        res.status(404).json({ error: "File not found" });
        return;
      }

      const versions = await prisma.fileVersion.findMany({
        where: { fileId: id },
        orderBy: { version: "desc" },
        select: {
          id: true,
          version: true,
          sizeBytes: true,
          plaintextHash: true,
          ciphertextHash: true,
          createdAt: true,
        },
      });

      res.status(200).json({ versions });
    } catch (err) {
      next(err);
    }
  }
);

// ─── POST /:id/share ──────────────────────────────────────────────────────────

filesRouter.post(
  "/:id/share",
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const uid = userId(req);
      const { id } = req.params as { id: string };

      const body = ShareSchema.safeParse(req.body);
      if (!body.success) {
        res.status(400).json({ error: "Invalid request", issues: body.error.issues });
        return;
      }

      const file = await prisma.file.findFirst({
        where: { id, userId: uid, isDeleted: false },
        select: { id: true },
      });

      if (!file) {
        res.status(404).json({ error: "File not found" });
        return;
      }

      const { wrappedFileKey, accessLevel, expiresAt, maxAccesses, sharedWithEmail } =
        body.data;

      const share = await prisma.fileShare.create({
        data: {
          fileId: id,
          sharedByUserId: uid,
          wrappedFileKey,
          accessLevel,
          expiresAt: expiresAt ? new Date(expiresAt) : null,
          maxAccesses: maxAccesses ?? null,
          sharedWithEmail: sharedWithEmail ?? null,
        },
      });

      await prisma.auditLog.create({
        data: {
          userId: uid,
          action: "file_share_create",
          details: { fileId: id, shareId: share.id, sharedWithEmail: sharedWithEmail ?? null },
          ipAddress: req.ip,
        },
      });

      res.status(201).json({ share });
    } catch (err) {
      next(err);
    }
  }
);

// ─── POST /:id/restore ────────────────────────────────────────────────────────

filesRouter.post(
  "/:id/restore",
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const uid = userId(req);
      const { id } = req.params as { id: string };

      const file = await prisma.file.findFirst({
        where: { id, userId: uid, isDeleted: true },
        select: { id: true },
      });

      if (!file) {
        res.status(404).json({ error: "Deleted file not found" });
        return;
      }

      const restored = await prisma.file.update({
        where: { id },
        data: { isDeleted: false, deletedAt: null },
        select: {
          id: true,
          encryptedName: true,
          isDeleted: true,
          updatedAt: true,
        },
      });

      await prisma.auditLog.create({
        data: {
          userId: uid,
          action: "file_restore",
          details: { fileId: id },
          ipAddress: req.ip,
        },
      });

      res.status(200).json({ file: restored });
    } catch (err) {
      next(err);
    }
  }
);

// ─── DELETE /:id/permanent ────────────────────────────────────────────────────

filesRouter.delete(
  "/:id/permanent",
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const uid = userId(req);
      const { id } = req.params as { id: string };

      // Only allow hard-delete if already soft-deleted
      const file = await prisma.file.findFirst({
        where: { id, userId: uid, isDeleted: true },
        select: { id: true, blobKey: true, sizeBytes: true },
      });

      if (!file) {
        res.status(404).json({
          error: "File not found or not in trash — soft-delete first",
        });
        return;
      }

      // Remove from S3 (best-effort; proceed with DB delete even if S3 fails)
      try {
        await deleteBlob(file.blobKey);
      } catch (err) {
        if (err instanceof StorageError) {
          console.error("[files] S3 delete failed (continuing):", err.message);
        } else {
          throw err;
        }
      }

      // Delete DB record and decrement storageUsed
      await prisma.$transaction([
        prisma.file.delete({ where: { id } }),
        prisma.user.update({
          where: { id: uid },
          data: { storageUsed: { decrement: file.sizeBytes } },
        }),
      ]);

      await prisma.auditLog.create({
        data: {
          userId: uid,
          action: "file_permanent_delete",
          details: { fileId: id },
          ipAddress: req.ip,
        },
      });

      res.status(204).send();
    } catch (err) {
      next(err);
    }
  }
);

// ─── DELETE /:id ──────────────────────────────────────────────────────────────

filesRouter.delete(
  "/:id",
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const uid = userId(req);
      const { id } = req.params as { id: string };

      const file = await prisma.file.findFirst({
        where: { id, userId: uid, isDeleted: false },
        select: { id: true },
      });

      if (!file) {
        res.status(404).json({ error: "File not found" });
        return;
      }

      await prisma.file.update({
        where: { id },
        data: { isDeleted: true, deletedAt: new Date() },
      });

      await prisma.auditLog.create({
        data: {
          userId: uid,
          action: "file_delete",
          details: { fileId: id },
          ipAddress: req.ip,
        },
      });

      res.status(204).send();
    } catch (err) {
      next(err);
    }
  }
);
