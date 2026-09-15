# critalarm server. Build context is the repo root:
#   docker build -t critalarm-server .
#
# One process, one SQLite file on a mounted volume. Runtime is tsx over the
# TypeScript source, the same as dev, so there is no dist to keep in sync.
FROM node:22-alpine AS base
WORKDIR /app

FROM base AS deps
# better-sqlite3 is a native module, so alpine needs a toolchain to build it.
# A multi-arch build compiles it once per platform.
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json ./
RUN npm ci

FROM base AS runner
ENV NODE_ENV=production
ENV PORT=8080
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm prune --omit=dev
RUN ln -s /app/bin/critalarm.mjs /usr/local/bin/critalarm
RUN addgroup -S critalarm && adduser -S critalarm -G critalarm && mkdir -p /data && chown -R critalarm:critalarm /app /data
USER critalarm
VOLUME ["/data"]
EXPOSE 8080
# GET /v1/health answers without auth and returns {"ok":true}. The check runs
# node, not curl or wget: node is the one program this image is guaranteed to
# have, and Node 22 has global fetch. The port is worked out the same way
# src/config.ts does it, so LISTEN alone is enough.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "const p=process.env.PORT||(process.env.LISTEN||':8080').slice(1);fetch(`http://127.0.0.1:${p}/v1/health`).then(r=>r.ok?r.json():Promise.reject(new Error(String(r.status)))).then(b=>process.exit(b&&b.ok===true?0:1)).catch(()=>process.exit(1))"]
CMD ["npm", "start"]
