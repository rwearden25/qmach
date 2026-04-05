import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { deleteBlob, StorageError } from "../services/storage.js";

// ─── Router ───────────────────────────────────────────────────────────────────

export const foldersRouter = Router();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function userId(req: Request): string {
  return (req as Request & { userId: string }).userId;
}

// ─── Zod Schemas ──────────────────────────────────────────────────────────────

const CreateFolderSchema = z.object({
  encryptedName: z.string().min(1),
  parentId: z.string().optional(),
});

const UpdateFolderSchema = z.object({
  encryptedName: z.string().min(1),
});

// ─── Tree builder ─────────────────────────────────────────────────────────────

interface FolderNode {
  id: string;
  userId: string;
  parentId: string | null;
  encryptedName: string;
  createdAt: Date;
  updatedAt: Date;
  children: FolderNode[];
  _count: { files: number };
}

function buildTree(
  folders: Array<{
    id: string;
    userId: string;
    parentId: string | null;
    encryptedName: string;
    createdAt: Date;
    updatedAt: Date;
    _count: { files: number; children: number };
  }>,
  parentId: string | null
): FolderNode[] {
  return folders
    .filter((f) => f.parentId === parentId)
    .map((f) => ({
      id: f.id,
      userId: f.userId,
      parentId: f.parentId,
      encryptedName: f.encryptedName,
      createdAt: f.createdAt,
      updatedAt: f.updatedAt,
      _count: { files: f._count.files },
      children: buildTree(folders, f.id),
    }));
}

// ─── Recursive helpers for cascade folder deletion ────────────────────────────

/**
 * Collect all descendant folder IDs (including the root) via BFS.
 */
async function collectDescendantIds(
  rootId: string,
  uid: string
): Promise<string[]> {
  const ids: string[] = [rootId];
  const queue: string[] = [rootId];

  while (queue.length > 0) {
    const currentId = queue.shift()!;
    const children = await prisma.folder.findMany({
      where: { parentId: currentId, userId: uid },
      select: { id: true },
    });
    for (const child of children) {
      ids.push(child.id);
      queue.push(child.id);
    }
  }

  return ids;
}

// ─── POST / ───────────────────────────────────────────────────────────────────

