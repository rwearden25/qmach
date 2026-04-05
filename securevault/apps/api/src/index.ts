import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import helmet from "helmet";
import cors from "cors";
import cookieParser from "cookie-parser";
import { prisma } from "./lib/prisma.js";
import { redis } from "./lib/redis.js";
import { authenticate } from "./middleware/auth.js";
import { authRouter } from "./routes/auth.js";
import { filesRouter } from "./routes/files.js";
import { foldersRouter } from "./routes/folders.js";
import { accountRouter } from "./routes/account.js";

const app = express();

// ---------------------------------------------------------------------------
// Security headers
// ---------------------------------------------------------------------------
const s3Endpoint = process.env["S3_ENDPOINT"] ?? "";

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "blob:", "data:"],
        connectSrc: ["'self'", ...(s3Endpoint ? [s3Endpoint] : [])],
      },
    },
  })
);

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------
const allowedOrigins = (process.env["CORS_ORIGINS"] ?? "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: allowedOrigins.length > 0 ? allowedOrigins : true,
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// ---------------------------------------------------------------------------
// Body parsers & cookie parser
// ---------------------------------------------------------------------------
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));
app.use(cookieParser());

// ---------------------------------------------------------------------------
// Health checks  (outside auth middleware)
// ---------------------------------------------------------------------------
app.get("/health/live", (_req: Request, res: Response) => {
  res.status(200).json({ status: "ok" });
});

app.get("/health/ready", async (_req: Request, res: Response) => {
  const checks: Record<string, string> = {};
  let healthy = true;

  // Database check
  try {
    await prisma.$queryRaw`SELECT 1`;
    checks["db"] = "ok";
  } catch (err) {
    checks["db"] = "error";
    healthy = false;
  }

  // Redis check
  try {
    const pong = await redis.ping();
    checks["redis"] = pong === "PONG" ? "ok" : "error";
    if (pong !== "PONG") healthy = false;
  } catch (err) {
    checks["redis"] = "error";
    healthy = false;
  }

  res.status(healthy ? 200 : 503).json({ status: healthy ? "ok" : "degraded", checks });
});

// ---------------------------------------------------------------------------
// Auth middleware applied to all /api/* routes except public auth endpoints
// ---------------------------------------------------------------------------
// When mounted at /api, req.path inside this handler is relative to /api,
// so "/api/auth/login" becomes "/auth/login".
const PUBLIC_API_PATHS = new Set([
  "/auth/login",
  "/auth/register",
  "/auth/mfa-verify",
  "/auth/refresh",
]);

app.use("/api", (req: Request, res: Response, next: NextFunction) => {
  if (PUBLIC_API_PATHS.has(req.path)) {
    next();
    return;
  }
  authenticate(req, res, next);
});

// ---------------------------------------------------------------------------
// Route modules
// ---------------------------------------------------------------------------
app.use("/api/auth", authRouter);
app.use("/api/files", filesRouter);
app.use("/api/folders", foldersRouter);
app.use("/api/account", accountRouter);

// ---------------------------------------------------------------------------
// 404 handler
// ---------------------------------------------------------------------------
app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: "Not found" });
});

// ---------------------------------------------------------------------------
// Global error handler
// ---------------------------------------------------------------------------
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof Error) {
    console.error("[error]", err.message, err.stack);
    res.status(500).json({ error: "Internal server error" });
  } else {
    console.error("[error] unknown error", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------
const PORT = Number(process.env["PORT"] ?? 4000);

app.listen(PORT, () => {
  console.log(`[api] listening on port ${PORT}`);
});

export { app };
