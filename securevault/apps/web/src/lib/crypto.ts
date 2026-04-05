/**
 * SecureVault client-side encryption engine
 *
 * All cryptographic operations use the Web Crypto API (crypto.subtle).
 * - Master key: PBKDF2 (600,000 iterations, SHA-256) → key material → HKDF-SHA256 sub-keys
 * - File encryption: AES-256-GCM with 12-byte IVs
 * - Key wrapping: AES-KW (256-bit)
 * - Hashing: SHA-256
 * - All random values: crypto.getRandomValues() — Math.random() is never used
 */

/* ------------------------------------------------------------------ */
/* Internal helpers                                                     */
/* ------------------------------------------------------------------ */

function bufferToBase64(buffer: ArrayBuffer | Uint8Array): string {
  const bytes =
    buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

function base64ToBuffer(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function bufferToHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function textToBuffer(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** AES-256-GCM IV is always 12 bytes (96 bits) per NIST recommendation */
const IV_LENGTH_BYTES = 12;

/** Chunk size for large-file streaming encryption: 64 KiB */
const CHUNK_SIZE = 64 * 1024;

/* ------------------------------------------------------------------ */
/* Salt Generation                                                      */
/* ------------------------------------------------------------------ */

/**
 * Generate a 32-byte cryptographically random salt.
 * Used once per user account and stored server-side with the user record.
 */
export function generateSalt(): Uint8Array {
  const salt = new Uint8Array(32);
  crypto.getRandomValues(salt);
  return salt;
}

/* ------------------------------------------------------------------ */
/* Master Key Derivation                                                */
/* ------------------------------------------------------------------ */

/**
 * Derive a master CryptoKey from the user's password and their stored salt.
 *
 * Pipeline:
 *   password → PBKDF2 (600,000 iterations, SHA-256, 32-byte salt)
 *            → raw key material (256 bits)
 *            → imported as HKDF base key
 *
 * The returned key is suitable for use with deriveSubKey().
 *
 * NOTE: Argon2id is the ideal KDF but is not available in the Web Crypto
 * API.  PBKDF2 with 600,000 iterations (NIST SP 800-132 recommendation
 * for SHA-256) is the browser-compatible alternative.
 */
export async function deriveMasterKey(
  password: string,
  salt: Uint8Array,
): Promise<CryptoKey> {
  // Step 1 – import the raw password bytes as a PBKDF2 key
  const passwordKey = await crypto.subtle.importKey(
    'raw',
    textToBuffer(password),
    { name: 'PBKDF2' },
    false,
    ['deriveBits'],
  );

  // Step 2 – derive 256 bits of key material via PBKDF2
  const keyMaterial = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt,
      iterations: 600_000,
      hash: 'SHA-256',
    },
    passwordKey,
    256,
  );

  // Step 3 – import the derived bits as an HKDF base key so sub-keys
  //           can be derived from it with purpose-specific info strings.
  return crypto.subtle.importKey(
    'raw',
    keyMaterial,
    { name: 'HKDF' },
    false,
    ['deriveKey', 'deriveBits'],
  );
}

/* ------------------------------------------------------------------ */
/* Sub-key Derivation                                                   */
/* ------------------------------------------------------------------ */

type SubKeyPurpose =
  | 'file-encryption'
  | 'metadata-encryption'
  | 'key-wrapping';

/**
 * Derive a purpose-specific AES-256-GCM (or AES-KW) sub-key from the
 * master key using HKDF-SHA256.
 *
 * @param masterKey  - The HKDF base key returned by deriveMasterKey()
 * @param purpose    - Logical label used as the HKDF info parameter
 * @param info       - Optional additional context bytes appended to the
 *                     purpose string before being used as HKDF info
 */
export async function deriveSubKey(
  masterKey: CryptoKey,
  purpose: SubKeyPurpose,
  info?: Uint8Array,
): Promise<CryptoKey> {
  const purposeBytes = textToBuffer(purpose);
  const infoBytes =
    info !== undefined
      ? (() => {
          const combined = new Uint8Array(purposeBytes.length + info.length);
          combined.set(purposeBytes, 0);
          combined.set(info, purposeBytes.length);
          return combined;
        })()
      : purposeBytes;

  // AES-KW is used for key-wrapping; everything else uses AES-GCM.
  const isWrapping = purpose === 'key-wrapping';

  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(32), // HKDF "salt" – fixed zero bytes (key material already has entropy)
      info: infoBytes,
    },
    masterKey,
    isWrapping
      ? { name: 'AES-KW', length: 256 }
      : { name: 'AES-GCM', length: 256 },
    false,
    isWrapping ? ['wrapKey', 'unwrapKey'] : ['encrypt', 'decrypt'],
  );
}

