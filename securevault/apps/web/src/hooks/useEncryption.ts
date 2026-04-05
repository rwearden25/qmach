/**
 * useEncryption – React hook for all client-side encryption operations.
 *
 * Wraps the Web Crypto engine in crypto.ts and provides:
 *  - Vault unlock / lock (master-key derivation + auto-lock)
 *  - Full encrypt-and-prepare-upload pipeline
 *  - Full decrypt-download pipeline
 *
 * The master CryptoKey lives only in React state — it is never serialised,
 * never persisted, and is cleared on lock() or after 30 minutes of inactivity.
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import {
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
  generateSalt,
} from '../lib/crypto';

/* ------------------------------------------------------------------ */
/* Types                                                                */
/* ------------------------------------------------------------------ */

/** Everything the upload API endpoint expects for a single file. */
export interface PreparedUpload {
  /** The AES-256-GCM encrypted file blob. Field name: encryptedBlob. */
  encryptedBlob: Blob;
  /** Base64-encoded AES-KW-wrapped File Encryption Key. */
  wrappedFileKey: string;
  /** Base64(IV + ciphertext) for the original filename. */
  encryptedName: string;
  /** Base64(IV + ciphertext) for the original MIME type. */
  encryptedMimeType: string;
  /** Base64(IV + ciphertext) for the original file size (decimal string). */
  encryptedSize: string;
  /** JSON array of base64 IVs, one per chunk (or single-element for small files). */
  ivs: string;
  /** SHA-256 hex of the original plaintext bytes. */
  plaintextHash: string;
  /** SHA-256 hex of the encrypted blob bytes. */
  ciphertextHash: string;
}

/** Decrypted file data returned from the download pipeline. */
export interface DecryptedDownload {
  blob: Blob;
  filename: string;
  mimeType: string;
}

/* ------------------------------------------------------------------ */
/* Constants                                                            */
/* ------------------------------------------------------------------ */

/** Auto-lock the vault after 30 minutes of inactivity (in ms). */
const AUTO_LOCK_MS = 30 * 60 * 1000;

/* ------------------------------------------------------------------ */
/* Hook                                                                 */
/* ------------------------------------------------------------------ */

