# syntax=docker/dockerfile:1.7
# Tower of HN web: towerd (live HN -> cached files, the voicing queue) serving the built client.
# Node runs the TypeScript sources directly (type stripping); towerd has no npm dependencies.
FROM node:24-slim AS client
WORKDIR /src/apps/client
COPY apps/client/package.json apps/client/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY packages/ /src/packages/
COPY apps/client/ ./
RUN npx vite build

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production VAR=/data STATIC=/app/apps/client/dist PORT=8787
COPY packages/core/src packages/core/src
COPY apps/towerd/package.json apps/towerd/package-lock.json apps/towerd/
RUN cd apps/towerd && npm ci --omit=dev --no-audit --no-fund
COPY apps/towerd/src apps/towerd/src
COPY --from=client /src/apps/client/dist apps/client/dist
ARG VERSION=dev
ENV TOWEROFHN_VERSION=$VERSION
USER 1000:1000
EXPOSE 8787
CMD ["node", "apps/towerd/src/main.ts"]
