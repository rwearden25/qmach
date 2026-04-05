/**
 * SecureVault MFA client helpers
 *
 * Provides utilities for:
 *  - OTP input formatting and validation
 *  - WebAuthn feature detection, registration, and authentication
 *  - Backup-code normalisation
 */

/* ------------------------------------------------------------------ */
/* OTP helpers                                                          */
/* ------------------------------------------------------------------ */

/**
 * Strip every character that is not a decimal digit and limit the result
 * to 6 characters.  Safe to call on every keystroke in a controlled input.
 */
export function formatOTPInput(value: string): string {
  return value.replace(/\D/g, '').slice(0, 6);
}

/**
 * Return true when the code is exactly 6 decimal digits.
 */
export function isValidOTPCode(code: string): boolean {
  return /^\d{6}$/.test(code);
}

/* ------------------------------------------------------------------ */
/* WebAuthn helpers                                                     */
/* ------------------------------------------------------------------ */

/**
 * Return true when the browser supports the WebAuthn API.
 *
 * Checks for the existence of `PublicKeyCredential` on `window` in a way
 * that is safe in non-browser environments (SSR, Node, test runners) and
 * avoids a ReferenceError in environments where `window` is not defined.
 */
export function isWebAuthnAvailable(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.PublicKeyCredential !== 'undefined' &&
    typeof window.PublicKeyCredential === 'function'
  );
}

/**
 * Start a WebAuthn credential registration ceremony.
 *
 * Wraps `navigator.credentials.create()` with a consistent error surface:
 * - Throws a descriptive `Error` when WebAuthn is unavailable.
 * - Re-throws `DOMException` errors with their name attached so callers
 *   can distinguish "user cancelled" (`NotAllowedError`) from hardware
 *   failures, etc.
 *
 * @param options - The `PublicKeyCredentialCreationOptions` object
 *                  returned by the server's `/auth/webauthn/register/begin`
 *                  endpoint (challenge must already be a BufferSource).
 * @returns The newly created `PublicKeyCredential`.
 */
export async function startWebAuthnRegistration(
  options: PublicKeyCredentialCreationOptions,
): Promise<PublicKeyCredential> {
  if (!isWebAuthnAvailable()) {
    throw new Error(
      'WebAuthn is not available in this browser. ' +
        'Please use a security key or authenticator app instead.',
    );
  }

  let credential: Credential | null;

  try {
    credential = await navigator.credentials.create({ publicKey: options });
  } catch (err) {
    if (err instanceof DOMException) {
      throw new Error(`WebAuthn registration failed (${err.name}): ${err.message}`);
    }
    throw err;
  }

  if (!credential || credential.type !== 'public-key') {
    throw new Error('WebAuthn registration did not return a public-key credential.');
  }

  return credential as PublicKeyCredential;
}

/**
 * Start a WebAuthn authentication assertion ceremony.
 *
 * Wraps `navigator.credentials.get()` with the same error-handling
 * conventions as `startWebAuthnRegistration()`.
 *
 * @param options - The `PublicKeyCredentialRequestOptions` object
 *                  returned by the server's `/auth/webauthn/authenticate/begin`
 *                  endpoint.
 * @returns The signed `PublicKeyCredential` assertion.
 */
export async function startWebAuthnAuthentication(
  options: PublicKeyCredentialRequestOptions,
): Promise<PublicKeyCredential> {
  if (!isWebAuthnAvailable()) {
    throw new Error(
      'WebAuthn is not available in this browser. ' +
        'Please use your one-time code instead.',
    );
  }

  let credential: Credential | null;

  try {
    credential = await navigator.credentials.get({ publicKey: options });
  } catch (err) {
    if (err instanceof DOMException) {
      throw new Error(`WebAuthn authentication failed (${err.name}): ${err.message}`);
    }
    throw err;
  }

  if (!credential || credential.type !== 'public-key') {
    throw new Error('WebAuthn authentication did not return a public-key credential.');
  }

  return credential as PublicKeyCredential;
}

/* ------------------------------------------------------------------ */
/* Backup codes                                                         */
/* ------------------------------------------------------------------ */

/**
 * Normalise a backup code entered by the user:
 *  1. Trim leading/trailing whitespace.
 *  2. Convert to upper-case.
 *  3. Remove any dash or hyphen separators (e.g. "ABCD-1234" → "ABCD1234").
 *
 * The normalised value can then be compared directly against the stored
 * backup code hash.
 */
export function parseBackupCode(input: string): string {
  return input.trim().toUpperCase().replace(/-/g, '');
}
