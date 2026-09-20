# Stage 6B frontend image: build the production static assets, then serve them
# with an unprivileged nginx that also proxies /api/ to the backend Service
# (manao-backend:8080 in namespace manao-stage6b).
#
# Build-time flags are set explicitly here:
# - VITE_ENABLE_MOCK_API gates the MSW mock worker (src/main.tsx).
# - VITE_ENABLE_EXPERIMENTAL_TERMINAL gates the experimental terminal panel
#   (src/components/shell/WorkbenchShell.tsx).
# Both must be non-"true" for the production bundle. The legacy VITE_USE_MSW
# variable (only present in .env.local-cluster.example) is NOT read by any code
# and must not be relied on (Task 3 brief).
# syntax=docker/dockerfile:1

# Pinned: node 22 LTS line, Alpine 3.23 (tag verified on Docker Hub 2026-09-18).
FROM node:22.23.2-alpine3.23 AS build
WORKDIR /app

# pnpm is pinned to the exact version declared by package.json
# ("packageManager": "pnpm@10.33.0"). Installed via npm instead of corepack so
# the version is fully deterministic and corepack's signature-key lookup can
# never break the build.
RUN npm install --global pnpm@10.33.0

# Install dependencies in a separate layer so it stays cached while only the
# lockfile is unchanged.
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN VITE_ENABLE_MOCK_API=false VITE_ENABLE_EXPERIMENTAL_TERMINAL=false \
    pnpm build

# Runtime: nginxinc/nginx-unprivileged is the official nginx build running as
# uid/gid 101 (no root master, no root worker), which allows the pod to enforce
# runAsNonRoot. Listening on 8080 requires no privileged port. The image still
# uses the standard nginx layout (/etc/nginx/conf.d/*.conf, /usr/share/nginx/html).
# Pinned: nginx 1.27 line (the plan-given default), Alpine 3.21
# (tag verified on Docker Hub 2026-09-18).
FROM nginxinc/nginx-unprivileged:1.27-alpine3.21

COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 8080
