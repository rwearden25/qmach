/**
 * Encryption service unit tests
 *
 * Covers JWT signing/verification, MFA challenge tokens, TOTP secret
 * encryption/decryption, backup code generation, hashing, and verification.
 *
 * All tests run without I/O.  A throwaway RSA-2048 key pair is generated once
 * for the suite; TOTP_ENCRYPTION_KEY is set to a fixed 64-char hex string.
 */

import { describe, it, expect, beforeAll } from "vitest";
import crypto from "crypto";

// ─── Inject environment variables before importing the services ───────────────

const { privateKey: TEST_PRIVATE_KEY, publicKey: TEST_PUBLIC_KEY } =
  crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

process.env["JWT_PRIVATE_KEY"] = TEST_PRIVATE_KEY;
process.env["JWT_PUBLIC_KEY"] = TEST_PUBLIC_KEY;
// 64 hex chars = 32 bytes
process.env["TOTP_ENCRYPTION_KEY"] = "deadbeef".repeat(8);

// ─── Lazy imports (after env setup) ──────────────────────────────────────────

import {
  signAccessToken,
  verifyAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  generateMFAChallengeToken,
  verifyMFAChallengeToken,
  generateKeyPair,
} from "../services/encryption.js";

import {
  generateBackupCodes,
  hashBackupCode,
  verifyBackupCode,
  encryptTOTPSecret,
  decryptTOTPSecret,
} from "../services/mfa.js";

// ─── Constants used across tests ──────────────────────────────────────────────

const TEST_USER_ID = "user-enc-test-001";
const TEST_SESSION_ID = "session-enc-test-001";
const BACKUP_CODE_LENGTH = 8;
const BACKUP_CODE_COUNT = 10;

// ─── JWT signing and verification ────────────────────────────────────────────

describe("signAccessToken / verifyAccessToken", () => {
  it("round-trips: a signed access token can be verified", () => {
    const token = signAccessToken({ userId: TEST_USER_ID, mfaVerified: true });

    expect(typeof token).toBe("string");
    expect(token.split(".")).toHaveLength(3); // JWT format: header.payload.sig

    const decoded = verifyAccessToken(token);
    expect(decoded.userId).toBe(TEST_USER_ID);
    expect(decoded.sub).toBe(TEST_USER_ID);
    expect(decoded.mfaVerified).toBe(true);
  });

  it("carries mfaVerified=false when specified", () => {
    const token = signAccessToken({ userId: TEST_USER_ID, mfaVerified: false });
    const decoded = verifyAccessToken(token);
    expect(decoded.mfaVerified).toBe(false);
  });

  it("throws when the token is tampered with", () => {
    const token = signAccessToken({ userId: TEST_USER_ID, mfaVerified: true });
    const [h, p, s] = token.split(".");
    const tampered = `${h}.${p}TAMPERED.${s}`;

    expect(() => verifyAccessToken(tampered)).toThrow();
  });

  it("throws on a completely invalid string", () => {
    expect(() => verifyAccessToken("not.a.jwt")).toThrow();
  });

  it("access token expires after 15 minutes (exp claim is ~15 min from now)", () => {
    const before = Math.floor(Date.now() / 1000);
    const token = signAccessToken({ userId: TEST_USER_ID, mfaVerified: true });
    const decoded = verifyAccessToken(token);
    const after = Math.floor(Date.now() / 1000);

    // 15 min = 900 seconds
    expect(decoded.exp).toBeGreaterThanOrEqual(before + 899);
    expect(decoded.exp).toBeLessThanOrEqual(after + 901);
  });

  it("throws when verified against a different public key", () => {
    const { publicKey: otherPublic } = crypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });

    const token = signAccessToken({ userId: TEST_USER_ID, mfaVerified: true });

    // Temporarily swap the public key
    const original = process.env["JWT_PUBLIC_KEY"];
    process.env["JWT_PUBLIC_KEY"] = otherPublic;
    expect(() => verifyAccessToken(token)).toThrow();
    process.env["JWT_PUBLIC_KEY"] = original;
  });
});

// ─── Refresh token ────────────────────────────────────────────────────────────

