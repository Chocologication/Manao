# Manao Java 17 + Maven project

This project was created by the Manao workspace with a fixed Java 17 + Maven 3.9 template.

Run the editor's Run action to compile and execute `com.example.app.App`; edit `src/main/java/com/example/app/App.java` to change the program.

<!-- MANAO:IF mysql -->
## MySQL client

The MySQL JDBC driver (`mysql-connector-j`) is already on the classpath. Connect with the
injected environment variables and create your schema with idempotent statements:

```java
String url = "jdbc:mysql://" + System.getenv("MANAO_MYSQL_HOST") + ":"
    + System.getenv("MANAO_MYSQL_PORT") + "/" + System.getenv("MANAO_MYSQL_DATABASE");
try (var connection = java.sql.DriverManager.getConnection(url,
        System.getenv("MANAO_MYSQL_USERNAME"), System.getenv("MANAO_MYSQL_PASSWORD"))) {
    try (var statement = connection.createStatement()) {
        statement.execute("""
            CREATE TABLE IF NOT EXISTS demo_notes (
                id BIGINT AUTO_INCREMENT PRIMARY KEY,
                message VARCHAR(255) NOT NULL
            )""");
    }
}
```
<!-- MANAO:END mysql -->

<!-- MANAO:IF redis -->
## Redis client

The Jedis client (`jedis`) is already on the classpath. Connect with the injected environment
variables; Redis runs as a non-persistent cache for this project:

```java
try (var jedis = new redis.clients.jedis.Jedis(System.getenv("MANAO_REDIS_HOST"),
        Integer.parseInt(System.getenv("MANAO_REDIS_PORT")))) {
    jedis.auth(System.getenv("MANAO_REDIS_PASSWORD"));
    jedis.set("demo", "Hello from Manao");
    System.out.println(jedis.get("demo"));
}
```
<!-- MANAO:END redis -->
