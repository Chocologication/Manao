package com.manao.poc4.persistence;

import java.sql.DriverManager;

/** Command-line bootstrap for the loopback-only terminal settlement verification. */
public final class LocalDisposableSchema {
    public static void main(String[] args) throws Exception {
        String schema = args[1];
        if (!schema.matches("manao_(stage6_)?terminal_[0-9a-f]{32}")) throw new IllegalArgumentException("Disposable schema required");
        String url = System.getenv("MANAO_DB_URL");
        if (url == null || !url.startsWith("jdbc:mysql://127.0.0.1:")) throw new IllegalArgumentException("Loopback MySQL required");
        String server = url.substring(0, url.indexOf('/', "jdbc:mysql://".length()) + 1);
        try (var connection = DriverManager.getConnection(server, System.getenv("MANAO_DB_USERNAME"), System.getenv("MANAO_DB_PASSWORD"));
             var statement = connection.createStatement()) {
            if (args[0].equals("create")) statement.execute("CREATE SCHEMA " + schema + " CHARACTER SET utf8mb4");
            else if (args[0].equals("drop")) statement.execute("DROP SCHEMA " + schema);
            else throw new IllegalArgumentException("create or drop required");
        }
        System.out.println(args[0] + " owned disposable schema: " + schema);
    }
}
