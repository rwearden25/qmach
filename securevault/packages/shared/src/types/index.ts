// ─── Enums ────────────────────────────────────────────────────────────────────

export type UserRole = "owner" | "admin" | "member" | "viewer";

export type MfaMethod = "totp" | "webauthn" | "backup_code";

export type FileStatus = "active" | "trashed" | "deleted";

export type SharePermission = "view" | "download" | "edit";

export type AuditAction =
  | "login"
  | "logout"
  | "login_failed"
  | "mfa_verified"
  | "mfa_failed"
  | "file_upload"
  | "file_download"
  | "file_delete"
  | "file_restore"
  | "file_share"
  | "file_unshare"
  | "folder_create"
  | "folder_delete"
  | "password_change"
  | "mfa_enabled"
  | "mfa_disabled"
  | "session_revoked"
  | "integrity_check";

export type IntegrityStatus = "pending" | "valid" | "tampered" | "missing";

// ─── Core Models ──────────────────────────────────────────────────────────────

export interface User {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
  mfaEnabled: boolean;
  mfaMethods: MfaMethod[];
  storageUsedBytes: number;
  storageQuotaBytes: number;
  createdAt: Date;
  updatedAt: Date;
  lastLoginAt: Date | null;
  isActive: boolean;
}

export interface Session {
  id: string;
  userId: string;
  deviceName: string | null;
  deviceOs: string | null;
  ipAddress: string;
  userAgent: string;
  createdAt: Date;
  expiresAt: Date;
  lastActiveAt: Date;
  isCurrent: boolean;
}

export interface Folder {
  id: string;
  ownerId: string;
  parentId: string | null;
  name: string;
  path: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface File {
  id: string;
  ownerId: string;
  folderId: string | null;
  name: string;
  mimeType: string;
  sizeBytes: number;
  encryptedSizeBytes: number;
  checksumSha256: string;
  encryptedKeyBase64: string;
  ivBase64: string;
  status: FileStatus;
  versionCount: number;
  createdAt: Date;
  updatedAt: Date;
  trashedAt: Date | null;
}

export interface FileVersion {
  id: string;
  fileId: string;
  versionNumber: number;
  sizeBytes: number;
  encryptedSizeBytes: number;
  checksumSha256: string;
  encryptedKeyBase64: string;
  ivBase64: string;
  createdAt: Date;
  createdBy: string;
  note: string | null;
}

export interface FileShare {
  id: string;
  fileId: string;
  sharedByUserId: string;
  sharedWithUserId: string | null;
  shareToken: string | null;
  permission: SharePermission;
  expiresAt: Date | null;
  downloadCount: number;
  maxDownloads: number | null;
  passwordProtected: boolean;
  createdAt: Date;
  revokedAt: Date | null;
}

export interface AuditLog {
  id: string;
  userId: string;
  action: AuditAction;
  resourceType: string | null;
  resourceId: string | null;
  ipAddress: string;
  userAgent: string;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
}

export interface IntegrityCheck {
  id: string;
  fileId: string;
  status: IntegrityStatus;
  expectedChecksum: string;
  actualChecksum: string | null;
  checkedAt: Date;
  triggeredBy: string;
}

export interface WebAuthnCredential {
  id: string;
  userId: string;
  credentialId: string;
  publicKey: string;
  counter: number;
  deviceName: string | null;
  aaguid: string;
  transports: string[];
  createdAt: Date;
  lastUsedAt: Date | null;
}

// ─── API Request Types ────────────────────────────────────────────────────────

export interface RegisterRequest {
  email: string;
  password: string;
  displayName: string;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface MfaVerifyRequest {
  challengeToken: string;
  code: string;
  method: MfaMethod;
}

export interface PasswordChangeRequest {
  currentPassword: string;
  newPassword: string;
  revokeOtherSessions?: boolean;
}

export interface FileUploadRequest {
  name: string;
  mimeType: string;
  sizeBytes: number;
  folderId?: string;
}

export interface FolderCreateRequest {
  name: string;
  parentId?: string;
}

export interface ShareCreateRequest {
  fileId: string;
  sharedWithUserId?: string;
  permission: SharePermission;
  expiresAt?: string;
  maxDownloads?: number;
  password?: string;
}

// ─── API Response Types ───────────────────────────────────────────────────────

export interface ApiResponse<T> {
  success: boolean;
  data: T;
  requestId: string;
}

export interface ApiError {
  success: false;
  error: {
    code: string;
    message: string;
    details?: Record<string, string[]>;
  };
  requestId: string;
}

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  hasNextPage: boolean;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface LoginResponse {
  tokens?: AuthTokens;
  mfaRequired: boolean;
  challengeToken?: string;
  allowedMethods?: MfaMethod[];
}

export interface RegisterResponse {
  user: User;
  tokens: AuthTokens;
}

export interface FileUploadResponse {
  file: File;
  uploadUrl: string;
  uploadFields: Record<string, string>;
}

export interface StorageStats {
  usedBytes: number;
  quotaBytes: number;
  fileCount: number;
  folderCount: number;
}
