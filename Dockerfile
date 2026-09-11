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
RUN addgroup -S critalarm && adduser -S critalarm -G critalarm && mkdir -p /data && chown -R critalarm:critalarm /app /data
USER critalarm
VOLUME ["/data"]
EXPOSE 8080
CMD ["npm", "start"]
