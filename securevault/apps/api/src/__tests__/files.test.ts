/**
 * File route integration tests
 *
 * Exercises the full Express request/response cycle via supertest without
 * hitting a real database, S3 bucket, or Redis instance.
 *
 * Mocking strategy:
 *   - @prisma/client  → in-memory mock (vi.mock)
 *   - ../services/storage  → vi.mock (uploadBlob / downloadBlob / deleteBlob)
 *   - ioredis          → lightweight in-memory counter mock
 *   - argon2 / speakeasy / qrcode → stubbed for completeness
 *
 * Auth:
 *   A valid RS256 access token (signed with the test key pair) is attached to
 *   every authenticated request via the Authorization header so that the
 *   authenticate middleware passes.
 */

import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import request from "supertest";
import crypto from "crypto";
import { Readable } from "stream";

// ─── RSA key pair + env setup (must happen before any module imports) ─────────

const { privateKey: TEST_PRIVATE_KEY, publicKey: TEST_PUBLIC_KEY } =
  crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

process.env["JWT_PRIVATE_KEY"] = TEST_PRIVATE_KEY;
process.env["JWT_PUBLIC_KEY"] = TEST_PUBLIC_KEY;
process.env["TOTP_ENCRYPTION_KEY"] = "abcdef01".repeat(8); // 64 hex chars
process.env["REDIS_URL"] = "redis://localhost:6379";
// S3 env vars so storage.ts does not throw on module load
process.env["S3_ACCESS_KEY"] = "test-access-key";
process.env["S3_SECRET_KEY"] = "test-secret-key";
process.env["S3_BUCKET"] = "test-bucket";
process.env["S3_REGION"] = "us-east-1";

// ─── Mock ioredis ─────────────────────────────────────────────────────────────

vi.mock("ioredis", () => {
  const MockRedis = vi.fn().mockImplementation(() => ({
    incr: vi.fn(async () => 1),
    expire: vi.fn(async () => 1),
    ttl: vi.fn(async () => 900),
    ping: vi.fn(async () => "PONG"),
    on: vi.fn(),
  }));
  return { default: MockRedis };
});

// ─── Mock @prisma/client ──────────────────────────────────────────────────────

vi.mock("@prisma/client", () => {
  const mockPrisma = {
    user: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    file: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      count: vi.fn(),
    },
    folder: {
      findFirst: vi.fn(),
    },
    fileShare: {
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    fileVersion: {
      findMany: vi.fn(),
    },
    session: {
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
    },
    auditLog: {
      create: vi.fn(),
    },
    $transaction: vi.fn(),
    $queryRaw: vi.fn(),
  };
  return { PrismaClient: vi.fn(() => mockPrisma) };
});

// ─── Mock storage service ─────────────────────────────────────────────────────

