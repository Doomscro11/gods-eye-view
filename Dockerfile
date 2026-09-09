# God's Eye View — production-oriented self-host image.
#
# Build the client once, then serve the compiled dist/ bundle through Vite's
# preview server. The existing proxy plugins implement configurePreviewServer,
# so the /api feed-proxy surface remains available without the dev server's
# HMR, source transforms, file watcher, and esbuild runtime overhead.
#
#   docker build -t gods-eye-view .
#   docker run --rm -p 4173:4173 gods-eye-view
#   # open http://localhost:4173
#
# Engines contract (package.json): Node >=24.14 <25 || >=26 <27.

FROM node:24-bookworm-slim

WORKDIR /app

# Puppeteer is present for QA only. Do not download a browser into the server
# image during npm ci.
ENV PUPPETEER_SKIP_DOWNLOAD=1

# Lockfile install first so source edits don't bust the dependency layer.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .

# Compile once at image-build time. Runtime serves dist/ and does not keep the
# Vite development transform/watch pipeline alive.
RUN npm run build \
    && mkdir -p /app/.gev-cache \
    && chown node:node /app/.gev-cache

# Public demo credentials are supplied by the deployment environment to the
# server-side proxy plugins. Provider Settings is intentionally unavailable in
# preview mode on shared/public instances.
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4173

EXPOSE 4173

# Drop root before accepting traffic. The runtime only needs write access to
# .gev-cache; application source and dist/ remain read-only.
USER node

CMD ["npm", "run", "start:prod"]