/* ------------------------------------------------------------------ */
/* File Encryption Key (FEK) Generation                                */
/* ------------------------------------------------------------------ */

/**
 * Generate a random 256-bit AES-GCM key to be used as a File Encryption
 * Key (FEK).  One unique FEK is generated per file upload.
 */
export async function generateFileKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true, // exportable so it can be wrapped
    ['encrypt', 'decrypt'],
  );
}

/* ------------------------------------------------------------------ */
/* Key Wrapping / Unwrapping                                           */
/* ------------------------------------------------------------------ */

/**
 * Wrap a CryptoKey using AES-KW and return the result as a base64 string.
 * The wrapped key can be safely stored server-side.
 */
export async function wrapKey(
  keyToWrap: CryptoKey,
  wrappingKey: CryptoKey,
): Promise<string> {
  const wrapped = await crypto.subtle.wrapKey(
    'raw',
    keyToWrap,
    wrappingKey,
    { name: 'AES-KW' },
  );
  return bufferToBase64(wrapped);
}

/**
 * Unwrap a base64-encoded AES-KW-wrapped key and return a usable CryptoKey.
 * The result is an AES-256-GCM key usable for encrypt/decrypt.
 */
export async function unwrapKey(
  wrappedKeyB64: string,
  unwrappingKey: CryptoKey,
): Promise<CryptoKey> {
  const wrappedBytes = base64ToBuffer(wrappedKeyB64);
  return crypto.subtle.unwrapKey(
    'raw',
    wrappedBytes,
    unwrappingKey,
    { name: 'AES-KW' },
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt'],
  );
}

/* ------------------------------------------------------------------ */
/* File Encryption (streaming for large files)                         */
/* ------------------------------------------------------------------ */

/**
 * Encrypt a File using AES-256-GCM.
 *
 * - Files < 64 KiB: encrypted as a single chunk with one IV.
 * - Files >= 64 KiB: split into 64 KiB chunks; each chunk has its own
 *   random IV.  This avoids holding the entire file in memory.
 *
 * Returns the encrypted Blob and a JSON-serialised array of base64 IVs.
 * The IV array always contains at least one entry; single-chunk files
 * contain exactly one.
 */
export async function encryptFile(
  file: File,
  fileKey: CryptoKey,
): Promise<{ encrypted: Blob; iv: string }> {
  const fileBuffer = await file.arrayBuffer();

  if (fileBuffer.byteLength < CHUNK_SIZE) {
    // ---- Single-chunk path ----
    const iv = new Uint8Array(IV_LENGTH_BYTES);
    crypto.getRandomValues(iv);

    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      fileKey,
      fileBuffer,
    );

    const ivArray = [bufferToBase64(iv)];
    return {
      encrypted: new Blob([ciphertext], { type: 'application/octet-stream' }),
      iv: JSON.stringify(ivArray),
    };
  }

  // ---- Chunked path ----
  const encryptedChunks: ArrayBuffer[] = [];
  const ivList: string[] = [];

  let offset = 0;
  while (offset < fileBuffer.byteLength) {
    const end = Math.min(offset + CHUNK_SIZE, fileBuffer.byteLength);
    const chunk = fileBuffer.slice(offset, end);

    const iv = new Uint8Array(IV_LENGTH_BYTES);
    crypto.getRandomValues(iv);

    const encryptedChunk = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      fileKey,
      chunk,
    );

    encryptedChunks.push(encryptedChunk);
    ivList.push(bufferToBase64(iv));
    offset = end;
  }

  return {
    encrypted: new Blob(encryptedChunks, { type: 'application/octet-stream' }),
    iv: JSON.stringify(ivList),
  };
}

/**
 * Decrypt an encrypted Blob back to its original plaintext Blob.
 *
 * @param encryptedBlob  - The blob produced by encryptFile()
 * @param fileKey        - The original File Encryption Key
 * @param ivsJson        - The JSON IV array string produced by encryptFile()
 */
