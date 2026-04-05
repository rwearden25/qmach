/**
 * Client-side encryption engine unit tests
 *
 * Tests all Web Crypto API operations: key derivation, file encryption,
 * metadata encryption, key wrapping, hashing, and recovery key flows.
 */

import { describe, it, expect } from 'vitest';
import {
  generateSalt,
  deriveMasterKey,
  deriveSubKey,
  generateFileKey,
  wrapKey,
  unwrapKey,
  encryptFile,
  decryptFile,
  encryptMetadata,
  decryptMetadata,
  computeSHA256,
  generateRecoveryKey,
  wrapMasterKeyWithRecovery,
  unwrapMasterKeyWithRecovery,
  exportKey,
  importKey,
} from '../lib/crypto';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createTestFile(content: string, name = 'test.txt'): File {
  const blob = new Blob([content], { type: 'text/plain' });
  return new File([blob], name, { type: 'text/plain' });
}

function createLargeTestFile(sizeKB: number, name = 'large.bin'): File {
  const chunk = new Uint8Array(1024);
  crypto.getRandomValues(chunk);
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < sizeKB; i++) {
    chunks.push(new Uint8Array(chunk));
  }
  const blob = new Blob(chunks, { type: 'application/octet-stream' });
  return new File([blob], name, { type: 'application/octet-stream' });
}

// ─── Salt Generation ──────────────────────────────────────────────────────────

describe('generateSalt', () => {
  it('returns a 32-byte Uint8Array', () => {
    const salt = generateSalt();
    expect(salt).toBeInstanceOf(Uint8Array);
    expect(salt.byteLength).toBe(32);
  });

  it('produces different salts on each call', () => {
    const salt1 = generateSalt();
    const salt2 = generateSalt();
    expect(salt1).not.toEqual(salt2);
  });
});

// ─── Master Key Derivation ────────────────────────────────────────────────────

describe('deriveMasterKey', () => {
  it('derives a CryptoKey from password + salt', async () => {
    const salt = generateSalt();
    const key = await deriveMasterKey('test-password-123', salt);
    expect(key).toBeDefined();
    expect(key.type).toBe('secret');
    expect(key.algorithm.name).toBe('HKDF');
  });

  it('produces the same key from the same password + salt', async () => {
    const salt = generateSalt();
    const key1 = await deriveMasterKey('same-password', salt);
    const key2 = await deriveMasterKey('same-password', salt);

    const sub1 = await deriveSubKey(key1, 'file-encryption');
    const sub2 = await deriveSubKey(key2, 'file-encryption');
    const raw1 = await crypto.subtle.exportKey('raw', sub1);
    const raw2 = await crypto.subtle.exportKey('raw', sub2);

    expect(new Uint8Array(raw1)).toEqual(new Uint8Array(raw2));
  });

  it('produces different keys for different passwords', async () => {
    const salt = generateSalt();
    const key1 = await deriveMasterKey('password-one', salt);
    const key2 = await deriveMasterKey('password-two', salt);

    const sub1 = await deriveSubKey(key1, 'file-encryption');
    const sub2 = await deriveSubKey(key2, 'file-encryption');
    const raw1 = await crypto.subtle.exportKey('raw', sub1);
    const raw2 = await crypto.subtle.exportKey('raw', sub2);

    expect(new Uint8Array(raw1)).not.toEqual(new Uint8Array(raw2));
  });
});

// ─── Sub-key Derivation ───────────────────────────────────────────────────────

describe('deriveSubKey', () => {
  it('derives different keys for different purposes', async () => {
    const salt = generateSalt();
    const masterKey = await deriveMasterKey('test-password', salt);

    const fileKey = await deriveSubKey(masterKey, 'file-encryption');
    const metaKey = await deriveSubKey(masterKey, 'metadata-encryption');
    const wrapKeyResult = await deriveSubKey(masterKey, 'key-wrapping');

    const rawFile = await crypto.subtle.exportKey('raw', fileKey);
    const rawMeta = await crypto.subtle.exportKey('raw', metaKey);

    expect(new Uint8Array(rawFile)).not.toEqual(new Uint8Array(rawMeta));
    expect(wrapKeyResult.algorithm.name).toBe('AES-KW');
    expect(fileKey.algorithm.name).toBe('AES-GCM');
  });

  it('produces AES-256 keys (32 bytes)', async () => {
    const salt = generateSalt();
    const masterKey = await deriveMasterKey('test-password', salt);
    const subKey = await deriveSubKey(masterKey, 'file-encryption');
    const raw = await crypto.subtle.exportKey('raw', subKey);
    expect(raw.byteLength).toBe(32);
  });
});

