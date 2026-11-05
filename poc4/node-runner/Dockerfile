# Build from the repository root. Deployment must reference the built image by digest.
ARG NODE_IMAGE=node:24.15.0-bookworm-slim
FROM ${NODE_IMAGE} AS supervisor-build
RUN apt-get update && apt-get install -y --no-install-recommends default-jdk-headless \
    && rm -rf /var/lib/apt/lists/*
COPY poc4/maven-runner/runtime/src/ /build/src/
RUN javac -encoding UTF-8 -d /build/classes /build/src/com/manao/runtime/*.java

FROM ${NODE_IMAGE} AS seed-build
ENV COREPACK_HOME=/opt/corepack
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
COPY poc4/backend/src/main/resources/workspace-template-node-javascript-console/ /seed-projects/javascript-console/
COPY poc4/backend/src/main/resources/workspace-template-node-javascript-web/ /seed-projects/javascript-web/
COPY poc4/backend/src/main/resources/workspace-template-node-typescript-console/ /seed-projects/typescript-console/
COPY poc4/backend/src/main/resources/workspace-template-node-typescript-web/ /seed-projects/typescript-web/
RUN for project in /seed-projects/*; do cd "$project" \
    && pnpm install --frozen-lockfile --ignore-scripts --store-dir /opt/manao-node-seed/store \
    && pnpm build && pnpm test || exit 1; done

FROM ${NODE_IMAGE}
ENV COREPACK_HOME=/opt/corepack
RUN apt-get update && apt-get install -y --no-install-recommends default-jre-headless bash coreutils findutils \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable && corepack prepare pnpm@10.33.0 --activate \
    && useradd -r -u 1001 manao
COPY --from=supervisor-build /build/classes/ /opt/manao-runner/classes/
COPY --from=seed-build /opt/manao-node-seed/ /opt/manao-node-seed/
COPY poc4/maven-runner/manao-run-supervisor /usr/local/bin/manao-run-supervisor
COPY poc4/node-runner/runner.mjs /opt/manao-node/runner.mjs
COPY poc4/node-runner/copy.mjs /opt/manao-node/copy.mjs
COPY poc4/node-runner/manao-node /usr/local/bin/manao-node
COPY poc4/node-runner/manao-dev-build /usr/local/bin/manao-dev-build
RUN chmod 0555 /usr/local/bin/manao-run-supervisor /usr/local/bin/manao-node /usr/local/bin/manao-dev-build \
    /opt/manao-node/copy.mjs /opt/manao-node/runner.mjs
WORKDIR /workspace
ENV HOME=/tmp TMPDIR=/tmp COREPACK_ENABLE_NETWORK=0
USER 1001
