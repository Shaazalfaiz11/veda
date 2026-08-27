# Single image carrying both halves of the app: the Next server and the queue
# worker. They share the prepared page bitmaps on disk, so they share a
# container and a volume — see scripts/start-production.mjs for why.

FROM node:22-bookworm-slim

# sharp, @napi-rs/canvas and onnxruntime-node ship prebuilt binaries but still
# link against the system C++ runtime and fontconfig; pdf.js needs fonts to
# rasterise a page that names one.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       libstdc++6 \
       libfontconfig1 \
       fonts-dejavu-core \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV NODE_ENV=production

# Model weights live inside the image rather than being fetched on first
# request: a cold start that has to download 90MB before it can map anything
# turns the first assessment into a timeout.
ENV HF_HOME=/app/.cache/huggingface
ENV TRANSFORMERS_CACHE=/app/.cache/huggingface

# Dependencies first, so a source change does not reinstall them. Dev
# dependencies are needed here: the build runs the TypeScript compiler, and the
# worker is started through tsx at runtime.
COPY package.json package-lock.json ./
RUN npm ci --include=dev

COPY . .

RUN npm run build

# Warm the embedding cache at build time. It is a network fetch, so it is
# allowed to fail — the runtime download path still exists as the fallback.
RUN node --import tsx -e "import('./lib/providers/embeddings/local-embedding-provider.ts').then(m => m.LocalEmbeddingProvider ? new m.LocalEmbeddingProvider().embed(['warm']) : null)" \
  || echo "embedding warm-up skipped; the model will download on first use"

# Where uploads and prepared pages live. Mount a persistent volume here, or
# every restart loses the assessments already processed.
ENV STORAGE_ROOT=/app/.storage
RUN mkdir -p /app/.storage

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

CMD ["node", "scripts/start-production.mjs"]
