FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
COPY package*.json ./
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
COPY --from=build --chown=style:style /app/scripts/backup-encrypted.ts ./scripts/backup-encrypted.ts
COPY --from=build --chown=style:style /app/scripts/restore-encrypted.ts ./scripts/restore-encrypted.ts
COPY --from=build --chown=style:style /app/tsconfig.json ./tsconfig.json
USER style
EXPOSE 3000
CMD ["node", "server.js"]
