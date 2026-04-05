# ─── Stage 1: Build ───────────────────────────────────────────────────────────
FROM node:20-alpine AS build

WORKDIR /app

# Copy dependency manifests first for layer caching
COPY package.json package-lock.json* ./

RUN npm ci --frozen-lockfile

# Copy the rest of the application source
COPY . .

# Build the Vite / React application
RUN npm run build

# ─── Stage 2: Serve ───────────────────────────────────────────────────────────
FROM nginx:alpine AS serve

# Remove the default nginx static files
RUN rm -rf /usr/share/nginx/html/*

# Copy compiled assets from the build stage
COPY --from=build /app/dist /usr/share/nginx/html

# Copy custom nginx configuration for SPA routing
COPY ../../infra/docker/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 3000

CMD ["nginx", "-g", "daemon off;"]
