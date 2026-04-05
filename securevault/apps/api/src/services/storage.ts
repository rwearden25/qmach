import {
  S3Client,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { Readable } from "node:stream";

// ─── Custom Error ─────────────────────────────────────────────────────────────

export class StorageError extends Error {
  public readonly code: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public override readonly cause?: unknown;

  constructor(message: string, code: string, cause?: unknown) {
    super(message);
    this.name = "StorageError";
    this.code = code;
    this.cause = cause;
  }
}

// ─── S3 Client Factory ────────────────────────────────────────────────────────

function buildS3Client(): S3Client {
  const accessKeyId = process.env["S3_ACCESS_KEY"];
  const secretAccessKey = process.env["S3_SECRET_KEY"];

  if (!accessKeyId || !secretAccessKey) {
    throw new StorageError(
      "S3_ACCESS_KEY and S3_SECRET_KEY environment variables are required",
      "STORAGE_MISCONFIGURED"
    );
  }

  const endpoint = process.env["S3_ENDPOINT"];
  return new S3Client({
    region: process.env["S3_REGION"] ?? "us-east-1",
    ...(endpoint !== undefined ? { endpoint } : {}),
    forcePathStyle: process.env["S3_FORCE_PATH_STYLE"] === "true",
    credentials: { accessKeyId, secretAccessKey },
  });
}

function getBucket(): string {
  const bucket = process.env["S3_BUCKET"];
  if (!bucket) {
    throw new StorageError("S3_BUCKET environment variable is required", "STORAGE_MISCONFIGURED");
  }
  return bucket;
}

// ─── Singleton client (lazily initialised) ───────────────────────────────────

let _s3: S3Client | undefined;
function getClient(): S3Client {
  if (!_s3) _s3 = buildS3Client();
  return _s3;
}

// ─── Blob Metadata ────────────────────────────────────────────────────────────

export interface BlobMetadata {
  key: string;
  sizeBytes: number;
  etag: string | undefined;
  lastModified: Date | undefined;
  contentType: string | undefined;
}

// ─── uploadBlob ───────────────────────────────────────────────────────────────

/**
 * Upload a blob to S3. Uses multipart upload via @aws-sdk/lib-storage so that
 * large files (> 5 MB) are chunked automatically without loading the whole
 * payload into memory.
 */
export async function uploadBlob(
  key: string,
  data: Buffer | Readable,
  contentLength?: number
): Promise<void> {
  const client = getClient();
  const Bucket = getBucket();

  try {
    const upload = new Upload({
      client,
      params: {
        Bucket,
        Key: key,
        Body: data,
        ContentType: "application/octet-stream",
        ...(contentLength !== undefined ? { ContentLength: contentLength } : {}),
      },
      // Increase part size to 10 MB for large uploads; SDK default is 5 MB.
      partSize: 10 * 1024 * 1024,
      // Allow up to 4 concurrent uploads.
      queueSize: 4,
    });

    await upload.done();
  } catch (err) {
    throw new StorageError(
      `Failed to upload blob "${key}"`,
      "UPLOAD_FAILED",
      err
    );
  }
}

// ─── downloadBlob ─────────────────────────────────────────────────────────────

/**
 * Download a blob from S3 and return it as a Node.js Readable stream. The
 * caller is responsible for consuming or destroying the stream.
 */
export async function downloadBlob(key: string): Promise<Readable> {
  const client = getClient();
  try {
    const response = await client.send(
      new GetObjectCommand({ Bucket: getBucket(), Key: key })
    );
    if (!response.Body) {
      throw new StorageError(`Empty body returned for key "${key}"`, "DOWNLOAD_EMPTY");
    }
    // AWS SDK v3 returns a SdkStreamMixin which is also a Node Readable in Node envs.
    return response.Body as Readable;
  } catch (err) {
    if (err instanceof StorageError) throw err;
    throw new StorageError(`Failed to download blob "${key}"`, "DOWNLOAD_FAILED", err);
  }
}

// ─── deleteBlob ───────────────────────────────────────────────────────────────

export async function deleteBlob(key: string): Promise<void> {
  const client = getClient();
  try {
    await client.send(new DeleteObjectCommand({ Bucket: getBucket(), Key: key }));
  } catch (err) {
    throw new StorageError(`Failed to delete blob "${key}"`, "DELETE_FAILED", err);
  }
}

// ─── getBlobMetadata ──────────────────────────────────────────────────────────

export async function getBlobMetadata(key: string): Promise<BlobMetadata> {
  const client = getClient();
  try {
    const response = await client.send(
      new HeadObjectCommand({ Bucket: getBucket(), Key: key })
    );
    return {
      key,
      sizeBytes: response.ContentLength ?? 0,
      etag: response.ETag?.replace(/"/g, ""),
      lastModified: response.LastModified,
      contentType: response.ContentType,
    };
  } catch (err) {
    throw new StorageError(`Failed to get metadata for blob "${key}"`, "METADATA_FAILED", err);
  }
}

// ─── generatePresignedUploadUrl ───────────────────────────────────────────────

/**
 * Generate a presigned PUT URL that allows direct client uploads to S3 without
 * routing binary data through this API server. Expires in `expiresIn` seconds.
 */
export async function generatePresignedUploadUrl(
  key: string,
  expiresIn: number
): Promise<string> {
  const client = getClient();
  try {
    return await getSignedUrl(
      client,
      new PutObjectCommand({
        Bucket: getBucket(),
        Key: key,
        ContentType: "application/octet-stream",
      }),
      { expiresIn }
    );
  } catch (err) {
    throw new StorageError(
      `Failed to generate presigned upload URL for "${key}"`,
      "PRESIGN_FAILED",
      err
    );
  }
}