export function useEncryption() {
  const [masterKey, setMasterKey] = useState<CryptoKey | null>(null);
  const [isUnlocked, setIsUnlocked] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Auto-lock timer ref — reset on every operation
  const autoLockTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /* ---- Auto-lock management ---- */

  const scheduleAutoLock = useCallback(() => {
    if (autoLockTimerRef.current !== null) {
      clearTimeout(autoLockTimerRef.current);
    }
    autoLockTimerRef.current = setTimeout(() => {
      setMasterKey(null);
      setIsUnlocked(false);
    }, AUTO_LOCK_MS);
  }, []);

  const resetAutoLock = useCallback(() => {
    if (isUnlocked) {
      scheduleAutoLock();
    }
  }, [isUnlocked, scheduleAutoLock]);

  // Clean up the timer when the component unmounts
  useEffect(() => {
    return () => {
      if (autoLockTimerRef.current !== null) {
        clearTimeout(autoLockTimerRef.current);
      }
    };
  }, []);

  /* ---- unlock ---- */

  /**
   * Derive the master key from the user's password and their stored salt
   * (stored server-side as hex; pass the hex string directly).
   */
  const unlock = useCallback(
    async (password: string, saltHex: string): Promise<void> => {
      setIsProcessing(true);
      setError(null);

      try {
        // Decode salt from hex
        const saltBytes = new Uint8Array(saltHex.length / 2);
        for (let i = 0; i < saltBytes.length; i++) {
          saltBytes[i] = parseInt(saltHex.slice(i * 2, i * 2 + 2), 16);
        }

        const key = await deriveMasterKey(password, saltBytes);
        setMasterKey(key);
        setIsUnlocked(true);
        scheduleAutoLock();
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Failed to unlock vault';
        setError(message);
        throw new Error(message);
      } finally {
        setIsProcessing(false);
      }
    },
    [scheduleAutoLock],
  );

  /* ---- lock ---- */

  /** Clear the master key from memory immediately. */
  const lock = useCallback((): void => {
    if (autoLockTimerRef.current !== null) {
      clearTimeout(autoLockTimerRef.current);
      autoLockTimerRef.current = null;
    }
    setMasterKey(null);
    setIsUnlocked(false);
    setError(null);
  }, []);

  /* ---- encryptAndPrepareUpload ---- */

  /**
   * Full encryption pipeline for a single file:
   *  1. Generate a fresh File Encryption Key (FEK).
   *  2. Encrypt the file with the FEK (chunked for large files).
   *  3. Encrypt each piece of metadata (name, MIME type, size) with the
   *     metadata sub-key derived from the master key.
   *  4. Wrap the FEK with the key-wrapping sub-key.
   *  5. Compute SHA-256 of both the plaintext and the ciphertext.
   *
   * Returns a {@link PreparedUpload} ready to POST to the files/upload endpoint.
   */
  const encryptAndPrepareUpload = useCallback(
    async (file: File): Promise<PreparedUpload> => {
      if (!masterKey) {
        throw new Error('Vault is locked. Call unlock() first.');
      }

      setIsProcessing(true);
      setError(null);
      resetAutoLock();

      try {
        // Derive purpose-specific sub-keys from the master key
        const [metadataKey, wrappingKey] = await Promise.all([
          deriveSubKey(masterKey, 'metadata-encryption'),
          deriveSubKey(masterKey, 'key-wrapping'),
        ]);

        // Generate a unique File Encryption Key for this file
        const fileKey = await generateFileKey();

        // Encrypt the file content
        const { encrypted: encryptedBlob, iv: ivs } = await encryptFile(
          file,
          fileKey,
        );

        // Encrypt metadata strings in parallel
        const [encryptedName, encryptedMimeType, encryptedSize] =
          await Promise.all([
            encryptMetadata(file.name, metadataKey),
            encryptMetadata(file.type || 'application/octet-stream', metadataKey),
            encryptMetadata(String(file.size), metadataKey),
          ]);

        // Wrap the FEK so it can be stored server-side
        const wrappedFileKey = await wrapKey(fileKey, wrappingKey);

        // Compute integrity hashes
        const [plaintextHash, ciphertextHash] = await Promise.all([
          computeSHA256(file),
          computeSHA256(encryptedBlob),
        ]);

        return {
          encryptedBlob,
          wrappedFileKey,
          encryptedName,
          encryptedMimeType,
          encryptedSize,
          ivs,
          plaintextHash,
          ciphertextHash,
        };
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Encryption failed';
        setError(message);
        throw new Error(message);
      } finally {
        setIsProcessing(false);
      }
    },
    [masterKey, resetAutoLock],
  );

  /* ---- decryptDownload ---- */

  /**
   * Full decryption pipeline for a downloaded file:
   *  1. Derive the metadata and key-wrapping sub-keys.
   *  2. Unwrap the FEK.
   *  3. Decrypt the encrypted blob.
   *  4. Decrypt filename and MIME type metadata.
   *
   * Returns a {@link DecryptedDownload} with the plaintext blob and
   * decrypted metadata.
   */
  const decryptDownload = useCallback(
    async (
      encryptedBlob: Blob,
      wrappedFileKey: string,
      encryptedName: string,
      encryptedMimeType: string,
      ivs: string,
    ): Promise<DecryptedDownload> => {
      if (!masterKey) {
        throw new Error('Vault is locked. Call unlock() first.');
      }

      setIsProcessing(true);
      setError(null);
      resetAutoLock();

      try {
        // Derive the same sub-keys that were used during upload
        const [metadataKey, wrappingKey] = await Promise.all([
          deriveSubKey(masterKey, 'metadata-encryption'),
          deriveSubKey(masterKey, 'key-wrapping'),
        ]);

        // Unwrap the File Encryption Key
        const fileKey = await unwrapKey(wrappedFileKey, wrappingKey);

        // Decrypt file content and metadata in parallel
        const [plaintextBlob, filename, mimeType] = await Promise.all([
          decryptFile(encryptedBlob, fileKey, ivs),
          decryptMetadata(encryptedName, metadataKey),
          decryptMetadata(encryptedMimeType, metadataKey),
        ]);

        // Re-type the blob with the correct MIME type for browser rendering
        const typedBlob = new Blob([await plaintextBlob.arrayBuffer()], {
          type: mimeType,
        });

        return { blob: typedBlob, filename, mimeType };
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Decryption failed';
        setError(message);
        throw new Error(message);
      } finally {
        setIsProcessing(false);
      }
    },
    [masterKey, resetAutoLock],
  );

  /* ---- generateNewSalt ---- */

  /**
   * Convenience wrapper — generate a fresh 32-byte salt and return it as
   * a hex string, ready to be stored alongside the user record.
   */
  const generateNewSalt = useCallback((): string => {
    const bytes = generateSalt();
    return Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }, []);

  return {
    /** True when the master key is present in memory. */
    isUnlocked,
    /** True while an encryption/decryption operation is running. */
    isProcessing,
    /** Last error message, if any. */
    error,
    /** Derive master key from password + salt hex string and store in state. */
    unlock,
    /** Clear master key from memory immediately. */
    lock,
    /** Encrypt a File and return everything needed for the upload API call. */
    encryptAndPrepareUpload,
    /** Unwrap FEK and decrypt an encrypted blob from the server. */
    decryptDownload,
    /** Generate a fresh hex-encoded 32-byte salt. */
    generateNewSalt,
  };
}
