# manao/maven-runner

Immutable Maven runner image for POC4 stage 6.

- Base: maven:3.9.9-eclipse-temurin-17 (JDK 17, Maven 3.9, Bash)
- Contents: /usr/local/bin/manao-pty-wrapper, /usr/local/bin/manao-shell-hook and
  /usr/local/bin/manao-run-supervisor (root-owned, 0555), plus the supervisor classes.
- Console Job command: `mvn -q -DskipTests compile exec:java`.
- Web Job PID 1: the supervisor launches `mvn -q -DskipTests spring-boot:run` after
  claiming the Run and enforces startup/lifetime deadlines. The PTY wrapper is an
  independent pods/exec target.

## Build / digest pinning

    docker build -t manao/maven-runner:stage6-remediation .
    docker push <registry>/manao/maven-runner:<tag>
    docker inspect --format='{{index .RepoDigests 0}}' <registry>/manao/maven-runner:<tag>

Reference the returned digest (repo@sha256:...) in MANAO_MAVEN_RUNNER_IMAGE; floating tags
are rejected by JobResourceFactory.

## Approved Maven cache supplement (2026-09-22)

The user approved an image-seeded Maven repository plus a private persistent cache on
each project's existing workspace PVC. Implementation and performance remain unverified.
See the [design, section 7.5](../../docs/superpowers/specs/2026-09-21-java-project-runtime-design.md)
and [implementation supplement](../../docs/superpowers/plans/2026-09-22-java-maven-cache-implementation-plan.md).
The supplement defines actual-template export, a named Docker build context, a fixed Maven
wrapper, non-root cache access and focused container tests. Its new build commands become
applicable after those files are implemented; the current image does not already contain a seed.

Cache integration must preserve the current Maven goals and the Web supervisor's claim,
stop and deadline behavior. No cache PVC or user-facing cache option is added.

## Trust boundary

manao-pty-wrapper and manao-shell-hook are PLACEHOLDERS (v0). The HMAC/FIFO structured audit
transport, the session-bound 256-bit MAC key delivery via controlled exec stdin, and the
non-PTY pods/exec cat consumption stream are delivered by the separate audit-transport plan.
Until that lands, the trust level "wrapper transport verified" is NOT claimable and the 6A
gate must record the audit items as SKIPPED. Shell users can run arbitrary commands, so this
image provides no malicious-code isolation.
