# manao/maven-runner

Immutable Maven runner image for POC4 stage 6.

- Base: maven:3.9.9-eclipse-temurin-17 (JDK 17, Maven 3.9, Bash)
- Contents: /usr/local/bin/manao-pty-wrapper (root-owned, 0555) and
  /usr/local/bin/manao-shell-hook (root-owned, 0555)
- Job PID 1: ["mvn","clean","test"] set by JobResourceFactory; the wrapper is only the
  pods/exec target for the interactive PTY.

## Build / digest pinning

    docker build -t manao/maven-runner:stage6-remediation .
    docker push <registry>/manao/maven-runner:<tag>
    docker inspect --format='{{index .RepoDigests 0}}' <registry>/manao/maven-runner:<tag>

Reference the returned digest (repo@sha256:...) in MANAO_MAVEN_RUNNER_IMAGE; floating tags
are rejected by JobResourceFactory.

## Trust boundary

manao-pty-wrapper and manao-shell-hook are PLACEHOLDERS (v0). The HMAC/FIFO structured audit
transport, the session-bound 256-bit MAC key delivery via controlled exec stdin, and the
non-PTY pods/exec cat consumption stream are delivered by the separate audit-transport plan.
Until that lands, the trust level "wrapper transport verified" is NOT claimable and the 6A
gate must record the audit items as SKIPPED. Shell users can run arbitrary commands, so this
image provides no malicious-code isolation.
