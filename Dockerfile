FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json .npmrc ./
RUN npm ci
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
COPY package*.json .npmrc ./
RUN npm ci --omit=dev

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000 STYLE_DATA_DIR=/data
RUN groupadd --gid 1001 style && useradd --uid 1001 --gid 1001 --no-create-home style && mkdir /data && chown style:style /data && chmod 700 /data
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=build --chown=style:style /app/.next/standalone ./
COPY --from=build --chown=style:style /app/.next/static ./.next/static
COPY --from=build --chown=style:style /app/src/server ./src/server
COPY --from=build --chown=style:style /app/src/domain ./src/domain
COPY --from=build --chown=style:style /app/scripts/analysis-worker.ts ./scripts/analysis-worker.ts
COPY --from=build --chown=style:style /app/scripts/mail-worker.ts ./scripts/mail-worker.ts
COPY --from=build --chown=style:style /app/scripts/init-auth.ts ./scripts/init-auth.ts
COPY --from=build --chown=style:style /app/scripts/backup-database.ts ./scripts/backup-database.ts
COPY --from=build --chown=style:style /app/scripts/restore-database.ts ./scripts/restore-database.ts
COPY --from=build --chown=style:style /app/scripts/export-deletion-ledger.ts ./scripts/export-deletion-ledger.ts
COPY --from=build --chown=style:style /app/scripts/cleanup-deleted-data.ts ./scripts/cleanup-deleted-data.ts
COPY --from=build --chown=style:style /app/scripts/backup-encrypted.ts ./scripts/backup-encrypted.ts
COPY --from=build --chown=style:style /app/scripts/restore-encrypted.ts ./scripts/restore-encrypted.ts
COPY --from=build --chown=style:style /app/tsconfig.json ./tsconfig.json
USER style
EXPOSE 3000
CMD ["node", "server.js"]

# Supply the optional layer with the same Python minor used to generate its
# hash-locked dependency graph. The ordinary/default Node image remains
# Python-free.
FROM python:3.13.15-slim-bookworm AS fashion-python

# Optional benchmark image. The normal/default image above remains Python- and
# Torch-free. Build explicitly with: docker build --target fashion-vision .
FROM fashion-python AS fashion-vision
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000 STYLE_DATA_DIR=/data
RUN apt-get update && apt-get install -y --no-install-recommends libatomic1 && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 1001 style \
    && useradd --uid 1001 --gid 1001 --no-create-home style \
    && mkdir /data && chown style:style /data && chmod 700 /data
COPY --from=runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=runtime --chown=style:style /app /app
COPY --from=build /app/services/fashion-vision-requirements.txt /tmp/fashion-vision-requirements.txt
COPY --from=build /app/services/fashion-vision-cpu-wheels.txt /tmp/fashion-vision-cpu-wheels.txt
# Install exactly the audited CPU lock. Torch advertises optional Linux CUDA
# extras that are neither needed nor approved for this CPU provider; --no-deps
# prevents pip from adding that unaudited GPU stack.
RUN python3 -m venv /opt/fashion-vision \
    && /opt/fashion-vision/bin/pip install --no-cache-dir --require-hashes --no-deps -r /tmp/fashion-vision-cpu-wheels.txt \
    && /opt/fashion-vision/bin/pip install --no-cache-dir --require-hashes --no-deps -r /tmp/fashion-vision-requirements.txt \
    && /opt/fashion-vision/bin/python -c "import open_clip, torch, torchvision; assert torch.tensor([1]).sum().item() == 1"
COPY --from=build --chown=style:style /app/scripts/fashion_clip_inference.py /app/scripts/setup_fashion_clip.py ./scripts/
ENV FASHION_MODEL_PYTHON=/opt/fashion-vision/bin/python FASHION_MODEL_DIR=/models/fashionclip
USER style
EXPOSE 3000
CMD ["node", "server.js"]

# Keep the ordinary runtime as Docker's default final image.
FROM runtime AS final
