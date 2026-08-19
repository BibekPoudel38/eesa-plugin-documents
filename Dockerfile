FROM node:20-slim

WORKDIR /app

# node:20-slim is Debian (glibc) — REQUIRED. The heavy deps ship prebuilt
# binaries for glibc only: onnxruntime (via fastembed) and @napi-rs/canvas.
# An Alpine/musl base would fail to load them at runtime.
#   ca-certificates → HTTPS model/CDN downloads (FastEmbed, Tesseract)
#   fontconfig      → text rendering when rasterising PDF pages for OCR
#   curl            → the deploy healthcheck, which Coolify runs INSIDE the
#                     container. node:20-slim has neither curl nor wget, so the
#                     check could never pass ("/bin/sh: 1: curl: not found"),
#                     every attempt was scored unhealthy and the deploy rolled
#                     back to the old container — with the new one booting
#                     perfectly the whole time. Without a passing healthcheck
#                     Coolify cannot do a wait-then-swap at all, so this ~2MB
#                     package is what buys zero-downtime deploys.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates fontconfig curl \
    && rm -rf /var/lib/apt/lists/*

# `npm ci` from the committed lockfile, NOT `npm install`. Without the lockfile
# every rebuild re-resolved the `^` ranges, so the image that passed review and
# the image that shipped a week later were not the same code. `ci` also fails
# loudly when package.json and the lock disagree, instead of quietly updating.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# Bake the FastEmbed model into the image so the container starts WARM — no
# ~100MB cold download on the first search, and a runtime network blip can't
# stall indexing. Non-fatal: falls back to lazy download on first use.
RUN node scripts/prefetch.js || echo "prefetch skipped — model will download on first use"

ENV PORT=8080
EXPOSE 8080

CMD ["node", "src/server.js"]
