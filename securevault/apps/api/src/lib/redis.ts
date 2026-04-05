import Redis from "ioredis";

const redisUrl = process.env["REDIS_URL"];

if (!redisUrl) {
  throw new Error("REDIS_URL environment variable is required");
}

export const redis = new Redis(redisUrl, {
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  lazyConnect: false,
});

redis.on("connect", () => {
  console.log("[redis] connected");
});

redis.on("error", (err: Error) => {
  console.error("[redis] connection error:", err.message);
});

redis.on("close", () => {
  console.warn("[redis] connection closed");
});
