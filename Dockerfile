# GpuGrid all-in-one image: builds the React site and runs the Bun gateway, which
# serves both the static site and the API. Used by the platform's docker-db mode
# (persistent SQLite mounted at /data, DATABASE_URL injected automatically).

# 1) build the web (Vite → /web/dist)
FROM oven/bun:1 AS web
WORKDIR /web
COPY web/package.json web/bun.lock ./
RUN bun install
COPY web/ ./
RUN bun run build

# 2) install server deps
FROM oven/bun:1 AS server
WORKDIR /app
COPY server/package.json server/bun.lock ./
RUN bun install
COPY server/ ./

# 3) runtime
FROM oven/bun:1
WORKDIR /app
COPY --from=server /app /app
COPY --from=web /web/dist /web/dist
ENV WEB_DIR=/web/dist
ENV APP_PORT=8080
EXPOSE 8080
CMD ["bun", "src/index.ts"]
