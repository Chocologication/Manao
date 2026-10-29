# Manao stage-one Pi worker image. The source tree is forced LF by .gitattributes
# (poc4/pi-worker/**), so the build context never carries CRLF files regardless of
# core.autocrlf. pnpm only — npm is not used anywhere in this image.
FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
COPY package.json pnpm-lock.yaml ./
RUN pnpm fetch
COPY tsconfig.json ./
COPY src ./src
RUN pnpm install --frozen-lockfile --offline && pnpm build

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
COPY --from=build /app/package.json /app/pnpm-lock.yaml ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# All configuration arrives through the environment (see .env.example / README).
# The model key lives only here and in the ModelRuntime; it is never written to
# any project, Job, or shared volume.
USER node
EXPOSE 18090
CMD ["node", "dist/server.js"]