// ─── File Encryption Key ──────────────────────────────────────────────────────

describe('generateFileKey', () => {
  it('generates an AES-256-GCM CryptoKey', async () => {
    const key = await generateFileKey();
    expect(key.type).toBe('secret');
    expect(key.algorithm.name).toBe('AES-GCM');
    expect((key.algorithm as AesKeyAlgorithm).length).toBe(256);
    expect(key.extractable).toBe(true);
  });

  it('generates unique keys', async () => {
    const key1 = await generateFileKey();
    const key2 = await generateFileKey();
    const raw1 = await crypto.subtle.exportKey('raw', key1);
    const raw2 = await crypto.subtle.exportKey('raw', key2);
    expect(new Uint8Array(raw1)).not.toEqual(new Uint8Array(raw2));
  });
});

// ─── Key Wrapping ─────────────────────────────────────────────────────────────

describe('wrapKey / unwrapKey', () => {
  it('wraps and unwraps a key round-trip', async () => {
    const salt = generateSalt();
    const masterKey = await deriveMasterKey('test-password', salt);
    const wrappingKey = await deriveSubKey(masterKey, 'key-wrapping');
    const fileKey = await generateFileKey();

    const wrapped = await wrapKey(fileKey, wrappingKey);
    expect(typeof wrapped).toBe('string');

    const unwrapped = await unwrapKey(wrapped, wrappingKey);
    const rawOriginal = await crypto.subtle.exportKey('raw', fileKey);
    const rawUnwrapped = await crypto.subtle.exportKey('raw', unwrapped);
    expect(new Uint8Array(rawOriginal)).toEqual(new Uint8Array(rawUnwrapped));
  });

  it('fails to unwrap with the wrong key', async () => {
    const salt1 = generateSalt();
    const salt2 = generateSalt();
    const mk1 = await deriveMasterKey('password1', salt1);
    const mk2 = await deriveMasterKey('password2', salt2);
    const wk1 = await deriveSubKey(mk1, 'key-wrapping');
    const wk2 = await deriveSubKey(mk2, 'key-wrapping');
    const fileKey = await generateFileKey();

    const wrapped = await wrapKey(fileKey, wk1);
    await expect(unwrapKey(wrapped, wk2)).rejects.toThrow();
  });
});

// ─── File Encryption (small) ──────────────────────────────────────────────────

describe('encryptFile / decryptFile (small)', () => {
  it('round-trips a small text file', async () => {
    const content = 'Hello, SecureVault!';
    const file = createTestFile(content);
    const fileKey = await generateFileKey();

    const { encrypted, iv } = await encryptFile(file, fileKey);
    expect(encrypted.size).toBeGreaterThan(0);
    expect(JSON.parse(iv)).toHaveLength(1);

    const decrypted = await decryptFile(encrypted, fileKey, iv);
    expect(await decrypted.text()).toBe(content);
  });

  it('produces different ciphertexts for the same file', async () => {
    const file = createTestFile('same content');
    const fileKey = await generateFileKey();

    const enc1 = await encryptFile(file, fileKey);
    const enc2 = await encryptFile(file, fileKey);

    const buf1 = new Uint8Array(await enc1.encrypted.arrayBuffer());
    const buf2 = new Uint8Array(await enc2.encrypted.arrayBuffer());
    expect(buf1).not.toEqual(buf2);
  });

  it('fails to decrypt with wrong key', async () => {
    const file = createTestFile('secret');
    const key1 = await generateFileKey();
    const key2 = await generateFileKey();

    const { encrypted, iv } = await encryptFile(file, key1);
    await expect(decryptFile(encrypted, key2, iv)).rejects.toThrow();
  });
});

// ─── File Encryption (large, chunked) ─────────────────────────────────────────

