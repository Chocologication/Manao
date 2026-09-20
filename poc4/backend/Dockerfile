# Manao poc4 backend - Spring Boot service image (Java 17, non-root, in-cluster).
# Build context: poc4/backend (see .dockerignore). Produces an immutable, tagged image;
# the deploy pipeline must pin the pushed image by digest before referencing it in cluster manifests.

FROM maven:3.9.9-eclipse-temurin-17 AS build
WORKDIR /src
# Dependency layer first: pom.xml changes invalidate fewer layers than source changes.
COPY pom.xml .
RUN mvn -q -B -DskipTests dependency:go-offline
COPY src ./src
RUN mvn -q -B -DskipTests package

FROM eclipse-temurin:17.0.13_11-jre
LABEL org.opencontainers.image.title="manao-poc4-backend" \
      org.opencontainers.image.description="Manao Stage 6B cloud workbench backend (Spring Boot, in-cluster profile)" \
      org.opencontainers.image.source="https://github.com/manao/project-manao"

# Dedicated non-root user/group; no shell privileges, no kubeconfig, no kubectl in the image.
RUN groupadd --gid 10001 manao \
    && useradd --uid 10001 --gid manao --no-create-home --shell /usr/sbin/nologin manao

WORKDIR /app
COPY --from=build /src/target/manao-poc4-backend-0.0.1-SNAPSHOT.jar /app/manao-poc4-backend.jar

# Writable locations: Spring Boot tmp directory (Tomcat unpack, JVM temps) and /app for logs.
# Everything else in the image stays read-only.
RUN mkdir -p /tmp /app/logs \
    && chown -R manao:manao /tmp /app \
    && chmod 1777 /tmp \
    && chmod 775 /app/logs

USER 10001:10001

ENV SERVER_PORT=8080 \
    TMPDIR=/tmp \
    JAVA_TOOL_OPTIONS="-XX:MaxRAMPercentage=75.0 -Djava.io.tmpdir=/tmp"

EXPOSE 8080

ENTRYPOINT ["java", "-jar", "/app/manao-poc4-backend.jar"]