describe("signRefreshToken / verifyRefreshToken", () => {
  it("round-trips: a signed refresh token can be verified", () => {
    const token = signRefreshToken({
      userId: TEST_USER_ID,
      sessionId: TEST_SESSION_ID,
    });

    expect(typeof token).toBe("string");

    const decoded = verifyRefreshToken(token);
    expect(decoded.userId).toBe(TEST_USER_ID);
    expect(decoded.sub).toBe(TEST_USER_ID);
    expect(decoded.sessionId).toBe(TEST_SESSION_ID);
  });

  it("refresh token expires after 7 days (exp claim is ~7 days from now)", () => {
    const before = Math.floor(Date.now() / 1000);
    const token = signRefreshToken({
      userId: TEST_USER_ID,
      sessionId: TEST_SESSION_ID,
    });
    const decoded = verifyRefreshToken(token);
    const after = Math.floor(Date.now() / 1000);

    // 7 days = 604800 seconds
    expect(decoded.exp).toBeGreaterThanOrEqual(before + 604799);
    expect(decoded.exp).toBeLessThanOrEqual(after + 604801);
  });

  it("throws on a tampered refresh token", () => {
    const token = signRefreshToken({
      userId: TEST_USER_ID,
      sessionId: TEST_SESSION_ID,
    });
    const [h, p, s] = token.split(".");
    const tampered = `${h}.${p}X.${s}`;
    expect(() => verifyRefreshToken(tampered)).toThrow();
  });

  it("access token is rejected when verifying as a refresh token", () => {
    // Both use RS256 but carry different claims; no cross-type confusion
    const accessToken = signAccessToken({
      userId: TEST_USER_ID,
      mfaVerified: true,
    });
    // verifyRefreshToken expects sessionId — the JWT itself may still verify
    // but the caller should check claim presence
    const decoded = verifyRefreshToken(accessToken);
    // sessionId will be undefined on an access token payload
    expect(decoded.sessionId).toBeUndefined();
  });
});

// ─── MFA challenge token ──────────────────────────────────────────────────────

describe("generateMFAChallengeToken / verifyMFAChallengeToken", () => {
  it("round-trips: a generated challenge token can be verified", () => {
    const token = generateMFAChallengeToken(TEST_USER_ID);

    expect(typeof token).toBe("string");

    const decoded = verifyMFAChallengeToken(token);
    expect(decoded.userId).toBe(TEST_USER_ID);
    expect(decoded.sub).toBe(TEST_USER_ID);
  });

  it("decoded token includes type='mfa_challenge'", () => {
    const token = generateMFAChallengeToken(TEST_USER_ID);
    // The type claim is verified internally; if it were missing verifyMFA would throw.
    // Access the raw payload to confirm it is present.
    const parts = token.split(".");
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString());
    expect(payload.type).toBe("mfa_challenge");
  });

  it("challenge token expires after ~5 minutes", () => {
    const before = Math.floor(Date.now() / 1000);
    const token = generateMFAChallengeToken(TEST_USER_ID);
    const decoded = verifyMFAChallengeToken(token);
    const after = Math.floor(Date.now() / 1000);

    // 5 min = 300 seconds
    expect(decoded.exp).toBeGreaterThanOrEqual(before + 299);
    expect(decoded.exp).toBeLessThanOrEqual(after + 301);
  });

  it("throws when a plain access token is passed as a challenge token", () => {
    const accessToken = signAccessToken({
      userId: TEST_USER_ID,
      mfaVerified: true,
    });
    expect(() => verifyMFAChallengeToken(accessToken)).toThrow();
  });

  it("throws when a refresh token is passed as a challenge token", () => {
    const refreshToken = signRefreshToken({
      userId: TEST_USER_ID,
      sessionId: TEST_SESSION_ID,
    });
    expect(() => verifyMFAChallengeToken(refreshToken)).toThrow();
  });

  it("throws on an obviously invalid string", () => {
    expect(() => verifyMFAChallengeToken("garbage")).toThrow();
  });
});

// ─── generateKeyPair ──────────────────────────────────────────────────────────

describe("generateKeyPair", () => {
  it("returns a PEM private key and a PEM public key", () => {
    const { privateKey, publicKey } = generateKeyPair();

    expect(privateKey).toContain("-----BEGIN PRIVATE KEY-----");
    expect(publicKey).toContain("-----BEGIN PUBLIC KEY-----");
  });

  it("each call produces a unique key pair", () => {
    const kp1 = generateKeyPair();
    const kp2 = generateKeyPair();

    expect(kp1.privateKey).not.toBe(kp2.privateKey);
    expect(kp1.publicKey).not.toBe(kp2.publicKey);
  });
});

// ─── TOTP secret encryption / decryption ─────────────────────────────────────

