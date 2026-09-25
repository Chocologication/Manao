package com.manao.runtime;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.util.List;
import java.util.concurrent.CountDownLatch;

/**
 * TEST-ONLY fixture main. Compiled only into the {@code runtime-test} image stage; the
 * final production stage never contains this class. It reuses the real supervisor
 * lifecycle through the package-private seam but substitutes a controlled child process,
 * so the container tests exercise claim/readiness/deadline/receipt behavior against real
 * processes instead of mocks.
 *
 * <p>The production {@code run} mode of {@link WebRunSupervisor} always executes the
 * fixed maven command; arbitrary commands cannot be injected through the environment
 * because this fixture is not present in the production image.</p>
 *
 * <p>Scenarios (argv[0]):</p>
 * <ul>
 *   <li>{@code ready-server} — child is a tiny HTTP server answering 200 on
 *       {@code $MANAO_PRIMARY_PORT} (real readiness).</li>
 *   <li>{@code ready-ignore-term} — child traps SIGTERM to ignore it, then runs the same
 *       HTTP server forever; it only logs {@code natural-exit} if the server ever stops
 *       on its own.</li>
 *   <li>{@code early-exit-0} / {@code early-exit-1} — child logs a start marker and
 *       exits immediately with 0 / 1.</li>
 *   <li>{@code receipt-fails-after-claim} — a watcher thread replaces
 *       {@code receipt.properties} with a directory as soon as the CLAIMED receipt has
 *       been written, so every later receipt rename fails; the ready-server child is
 *       used.</li>
 * </ul>
 *
 * <p>Each child start appends {@code start} to {@code $MANAO_TEST_CHILD_LOG} (mounted at
 * {@code /childout/starts.log} by the test script) to prove exactly-once execution.</p>
 */
public final class RuntimeFixtureMain {

    private RuntimeFixtureMain() {
    }

    public static void main(String[] args) throws Exception {
        String scenario = args.length == 0 ? "" : args[0];
        int exitCode;
        switch (scenario) {
            case "ready-server" -> exitCode = WebRunSupervisor.runMode(readyServerCommand());
            case "ready-ignore-term" -> {
                String cp = System.getProperty("java.class.path");
                exitCode = WebRunSupervisor.runMode(List.of("bash", "-c",
                        "trap '' TERM; echo start >> \"$MANAO_TEST_CHILD_LOG\"; "
                                + "java -cp '" + cp
                                + "' 'com.manao.runtime.RuntimeFixtureMain$ReadyServer' & "
                                + "wait $!; echo natural-exit >> \"$MANAO_TEST_CHILD_LOG\""));
            }
            case "early-exit-0" -> exitCode = WebRunSupervisor.runMode(List.of("sh", "-c",
                    "echo start >> \"$MANAO_TEST_CHILD_LOG\"; exit 0"));
            case "early-exit-1" -> exitCode = WebRunSupervisor.runMode(List.of("sh", "-c",
                    "echo start >> \"$MANAO_TEST_CHILD_LOG\"; exit 1"));
            case "receipt-fails-after-claim" -> {
                tamperReceiptAfterClaim();
                exitCode = WebRunSupervisor.runMode(readyServerCommand());
            }
            default -> {
                System.err.println("unknown fixture scenario: " + scenario);
                exitCode = 2;
            }
        }
        // runMode returns the intended exit code; exiting explicitly also ends the
        // non-daemon lifetime thread that would otherwise keep the JVM alive.
        System.exit(exitCode);
    }

    private static List<String> readyServerCommand() {
        return List.of("java", "-cp", System.getProperty("java.class.path"),
                "com.manao.runtime.RuntimeFixtureMain$ReadyServer");
    }

    /**
     * Keeps {@code receipt.properties} replaced by a directory from the moment the
     * supervisor first writes it (the CLAIMED receipt). The first CLAIMED-to-READY gap
     * is at least the child's boot time, so the swap reliably precedes the READY write;
     * every later rename then fails and the run must end fail-closed. The loop keeps
     * re-asserting the directory in case a write ever got through.
     */
    private static void tamperReceiptAfterClaim() {
        Thread tamperer = new Thread(() -> {
            Path receipt = Path.of(
                    System.getenv().getOrDefault("MANAO_RUN_CONTROL_DIR", "/run-control"),
                    "receipt.properties");
            while (true) {
                try {
                    if (Files.isRegularFile(receipt)) {
                        Files.delete(receipt);
                        Files.createDirectory(receipt);
                    }
                } catch (Exception ignored) {
                    // fixture sabotage: any transient failure just retries on the next tick
                }
                try {
                    Thread.sleep(100);
                } catch (InterruptedException e) {
                    return;
                }
            }
        }, "fixture-receipt-tamperer");
        tamperer.setDaemon(true);
        tamperer.start();
    }

    /** Minimal readiness target: HTTP 200 on any path, on {@code $MANAO_PRIMARY_PORT}. */
    public static final class ReadyServer {

        private ReadyServer() {
        }

        public static void main(String[] args) throws Exception {
            int port = Integer.parseInt(
                    System.getenv().getOrDefault("MANAO_PRIMARY_PORT", "8080"));
            appendMarker("start");
            com.sun.net.httpserver.HttpServer server =
                    com.sun.net.httpserver.HttpServer.create(new InetSocketAddress(port), 0);
            server.createContext("/", exchange -> {
                byte[] body = "OK".getBytes(StandardCharsets.UTF_8);
                exchange.getResponseHeaders().add("Content-Type", "text/plain");
                exchange.sendResponseHeaders(200, body.length);
                try (var out = exchange.getResponseBody()) {
                    out.write(body);
                }
            });
            server.start();
            new CountDownLatch(1).await(); // serve until the PID namespace is torn down
        }

        private static void appendMarker(String line) {
            String log = System.getenv("MANAO_TEST_CHILD_LOG");
            if (log == null) {
                return;
            }
            try {
                Files.writeString(Path.of(log), line + "\n",
                        StandardOpenOption.CREATE, StandardOpenOption.APPEND);
            } catch (IOException ignored) {
                // marker logging is best-effort test evidence
            }
        }
    }
}
