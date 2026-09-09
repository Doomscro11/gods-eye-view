# God's Eye View — one-command self-host.
#
# The app is a Vite dev server whose middleware doubles as the CORS-bypassing
# feed proxies (/api/celestrak, /api/adsblol, /api/overpass, …), so the
# supported runtime is `npm run dev` — the same command as the local Quick
# Start. Build the image, run the container, open the port.
#
#   docker build -t gods-eye-view .
#   docker run --rm -p 4173:4173 gods-eye-view
#   # open http://localhost:4173
#
# Engines contract (package.json): Node >=24.14 <25 || >=26 <27.

FROM node:24-bookworm-slim

WORKDIR /app

# puppeteer ships in devDependencies for the QA harness; its browser download
# is dead weight in a server image and fails on sandboxes without Chrome.
ENV PUPPETEER_SKIP_DOWNLOAD=1

# Lockfile install first so source edits don't bust the dependency layer.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .

# Optional keys (Cesium ion, Google Maps) are NOT baked in — add them at
# runtime through the app's POWER UP panel, or pass -e CESIUM_ION_TOKEN=… /
# -e GOOGLE_MAPS_API_KEY=… to docker run.
ENV PORT=4173
EXPOSE 4173

CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0", "--port", "4173"]