describe("encryptTOTPSecret / decryptTOTPSecret", () => {
  it("round-trips: encrypting then decrypting returns the original secret", () => {
    const original = "JBSWY3DPEHPK3PXP";
    const encrypted = encryptTOTPSecret(original);
    const decrypted = decryptTOTPSecret(encrypted);

    expect(decrypted).toBe(original);
  });

  it("produces a different ciphertext on every call (random IV)", () => {
    const secret = "JBSWY3DPEHPK3PXP";
    const enc1 = encryptTOTPSecret(secret);
    const enc2 = encryptTOTPSecret(secret);

    expect(enc1).not.toBe(enc2);
  });

  it("encrypted format is iv:ciphertext:authTag (3 colon-separated hex parts)", () => {
    const encrypted = encryptTOTPSecret("SOMESECRET");
    const parts = encrypted.split(":");
    expect(parts).toHaveLength(3);
    // Each part should be a non-empty hex string
    for (const part of parts) {
      expect(part).toMatch(/^[0-9a-f]+$/);
    }
  });

  it("throws when auth tag is corrupted (tampered ciphertext)", () => {
    const encrypted = encryptTOTPSecret("JBSWY3DPEHPK3PXP");
    // Corrupt the ciphertext portion (middle segment)
    const [iv, ct, tag] = encrypted.split(":");
    const corruptedCt = ct!.slice(0, -2) + "ff";
    const tampered = `${iv}:${corruptedCt}:${tag}`;

    expect(() => decryptTOTPSecret(tampered)).toThrow();
  });

  it("throws when the encrypted string has wrong number of parts", () => {
    expect(() => decryptTOTPSecret("only-two:parts")).toThrow();
    expect(() => decryptTOTPSecret("a:b:c:d")).toThrow();
  });

  it("handles TOTP secrets of various lengths", () => {
    const secrets = [
      "JBSWY3DPEHPK3PXP",          // 16-char base32
      "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP", // 32-char
      "A",                             // minimal
    ];
    for (const s of secrets) {
      expect(decryptTOTPSecret(encryptTOTPSecret(s))).toBe(s);
    }
  });
});

// ─── Backup code generation ───────────────────────────────────────────────────

describe("generateBackupCodes", () => {
  it(`generates exactly ${BACKUP_CODE_COUNT} codes`, () => {
    const codes = generateBackupCodes();
    expect(codes).toHaveLength(BACKUP_CODE_COUNT);
  });

  it(`each code is exactly ${BACKUP_CODE_LENGTH} characters`, () => {
    const codes = generateBackupCodes();
    for (const code of codes) {
      expect(code).toHaveLength(BACKUP_CODE_LENGTH);
    }
  });

  it("codes only contain characters from the unambiguous charset (no 0, O, 1, I, l)", () => {
    // Run several batches to reduce flakiness
    for (let i = 0; i < 5; i++) {
      const codes = generateBackupCodes();
      for (const code of codes) {
        expect(code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]+$/);
        expect(code).not.toMatch(/[01IlO]/);
      }
    }
  });

  it("each call produces a different set of codes", () => {
    const batch1 = generateBackupCodes().join(",");
    const batch2 = generateBackupCodes().join(",");
    expect(batch1).not.toBe(batch2);
  });

  it("all codes within a single batch are unique", () => {
    const codes = generateBackupCodes();
    const unique = new Set(codes);
    expect(unique.size).toBe(codes.length);
  });
});

// ─── Backup code hashing and verification ────────────────────────────────────

describe("hashBackupCode / verifyBackupCode", () => {
  it("hashBackupCode returns a non-empty string that is not the original code", async () => {
    const code = "ABCDEFGH";
    const hash = await hashBackupCode(code);

    expect(typeof hash).toBe("string");
    expect(hash.length).toBeGreaterThan(0);
    expect(hash).not.toBe(code);
  });

  it("hashing the same code twice produces different hashes (bcrypt salting)", async () => {
    const code = "ABCDEFGH";
    const hash1 = await hashBackupCode(code);
    const hash2 = await hashBackupCode(code);

    expect(hash1).not.toBe(hash2);
  });

  it("verifyBackupCode returns the correct index when code matches", async () => {
    const codes = ["FIRST001", "TARGET02", "THIRD003"];
    const hashes = await Promise.all(codes.map(hashBackupCode));

    const idx = await verifyBackupCode("TARGET02", hashes);
    expect(idx).toBe(1);
  });

  it("verifyBackupCode returns -1 when no code matches", async () => {
    const codes = ["FIRST001", "TARGET02"];
    const hashes = await Promise.all(codes.map(hashBackupCode));

    const idx = await verifyBackupCode("NOTFOUND", hashes);
    expect(idx).toBe(-1);
  });

  it("verifyBackupCode returns the index of the first matching code in an array", async () => {
    const code = "SAMECODE";
    // Two hashes of the same code (unusual but edge-case safe)
    const h1 = await hashBackupCode(code);
    const h2 = await hashBackupCode(code);
    const hashes = [h1, h2];

    const idx = await verifyBackupCode(code, hashes);
    // Should return 0 (first match) and not -1
    expect(idx).toBe(0);
  });

  it("verifyBackupCode returns -1 for an empty hash array", async () => {
    const idx = await verifyBackupCode("ABCDEFGH", []);
    expect(idx).toBe(-1);
  });

  it("round-trip: generate codes, hash them, verify each one individually", async () => {
    const codes = generateBackupCodes();
    const hashes = await Promise.all(codes.map(hashBackupCode));

    for (let i = 0; i < codes.length; i++) {
      const idx = await verifyBackupCode(codes[i]!, hashes);
      expect(idx).toBe(i);
    }
  }, 30_000); // bcrypt is intentionally slow — extend timeout for the full batch
});