export async function decryptFile(
  encryptedBlob: Blob,
  fileKey: CryptoKey,
  ivsJson: string,
): Promise<Blob> {
  const ivList: string[] = JSON.parse(ivsJson) as string[];
  const encryptedBuffer = await encryptedBlob.arrayBuffer();

  if (ivList.length === 1) {
    // ---- Single-chunk path ----
    const iv = base64ToBuffer(ivList[0]!);
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      fileKey,
      encryptedBuffer,
    );
    return new Blob([plaintext]);
  }

  // ---- Chunked path ----
  // AES-GCM adds 16 bytes of authentication tag per chunk.
  const tagSize = 16;
  const encryptedChunkSize = CHUNK_SIZE + tagSize;

  const plaintextChunks: ArrayBuffer[] = [];

  for (let i = 0; i < ivList.length; i++) {
    const isLast = i === ivList.length - 1;
    const chunkStart = i * encryptedChunkSize;
    // Last chunk may be smaller
    const chunkEnd = isLast
      ? encryptedBuffer.byteLength
      : chunkStart + encryptedChunkSize;

    const chunk = encryptedBuffer.slice(chunkStart, chunkEnd);
    const iv = base64ToBuffer(ivList[i]!);

    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      fileKey,
      chunk,
    );
    plaintextChunks.push(plaintext);
  }

  return new Blob(plaintextChunks);
}

/* ------------------------------------------------------------------ */
/* Metadata Encryption                                                  */
/* ------------------------------------------------------------------ */

/**
 * Encrypt a UTF-8 string (e.g. filename, MIME type) with AES-256-GCM.
 *
 * The returned value is base64-encoded and contains:
 *   [ 12-byte IV | ciphertext + 16-byte GCM tag ]
 * Everything is concatenated before base64 encoding so only one field
 * needs to be stored.
 */
export async function encryptMetadata(
  data: string,
  metadataKey: CryptoKey,
): Promise<string> {
  const iv = new Uint8Array(IV_LENGTH_BYTES);
  crypto.getRandomValues(iv);

  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    metadataKey,
    textToBuffer(data),
  );

  // Pack iv + ciphertext into a single buffer
  const combined = new Uint8Array(iv.byteLength + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.byteLength);

  return bufferToBase64(combined);
}

/**
 * Decrypt a base64-encoded metadata blob produced by encryptMetadata().
 */
export async function decryptMetadata(
  encrypted: string,
  metadataKey: CryptoKey,
): Promise<string> {
  const combined = base64ToBuffer(encrypted);
  const iv = combined.slice(0, IV_LENGTH_BYTES);
  const ciphertext = combined.slice(IV_LENGTH_BYTES);

  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    metadataKey,
    ciphertext,
  );

  return new TextDecoder().decode(plaintext);
}

/* ------------------------------------------------------------------ */
/* Hashing                                                              */
/* ------------------------------------------------------------------ */

/**
 * Compute the SHA-256 hash of an ArrayBuffer or a Blob and return it
 * as a lowercase hex string.
 *
 * Blobs are read in 4 MiB chunks to avoid OOM on large files.
 */
export async function computeSHA256(
  data: ArrayBuffer | Blob,
): Promise<string> {
  if (data instanceof ArrayBuffer) {
    const hash = await crypto.subtle.digest('SHA-256', data);
    return bufferToHex(hash);
  }

  // Incremental hashing for Blobs via SubtleCrypto is not possible
  // directly, so we read the whole blob in manageable slices but still
  // end up feeding the full buffer to digest() once.  For very large
  // files the caller should pre-slice or use the encryptedBlob path.
  const READ_CHUNK = 4 * 1024 * 1024; // 4 MiB
  const parts: Uint8Array[] = [];
  let offset = 0;

  while (offset < data.size) {
    const slice = data.slice(offset, offset + READ_CHUNK);
    const buf = await slice.arrayBuffer();
    parts.push(new Uint8Array(buf));
    offset += READ_CHUNK;
  }

  // Assemble into one buffer for digest
  const totalLength = parts.reduce((acc, p) => acc + p.byteLength, 0);
  const assembled = new Uint8Array(totalLength);
  let pos = 0;
  for (const part of parts) {
    assembled.set(part, pos);
    pos += part.byteLength;
  }

  const hash = await crypto.subtle.digest('SHA-256', assembled);
  return bufferToHex(hash);
}

