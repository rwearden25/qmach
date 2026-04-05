import { Queue, Worker, type Job } from "bullmq";
import { redis } from "../lib/redis.js";
import {
  verifyBlobIntegrity,
  runIntegrityBatch,
} from "../services/integrity.js";

// ─── Queue ────────────────────────────────────────────────────────────────────

export const integrityQueue = new Queue("integrity-checks", {
  connection: redis,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 5_000 },
    removeOnComplete: { count: 200 },
    removeOnFail: { count: 500 },
  },
});

// ─── Job payloads ─────────────────────────────────────────────────────────────

export interface VerifyFilJobData {
  type: "verify-file";
  fileId: string;
}

export interface BatchJobData {
  type: "batch";
  batchSize: number;
}

export type IntegrityJobData = VerifyFilJobData | BatchJobData;

// ─── Worker ───────────────────────────────────────────────────────────────────

export function createIntegrityWorker(): Worker<IntegrityJobData> {
  const worker = new Worker<IntegrityJobData>(
    "integrity-checks",
    async (job: Job<IntegrityJobData>) => {
      const { data } = job;

      if (data.type === "verify-file") {
        console.log(`[integrity-worker] Verifying file ${data.fileId}`);
        const result = await verifyBlobIntegrity(data.fileId);
        console.log(
          `[integrity-worker] File ${data.fileId} → status=${result.status}`
        );
        return result;
      }

      if (data.type === "batch") {
        console.log(
          `[integrity-worker] Running batch (size=${data.batchSize})`
        );
        const summary = await runIntegrityBatch(data.batchSize);
        console.log(
          `[integrity-worker] Batch done — checked=${summary.checked} passed=${summary.passed} failed=${summary.failed} errors=${summary.errors}`
        );
        return summary;
      }

      // Exhaustive check — should never reach here in well-typed code
      throw new Error(`Unknown job type: ${JSON.stringify(data)}`);
    },
    {
      connection: redis,
      concurrency: 2,
    }
  );

  worker.on("completed", (job: Job<IntegrityJobData>) => {
    console.log(`[integrity-worker] Job ${job.id} completed`);
  });

  worker.on("failed", (job: Job<IntegrityJobData> | undefined, err: Error) => {
    console.error(
      `[integrity-worker] Job ${job?.id ?? "unknown"} failed:`,
      err.message
    );
  });

  return worker;
}

// ─── Recurring batch schedule ─────────────────────────────────────────────────

const BATCH_JOB_NAME = "daily-integrity-batch";
const BATCH_SIZE = 100;

/**
 * Register the recurring daily integrity batch job.
 * Uses BullMQ's built-in `repeat` option (cron expression: every 24 hours).
 * Safe to call multiple times — BullMQ deduplicates by job name + pattern.
 */
export async function scheduleIntegrityBatch(): Promise<void> {
  await integrityQueue.add(
    BATCH_JOB_NAME,
    { type: "batch", batchSize: BATCH_SIZE },
    {
      repeat: { pattern: "0 2 * * *" }, // 02:00 UTC daily
      jobId: BATCH_JOB_NAME,            // stable ID prevents duplicate schedules
    }
  );
  console.log(
    `[integrity] Recurring batch job scheduled (cron: 0 2 * * *, batchSize: ${BATCH_SIZE})`
  );
}

// ─── One-off helpers (for use from API routes or admin scripts) ───────────────

/**
 * Enqueue an immediate integrity check for a single file.
 */
export async function enqueueFileCheck(fileId: string): Promise<void> {
  await integrityQueue.add(
    "verify-file",
    { type: "verify-file", fileId },
    { jobId: `verify-file:${fileId}` }
  );
}
