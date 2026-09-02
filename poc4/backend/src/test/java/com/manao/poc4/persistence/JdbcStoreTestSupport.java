package com.manao.poc4.persistence;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.UUID;
import javax.sql.DataSource;
import org.flywaydb.core.Flyway;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

/**
 * Real-MySQL test scaffold: {@link #create()} provisions a unique schema
 * (manao_stage6_&lt;uuid&gt;), migrates it with the classpath Flyway migrations (V1-V6) and
 * drops the schema again on {@link #close()}. A non-jdbc:mysql MANAO_DB_URL fails the suite up
 * front (REAL_MYSQL_REQUIRED) so no test can silently pass against an in-memory substitute.
 */
public final class JdbcStoreTestSupport implements AutoCloseable {
    private static final String DEFAULT_URL = "jdbc:mysql://127.0.0.1:3306/manao_poc4_test";
    private static final String DEFAULT_USER = "manao";

    private final String schema;
    private final DataSource dataSource;

    public static JdbcStoreTestSupport create() {
        String url = System.getenv().getOrDefault("MANAO_DB_URL", DEFAULT_URL);
        if (!url.startsWith("jdbc:mysql:")) {
            throw new AssertionError("REAL_MYSQL_REQUIRED: MANAO_DB_URL must be jdbc:mysql, got " + url);
        }
        String user = System.getenv().getOrDefault("MANAO_DB_USERNAME", DEFAULT_USER);
        String pass = System.getenv().getOrDefault("MANAO_DB_PASSWORD", "");
        String schema = "manao_stage6_" + UUID.randomUUID().toString().replace("-", "");
        String schemaUrl = schemaUrl(url, schema);
        try (Connection admin = DriverManager.getConnection(url, user, pass);
             Statement statement = admin.createStatement()) {
            statement.execute("CREATE SCHEMA " + schema + " CHARACTER SET utf8mb4");
        } catch (SQLException ex) {
            throw new AssertionError("REAL_MYSQL_BLOCKED: cannot create per-test schema " + schema, ex);
        }
        try {
            Flyway.configure().dataSource(schemaUrl, user, pass)
                .locations("classpath:db/migration").load().migrate();
        } catch (RuntimeException ex) {
            dropSchemaQuietly(schemaUrl, user, pass);
            throw new AssertionError("REAL_MYSQL_BLOCKED: Flyway migrate failed on " + schema, ex);
        }
        return new JdbcStoreTestSupport(schema, new DriverManagerDataSource(schemaUrl, user, pass));
    }

    public JdbcTemplate jdbc() {
        return new JdbcTemplate(dataSource);
    }

    @Override
    public void close() {
        try (Connection admin = dataSource.getConnection();
             Statement statement = admin.createStatement()) {
            statement.execute("DROP SCHEMA IF EXISTS " + schema);
        } catch (SQLException ex) {
            throw new AssertionError("cannot drop per-test schema " + schema, ex);
        }
    }

    private JdbcStoreTestSupport(String schema, DataSource dataSource) {
        this.schema = schema;
        this.dataSource = dataSource;
    }

    /** Replaces the database name in the base URL with the per-test schema name. */
    private static String schemaUrl(String baseUrl, String schema) {
        int query = baseUrl.indexOf('?');
        String withoutQuery = query >= 0 ? baseUrl.substring(0, query) : baseUrl;
        String suffix = query >= 0 ? baseUrl.substring(query) : "";
        int slash = withoutQuery.lastIndexOf('/');
        String serverPart = slash >= 0 ? withoutQuery.substring(0, slash + 1) : withoutQuery + "/";
        return serverPart + schema + suffix;
    }

    private static void dropSchemaQuietly(String schemaUrl, String user, String pass) {
        int query = schemaUrl.indexOf('?');
        String withoutQuery = query >= 0 ? schemaUrl.substring(0, query) : schemaUrl;
        String schema = withoutQuery.substring(withoutQuery.lastIndexOf('/') + 1);
        try (Connection admin = DriverManager.getConnection(withoutQuery, user, pass);
             Statement statement = admin.createStatement()) {
            statement.execute("DROP SCHEMA IF EXISTS " + schema);
        } catch (SQLException ignored) {
            // best-effort cleanup of a partially provisioned schema
        }
    }
}
