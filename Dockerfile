FROM node:20-alpine

WORKDIR /app

# Install dependencies for better-sqlite3 native build
RUN apk add --no-cache python3 make g++

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

# Ensure data directory exists (Railway volume will mount here)
RUN mkdir -p /data

EXPOSE 3000

CMD ["node", "server.js"]
