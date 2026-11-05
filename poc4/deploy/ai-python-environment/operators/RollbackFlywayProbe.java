import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.sql.*;
import java.util.*;
import org.flywaydb.core.Flyway;

/** Standalone operator probe; never starts Spring, workers or Kubernetes clients. */
public class RollbackFlywayProbe {
    static String fingerprint(Connection connection) throws Exception {
        var digest = MessageDigest.getInstance("SHA-256");
        var tables = new ArrayList<String>();
        try (var statement = connection.createStatement(); var rows = statement.executeQuery("SHOW TABLES")) {
            while (rows.next()) tables.add(rows.getString(1));
        }
        Collections.sort(tables);
        for (String table : tables) {
            if (!table.matches("[A-Za-z0-9_]+")) throw new IllegalStateException("Unsafe table name");
            digest.update(table.getBytes(StandardCharsets.UTF_8));
            var keys = new TreeMap<Short, String>();
            try (var rows = connection.getMetaData().getPrimaryKeys(connection.getCatalog(), null, table)) {
                while (rows.next()) keys.put(rows.getShort("KEY_SEQ"), rows.getString("COLUMN_NAME"));
            }
            if (keys.isEmpty()) throw new IllegalStateException("Deterministic primary key required");
            String order = String.join(",", keys.values().stream().map(key -> "`" + key + "`").toList());
            try (var statement = connection.createStatement(); var rows = statement.executeQuery("SELECT * FROM `" + table + "` ORDER BY " + order)) {
                int columns = rows.getMetaData().getColumnCount();
                while (rows.next()) for (int i = 1; i <= columns; i++) {
                    byte[] bytes = rows.getBytes(i);
                    digest.update((bytes == null ? "NULL:" : bytes.length + ":").getBytes(StandardCharsets.UTF_8));
                    if (bytes != null) digest.update(bytes);
                }
            }
        }
        return HexFormat.of().formatHex(digest.digest());
    }

    public static void main(String[] args) throws Exception {
        String url = Objects.requireNonNull(System.getenv("MANAO_ROLLBACK_TEST_DB_URL"));
        URI parsed = URI.create(url.substring("jdbc:".length()));
        String schema = parsed.getPath().substring(1);
        if (!url.startsWith("jdbc:mysql://127.0.0.1:13306/")
                || !schema.matches("manao_python_rollback_[a-f0-9]{32}")) {
            throw new IllegalArgumentException("Explicit local disposable schema required");
        }
        String user = System.getenv("MANAO_ROLLBACK_TEST_DB_USERNAME");
        String password = System.getenv("MANAO_ROLLBACK_TEST_DB_PASSWORD");
        try (var connection = DriverManager.getConnection(url, user, password)) {
            String before = fingerprint(connection);
            Flyway flyway = Flyway.configure().dataSource(url, user, password)
                .locations("classpath:db/migration").load();
            flyway.validate();
            int executed = flyway.migrate().migrationsExecuted;
            String after = fingerprint(connection);
            if (executed != 0 || !before.equals(after)) throw new IllegalStateException("Old artifact changed cloned data");
            try (var statement = connection.createStatement(); var rows = statement.executeQuery(
                    "SELECT COUNT(*), MIN(checksum), MIN(success) FROM flyway_schema_history WHERE version='20'")) {
                rows.next();
                if (rows.getInt(1) != 1 || rows.getInt(2) != 1710106007 || rows.getInt(3) != 1)
                    throw new IllegalStateException("V20 evidence changed");
            }
            System.out.println("OLD_FLYWAY_V20_PASS migrations=0 dataSha256=" + after);
        }
    }
}
