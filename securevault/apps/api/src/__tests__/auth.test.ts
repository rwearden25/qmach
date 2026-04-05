/**
 * Auth integration tests
 *
 * All external I/O (Prisma, Redis, argon2, speakeasy) is mocked so the tests
 * run without a real database, Redis instance, or file-system keys.
 *
 * JWT signing requires RSA key material; we generate a throwaway key pair
 * once for the whole suite and inject it via process.env.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import request from "supertest";
import crypto from "crypto";

// ─── Generate a throwaway RSA-2048 key pair for JWT signing ──────────────────

function generateTestKeyPair() {
  return crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
}

const { privateKey: TEST_PRIVATE_KEY, publicKey: TEST_PUBLIC_KEY } =
  generateTestKeyPair();

// ─── Environment setup (must happen before module imports) ───────────────────

process.env["JWT_PRIVATE_KEY"] = TEST_PRIVATE_KEY;
process.env["JWT_PUBLIC_KEY"] = TEST_PUBLIC_KEY;
process.env["TOTP_ENCRYPTION_KEY"] = "a".repeat(64); // 64 hex chars = 32 bytes
// Prevent redis.ts from throwing on import
process.env["REDIS_URL"] = "redis://localhost:6379";

// ─── Mock ioredis before the app is loaded ───────────────────────────────────

vi.mock("ioredis", () => {
  const counters: Record<string, number> = {};
  const ttls: Record<string, number> = {};

  const MockRedis = vi.fn().mockImplementation(() => ({
    incr: vi.fn(async (key: string) => {
      counters[key] = (counters[key] ?? 0) + 1;
      return counters[key];
    }),
    expire: vi.fn(async (key: string, seconds: number) => {
      ttls[key] = seconds;
      return 1;
    }),
    ttl: vi.fn(async (key: string) => ttls[key] ?? -1),
    ping: vi.fn(async () => "PONG"),
    on: vi.fn(),
    // Expose reset helper for test setup
    _reset: () => {
      for (const k of Object.keys(counters)) delete counters[k];
      for (const k of Object.keys(ttls)) delete ttls[k];
    },
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
    $queryRaw: vi.fn(),
  };

  return {
    PrismaClient: vi.fn(() => mockPrisma),
  };
});

// ─── Import app after mocks are in place ─────────────────────────────────────

// We import the Express app lazily so mocks are already registered.
// Using a dynamic import inside each test file keeps mock injection reliable.
const { app } = await import("../index.js");

// Helper: reach the prisma singleton the app created
import { prisma } from "../lib/prisma.js";
import {
  signAccessToken,
  generateMFAChallengeToken,
  signRefreshToken,
} from "../services/encryption.js";

// ─── Typed mock helpers ───────────────────────────────────────────────────────

const mockPrismaUser = prisma.user as {
  findUnique: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
};
const mockPrismaSession = prisma.session as {
  create: ReturnType<typeof vi.fn>;
  findUnique: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  deleteMany: ReturnType<typeof vi.fn>;
};
const mockPrismaAuditLog = prisma.auditLog as {
  create: ReturnType<typeof vi.fn>;
};

// ─── Test data ────────────────────────────────────────────────────────────────

const TEST_USER_ID = "user-test-uuid-001";
const TEST_EMAIL = "alice@example.com";
const TEST_PASSWORD = "SuperSecret123!";
const TEST_WRAPPED_MASTER_KEY = "dGVzdC13cmFwcGVkLWtleS1iYXNlNjQ=";

// Pre-hashed password produced by argon2 for TEST_PASSWORD.
// In tests we will mock argon2.verify to return true/false based on the
// password passed, avoiding the heavy hashing cost.
const ARGON2_PLACEHOLDER_HASH = "$argon2id$v=19$m=65536,t=3,p=4$placeholder";

// ─── Mock argon2 ─────────────────────────────────────────────────────────────

vi.mock("argon2", () => ({
  default: {
    hash: vi.fn(async (password: string) => `hashed:${password}`),
    verify: vi.fn(async (hash: string, password: string) => {
      // Simulate: hash was produced from TEST_PASSWORD
      return hash === `hashed:${password}` || hash === ARGON2_PLACEHOLDER_HASH;
    }),
  },
}));

// ─── Mock speakeasy / mfa service ────────────────────────────────────────────

vi.mock("speakeasy", () => ({
  default: {
    generateSecret: vi.fn(() => ({
      base32: "JBSWY3DPEHPK3PXP",
      otpauth_url:
        "otpauth://totp/SecureVault%20(alice%40example.com)?secret=JBSWY3DPEHPK3PXP&issuer=SecureVault",
    })),
    totp: {
      verify: vi.fn(() => true),
    },
  },
}));

vi.mock("qrcode", () => ({
  default: {
    toDataURL: vi.fn(async () => "data:image/png;base64,MOCK_QR_CODE"),
  },
}));

// ─── Shared beforeEach ────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockPrismaAuditLog.create.mockResolvedValue({ id: "audit-1" });
});

// ─── POST /api/auth/register ──────────────────────────────────────────────────

describe("POST /api/auth/register", () => {
  it("returns 201 with mfaSecret, qrCode, and backupCodes on valid registration", async () => {
    mockPrismaUser.findUnique.mockResolvedValue(null); // no existing user
    mockPrismaUser.create.mockResolvedValue({
      id: TEST_USER_ID,
      email: TEST_EMAIL,
      createdAt: new Date(),
    });

    const res = await request(app)
      .post("/api/auth/register")
      .send({
        email: TEST_EMAIL,
        password: TEST_PASSWORD,
        wrappedMasterKey: TEST_WRAPPED_MASTER_KEY,
      });

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty("mfaSecret");
    expect(res.body).toHaveProperty("qrCode");
    expect(res.body).toHaveProperty("backupCodes");
    expect(Array.isArray(res.body.backupCodes)).toBe(true);
    expect(res.body.backupCodes).toHaveLength(10);
    expect(res.body).toHaveProperty("recoveryKey");
    // Recovery key is 64 hex chars (32 bytes)
    expect(typeof res.body.recoveryKey).toBe("string");
    expect(res.body.recoveryKey).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns 409 when email is already registered", async () => {
    mockPrismaUser.findUnique.mockResolvedValue({
      id: "existing-user",
      email: TEST_EMAIL,
    });

    const res = await request(app)
      .post("/api/auth/register")
      .send({
        email: TEST_EMAIL,
        password: TEST_PASSWORD,
        wrappedMasterKey: TEST_WRAPPED_MASTER_KEY,
      });

    expect(res.status).toBe(409);
    expect(res.body).toHaveProperty("error");
  });

  it("returns 400 when email is missing", async () => {
    const res = await request(app)
      .post("/api/auth/register")
      .send({ password: TEST_PASSWORD, wrappedMasterKey: TEST_WRAPPED_MASTER_KEY });

    expect(res.status).toBe(400);
  });

  it("returns 400 when password is shorter than 12 characters", async () => {
    const res = await request(app)
      .post("/api/auth/register")
      .send({
        email: TEST_EMAIL,
        password: "short",
        wrappedMasterKey: TEST_WRAPPED_MASTER_KEY,
      });

    expect(res.status).toBe(400);
  });

  it("returns 400 when email format is invalid", async () => {
    const res = await request(app)
      .post("/api/auth/register")
      .send({
        email: "not-an-email",
        password: TEST_PASSWORD,
        wrappedMasterKey: TEST_WRAPPED_MASTER_KEY,
      });

    expect(res.status).toBe(400);
  });

  it("returns 400 when wrappedMasterKey is missing", async () => {
    const res = await request(app)
      .post("/api/auth/register")
      .send({ email: TEST_EMAIL, password: TEST_PASSWORD });

    expect(res.status).toBe(400);
  });
});

// ─── POST /api/auth/login ─────────────────────────────────────────────────────

describe("POST /api/auth/login", () => {
  const existingUser = {
    id: TEST_USER_ID,
    email: TEST_EMAIL,
    passwordHash: `hashed:${TEST_PASSWORD}`,
    mfaEnabled: true,
  };

  it("returns 200 with challengeToken and mfaRequired=true on valid credentials", async () => {
    mockPrismaUser.findUnique.mockResolvedValue(existingUser);

    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: TEST_EMAIL, password: TEST_PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("challengeToken");
    expect(typeof res.body.challengeToken).toBe("string");
    expect(res.body.mfaRequired).toBe(true);
  });

  it("returns 401 with 'Invalid credentials' for wrong password (not 'user not found')", async () => {
    mockPrismaUser.findUnique.mockResolvedValue(existingUser);

    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: TEST_EMAIL, password: "WrongPassword123!" });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Invalid credentials");
    // Must never leak user existence
    expect(res.body.error).not.toMatch(/not found/i);
  });

  it("returns 401 with 'Invalid credentials' when user does not exist", async () => {
    mockPrismaUser.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "ghost@example.com", password: TEST_PASSWORD });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Invalid credentials");
    // Same error message regardless — prevents user enumeration
    expect(res.body.error).not.toMatch(/not found/i);
  });

  it("returns 400 when email is missing", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ password: TEST_PASSWORD });

    expect(res.status).toBe(400);
  });

  it("returns 400 when password is missing", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: TEST_EMAIL });

    expect(res.status).toBe(400);
  });
});

// ─── POST /api/auth/mfa-verify ────────────────────────────────────────────────

describe("POST /api/auth/mfa-verify", () => {
  const encryptedTotpSecret =
    // iv:ciphertext:authTag — all zeroes is fine for mocked decrypt
    "000000000000000000000000:deadbeef:00000000000000000000000000000000";

  const existingUser = {
    id: TEST_USER_ID,
    email: TEST_EMAIL,
    mfaEnabled: true,
    totpSecret: encryptedTotpSecret,
    backupCodes: [],
  };

  it("returns 200 with accessToken on valid challenge token + valid TOTP code", async () => {
    const challengeToken = generateMFAChallengeToken(TEST_USER_ID);

    mockPrismaUser.findUnique.mockResolvedValue(existingUser);
    mockPrismaSession.create.mockResolvedValue({
      id: "session-001",
      userId: TEST_USER_ID,
      refreshToken: crypto.randomUUID(),
      mfaVerified: true,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });
    mockPrismaSession.update.mockResolvedValue({});

    const res = await request(app)
      .post("/api/auth/mfa-verify")
      .send({ challengeToken, code: "123456" }); // speakeasy.totp.verify is mocked to return true

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("accessToken");
    expect(res.body).toHaveProperty("user");
    expect(res.body.user.id).toBe(TEST_USER_ID);
  });

  it("returns 401 when challenge token is invalid", async () => {
    const res = await request(app)
      .post("/api/auth/mfa-verify")
      .send({ challengeToken: "totally.invalid.token", code: "123456" });

    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty("error");
  });

  it("returns 401 when TOTP code is wrong", async () => {
    // Override speakeasy mock to return false for this test
    const speakeasy = await import("speakeasy");
    vi.spyOn(speakeasy.default.totp, "verify").mockReturnValueOnce(false);

    const challengeToken = generateMFAChallengeToken(TEST_USER_ID);
    mockPrismaUser.findUnique.mockResolvedValue(existingUser);

    const res = await request(app)
      .post("/api/auth/mfa-verify")
      .send({ challengeToken, code: "000000" });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Invalid MFA code");
  });

  it("returns 401 when challenge token uses wrong JWT type", async () => {
    // A valid access token should be rejected as a challenge token
    const accessToken = signAccessToken({ userId: TEST_USER_ID, mfaVerified: true });

    const res = await request(app)
      .post("/api/auth/mfa-verify")
      .send({ challengeToken: accessToken, code: "123456" });

    expect(res.status).toBe(401);
  });

  it("accepts a valid 8-char backup code when TOTP fails", async () => {
    const { hashBackupCode } = await import("../services/mfa.js");

    const plainCode = "ABCDEFGH";
    const hash = await hashBackupCode(plainCode);

    const challengeToken = generateMFAChallengeToken(TEST_USER_ID);

    mockPrismaUser.findUnique.mockResolvedValue({
      ...existingUser,
      totpSecret: null, // no TOTP; force backup code path
      backupCodes: [hash],
    });
    mockPrismaUser.update.mockResolvedValue({});
    mockPrismaSession.create.mockResolvedValue({
      id: "session-002",
      userId: TEST_USER_ID,
      refreshToken: crypto.randomUUID(),
      mfaVerified: true,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });
    mockPrismaSession.update.mockResolvedValue({});

    const res = await request(app)
      .post("/api/auth/mfa-verify")
      .send({ challengeToken, code: plainCode });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("accessToken");
  });
});

// ─── POST /api/auth/refresh ───────────────────────────────────────────────────

describe("POST /api/auth/refresh", () => {
  const SESSION_ID = "session-refresh-001";

  function buildValidRefreshToken(): string {
    return signRefreshToken({ userId: TEST_USER_ID, sessionId: SESSION_ID });
  }

  it("returns 200 with a new accessToken when a valid refresh cookie is provided", async () => {
    const refreshToken = buildValidRefreshToken();

    mockPrismaSession.findUnique.mockResolvedValue({
      id: SESSION_ID,
      userId: TEST_USER_ID,
      refreshToken,
      deviceInfo: "Mozilla/5.0",
      mfaVerified: true,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });
    mockPrismaSession.delete.mockResolvedValue({});
    mockPrismaSession.create.mockResolvedValue({
      id: "session-refresh-002",
      userId: TEST_USER_ID,
      refreshToken: crypto.randomUUID(),
      mfaVerified: true,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });
    mockPrismaSession.update.mockResolvedValue({});

    const res = await request(app)
      .post("/api/auth/refresh")
      .set("Cookie", [`refreshToken=${refreshToken}`]);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("accessToken");
    expect(typeof res.body.accessToken).toBe("string");
  });

  it("returns 401 when no refresh cookie is present", async () => {
    const res = await request(app).post("/api/auth/refresh");

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("No refresh token provided");
  });

  it("returns 401 when refresh cookie is a malformed token", async () => {
    const res = await request(app)
      .post("/api/auth/refresh")
      .set("Cookie", ["refreshToken=this.is.garbage"]);

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Invalid refresh token");
  });

  it("detects refresh token reuse and revokes all sessions", async () => {
    // Simulate reuse: session no longer exists in DB (already rotated / deleted)
    const refreshToken = buildValidRefreshToken();

    mockPrismaSession.findUnique.mockResolvedValue(null); // session gone
    mockPrismaSession.deleteMany.mockResolvedValue({ count: 3 });

    const res = await request(app)
      .post("/api/auth/refresh")
      .set("Cookie", [`refreshToken=${refreshToken}`]);

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/reuse detected/i);

    // All sessions for the user must have been deleted
    expect(mockPrismaSession.deleteMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ userId: TEST_USER_ID }) })
    );
  });

  it("returns 401 when the session has expired", async () => {
    const refreshToken = buildValidRefreshToken();

    mockPrismaSession.findUnique.mockResolvedValue({
      id: SESSION_ID,
      userId: TEST_USER_ID,
      refreshToken,
      mfaVerified: true,
      expiresAt: new Date(Date.now() - 1000), // already expired
    });
    mockPrismaSession.delete.mockResolvedValue({});

    const res = await request(app)
      .post("/api/auth/refresh")
      .set("Cookie", [`refreshToken=${refreshToken}`]);

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/session expired/i);
  });
});

// ─── Rate limiting ────────────────────────────────────────────────────────────

describe("Rate limiting on POST /api/auth/login", () => {
  it("allows up to 5 requests and rate-limits the 6th", async () => {
    // Mock a non-existent user so requests resolve quickly
    mockPrismaUser.findUnique.mockResolvedValue(null);

    const responses: number[] = [];

    for (let i = 0; i < 6; i++) {
      const res = await request(app)
        .post("/api/auth/login")
        .send({ email: "ratelimit@example.com", password: "Password12345!" });
      responses.push(res.status);
    }

    // First 5 should complete (401 = wrong creds, not rate limited)
    for (const status of responses.slice(0, 5)) {
      expect([200, 400, 401]).toContain(status);
    }

    // 6th request should be rate limited
    expect(responses[5]).toBe(429);
  });
});
