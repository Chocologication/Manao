# Build stage
FROM maven:3.9-eclipse-temurin-17 AS build
WORKDIR /build
COPY pom.xml .
COPY src ./src
RUN mvn -q package -DskipTests

# Runtime stage: non-root, read-only-root friendly; the agent writes only under /workspace and /tmp
FROM eclipse-temurin:17-jre
RUN useradd --uid 10001 --user-group --shell /usr/sbin/nologin manao
WORKDIR /app
COPY --from=build /build/target/manao-poc4-workspace-agent-*.jar /app/workspace-agent.jar
USER 10001:10001
ENV TMPDIR=/tmp
EXPOSE 8080
ENTRYPOINT ["java", "-XX:MaxRAMPercentage=75", "-jar", "/app/workspace-agent.jar"]
