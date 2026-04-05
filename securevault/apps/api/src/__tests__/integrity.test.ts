/**
 * Integrity service unit tests
 *
 * Tests computeHash, verifyBlobIntegrity, and runIntegrityBatch.
 *
 * All external I/O (Prisma, S3 / storage) is mocked so tests run fully
 * in-process without any network calls.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import crypto from "crypto";
import { Readable } from "stream";

// ─── Env stubs required by transitive imports ─────────────────────────────────

process.env["JWT_PRIVATE_KEY"] = "PLACEHOLDER";
process.env["JWT_PUBLIC_KEY"] = "PLACEHOLDER";
process.env["TOTP_ENCRYPTION_KEY"] = "aa".repeat(32);
process.env["S3_ACCESS_KEY"] = "test";
process.env["S3_SECRET_KEY"] = "test";
process.env["S3_BUCKET"] = "test-bucket";

// ─── Mock @prisma/client ──────────────────────────────────────────────────────

vi.mock("@prisma/client", () => {
  const mockPrisma = {
    file: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
    },
    integrityCheck: {
      create: vi.fn(),
    },
  };
  return { PrismaClient: vi.fn(() => mockPrisma) };
});

// ─── Mock storage service ─────────────────────────────────────────────────────

vi.mock("../services/storage.js", () => {
  return {
    downloadBlob: vi.fn(),
    StorageError: class StorageError extends Error {
      code: string;
      constructor(message: string, code: string) {
        super(message);
        this.name = "StorageError";
        this.code = code;
      }
    },
  };
});

// ─── Import modules under test ────────────────────────────────────────────────

import {
  computeHash,
  verifyBlobIntegrity,
  runIntegrityBatch,
} from "../services/integrity.js";
import { prisma } from "../lib/prisma.js";
import * as storageModule from "../services/storage.js";

// ─── Typed mock helpers ───────────────────────────────────────────────────────

const mockFileDb = prisma.file as {
  findUnique: ReturnType<typeof vi.fn>;
  findMany: ReturnType<typeof vi.fn>;
};
const mockIntegrityCheck = prisma.integrityCheck as {
  create: ReturnType<typeof vi.fn>;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Compute expected SHA-256 hash using Node's built-in crypto (reference impl) */
