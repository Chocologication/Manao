# Build stage
FROM maven:3.9-eclipse-temurin-17 AS build
WORKDIR /build
COPY pom.xml .
COPY src ./src
RUN mvn -q package -DskipTests

# Runtime stage: the SAME toolchain identity as the Python runner image (python runtime design
# 6.2 "agent 镜像增加与 runner 对齐的 Python/uv"): python:3.13.15-slim (Debian 13 trixie,
# CPython 3.13.15), uv 0.11.6 at /usr/local/bin/uv and the Debian default JRE for the agent —
# the same distribution the runner uses for its supervisor. No Maven. The root-owned helper is
# not writable by the runtime user, so the fixed dependency-editing argv cannot be tampered
# with. Non-root, read-only-root friendly; the agent writes only under /workspace and /tmp.
FROM python:3.13.15-slim@sha256:8d9d0b8bcf6506481eae4907c18f5e3e7902e629f5f6d684f9e7c32e85e3ddf0
RUN apt-get update \
 && apt-get install -y --no-install-recommends default-jre-headless \
 && rm -rf /var/lib/apt/lists/*
COPY --from=ghcr.io/astral-sh/uv:0.11.6@sha256:b1e699368d24c57cda93c338a57a8c5a119009ba809305cc8e86986d4a006754 /uv /usr/local/bin/uv
RUN useradd --uid 10001 --user-group --shell /usr/sbin/nologin manao
WORKDIR /app
COPY --from=build /build/target/manao-poc4-workspace-agent-*.jar /app/workspace-agent.jar
COPY src/main/resources/python-dependency-helper.py /opt/manao-python/dependency_helper.py
RUN chown root:root /opt/manao-python/dependency_helper.py \
 && chmod 0555 /opt/manao-python/dependency_helper.py
USER 10001:10001
ENV TMPDIR=/tmp
ENV HOME=/tmp
EXPOSE 8080
ENTRYPOINT ["java", "-XX:MaxRAMPercentage=75", "-jar", "/app/workspace-agent.jar"]
