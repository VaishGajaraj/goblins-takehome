# ---- build ----
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci --no-audit --no-fund
COPY server server
COPY client client
RUN npm run build

# ---- runtime ----
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY server/package.json server/
# better-sqlite3 ships prebuilt binaries for node22/linux; if a platform ever
# forces a source build, add: apt-get update && apt-get install -y python3 make g++
RUN npm ci --omit=dev --workspace=server --no-audit --no-fund
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/client/dist client/dist
ENV PORT=3000 DATA_DIR=/data STATIC_DIR=/app/client/dist
EXPOSE 3000
CMD ["node", "server/dist/main.js"]
