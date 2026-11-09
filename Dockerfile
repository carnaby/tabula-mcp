FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
# Nx orders the builds (shared first); no daemon inside an image build.
ENV NX_DAEMON=false
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY apps/cli/package.json apps/cli/
COPY packages/shared/package.json packages/shared/
# apps/tray is not in the build context, so its dependencies are not installed.
RUN pnpm install --frozen-lockfile
COPY . .
# The server with only its production dependencies, @tabula/shared (dist) and @tabula/cli (the CLI files) included.
# --legacy: pnpm 10 deploys without injected workspace packages only this way; it keeps the lockfile's versions.
RUN pnpm build && pnpm --filter @tabula/server deploy --prod --legacy /prod/server

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOST=0.0.0.0 WEB_DIST=web/dist TABULA_MEDIA_DIR=/data/media
# ffmpeg: frames from report videos and durations of recordings. /data/media holds the attachments (mount a volume).
RUN apk add --no-cache ffmpeg && mkdir -p /data/media && chown node:node /data/media
# package.json, dist/, drizzle/ and node_modules/ (the CLI files are in node_modules/@tabula/cli).
COPY --from=build /prod/server ./
COPY --from=build /app/apps/web/dist ./web/dist
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "dist/main.js"]