function referenceHash(data: Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function makeReadable(data: Buffer): Readable {
  const r = new Readable();
  r.push(data);
  r.push(null);
  return r;
}

// ─── computeHash ─────────────────────────────────────────────────────────────

describe("computeHash", () => {
  it("computes the correct SHA-256 hash of a Buffer", async () => {
    const data = Buffer.from("Hello, SecureVault!");
    const hash = await computeHash(data);
    const expected = referenceHash(data);
    expect(hash).toBe(expected);
  });

  it("computes the correct SHA-256 hash of a Readable stream", async () => {
    const data = Buffer.from("Streaming data integrity test");
    const stream = makeReadable(data);
    const hash = await computeHash(stream);
    const expected = referenceHash(data);
    expect(hash).toBe(expected);
  });

  it("returns the same hash for the same input Buffer every time", async () => {
    const data = Buffer.from("Deterministic input");
    const hash1 = await computeHash(data);
    const hash2 = await computeHash(data);
    expect(hash1).toBe(hash2);
  });

  it("returns different hashes for different inputs", async () => {
    const hash1 = await computeHash(Buffer.from("input-A"));
    const hash2 = await computeHash(Buffer.from("input-B"));
    expect(hash1).not.toBe(hash2);
  });

  it("returns a lowercase 64-character hex string", async () => {
    const hash = await computeHash(Buffer.from("test"));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("handles an empty Buffer", async () => {
    const hash = await computeHash(Buffer.alloc(0));
    // SHA-256("") = e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
    expect(hash).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
  });

  it("handles large buffers (> 1 MiB)", async () => {
    const large = crypto.randomBytes(2 * 1024 * 1024);
    const hash = await computeHash(large);
    const expected = referenceHash(large);
    expect(hash).toBe(expected);
  });

  it("computes the same hash for a Buffer and an equivalent Readable stream", async () => {
    const data = Buffer.from("Consistency across input types");
    const bufHash = await computeHash(data);
    const streamHash = await computeHash(makeReadable(data));
    expect(bufHash).toBe(streamHash);
  });
});

// ─── verifyBlobIntegrity ──────────────────────────────────────────────────────

describe("verifyBlobIntegrity", () => {
  const FILE_ID = "file-integrity-test-001";
  const BLOB_KEY = "user-001/blob-key";
  const blobData = Buffer.from("THE_ENCRYPTED_FILE_CONTENT");
  const correctHash = referenceHash(blobData);

  beforeEach(() => {
    vi.clearAllMocks();
    mockIntegrityCheck.create.mockResolvedValue({
      id: "check-001",
      fileId: FILE_ID,
      status: "passed",
      expectedHash: correctHash,
      actualHash: correctHash,
      checkedAt: new Date(),
    });
  });

  it("creates a 'passed' IntegrityCheck when hashes match", async () => {
    mockFileDb.findUnique.mockResolvedValue({
      id: FILE_ID,
      blobKey: BLOB_KEY,
      ciphertextHash: correctHash,
    });

    vi.mocked(storageModule.downloadBlob).mockResolvedValue(
      makeReadable(blobData)
    );

    const result = await verifyBlobIntegrity(FILE_ID);

    expect(result.status).toBe("passed");
    expect(mockIntegrityCheck.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          fileId: FILE_ID,
          status: "passed",
          expectedHash: correctHash,
        }),
      })
    );
  });

  it("creates a 'failed' IntegrityCheck when hashes do not match", async () => {
    const wrongHash = "0".repeat(64);

    mockFileDb.findUnique.mockResolvedValue({
      id: FILE_ID,
      blobKey: BLOB_KEY,
      ciphertextHash: wrongHash, // stored hash is wrong
    });

    vi.mocked(storageModule.downloadBlob).mockResolvedValue(
      makeReadable(blobData) // actual blob produces correctHash
    );

    mockIntegrityCheck.create.mockResolvedValue({
      id: "check-002",
      fileId: FILE_ID,
      status: "failed",
      expectedHash: wrongHash,
      actualHash: correctHash,
      checkedAt: new Date(),
    });

    const result = await verifyBlobIntegrity(FILE_ID);

    expect(result.status).toBe("failed");
    expect(mockIntegrityCheck.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "failed",
        }),
      })
    );
  });

  it("creates an 'error' IntegrityCheck when the blob cannot be downloaded", async () => {
    mockFileDb.findUnique.mockResolvedValue({
      id: FILE_ID,
      blobKey: BLOB_KEY,
      ciphertextHash: correctHash,
    });

    const { StorageError } = await import("../services/storage.js");
    vi.mocked(storageModule.downloadBlob).mockRejectedValue(
      new (StorageError as unknown as new (msg: string, code: string) => Error)(
        "Blob not found",
        "DOWNLOAD_FAILED"
      )
    );

    mockIntegrityCheck.create.mockResolvedValue({
      id: "check-003",
      fileId: FILE_ID,
      status: "error",
      expectedHash: correctHash,
      actualHash: null,
      checkedAt: new Date(),
    });

    const result = await verifyBlobIntegrity(FILE_ID);
    expect(result.status).toBe("error");
  });

  it("throws when the file record does not exist in the database", async () => {
    mockFileDb.findUnique.mockResolvedValue(null);

    await expect(verifyBlobIntegrity("nonexistent-file-id")).rejects.toThrow(
      /file not found/i
    );
  });
});

// ─── runIntegrityBatch ────────────────────────────────────────────────────────

