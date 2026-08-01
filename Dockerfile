# syntax=docker/dockerfile:1

# Packages the built Astro standalone Node backend.
# Build:  docker build -t ultimatevienna .
# Run:    docker run --rm -p 8080:8080 --env-file .env ultimatevienna
# The server entry is dist/server/entry.mjs (Astro @astrojs/node standalone).

# ---- Build stage: install deps and build the standalone server ----
FROM node:22-slim AS build
WORKDIR /app

# Install dependencies first for better layer caching.
COPY package.json package-lock.json ./
RUN npm ci

# Build. Outputs dist/server/entry.mjs (the Node server) + dist/client (static
# assets the server serves).
COPY . .
RUN npm run build

# Drop devDependencies so the runtime image only carries what the server needs
# at runtime. (Vite externalizes runtime imports like googleapis/resend, so the
# bundle still needs node_modules present.)
RUN npm prune --omit=dev

# ---- Runtime stage: slim image that serves the built backend ----
FROM node:22-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production
# @astrojs/node standalone binds to HOST:PORT. 0.0.0.0 so the server is
# reachable outside the container; 8080 is the adapter default.
ENV HOST=0.0.0.0
ENV PORT=8080

COPY --chown=node:node package.json ./
COPY --chown=node:node --from=build /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/dist ./dist

USER node
EXPOSE 8080
CMD ["node", "./dist/server/entry.mjs"]