import crypto from "crypto";
import speakeasy from "speakeasy";
import bcrypt from "bcryptjs";
import qrcode from "qrcode";

// ─── Constants ────────────────────────────────────────────────────────────────

const ISSUER = "SecureVault";
const BCRYPT_ROUNDS = 10;
const BACKUP_CODE_COUNT = 10;
/** Unambiguous alphanumeric characters (no 0/O, 1/I/l) */
const BACKUP_CODE_CHARSET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const BACKUP_CODE_LENGTH = 8;

const AES_ALGO = "aes-256-gcm" as const;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

// ─── TOTP ─────────────────────────────────────────────────────────────────────

export interface TOTPSetupResult {
  /** Base-32 encoded TOTP secret */
  secret: string;
  /** otpauth:// URL for use with authenticator apps */
  otpauthUrl: string;
}

/**
 * Generates a new TOTP secret tied to the given email address.
 * Returns the raw base-32 secret and a matching otpauth:// URL with
 * issuer "SecureVault".
 */
export function generateTOTPSecret(email: string): TOTPSetupResult {
  const generated = speakeasy.generateSecret({
    name: `${ISSUER} (${email})`,
    issuer: ISSUER,
    length: 20,
  });

  return {
    secret: generated.base32,
    otpauthUrl: generated.otpauth_url ?? "",
  };
}

/**
 * Verifies a 6-digit TOTP token against the stored base-32 secret.
 * Allows a time window of ±1 step (30-second steps = ±30 s clock skew).
 */
export function verifyTOTP(secret: string, token: string): boolean {
  return speakeasy.totp.verify({
    secret,
    encoding: "base32",
    token,
    window: 1,
  });
}

// ─── Backup codes ─────────────────────────────────────────────────────────────

/**
 * Generates 10 random 8-character alphanumeric backup codes using an
 * unambiguous character set so codes are easy for users to read aloud.
 */
export function generateBackupCodes(): string[] {
  return Array.from({ length: BACKUP_CODE_COUNT }, () => {
    const bytes = crypto.randomBytes(BACKUP_CODE_LENGTH);
    return Array.from(bytes)
      .map((b) => BACKUP_CODE_CHARSET[b % BACKUP_CODE_CHARSET.length]!)
      .join("");
  });
}

/**
 * Returns a bcrypt hash of a single backup code for safe storage.
 */
export async function hashBackupCode(code: string): Promise<string> {
  return bcrypt.hash(code, BCRYPT_ROUNDS);
}

/**
 * Checks `code` against each entry in `hashes`.
 * Returns the index of the matching hash, or -1 if none match.
 * Iterates all hashes to avoid short-circuit timing leaks.
 */
export async function verifyBackupCode(
  code: string,
  hashes: string[]
): Promise<number> {
  let matchIndex = -1;
  for (let i = 0; i < hashes.length; i++) {
    const hash = hashes[i];
    if (hash === undefined) continue;
    const match = await bcrypt.compare(code, hash);
    if (match && matchIndex === -1) {
      matchIndex = i;
    }
  }
  return matchIndex;
}

// ─── TOTP Secret Encryption (AES-256-GCM) ────────────────────────────────────

function getEncryptionKey(): Buffer {
  const raw = process.env["TOTP_ENCRYPTION_KEY"];
  if (!raw) {
    throw new Error("TOTP_ENCRYPTION_KEY environment variable is not set");
  }

  // Accept both a 64-char hex string and a base64-encoded 32-byte key
  let key: Buffer;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    key = Buffer.from(raw, "hex");
  } else {
    key = Buffer.from(raw, "base64");
  }

  if (key.length !== 32) {
    throw new Error(
      `TOTP_ENCRYPTION_KEY must be 32 bytes (got ${key.length})`
    );
  }
  return key;
}

/**
 * Encrypts a TOTP secret with AES-256-GCM.
 * Output format: `<iv_hex>:<ciphertext_hex>:<authTag_hex>`
 */
export function encryptTOTPSecret(secret: string): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(AES_ALGO, key, iv);

  const ciphertext = Buffer.concat([
    cipher.update(secret, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return [
    iv.toString("hex"),
    ciphertext.toString("hex"),
    authTag.toString("hex"),
  ].join(":");
}

/**
 * Decrypts a TOTP secret previously encrypted with `encryptTOTPSecret`.
 * Throws on any tampering or format mismatch.
 */
export function decryptTOTPSecret(encrypted: string): string {
  const parts = encrypted.split(":");
  if (parts.length !== 3) {
    throw new Error("Invalid encrypted TOTP secret format");
  }

  const [ivHex, ciphertextHex, authTagHex] = parts as [string, string, string];
  const key = getEncryptionKey();
  const iv = Buffer.from(ivHex, "hex");
  const ciphertext = Buffer.from(ciphertextHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");

  if (iv.length !== IV_BYTES) throw new Error("Invalid IV length");
  if (authTag.length !== AUTH_TAG_BYTES) throw new Error("Invalid auth tag length");

  const decipher = crypto.createDecipheriv(AES_ALGO, key, iv);
  decipher.setAuthTag(authTag);

  return decipher.update(ciphertext).toString("utf8") + decipher.final("utf8");
}

// ─── QR Code ──────────────────────────────────────────────────────────────────

/**
 * Renders an otpauth:// URL as a PNG data URL suitable for an <img> src.
 */
export async function generateQRCode(otpauthUrl: string): Promise<string> {
  return qrcode.toDataURL(otpauthUrl);
}