vi.mock("../services/storage.js", () => {
  return {
    uploadBlob: vi.fn(async () => undefined),
    downloadBlob: vi.fn(async () => {
      const r = new Readable();
      r.push(Buffer.from("MOCK_ENCRYPTED_BLOB_CONTENT"));
      r.push(null);
      return r;
    }),
    deleteBlob: vi.fn(async () => undefined),
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

// ─── Mock argon2 ─────────────────────────────────────────────────────────────

vi.mock("argon2", () => ({
  default: {
    hash: vi.fn(async (pw: string) => `hashed:${pw}`),
    verify: vi.fn(async (h: string, pw: string) => h === `hashed:${pw}`),
  },
}));

// ─── Mock speakeasy / qrcode ──────────────────────────────────────────────────

vi.mock("speakeasy", () => ({
  default: {
    generateSecret: vi.fn(() => ({
      base32: "JBSWY3DPEHPK3PXP",
      otpauth_url: "otpauth://totp/test?secret=JBSWY3DPEHPK3PXP",
    })),
    totp: { verify: vi.fn(() => true) },
  },
}));

vi.mock("qrcode", () => ({
  default: { toDataURL: vi.fn(async () => "data:image/png;base64,MOCK") },
}));

// ─── Import app + helpers after all mocks ─────────────────────────────────────

const { app } = await import("../index.js");
import { prisma } from "../lib/prisma.js";
import { signAccessToken } from "../services/encryption.js";
import * as storageModule from "../services/storage.js";

// ─── Typed mock shortcuts ─────────────────────────────────────────────────────

const mockFile = prisma.file as Record<string, ReturnType<typeof vi.fn>>;
const mockUser = prisma.user as Record<string, ReturnType<typeof vi.fn>>;
const mockFolder = prisma.folder as Record<string, ReturnType<typeof vi.fn>>;
const mockShare = prisma.fileShare as Record<string, ReturnType<typeof vi.fn>>;
const mockAudit = prisma.auditLog as Record<string, ReturnType<typeof vi.fn>>;
const mockTx = prisma.$transaction as ReturnType<typeof vi.fn>;

// ─── Test fixtures ────────────────────────────────────────────────────────────

const TEST_USER_ID = "user-files-test-001";
const TEST_FILE_ID = "file-test-uuid-001";
const TEST_BLOB_KEY = `${TEST_USER_ID}/mock-blob-uuid`;

const MOCK_ACCESS_TOKEN = signAccessToken({
  userId: TEST_USER_ID,
  mfaVerified: true,
});

const AUTH_HEADER = `Bearer ${MOCK_ACCESS_TOKEN}`;

const BASE_FILE = {
  id: TEST_FILE_ID,
  userId: TEST_USER_ID,
  encryptedName: "enc-name-b64",
  encryptedMimeType: "enc-mime-b64",
  encryptedSize: "enc-size-b64",
  blobKey: TEST_BLOB_KEY,
  wrappedFileKey: "wrapped-key-b64",
  plaintextHash: "aabbccdd",
  ciphertextHash: "", // filled per-test
  sizeBytes: BigInt(1024),
  version: 1,
  folderId: null,
  isDeleted: false,
  deletedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

// Helper: compute real SHA-256 of a Buffer (mirrors computeHash in integrity.ts)
function sha256Hex(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

// ─── Shared beforeEach ────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockAudit.create.mockResolvedValue({ id: "audit-1" });
});

// ─── POST /api/files/upload ───────────────────────────────────────────────────

describe("POST /api/files/upload", () => {
  const blobContent = Buffer.from("ENCRYPTED_BLOB_DATA_HERE");
  const correctHash = sha256Hex(blobContent);

  const uploadFields = {
    encryptedName: "enc-name-b64",
    encryptedMimeType: "enc-mime-b64",
    encryptedSize: "1024",
    wrappedFileKey: "wrapped-key-b64",
    plaintextHash: "plaintext-hash-stub",
    ciphertextHash: correctHash,
  };

  beforeEach(() => {
    // User has plenty of storage
    mockUser.findUnique.mockResolvedValue({
      id: TEST_USER_ID,
      storageUsed: BigInt(0),
      storageLimit: BigInt(10 * 1024 * 1024 * 1024), // 10 GB
    });
    mockTx.mockResolvedValue([
      { ...BASE_FILE, ciphertextHash: correctHash },
      { id: TEST_USER_ID, storageUsed: BigInt(1024) },
    ]);
  });

  it("returns 201 with file metadata on successful upload", async () => {
    const res = await request(app)
      .post("/api/files/upload")
      .set("Authorization", AUTH_HEADER)
      .attach("encryptedBlob", blobContent, {
        filename: "encrypted.bin",
        contentType: "application/octet-stream",
      })
      .field("encryptedName", uploadFields.encryptedName)
      .field("encryptedMimeType", uploadFields.encryptedMimeType)
      .field("encryptedSize", uploadFields.encryptedSize)
      .field("wrappedFileKey", uploadFields.wrappedFileKey)
      .field("plaintextHash", uploadFields.plaintextHash)
      .field("ciphertextHash", uploadFields.ciphertextHash);

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty("file");
    expect(res.body.file).toHaveProperty("id");
  });

  it("returns 422 when ciphertextHash does not match the uploaded blob", async () => {
    const res = await request(app)
      .post("/api/files/upload")
      .set("Authorization", AUTH_HEADER)
      .attach("encryptedBlob", blobContent, {
        filename: "encrypted.bin",
        contentType: "application/octet-stream",
      })
      .field("encryptedName", uploadFields.encryptedName)
      .field("encryptedMimeType", uploadFields.encryptedMimeType)
      .field("encryptedSize", uploadFields.encryptedSize)
      .field("wrappedFileKey", uploadFields.wrappedFileKey)
      .field("plaintextHash", uploadFields.plaintextHash)
      .field("ciphertextHash", "000000wronghash000000");

    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/ciphertextHash/i);
  });

  it("returns 400 when encryptedBlob field is missing", async () => {
    const res = await request(app)
      .post("/api/files/upload")
      .set("Authorization", AUTH_HEADER)
      .send(uploadFields);

    expect(res.status).toBe(400);
  });

  it("returns 400 when required text fields are missing", async () => {
    const res = await request(app)
      .post("/api/files/upload")
      .set("Authorization", AUTH_HEADER)
      .attach("encryptedBlob", blobContent, {
        filename: "encrypted.bin",
        contentType: "application/octet-stream",
      })
      // omit most required fields
      .field("ciphertextHash", correctHash);

    expect(res.status).toBe(400);
  });

  it("returns 413 when storage limit would be exceeded", async () => {
    mockUser.findUnique.mockResolvedValue({
      id: TEST_USER_ID,
      storageUsed: BigInt(10 * 1024 * 1024 * 1024 - 1), // 1 byte under limit
      storageLimit: BigInt(10 * 1024 * 1024 * 1024),
    });

    const bigBlob = Buffer.alloc(1024, 0x42);
    const bigHash = sha256Hex(bigBlob);

    const res = await request(app)
      .post("/api/files/upload")
      .set("Authorization", AUTH_HEADER)
      .attach("encryptedBlob", bigBlob, {
        filename: "big.bin",
        contentType: "application/octet-stream",
      })
      .field("encryptedName", uploadFields.encryptedName)
      .field("encryptedMimeType", uploadFields.encryptedMimeType)
      .field("encryptedSize", "1024")
      .field("wrappedFileKey", uploadFields.wrappedFileKey)
      .field("plaintextHash", uploadFields.plaintextHash)
      .field("ciphertextHash", bigHash);

    expect(res.status).toBe(413);
    expect(res.body.error).toMatch(/storage limit/i);
  });

  it("returns 401 when no auth token is provided", async () => {
    const res = await request(app)
      .post("/api/files/upload")
      .attach("encryptedBlob", blobContent, {
        filename: "encrypted.bin",
        contentType: "application/octet-stream",
      });

    expect(res.status).toBe(401);
  });
});

// ─── GET /api/files/:id/download ──────────────────────────────────────────────

describe("GET /api/files/:id/download", () => {
  it("returns 200 with the encrypted blob stream for a valid owned file", async () => {
    mockFile.findFirst.mockResolvedValue({
      blobKey: TEST_BLOB_KEY,
      encryptedName: "enc-name-b64",
    });

    const res = await request(app)
      .get(`/api/files/${TEST_FILE_ID}/download`)
      .set("Authorization", AUTH_HEADER);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/octet-stream/);
    expect(res.body).toBeTruthy();
  });

  it("returns 404 when the file does not exist or is soft-deleted", async () => {
    mockFile.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .get(`/api/files/nonexistent-id/download`)
      .set("Authorization", AUTH_HEADER);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("File not found");
  });

  it("returns 502 when S3 download fails", async () => {
    mockFile.findFirst.mockResolvedValue({
      blobKey: TEST_BLOB_KEY,
      encryptedName: "enc-name-b64",
    });

    const { StorageError } = await import("../services/storage.js");
    vi.mocked(storageModule.downloadBlob).mockRejectedValueOnce(
      new (StorageError as unknown as new (msg: string, code: string) => Error)(
        "S3 unavailable",
        "DOWNLOAD_FAILED"
      )
    );

    const res = await request(app)
      .get(`/api/files/${TEST_FILE_ID}/download`)
      .set("Authorization", AUTH_HEADER);

    expect(res.status).toBe(502);
  });

  it("returns 401 when no auth token is provided", async () => {
    const res = await request(app).get(
      `/api/files/${TEST_FILE_ID}/download`
    );
    expect(res.status).toBe(401);
  });
});

// ─── GET /api/files ───────────────────────────────────────────────────────────

describe("GET /api/files (listing with pagination)", () => {
  const mockFiles = [
    { ...BASE_FILE, id: "file-001" },
    { ...BASE_FILE, id: "file-002" },
    { ...BASE_FILE, id: "file-003" },
  ];

  it("returns 200 with files array and pagination metadata", async () => {
    mockTx.mockResolvedValue([mockFiles, 3]);

    const res = await request(app)
      .get("/api/files")
      .set("Authorization", AUTH_HEADER);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.files)).toBe(true);
    expect(res.body.pagination).toMatchObject({
      total: 3,
      page: 1,
      limit: 50,
    });
  });

  it("respects page and limit query parameters", async () => {
    mockTx.mockResolvedValue([[mockFiles[0]], 3]);

    const res = await request(app)
      .get("/api/files?page=2&limit=1")
      .set("Authorization", AUTH_HEADER);

    expect(res.status).toBe(200);
    expect(res.body.pagination).toMatchObject({ page: 2, limit: 1, total: 3, pages: 3 });
  });

  it("returns 400 for invalid pagination parameters", async () => {
    const res = await request(app)
      .get("/api/files?limit=notanumber")
      .set("Authorization", AUTH_HEADER);

    expect(res.status).toBe(400);
  });

  it("returns empty files array when user has no files", async () => {
    mockTx.mockResolvedValue([[], 0]);

    const res = await request(app)
      .get("/api/files")
      .set("Authorization", AUTH_HEADER);

    expect(res.status).toBe(200);
    expect(res.body.files).toHaveLength(0);
    expect(res.body.pagination.total).toBe(0);
  });
});