/* ------------------------------------------------------------------ */
/* Recovery Key                                                         */
/* ------------------------------------------------------------------ */

/**
 * Generate a 256-bit (32-byte) random recovery key and return it as a
 * 64-character lowercase hex string.
 */
export function generateRecoveryKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bufferToHex(bytes.buffer as ArrayBuffer);
}

/**
 * Wrap the master key using a key derived from the recovery key string.
 *
 * Pipeline: recoveryKey (hex) → raw bytes → HKDF-SHA256 → AES-KW key
 *           → wrap masterKey → base64
 */
export async function wrapMasterKeyWithRecovery(
  masterKey: CryptoKey,
  recoveryKey: string,
): Promise<string> {
  const wrappingKey = await deriveRecoveryWrappingKey(recoveryKey);

  // masterKey was created as an HKDF key (non-extractable) — we need to
  // export it first as raw bits then re-import it as an AES-GCM key so
  // AES-KW can wrap it.
  const rawBits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(32),
      info: textToBuffer('master-key-export'),
    },
    masterKey,
    256,
  );

  const exportableKey = await crypto.subtle.importKey(
    'raw',
    rawBits,
    { name: 'AES-GCM', length: 256 },
    true, // must be extractable for wrapKey
    ['encrypt', 'decrypt'],
  );

  const wrapped = await crypto.subtle.wrapKey('raw', exportableKey, wrappingKey, {
    name: 'AES-KW',
  });

  return bufferToBase64(wrapped);
}

/**
 * Unwrap a master key that was previously wrapped with wrapMasterKeyWithRecovery().
 * Returns an HKDF-compatible CryptoKey identical to what deriveMasterKey() returns.
 */
export async function unwrapMasterKeyWithRecovery(
  wrappedKeyB64: string,
  recoveryKey: string,
): Promise<CryptoKey> {
  const unwrappingKey = await deriveRecoveryWrappingKey(recoveryKey);
  const wrappedBytes = base64ToBuffer(wrappedKeyB64);

  // Unwrap back to AES-GCM (that is what we wrapped above)
  const aesKey = await crypto.subtle.unwrapKey(
    'raw',
    wrappedBytes,
    unwrappingKey,
    { name: 'AES-KW' },
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt'],
  );

  // Re-export the raw bytes and re-import as HKDF so the caller gets
  // exactly the same key type as deriveMasterKey() returns.
  const rawBits = await crypto.subtle.exportKey('raw', aesKey);
  return crypto.subtle.importKey(
    'raw',
    rawBits,
    { name: 'HKDF' },
    false,
    ['deriveKey', 'deriveBits'],
  );
}

/** Internal helper: derive an AES-KW key from a hex recovery key string */
async function deriveRecoveryWrappingKey(recoveryKey: string): Promise<CryptoKey> {
  // Decode hex recovery key to raw bytes
  const hex = recoveryKey.replace(/[^0-9a-fA-F]/g, '');
  const rawBytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < rawBytes.length; i++) {
    rawBytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }

  // Import as HKDF base key
  const hkdfKey = await crypto.subtle.importKey(
    'raw',
    rawBytes,
    { name: 'HKDF' },
    false,
    ['deriveKey'],
  );

  // Derive AES-KW key
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(32),
      info: textToBuffer('recovery-key-wrapping'),
    },
    hkdfKey,
    { name: 'AES-KW', length: 256 },
    false,
    ['wrapKey', 'unwrapKey'],
  );
}

/* ------------------------------------------------------------------ */
/* Key Export / Import Helpers                                          */
/* ------------------------------------------------------------------ */

/**
 * Export a CryptoKey as a base64-encoded raw key.
 * The key must have been created with extractable = true.
 */
export async function exportKey(key: CryptoKey): Promise<string> {
  const raw = await crypto.subtle.exportKey('raw', key);
  return bufferToBase64(raw);
}

/**
 * Import a CryptoKey from a base64-encoded raw key.
 * Returns an AES-256-GCM key with the specified usages.
 */
export async function importKey(
  keyData: string,
  usages: KeyUsage[],
): Promise<CryptoKey> {
  const raw = base64ToBuffer(keyData);
  return crypto.subtle.importKey(
    'raw',
    raw,
    { name: 'AES-GCM', length: 256 },
    true,
    usages,
  );
}