describe("runIntegrityBatch", () => {
  const blobData = Buffer.from("BATCH_TEST_BLOB");
  const correctHash = referenceHash(blobData);

  function makeFileRecord(id: string, lastCheckedAt?: Date) {
    return {
      id,
      integrityChecks: lastCheckedAt
        ? [{ checkedAt: lastCheckedAt }]
        : [],
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns zero counts for an empty file list", async () => {
    mockFileDb.findMany.mockResolvedValue([]);

    const result = await runIntegrityBatch(10);

    expect(result.checked).toBe(0);
    expect(result.passed).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.errors).toBe(0);
  });

  it("processes up to batchSize files per call", async () => {
    // Provide 10 files but request a batch of 3
    const files = Array.from({ length: 10 }, (_, i) =>
      makeFileRecord(`file-${i}`)
    );
    mockFileDb.findMany.mockResolvedValue(files);

    // Make each individual file lookup succeed
    mockFileDb.findUnique.mockImplementation(({ where }: { where: { id: string } }) =>
      Promise.resolve({ id: where.id, blobKey: `key/${where.id}`, ciphertextHash: correctHash })
    );

    vi.mocked(storageModule.downloadBlob).mockResolvedValue(
      makeReadable(blobData)
    );

    mockIntegrityCheck.create.mockResolvedValue({
      id: "check-batch",
      fileId: "file-0",
      status: "passed",
      checkedAt: new Date(),
    });

    const result = await runIntegrityBatch(3);

    expect(result.checked).toBe(3);
    expect(result.passed).toBe(3);
  });

  it("prioritises never-checked files over recently-checked ones", async () => {
    const recentlyChecked = makeFileRecord("file-recent", new Date());
    const neverChecked = makeFileRecord("file-never"); // no checks array entry

    // findMany returns recently-checked first (as if DB returned them that way)
    mockFileDb.findMany.mockResolvedValue([recentlyChecked, neverChecked]);

    const processedIds: string[] = [];

    // Capture which file IDs are actually looked up (verifyBlobIntegrity calls findUnique)
    mockFileDb.findUnique.mockImplementation(({ where }: { where: { id: string } }) => {
      processedIds.push(where.id);
      return Promise.resolve({
        id: where.id,
        blobKey: `key/${where.id}`,
        ciphertextHash: correctHash,
      });
    });

    vi.mocked(storageModule.downloadBlob).mockResolvedValue(
      makeReadable(blobData)
    );
    mockIntegrityCheck.create.mockResolvedValue({
      id: "check-x",
      fileId: "x",
      status: "passed",
      checkedAt: new Date(),
    });

    await runIntegrityBatch(1);

    // The never-checked file should have been processed first
    expect(processedIds[0]).toBe("file-never");
  });

  it("counts passed, failed, and error results correctly", async () => {
    const files = [
      makeFileRecord("file-pass"),
      makeFileRecord("file-fail"),
      makeFileRecord("file-err"),
    ];
    mockFileDb.findMany.mockResolvedValue(files);

    const { StorageError } = await import("../services/storage.js");

    mockFileDb.findUnique.mockImplementation(({ where }: { where: { id: string } }) => {
      if (where.id === "file-pass") {
        return Promise.resolve({ id: where.id, blobKey: "k1", ciphertextHash: correctHash });
      }
      if (where.id === "file-fail") {
        return Promise.resolve({ id: where.id, blobKey: "k2", ciphertextHash: "wronghash" });
      }
      return Promise.resolve({ id: where.id, blobKey: "k3", ciphertextHash: correctHash });
    });

    vi.mocked(storageModule.downloadBlob).mockImplementation(async (key: string) => {
      if (key === "k3") {
        throw new (StorageError as unknown as new (msg: string, code: string) => Error)(
          "S3 error",
          "DOWNLOAD_FAILED"
        );
      }
      return makeReadable(blobData);
    });

    mockIntegrityCheck.create.mockImplementation(
      ({ data }: { data: { status: string; fileId: string } }) =>
        Promise.resolve({ id: "c", ...data, checkedAt: new Date() })
    );

    const result = await runIntegrityBatch(3);

    expect(result.checked).toBe(3);
    expect(result.passed).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.errors).toBe(1);
  });

  it("does not throw when an individual file check throws an unhandled error", async () => {
    mockFileDb.findMany.mockResolvedValue([makeFileRecord("file-boom")]);

    // findUnique throws unexpectedly
    mockFileDb.findUnique.mockRejectedValue(new Error("Unexpected DB error"));

    const result = await runIntegrityBatch(1);

    expect(result.checked).toBe(1);
    expect(result.errors).toBe(1);
    expect(result.passed).toBe(0);
  });
});