// ─── Soft delete: DELETE /api/files/:id ──────────────────────────────────────

describe("DELETE /api/files/:id (soft delete)", () => {
  it("returns 204 on successful soft delete", async () => {
    mockFile.findFirst.mockResolvedValue({ id: TEST_FILE_ID });
    mockFile.update.mockResolvedValue({ ...BASE_FILE, isDeleted: true });

    const res = await request(app)
      .delete(`/api/files/${TEST_FILE_ID}`)
      .set("Authorization", AUTH_HEADER);

    expect(res.status).toBe(204);
  });

  it("returns 404 when file does not exist or already deleted", async () => {
    mockFile.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .delete(`/api/files/nonexistent`)
      .set("Authorization", AUTH_HEADER);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("File not found");
  });
});

// ─── Restore: POST /api/files/:id/restore ────────────────────────────────────

describe("POST /api/files/:id/restore", () => {
  it("returns 200 with restored file metadata", async () => {
    mockFile.findFirst.mockResolvedValue({ id: TEST_FILE_ID });
    mockFile.update.mockResolvedValue({
      id: TEST_FILE_ID,
      encryptedName: "enc-name-b64",
      isDeleted: false,
      updatedAt: new Date(),
    });

    const res = await request(app)
      .post(`/api/files/${TEST_FILE_ID}/restore`)
      .set("Authorization", AUTH_HEADER);

    expect(res.status).toBe(200);
    expect(res.body.file.isDeleted).toBe(false);
  });

  it("returns 404 when no deleted file is found for restore", async () => {
    // findFirst with isDeleted:true returns null (file is not soft-deleted)
    mockFile.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/files/notdeleted/restore`)
      .set("Authorization", AUTH_HEADER);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Deleted file not found");
  });
});

// ─── Permanent delete: DELETE /api/files/:id/permanent ───────────────────────

describe("DELETE /api/files/:id/permanent", () => {
  it("returns 204 after permanently deleting a soft-deleted file", async () => {
    mockFile.findFirst.mockResolvedValue({
      id: TEST_FILE_ID,
      blobKey: TEST_BLOB_KEY,
      sizeBytes: BigInt(1024),
    });
    mockTx.mockResolvedValue([undefined, undefined]);

    const res = await request(app)
      .delete(`/api/files/${TEST_FILE_ID}/permanent`)
      .set("Authorization", AUTH_HEADER);

    expect(res.status).toBe(204);
    expect(storageModule.deleteBlob).toHaveBeenCalledWith(TEST_BLOB_KEY);
  });

  it("returns 404 when the file is not in trash (not soft-deleted first)", async () => {
    mockFile.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .delete(`/api/files/active-file/permanent`)
      .set("Authorization", AUTH_HEADER);

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/soft-delete first/i);
  });

  it("proceeds with DB delete even when S3 delete fails", async () => {
    mockFile.findFirst.mockResolvedValue({
      id: TEST_FILE_ID,
      blobKey: TEST_BLOB_KEY,
      sizeBytes: BigInt(1024),
    });
    mockTx.mockResolvedValue([undefined, undefined]);

    const { StorageError } = await import("../services/storage.js");
    vi.mocked(storageModule.deleteBlob).mockRejectedValueOnce(
      new (StorageError as unknown as new (msg: string, code: string) => Error)(
        "S3 delete failed",
        "DELETE_FAILED"
      )
    );

    const res = await request(app)
      .delete(`/api/files/${TEST_FILE_ID}/permanent`)
      .set("Authorization", AUTH_HEADER);

    // Should still succeed — S3 errors are swallowed for hard deletes
    expect(res.status).toBe(204);
  });
});

// ─── File sharing: POST /api/files/:id/share ─────────────────────────────────

describe("POST /api/files/:id/share", () => {
  const sharePayload = {
    wrappedFileKey: "wrapped-share-key-b64",
    accessLevel: "view",
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  };

  it("returns 201 with a share object", async () => {
    mockFile.findFirst.mockResolvedValue({ id: TEST_FILE_ID });
    mockShare.create.mockResolvedValue({
      id: "share-uuid-001",
      fileId: TEST_FILE_ID,
      sharedByUserId: TEST_USER_ID,
      wrappedFileKey: sharePayload.wrappedFileKey,
      accessLevel: "view",
      expiresAt: new Date(sharePayload.expiresAt),
      accessCount: 0,
    });

    const res = await request(app)
      .post(`/api/files/${TEST_FILE_ID}/share`)
      .set("Authorization", AUTH_HEADER)
      .send(sharePayload);

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty("share");
    expect(res.body.share.id).toBe("share-uuid-001");
  });

  it("returns 404 when the file does not exist or is deleted", async () => {
    mockFile.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/files/nonexistent/share`)
      .set("Authorization", AUTH_HEADER)
      .send(sharePayload);

    expect(res.status).toBe(404);
  });

  it("returns 400 when wrappedFileKey is missing", async () => {
    mockFile.findFirst.mockResolvedValue({ id: TEST_FILE_ID });

    const res = await request(app)
      .post(`/api/files/${TEST_FILE_ID}/share`)
      .set("Authorization", AUTH_HEADER)
      .send({ accessLevel: "view" });

    expect(res.status).toBe(400);
  });
});