describe('encryptFile / decryptFile (large, chunked)', () => {
  it('round-trips a 128KB file with multiple chunks', async () => {
    const file = createLargeTestFile(128);
    const fileKey = await generateFileKey();

    const { encrypted, iv } = await encryptFile(file, fileKey);
    const ivArray = JSON.parse(iv) as string[];
    expect(ivArray.length).toBeGreaterThan(1);

    const decrypted = await decryptFile(encrypted, fileKey, iv);
    const original = new Uint8Array(await file.arrayBuffer());
    const result = new Uint8Array(await decrypted.arrayBuffer());
    expect(result).toEqual(original);
  });

  it('each chunk gets a unique IV', async () => {
    const file = createLargeTestFile(200);
    const fileKey = await generateFileKey();

    const { iv } = await encryptFile(file, fileKey);
    const ivArray = JSON.parse(iv) as string[];
    expect(new Set(ivArray).size).toBe(ivArray.length);
  });
});

// ─── Metadata Encryption ──────────────────────────────────────────────────────

describe('encryptMetadata / decryptMetadata', () => {
  it('round-trips a filename', async () => {
    const salt = generateSalt();
    const mk = await deriveMasterKey('test', salt);
    const metaKey = await deriveSubKey(mk, 'metadata-encryption');

    const name = 'secret-doc.pdf';
    const enc = await encryptMetadata(name, metaKey);
    expect(enc).not.toBe(name);
    expect(await decryptMetadata(enc, metaKey)).toBe(name);
  });

  it('handles unicode', async () => {
    const salt = generateSalt();
    const mk = await deriveMasterKey('test', salt);
    const metaKey = await deriveSubKey(mk, 'metadata-encryption');

    const unicode = 'файл-报告.pdf';
    const enc = await encryptMetadata(unicode, metaKey);
    expect(await decryptMetadata(enc, metaKey)).toBe(unicode);
  });
});

// ─── Hashing ──────────────────────────────────────────────────────────────────

describe('computeSHA256', () => {
  it('computes correct hash for known input', async () => {
    const data = new TextEncoder().encode('hello');
    const hash = await computeSHA256(data.buffer as ArrayBuffer);
    expect(hash).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  });

  it('works with Blob input', async () => {
    const blob = new Blob(['hello']);
    const hash = await computeSHA256(blob);
    expect(hash).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  });

  it('returns 64-char hex string', async () => {
    const hash = await computeSHA256(new TextEncoder().encode('test').buffer as ArrayBuffer);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ─── Recovery Key ─────────────────────────────────────────────────────────────

describe('generateRecoveryKey', () => {
  it('returns 64-char hex string', () => {
    const key = generateRecoveryKey();
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it('generates unique keys', () => {
    expect(generateRecoveryKey()).not.toBe(generateRecoveryKey());
  });
});

describe('wrapMasterKeyWithRecovery / unwrapMasterKeyWithRecovery', () => {
  it('round-trips the master key', async () => {
    const salt = generateSalt();
    const masterKey = await deriveMasterKey('my-password', salt);
    const recoveryKey = generateRecoveryKey();

    const wrapped = await wrapMasterKeyWithRecovery(masterKey, recoveryKey);
    const unwrapped = await unwrapMasterKeyWithRecovery(wrapped, recoveryKey);

    const sub1 = await deriveSubKey(masterKey, 'file-encryption');
    const sub2 = await deriveSubKey(unwrapped, 'file-encryption');
    const raw1 = await crypto.subtle.exportKey('raw', sub1);
    const raw2 = await crypto.subtle.exportKey('raw', sub2);
    expect(new Uint8Array(raw1)).toEqual(new Uint8Array(raw2));
  });

  it('fails with wrong recovery key', async () => {
    const salt = generateSalt();
    const masterKey = await deriveMasterKey('my-password', salt);
    const rk1 = generateRecoveryKey();
    const rk2 = generateRecoveryKey();

    const wrapped = await wrapMasterKeyWithRecovery(masterKey, rk1);
    await expect(unwrapMasterKeyWithRecovery(wrapped, rk2)).rejects.toThrow();
  });
});

// ─── Export / Import ──────────────────────────────────────────────────────────

describe('exportKey / importKey', () => {
  it('round-trips a key', async () => {
    const original = await generateFileKey();
    const exported = await exportKey(original);
    const imported = await importKey(exported, ['encrypt', 'decrypt']);

    const rawOrig = await crypto.subtle.exportKey('raw', original);
    const rawImport = await crypto.subtle.exportKey('raw', imported);
    expect(new Uint8Array(rawOrig)).toEqual(new Uint8Array(rawImport));
  });
});
