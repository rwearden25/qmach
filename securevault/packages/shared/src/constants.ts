// ─── Encryption Parameters ────────────────────────────────────────────────────

export const ARGON2_MEMORY = 65536 as const;
export const ARGON2_ITERATIONS = 3 as const;
export const ARGON2_PARALLELISM = 4 as const;
export const AES_KEY_LENGTH = 256 as const;
export const CHUNK_SIZE = 65536 as const;
export const IV_LENGTH = 12 as const;

// ─── Authentication Parameters ────────────────────────────────────────────────

export const ACCESS_TOKEN_EXPIRY = "15m" as const;
export const REFRESH_TOKEN_EXPIRY = "7d" as const;
export const TOTP_WINDOW = 1 as const;
export const MAX_BACKUP_CODES = 10 as const;
export const MFA_CHALLENGE_EXPIRY = 300_000 as const; // 5 minutes in ms

// ─── Rate Limits ──────────────────────────────────────────────────────────────

/** Max login attempts per window */
export const LOGIN_MAX = 5 as const;
/** Login rate limit window in ms (15 minutes) */
export const LOGIN_WINDOW = 900_000 as const;

/** Max MFA attempts per window */
export const MFA_MAX = 5 as const;
/** MFA rate limit window in ms (5 minutes) */
export const MFA_WINDOW = 300_000 as const;

/** Max upload requests per window */
export const UPLOAD_MAX = 100 as const;
/** Upload rate limit window in ms (1 hour) */
export const UPLOAD_WINDOW = 3_600_000 as const;

/** Max general API requests per window */
export const API_MAX = 1000 as const;
/** General API rate limit window in ms (1 minute) */
export const API_WINDOW = 60_000 as const;

// ─── Storage ──────────────────────────────────────────────────────────────────

/** Maximum file size in bytes (5 GiB) */
export const MAX_FILE_SIZE = 5_368_709_120 as const;
/** Maximum number of stored versions per file */
export const MAX_VERSIONS = 10 as const;
/** Days before trashed files are permanently deleted */
export const TRASH_RETENTION_DAYS = 30 as const;

// ─── Responsive Breakpoints (px) ─────────────────────────────────────────────

export const BREAKPOINT_MOBILE = 375 as const;
export const BREAKPOINT_TABLET = 768 as const;
export const BREAKPOINT_DESKTOP = 1024 as const;
export const BREAKPOINT_TV = 1920 as const;

// ─── Touch Targets (px) ───────────────────────────────────────────────────────

/** Minimum touch target size (WCAG 2.5.5) */
export const MIN_TOUCH = 44 as const;
/** Recommended touch target size on TV/10-foot UI */
export const TV_TOUCH = 56 as const;
/** Safe area inset for TV overscan */
export const TV_SAFE_AREA = 48 as const;