// ─── Accessing a share link: GET /api/files/shared/:shareId ──────────────────

describe("GET /api/files/shared/:shareId (public share access)", () => {
  const SHARE_ID = "share-access-uuid-001";

  const validShare = {
    id: SHARE_ID,
    fileId: TEST_FILE_ID,
    wrappedFileKey: "wrapped-share-key-b64",
    accessLevel: "view",
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // future
    maxAccesses: null,
    accessCount: 0,
    file: { blobKey: TEST_BLOB_KEY, isDeleted: false },
  };

  it("returns 200 with encrypted blob and X-Wrapped-File-Key header", async () => {
    mockShare.findUnique.mockResolvedValue(validShare);
    mockShare.update.mockResolvedValue({});

    const res = await request(app).get(`/api/files/shared/${SHARE_ID}`);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/octet-stream/);
    expect(res.headers["x-wrapped-file-key"]).toBe("wrapped-share-key-b64");
  });

  it("returns 404 when the share does not exist", async () => {
    mockShare.findUnique.mockResolvedValue(null);

    const res = await request(app).get(`/api/files/shared/nonexistent-share`);

    expect(res.status).toBe(404);
  });

  it("returns 410 when the share link has expired", async () => {
    mockShare.findUnique.mockResolvedValue({
      ...validShare,
      expiresAt: new Date(Date.now() - 1000), // already expired
    });

    const res = await request(app).get(`/api/files/shared/${SHARE_ID}`);

    expect(res.status).toBe(410);
    expect(res.body.error).toMatch(/expired/i);
  });

  it("returns 410 when access count has reached maxAccesses limit", async () => {
    mockShare.findUnique.mockResolvedValue({
      ...validShare,
      maxAccesses: 5,
      accessCount: 5, // limit reached
    });

    const res = await request(app).get(`/api/files/shared/${SHARE_ID}`);

    expect(res.status).toBe(410);
    expect(res.body.error).toMatch(/access limit/i);
  });

  it("increments the accessCount on each valid access", async () => {
    mockShare.findUnique.mockResolvedValue(validShare);
    mockShare.update.mockResolvedValue({});

    await request(app).get(`/api/files/shared/${SHARE_ID}`);

    expect(mockShare.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: SHARE_ID },
        data: { accessCount: { increment: 1 } },
      })
    );
  });
});
