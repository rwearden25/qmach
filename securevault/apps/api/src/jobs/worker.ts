/**
 * Main worker entry point.
 *
 * Run as a separate process alongside the API server:
 *   node dist/jobs/worker.js
 *
 * Initialises all BullMQ workers, registers recurring jobs, and handles
 * graceful shutdown on SIGTERM / SIGINT.
 */

import { redis } from "../lib/redis.js";
import {
  createIntegrityWorker,
  scheduleIntegrityBatch,
} from "./integrityCheck.js";
import type { Worker } from "bullmq";

// ─── Worker registry ──────────────────────────────────────────────────────────

const workers: Worker[] = [];

// ─── Boot ─────────────────────────────────────────────────────────────────────

async function boot(): Promise<void> {
  console.log("[worker] Starting SecureVault background workers…");

  // Verify Redis is reachable before registering workers
  const pong = await redis.ping();
  if (pong !== "PONG") {
    throw new Error("[worker] Redis ping failed — cannot start workers");
  }
  console.log("[worker] Redis connection OK");

  // ── Integrity check worker ────────────────────────────────────────────────
  const integrityWorker = createIntegrityWorker();
  workers.push(integrityWorker as Worker);
  console.log("[worker] Integrity-check worker registered");

  // Schedule the recurring 24-hour batch job
  await scheduleIntegrityBatch();

  console.log("[worker] All workers running. Waiting for jobs…");
}

// ─── Graceful shutdown ────────────────────────────────────────────────────────

async function shutdown(signal: string): Promise<void> {
  console.log(`[worker] Received ${signal}. Shutting down gracefully…`);

  // Close all workers, allowing in-flight jobs to finish
  await Promise.allSettled(workers.map((w) => w.close()));

  // Disconnect Redis
  await redis.quit();

  console.log("[worker] Shutdown complete.");
  process.exit(0);
}

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

// ─── Unhandled rejection safety net ──────────────────────────────────────────

process.on("unhandledRejection", (reason: unknown) => {
  console.error("[worker] Unhandled rejection:", reason);
  // Do not exit — log and continue so other jobs are not disrupted
});

process.on("uncaughtException", (err: Error) => {
  console.error("[worker] Uncaught exception:", err.message, err.stack);
  // Exit after an uncaught exception as the process state may be corrupt
  process.exit(1);
});

// ─── Start ────────────────────────────────────────────────────────────────────

boot().catch((err: unknown) => {
  console.error("[worker] Failed to start:", err);
  process.exit(1);
});
