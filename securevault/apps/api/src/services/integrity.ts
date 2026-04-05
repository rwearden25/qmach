import crypto from "node:crypto";
import type { Readable } from "node:stream";
import { prisma } from "../lib/prisma.js";
import { downloadBlob } from "./storage.js";
import { StorageError } from "./storage.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface IntegrityReport {
  userId: string;
  totalFiles: number;
  passed: number;
  failed: number;
  unchecked: number;
  lastCheckAt: Date | null;
}

// ─── computeHash ─────────────────────────────────────────────────────────────

/**
 * Compute the SHA-256 hash of a Buffer or a Readable stream.
 * Returns the digest as a lowercase hex string.
 */
export async function computeHash(data: Buffer | Readable): Promise<string> {
  const hash = crypto.createHash("sha256");

  if (Buffer.isBuffer(data)) {
    hash.update(data);
    return hash.digest("hex");
  }

  // Readable stream: process chunk by chunk to avoid loading everything into RAM
  return new Promise<string>((resolve, reject) => {
    data.on("data", (chunk: Buffer | string) => hash.update(chunk));
    data.on("end", () => resolve(hash.digest("hex")));
    data.on("error", (err) => reject(err));
  });
}

// ─── verifyBlobIntegrity ──────────────────────────────────────────────────────

/**
 * Download the S3 blob for the given file, compute its SHA-256 hash, compare
 * it with the `ciphertextHash` stored in the database, and persist an
 * IntegrityCheck record.
 *
 * Returns the persisted IntegrityCheck record.
 */
export async function verifyBlobIntegrity(fileId: string) {
  const file = await prisma.file.findUnique({
    where: { id: fileId },
    select: { id: true, blobKey: true, ciphertextHash: true },
  });

  if (!file) {
    throw new Error(`File not found: ${fileId}`);
  }

  let actualHash: string | null = null;
  let status: "passed" | "failed" | "error" = "error";

  try {
    const stream = await downloadBlob(file.blobKey);
    actualHash = await computeHash(stream);
    status = actualHash === file.ciphertextHash ? "passed" : "failed";
  } catch (err) {
    // Blob could not be retrieved — treat as an error status, not a hash mismatch.
    const message = err instanceof StorageError ? err.message : String(err);
    console.error(`[integrity] Error downloading blob for file ${fileId}: ${message}`);
    status = "error";
  }

  const check = await prisma.integrityCheck.create({
    data: {
      fileId: file.id,
      status,
      expectedHash: file.ciphertextHash,
      actualHash: actualHash ?? undefined,
    },
  });

  if (status === "failed") {
    console.warn(
      `[integrity] HASH MISMATCH for file ${fileId} — expected ${file.ciphertextHash}, got ${actualHash}`
    );
  }

  return check;
}

// ─── runIntegrityBatch ────────────────────────────────────────────────────────

/**
 * Find the `batchSize` files whose most-recent integrity check is oldest (or
 * that have never been checked), then verify each one.
 *
 * Returns a summary of the batch: { checked, passed, failed, errors }.
 */
export async function runIntegrityBatch(batchSize: number): Promise<{
  checked: number;
  passed: number;
  failed: number;
  errors: number;
}> {
  // Subquery: find files not soft-deleted, ordered by the date of their most
  // recent integrity check (nulls first = never-checked files come first).
  const files = await prisma.file.findMany({
    where: { isDeleted: false },
    select: {
      id: true,
      integrityChecks: {
        orderBy: { checkedAt: "desc" },
        take: 1,
        select: { checkedAt: true },
      },
    },
    orderBy: {
      createdAt: "asc",
    },
    take: batchSize * 3, // over-fetch so we can sort by last-check time in JS
  });

  // Sort so never-checked files come first, then oldest-check-first.
  type FileItem = (typeof files)[number];
  files.sort((a: FileItem, b: FileItem) => {
    const aTime = a.integrityChecks[0]?.checkedAt?.getTime() ?? 0;
    const bTime = b.integrityChecks[0]?.checkedAt?.getTime() ?? 0;
    return aTime - bTime;
  });

  const batch = files.slice(0, batchSize);

  let passed = 0;
  let failed = 0;
  let errors = 0;

  for (const file of batch) {
    try {
      const result = await verifyBlobIntegrity(file.id);
      if (result.status === "passed") passed++;
      else if (result.status === "failed") failed++;
      else errors++;
    } catch {
      errors++;
      console.error(`[integrity] Unhandled error verifying file ${file.id}`);
    }
  }

  console.log(
    `[integrity] Batch complete — checked: ${batch.length}, passed: ${passed}, failed: ${failed}, errors: ${errors}`
  );

  return { checked: batch.length, passed, failed, errors };
}

// ─── getIntegrityReport ───────────────────────────────────────────────────────

/**
 * Return a high-level integrity summary for all files owned by `userId`.
 */
export async function getIntegrityReport(userId: string): Promise<IntegrityReport> {
  const files = await prisma.file.findMany({
    where: { userId, isDeleted: false },
    select: {
      id: true,
      integrityChecks: {
        orderBy: { checkedAt: "desc" },
        take: 1,
        select: { status: true, checkedAt: true },
      },
    },
  });

  let passed = 0;
  let failed = 0;
  let unchecked = 0;
  let lastCheckAt: Date | null = null;

  for (const file of files) {
    const latest = file.integrityChecks[0];
    if (!latest) {
      unchecked++;
    } else {
      if (latest.status === "passed") passed++;
      else failed++; // counts "failed" and "error"
      if (!lastCheckAt || latest.checkedAt > lastCheckAt) {
        lastCheckAt = latest.checkedAt;
      }
    }
  }

  return {
    userId,
    totalFiles: files.length,
    passed,
    failed,
    unchecked,
    lastCheckAt,
  };
}
