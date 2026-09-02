# poc4/maven-runner/Dockerfile
# Immutable Maven runner image: JDK 17 + Maven 3.9 + Bash + the fixed root-owned PTY wrapper.
# Job PID 1 is set by JobResourceFactory to ["mvn","clean","test"]; the wrapper is only an
# independent pods/exec target for the interactive PTY.
FROM maven:3.9.9-eclipse-temurin-17
RUN useradd -r -u 1001 manao || useradd -r manao
COPY manao-pty-wrapper /usr/local/bin/manao-pty-wrapper
COPY manao-shell-hook.sh /usr/local/bin/manao-shell-hook
RUN chown root:root /usr/local/bin/manao-pty-wrapper /usr/local/bin/manao-shell-hook \
 && chmod 0555 /usr/local/bin/manao-pty-wrapper /usr/local/bin/manao-shell-hook
WORKDIR /workspace
ENV TMPDIR=/tmp HOME=/tmp
USER 1001
