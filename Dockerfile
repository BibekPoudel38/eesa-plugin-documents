FROM node:20-slim

WORKDIR /app

# node:20-slim is Debian (glibc) — REQUIRED. The heavy deps ship prebuilt
# binaries for glibc only: onnxruntime (via fastembed) and @napi-rs/canvas.
# An Alpine/musl base would fail to load them at runtime.
#   ca-certificates → HTTPS model/CDN downloads (FastEmbed, Tesseract)
#   fontconfig      → text rendering when rasterising PDF pages for OCR
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates fontconfig \
    && rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN npm install --omit=dev

COPY . .

# Bake the FastEmbed model into the image so the container starts WARM — no
# ~100MB cold download on the first search, and a runtime network blip can't
# stall indexing. Non-fatal: falls back to lazy download on first use.
RUN node scripts/prefetch.js || echo "prefetch skipped — model will download on first use"

ENV PORT=8080
EXPOSE 8080

CMD ["node", "src/server.js"]
