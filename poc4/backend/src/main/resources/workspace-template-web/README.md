# Manao Spring Boot web project

This project was created by the Manao workspace with a fixed Java 17 + Spring Boot 3.5.9 template.

## Run

Use the editor's Run action to start `com.example.app.App`; the application listens on the
project's primary port (`SERVER_PORT`). Edit `src/main/java/com/example/app/DemoController.java`
to add endpoints.

## Health

Only the health endpoint is exposed (`/actuator/health`); health details are disabled. The
readiness probe reflects exactly the dependencies selected for this project.

<!-- MANAO:IF mysql -->
## MySQL

`application.yml` maps the injected environment variables (`MANAO_MYSQL_HOST`,
`MANAO_MYSQL_PORT`, `MANAO_MYSQL_DATABASE`, `MANAO_MYSQL_USERNAME`, `MANAO_MYSQL_PASSWORD`)
to the Spring `spring.datasource` properties. Create your schema with idempotent statements,
for example:

```sql
CREATE TABLE IF NOT EXISTS demo_notes (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    message VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

The JDBC URL follows `jdbc:mysql://$MANAO_MYSQL_HOST:$MANAO_MYSQL_PORT/$MANAO_MYSQL_DATABASE`.
<!-- MANAO:END mysql -->

<!-- MANAO:IF redis -->
## Redis

`application.yml` maps `MANAO_REDIS_HOST`, `MANAO_REDIS_PORT` and `MANAO_REDIS_PASSWORD` to
`spring.data.redis`. Redis runs as a non-persistent cache for this project, so treat stored
values as disposable.
<!-- MANAO:END redis -->
