# manao/maven-runner

Immutable Maven runner image for POC4 stage 6.

- Base: maven:3.9.9-eclipse-temurin-17 (JDK 17, Maven 3.9, Bash)
- Contents: /usr/local/bin/manao-pty-wrapper, /usr/local/bin/manao-shell-hook,
  /usr/local/bin/manao-run-supervisor and /usr/local/bin/manao-maven (root-owned,
  0555), the supervisor classes, and the read-only seeded Maven repository
  /opt/manao-maven-seed (repository/ + seed-id) built from the real workspace
  templates.
- Console Job command: `manao-maven -q -DskipTests compile exec:java` (the wrapper
  initializes the project cache, then execs Maven with
  `-Dmaven.repo.local=/maven-cache/repository`).
- Web Job PID 1: the supervisor launches the fixed `manao-maven` wrapper (which execs
  `mvn -q -DskipTests spring-boot:run`) after claiming the Run and enforces
  startup/lifetime deadlines. The PTY wrapper is an independent pods/exec target.

## Build / digest pinning

The seed repository comes from the real workspace templates, exported by the test-classpath
exporter, and is passed to the build as the named context `seed-templates`
(PowerShell, from the implementation checkout root; `<abs>` = absolute checkout path):

    mvn -q -f poc4/backend/pom.xml -DskipTests test-compile org.codehaus.mojo:exec-maven-plugin:3.5.0:java -Dexec.mainClass=com.manao.poc4.workspace.MavenSeedTemplateExporter -Dexec.classpathScope=test "-Dmanao.seed.output=<abs>\poc4\backend\target\maven-seed-templates"
    docker build --build-context "seed-templates=<abs>\poc4\backend\target\maven-seed-templates" -t manao/maven-runner:<tag> poc4/maven-runner
    docker push <registry>/manao/maven-runner:<tag>
    docker buildx imagetools inspect <registry>/manao/maven-runner:<tag>

Reference the returned digest (repo@sha256:...) in MANAO_MAVEN_RUNNER_IMAGE; floating tags
are rejected by JobResourceFactory. Re-export the templates on every image build so the
seed always matches the current sources; record the published digest and the image's
seed-id in the java-runtime acceptance record, and pre-pull the digest on the nodes that
will schedule Run Jobs before startup measurements (or record the cold-image condition).

## Maven cache supplement (2026-09-22, implemented)

An image-seeded Maven repository plus a private persistent cache on each project's
existing workspace PVC is implemented (C1/C2 of the
[implementation supplement](../../docs/superpowers/plans/2026-09-22-java-maven-cache-implementation-plan.md)):
actual-template export, the named Docker build context, the fixed root-owned
`manao-maven` wrapper, non-root cache access and focused container tests
(`poc4/maven-runner/tests/maven-cache.sh`). Performance and cloud acceptance evidence is
recorded only in [poc4/docs/evidence/java-runtime/acceptance.md](../../docs/evidence/java-runtime/acceptance.md).

Cache integration preserves the current Maven goals and the Web supervisor's claim,
stop and deadline behavior. No cache PVC or user-facing cache option is added.

## Trust boundary

manao-pty-wrapper and manao-shell-hook are PLACEHOLDERS (v0). The HMAC/FIFO structured audit
transport, the session-bound 256-bit MAC key delivery via controlled exec stdin, and the
non-PTY pods/exec cat consumption stream are delivered by the separate audit-transport plan.
Until that lands, the trust level "wrapper transport verified" is NOT claimable and the 6A
gate must record the audit items as SKIPPED. Shell users can run arbitrary commands, so this
image provides no malicious-code isolation.
