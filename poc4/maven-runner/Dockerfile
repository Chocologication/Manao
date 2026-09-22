# poc4/maven-runner/Dockerfile
# Immutable Maven runner image: JDK 17 + Maven 3.9 + Bash + the fixed root-owned PTY wrapper.
# For web runs the container PID 1 is the small single-run supervisor (JDK standard
# library only, compiled from runtime/src into /opt/manao-runner/classes):
#   manao-run-supervisor run    -> fixed `mvn -q -DskipTests spring-boot:run` child
#   manao-run-supervisor probe  -> readiness probe helper (exec child, no PID 1 required)
# The console Job still runs ["mvn","clean","test"] as PID 1; the wrapper is only an
# independent pods/exec target for the interactive PTY.
# The runtime-test stage additionally contains the test fixture classes
# (/opt/manao-runner/test-classes); the final stage copies production classes only.
# The maven-cache supplement adds a read-only seeded Maven repository built from the real
# workspace templates: build with the named context, e.g.
#   docker build --build-context "seed-templates=<exported templates dir>" -t <image> .
# (the export comes from the MavenSeedTemplateExporter; offline verification is
# tests/maven-cache.sh). Production and runtime-test share the same seed content:
# /opt/manao-maven-seed/repository (read-only) plus the seed-id content version file.
FROM maven:3.9.9-eclipse-temurin-17 AS runner-build
WORKDIR /build
COPY runtime/src/ src/
RUN javac -encoding UTF-8 -d classes src/com/manao/runtime/*.java

FROM runner-build AS runner-test-build
COPY runtime/test/ test-src/
RUN javac -encoding UTF-8 -cp classes -d test-classes test-src/com/manao/runtime/*.java

# Seed build: populate the read-only repository from the exported real templates and verify
# offline startup of the no-database web template (prepare-maven-seed.sh). Sample sources and
# build outputs stay in this intermediate stage and never reach the final images.
FROM maven:3.9.9-eclipse-temurin-17 AS seed-build
COPY --from=seed-templates / /seed-projects/
COPY prepare-maven-seed.sh /usr/local/bin/prepare-maven-seed.sh
RUN chmod 0555 /usr/local/bin/prepare-maven-seed.sh \
 && prepare-maven-seed.sh /seed-projects /opt/manao-maven-seed

FROM maven:3.9.9-eclipse-temurin-17 AS runtime-test
RUN useradd -r -u 1001 manao || useradd -r manao
COPY manao-pty-wrapper /usr/local/bin/manao-pty-wrapper
COPY manao-shell-hook.sh /usr/local/bin/manao-shell-hook
COPY manao-run-supervisor /usr/local/bin/manao-run-supervisor
RUN chown root:root /usr/local/bin/manao-pty-wrapper /usr/local/bin/manao-shell-hook /usr/local/bin/manao-run-supervisor \
 && chmod 0555 /usr/local/bin/manao-pty-wrapper /usr/local/bin/manao-shell-hook /usr/local/bin/manao-run-supervisor
COPY --from=runner-build /build/classes /opt/manao-runner/classes
COPY --from=runner-test-build /build/test-classes /opt/manao-runner/test-classes
COPY --from=seed-build /opt/manao-maven-seed /opt/manao-maven-seed
WORKDIR /workspace
ENV TMPDIR=/tmp HOME=/tmp
USER 1001

FROM maven:3.9.9-eclipse-temurin-17
RUN useradd -r -u 1001 manao || useradd -r manao
COPY manao-pty-wrapper /usr/local/bin/manao-pty-wrapper
COPY manao-shell-hook.sh /usr/local/bin/manao-shell-hook
COPY manao-run-supervisor /usr/local/bin/manao-run-supervisor
RUN chown root:root /usr/local/bin/manao-pty-wrapper /usr/local/bin/manao-shell-hook /usr/local/bin/manao-run-supervisor \
 && chmod 0555 /usr/local/bin/manao-pty-wrapper /usr/local/bin/manao-shell-hook /usr/local/bin/manao-run-supervisor
COPY --from=runner-build /build/classes /opt/manao-runner/classes
COPY --from=seed-build /opt/manao-maven-seed /opt/manao-maven-seed
WORKDIR /workspace
ENV TMPDIR=/tmp HOME=/tmp
USER 1001
