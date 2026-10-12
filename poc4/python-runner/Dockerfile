# poc4/python-runner/Dockerfile
# Python runner image: fixed Python 3.13 + uv 0.11.6 + the JRE the shared single-run web
# supervisor needs. No Maven. The supervisor is compiled from the SAME
# poc4/maven-runner/runtime/src the Maven runner uses — supervisor sources are never
# vendored into this directory (build from the repository root):
#   docker build -f poc4/python-runner/Dockerfile \
#     --build-context "seed-templates=<exported python-seed-templates dir>" -t <image> .
# (the export comes from PythonSeedTemplateExporter; offline verification is
# tests/python-cache.sh).
#
# The root-owned fixed launcher /usr/local/bin/manao-python initializes the private
# per-project uv cache mounted at /python-cache from the read-only image seed and execs
# the only two modes (console|web). The seed is built from the real exported templates
# and verified offline inside the seed-build stage (prepare-python-seed.sh); production
# and runtime-test share the same Python/uv/JRE distribution and the same seed:
# /opt/manao-python-seed/uv-cache (read-only) plus the seed-id content version file.
# The runtime-test stage additionally carries the exported template variants under
# /opt/manao-python-templates for the black-box container tests; the production stage
# copies the seed, classes and launchers only.
#
# Toolchain identity resolved by real pulls (see poc4/python-runner/README.md):
#   base  python:3.13.15-slim (Debian 13 trixie, CPython 3.13.15)
#         @sha256:8d9d0b8bcf6506481eae4907c18f5e3e7902e629f5f6d684f9e7c32e85e3ddf0
#   uv    ghcr.io/astral-sh/uv:0.11.6 (x86_64-unknown-linux-musl) — the same version that
#         generated the committed locks
#         @sha256:b1e699368d24c57cda93c338a57a8c5a119009ba809305cc8e86986d4a006754
#   JRE   default-jre-headless (OpenJDK 21, Debian trixie) for the supervisor; the compile
#         stage uses default-jdk-headless of the same distribution. No Maven anywhere.
FROM python:3.13.15-slim@sha256:8d9d0b8bcf6506481eae4907c18f5e3e7902e629f5f6d684f9e7c32e85e3ddf0 AS supervisor-build
RUN apt-get update \
 && apt-get install -y --no-install-recommends default-jdk-headless \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /build
COPY poc4/maven-runner/runtime/src/ src/
RUN javac -encoding UTF-8 -d classes src/com/manao/runtime/*.java

# Seed build: populate the read-only uv cache from the exported real templates and verify
# offline startup of the no-database web template (prepare-python-seed.sh). Scratch venvs
# and downloaded sources stay in this intermediate stage and never reach the final images.
FROM python:3.13.15-slim@sha256:8d9d0b8bcf6506481eae4907c18f5e3e7902e629f5f6d684f9e7c32e85e3ddf0 AS seed-build
COPY --from=ghcr.io/astral-sh/uv:0.11.6@sha256:b1e699368d24c57cda93c338a57a8c5a119009ba809305cc8e86986d4a006754 /uv /usr/local/bin/uv
COPY --from=seed-templates / /seed-projects/
COPY poc4/python-runner/prepare-python-seed.sh /usr/local/bin/prepare-python-seed.sh
RUN chmod 0555 /usr/local/bin/prepare-python-seed.sh \
 && prepare-python-seed.sh /seed-projects /opt/manao-python-seed

FROM python:3.13.15-slim@sha256:8d9d0b8bcf6506481eae4907c18f5e3e7902e629f5f6d684f9e7c32e85e3ddf0 AS runtime-test
RUN apt-get update \
 && apt-get install -y --no-install-recommends default-jre-headless \
 && rm -rf /var/lib/apt/lists/*
COPY --from=ghcr.io/astral-sh/uv:0.11.6@sha256:b1e699368d24c57cda93c338a57a8c5a119009ba809305cc8e86986d4a006754 /uv /usr/local/bin/uv
RUN useradd -r -u 1001 manao || useradd -r manao
COPY poc4/maven-runner/manao-run-supervisor /usr/local/bin/manao-run-supervisor
COPY poc4/python-runner/manao-python /usr/local/bin/manao-python
RUN chown root:root /usr/local/bin/manao-run-supervisor /usr/local/bin/manao-python \
 && chmod 0555 /usr/local/bin/manao-run-supervisor /usr/local/bin/manao-python
COPY --from=supervisor-build /build/classes /opt/manao-runner/classes
COPY --from=seed-build /opt/manao-python-seed /opt/manao-python-seed
COPY --from=seed-templates / /opt/manao-python-templates/
WORKDIR /workspace
ENV TMPDIR=/tmp HOME=/tmp
USER 1001

FROM python:3.13.15-slim@sha256:8d9d0b8bcf6506481eae4907c18f5e3e7902e629f5f6d684f9e7c32e85e3ddf0
RUN apt-get update \
 && apt-get install -y --no-install-recommends default-jre-headless \
 && rm -rf /var/lib/apt/lists/*
COPY --from=ghcr.io/astral-sh/uv:0.11.6@sha256:b1e699368d24c57cda93c338a57a8c5a119009ba809305cc8e86986d4a006754 /uv /usr/local/bin/uv
RUN useradd -r -u 1001 manao || useradd -r manao
COPY poc4/maven-runner/manao-run-supervisor /usr/local/bin/manao-run-supervisor
COPY poc4/python-runner/manao-python /usr/local/bin/manao-python
RUN chown root:root /usr/local/bin/manao-run-supervisor /usr/local/bin/manao-python \
 && chmod 0555 /usr/local/bin/manao-run-supervisor /usr/local/bin/manao-python
COPY --from=supervisor-build /build/classes /opt/manao-runner/classes
COPY --from=seed-build /opt/manao-python-seed /opt/manao-python-seed
WORKDIR /workspace
ENV TMPDIR=/tmp HOME=/tmp
USER 1001
