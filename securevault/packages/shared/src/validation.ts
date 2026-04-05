import { z } from "zod";

// ─── Auth Schemas ─────────────────────────────────────────────────────────────

export const registerSchema = z.object({
  email: z
    .string({ required_error: "Email is required" })
    .email("Must be a valid email address")
    .toLowerCase()
    .trim(),
  password: z
    .string({ required_error: "Password is required" })
    .min(8, "Password must be at least 8 characters"),
  displayName: z
    .string({ required_error: "Display name is required" })
    .min(1, "Display name cannot be empty")
    .max(100, "Display name must be 100 characters or fewer")
    .trim(),
});

export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  email: z
    .string({ required_error: "Email is required" })
    .email("Must be a valid email address")
    .toLowerCase()
    .trim(),
  password: z.string({ required_error: "Password is required" }).min(1, "Password is required"),
});

export type LoginInput = z.infer<typeof loginSchema>;

export const mfaVerifySchema = z.object({
  challengeToken: z
    .string({ required_error: "Challenge token is required" })
    .min(1, "Challenge token is required"),
  code: z
    .string({ required_error: "MFA code is required" })
    .regex(/^\d{6}$/, "Code must be exactly 6 digits"),
  method: z.enum(["totp", "webauthn", "backup_code"], {
    required_error: "MFA method is required",
    invalid_type_error: "Invalid MFA method",
  }),
});

export type MfaVerifyInput = z.infer<typeof mfaVerifySchema>;

export const passwordChangeSchema = z
  .object({
    currentPassword: z
      .string({ required_error: "Current password is required" })
      .min(1, "Current password is required"),
    newPassword: z
      .string({ required_error: "New password is required" })
      .min(8, "New password must be at least 8 characters"),
    confirmPassword: z
      .string({ required_error: "Please confirm your new password" })
      .min(1, "Please confirm your new password"),
    revokeOtherSessions: z.boolean().optional().default(false),
  })
  .refine((data) => data.newPassword === data.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });

export type PasswordChangeInput = z.infer<typeof passwordChangeSchema>;

// ─── File / Folder Schemas ────────────────────────────────────────────────────

export const fileUploadSchema = z.object({
  name: z
    .string({ required_error: "File name is required" })
    .min(1, "File name cannot be empty")
    .max(255, "File name must be 255 characters or fewer")
    .trim(),
  mimeType: z
    .string({ required_error: "MIME type is required" })
    .min(1, "MIME type is required"),
  sizeBytes: z
    .number({ required_error: "File size is required" })
    .int("File size must be an integer")
    .positive("File size must be positive")
    .max(5_368_709_120, "File exceeds the 5 GiB maximum size"),
  folderId: z.string().uuid("Folder ID must be a valid UUID").optional(),
});

export type FileUploadInput = z.infer<typeof fileUploadSchema>;

export const folderCreateSchema = z.object({
  name: z
    .string({ required_error: "Folder name is required" })
    .min(1, "Folder name cannot be empty")
    .max(255, "Folder name must be 255 characters or fewer")
    .trim(),
  parentId: z.string().uuid("Parent ID must be a valid UUID").optional(),
});

export type FolderCreateInput = z.infer<typeof folderCreateSchema>;

// ─── Share Schema ─────────────────────────────────────────────────────────────

export const shareCreateSchema = z.object({
  fileId: z
    .string({ required_error: "File ID is required" })
    .uuid("File ID must be a valid UUID"),
  sharedWithUserId: z.string().uuid("User ID must be a valid UUID").optional(),
  permission: z.enum(["view", "download", "edit"], {
    required_error: "Permission is required",
    invalid_type_error: "Permission must be view, download, or edit",
  }),
  expiresAt: z
    .string()
    .datetime({ message: "expiresAt must be a valid ISO 8601 datetime" })
    .optional(),
  maxDownloads: z
    .number()
    .int("Max downloads must be an integer")
    .positive("Max downloads must be positive")
    .optional(),
  password: z
    .string()
    .min(1, "Password cannot be empty")
    .optional(),
});

export type ShareCreateInput = z.infer<typeof shareCreateSchema>;