foldersRouter.post(
  "/",
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const uid = userId(req);
      const body = CreateFolderSchema.safeParse(req.body);
      if (!body.success) {
        res.status(400).json({ error: "Invalid request", issues: body.error.issues });
        return;
      }

      const { encryptedName, parentId } = body.data;

      if (parentId) {
        const parent = await prisma.folder.findFirst({
          where: { id: parentId, userId: uid },
          select: { id: true },
        });
        if (!parent) {
          res.status(404).json({ error: "Parent folder not found" });
          return;
        }
      }

      const folder = await prisma.folder.create({
        data: { userId: uid, encryptedName, parentId: parentId ?? null },
        select: {
          id: true,
          userId: true,
          parentId: true,
          encryptedName: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      await prisma.auditLog.create({
        data: {
          userId: uid,
          action: "folder_create",
          details: { folderId: folder.id },
          ipAddress: req.ip,
        },
      });

      res.status(201).json({ folder });
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET / ────────────────────────────────────────────────────────────────────
//
// Returns a tree structure. If parentId is provided, returns that subtree.
// Without parentId returns the full tree from the root.

foldersRouter.get(
  "/",
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const uid = userId(req);
      const parentId = (req.query["parentId"] as string | undefined) ?? null;

      // Fetch all folders belonging to the user so we can build the full tree
      // in one query instead of making N recursive DB calls.
      const allFolders = await prisma.folder.findMany({
        where: { userId: uid },
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          userId: true,
          parentId: true,
          encryptedName: true,
          createdAt: true,
          updatedAt: true,
          _count: { select: { files: true, children: true } },
        },
      });

      const tree = buildTree(allFolders, parentId);

      res.status(200).json({ folders: tree });
    } catch (err) {
      next(err);
    }
  }
);

// ─── PUT /:id ─────────────────────────────────────────────────────────────────

foldersRouter.put(
  "/:id",
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const uid = userId(req);
      const { id } = req.params as { id: string };

      const body = UpdateFolderSchema.safeParse(req.body);
      if (!body.success) {
        res.status(400).json({ error: "Invalid request", issues: body.error.issues });
        return;
      }

      const existing = await prisma.folder.findFirst({
        where: { id, userId: uid },
        select: { id: true },
      });
      if (!existing) {
        res.status(404).json({ error: "Folder not found" });
        return;
      }

      const updated = await prisma.folder.update({
        where: { id },
        data: { encryptedName: body.data.encryptedName },
        select: {
          id: true,
          userId: true,
          parentId: true,
          encryptedName: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      await prisma.auditLog.create({
        data: {
          userId: uid,
          action: "folder_update",
          details: { folderId: id },
          ipAddress: req.ip,
        },
      });

      res.status(200).json({ folder: updated });
    } catch (err) {
      next(err);
    }
  }
);

// ─── DELETE /:id ──────────────────────────────────────────────────────────────
//
// ?force=true  →  cascade delete: removes all descendant folders and files
//              (S3 blobs + DB records + storageUsed adjustment).
// default      →  refuse if folder contains files or subfolders.

foldersRouter.delete(
  "/:id",
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const uid = userId(req);
      const { id } = req.params as { id: string };
      const force = req.query["force"] === "true";

      const folder = await prisma.folder.findFirst({
        where: { id, userId: uid },
        select: { id: true },
      });
      if (!folder) {
        res.status(404).json({ error: "Folder not found" });
        return;
      }

      if (!force) {
        // Check that the folder is empty
        const [fileCount, childCount] = await Promise.all([
          prisma.file.count({ where: { folderId: id, isDeleted: false } }),
          prisma.folder.count({ where: { parentId: id } }),
        ]);

        if (fileCount > 0 || childCount > 0) {
          res.status(409).json({
            error:
              "Folder is not empty. Use ?force=true to cascade-delete its contents.",
          });
          return;
        }

        await prisma.folder.delete({ where: { id } });
      } else {
        // Cascade: collect all descendant folder IDs
        const folderIds = await collectDescendantIds(id, uid);

        // Collect all files within those folders (including soft-deleted)
        const files = await prisma.file.findMany({
          where: { folderId: { in: folderIds }, userId: uid },
          select: { id: true, blobKey: true, sizeBytes: true },
        });

        // Delete S3 blobs (best-effort — continue even if some fail)
        let reclaimBytes = 0n;
        for (const file of files) {
          try {
            await deleteBlob(file.blobKey);
            reclaimBytes += file.sizeBytes;
          } catch (err) {
            if (err instanceof StorageError) {
              console.error(
                `[folders] Failed to delete S3 blob ${file.blobKey}:`,
                err.message
              );
            } else {
              throw err;
            }
          }
        }

        // Delete all descendant folders (cascade on DB will remove files too)
        // Delete files first to avoid FK constraint issues
        await prisma.$transaction([
          prisma.file.deleteMany({
            where: { folderId: { in: folderIds }, userId: uid },
          }),
          prisma.folder.deleteMany({
            where: { id: { in: folderIds }, userId: uid },
          }),
          ...(reclaimBytes > 0n
            ? [
                prisma.user.update({
                  where: { id: uid },
                  data: { storageUsed: { decrement: reclaimBytes } },
                }),
              ]
            : []),
        ]);
      }

      await prisma.auditLog.create({
        data: {
          userId: uid,
          action: "folder_delete",
          details: { folderId: id, force },
          ipAddress: req.ip,
        },
      });

      res.status(204).send();
    } catch (err) {
      next(err);
    }
  }
);
