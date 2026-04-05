# ─── Stage 1: Build ───────────────────────────────────────────────────────────
FROM node:20-alpine AS build

WORKDIR /app

# Install build tools required for native addons (e.g. bcrypt)
RUN apk add --no-cache python3 make g++

# Copy dependency manifests for layer caching
COPY package.json package-lock.json* ./
COPY prisma ./prisma/

RUN npm ci --frozen-lockfile

# Generate the Prisma client before building TypeScript
RUN npx prisma generate

# Copy the rest of the application source
COPY . .

# Compile TypeScript to dist/
RUN npm run build

# ─── Stage 2: Run ─────────────────────────────────────────────────────────────
FROM node:20-alpine AS run

WORKDIR /app

RUN apk add --no-cache openssl

# Copy only what the runtime needs
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/package.json ./package.json

# Worker does not expose a port — it consumes jobs from the queue
CMD ["node", "dist/jobs/worker.js"]
