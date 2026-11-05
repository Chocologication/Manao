import java.io.*;
import java.net.ServerSocket;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.*;

/** Real child-JVM/JDWP checks. No product services, cluster, model, or third-party libraries. */
public final class DependencyFaultGateSelfTest {
    private static final String PROJECT = "target-project";
    private static final String OPERATION = "original-operation";
    private static final String JAVA = Path.of(System.getProperty("java.home"), "bin", "java").toString();
    private static final String CP = System.getProperty("java.class.path");

    public static void main(String[] args) throws Exception {
        if (args.length > 0 && args[0].equals("fixture")) { fixture(); return; }
        Class.forName("DependencyFaultGate");
        int line = markerLine(Path.of(args[0]));
        try (Harness h = new Harness(line, 6)) {
            h.send("foreign-project foreign-operation pyproject.toml");
            h.target.await("AFTER foreign-operation", Duration.ofSeconds(4));
            h.send(PROJECT + " wrong-operation pyproject.toml");
            h.target.await("AFTER wrong-operation", Duration.ofSeconds(4));
            h.send(PROJECT + " " + OPERATION + " uv.lock");
            h.target.await("AFTER " + OPERATION, Duration.ofSeconds(4));
            h.send(PROJECT + " " + OPERATION + " pyproject.toml");
            h.gate.await("\"event\":\"HIT\"", Duration.ofSeconds(4));
            h.send("foreign-project other-during-hold pyproject.toml");
            h.target.await("AFTER other-during-hold", Duration.ofSeconds(4));
            require(h.target.count("AFTER " + OPERATION) == 1, "target request advanced while held");
            Files.writeString(h.control, "resume", StandardCharsets.UTF_8);
            h.gate.await("\"event\":\"RESUMED\"", Duration.ofSeconds(4));
            h.target.awaitCount("AFTER " + OPERATION, 2, Duration.ofSeconds(4));
            require(h.operator.waitFor(5, TimeUnit.SECONDS) && h.operator.exitValue() == 0, "gate resume failed");
            require(h.gate.lines.stream().noneMatch(s -> s.contains("fixture-secret")), "secret leaked");
        }
        System.out.println("PASS exact identity and filename; foreign request progresses during hold; explicit resume");
        try (Harness h = new Harness(line, 1)) {
            h.send(PROJECT + " " + OPERATION + " pyproject.toml");
            h.gate.await("\"event\":\"HIT\"", Duration.ofSeconds(4));
            h.gate.await("\"event\":\"HOLD_TIMEOUT\"", Duration.ofSeconds(4));
            h.target.await("AFTER " + OPERATION, Duration.ofSeconds(4));
            require(h.operator.waitFor(5, TimeUnit.SECONDS) && h.operator.exitValue() != 0, "timeout must fail gate");
        }
        System.out.println("PASS deadline resumes target and fails gate");
        try (Harness h = new Harness(line, 6)) {
            h.send(PROJECT + " " + OPERATION + " pyproject.toml");
            h.gate.await("\"event\":\"HIT\"", Duration.ofSeconds(4));
            Files.writeString(h.control, "exit", StandardCharsets.UTF_8);
            h.gate.await("\"event\":\"VM_EXIT_REQUESTED\"", Duration.ofSeconds(4));
            require(h.fixture.waitFor(5, TimeUnit.SECONDS) && h.fixture.exitValue() != 0, "VM did not exit");
            require(h.operator.waitFor(5, TimeUnit.SECONDS) && h.operator.exitValue() == 0, "exit control failed");
        }
        System.out.println("PASS scoped held VM exit");
        try (Harness h = new Harness(line, 6)) {
            h.send(PROJECT + " " + OPERATION + " pyproject.toml");
            h.gate.await("\"event\":\"HIT\"", Duration.ofSeconds(4));
            Files.writeString(h.control, "interruptCall", StandardCharsets.UTF_8);
            h.gate.await("\"event\":\"INTERRUPTED\"", Duration.ofSeconds(4));
            h.target.await("AFTER_INTERRUPTED " + OPERATION, Duration.ofSeconds(4));
            require(h.operator.waitFor(5, TimeUnit.SECONDS) && h.operator.exitValue() == 0, "interrupt control failed");
        }
        System.out.println("PASS scoped held request interrupt");
        try (Harness h = new Harness(line, 6, false)) {
            h.send(PROJECT + " " + OPERATION + " pyproject.toml block");
            h.target.await("BLOCKED " + OPERATION, Duration.ofSeconds(4));
            var rejected = h.command("exit", "foreign-project");
            require(rejected.waitFor(5, TimeUnit.SECONDS) && rejected.exitValue() != 0, "foreign VM exit was allowed");
            require(h.fixture.isAlive(), "foreign command exited fixture");
            var interrupt = h.command("interruptCall", PROJECT);
            require(interrupt.waitFor(5, TimeUnit.SECONDS) && interrupt.exitValue() == 0,
                "standalone interrupt failed: " + new String(interrupt.getInputStream().readAllBytes(), StandardCharsets.UTF_8));
            h.target.await("BLOCK_INTERRUPTED " + OPERATION, Duration.ofSeconds(4));
        }
        System.out.println("PASS standalone interrupt through native blocking frames; foreign exit refused");
        try (Harness h = new Harness(line, 6, false)) {
            h.send(PROJECT + " " + OPERATION + " pyproject.toml block");
            h.target.await("BLOCKED " + OPERATION, Duration.ofSeconds(4));
            var exit = h.command("exit", PROJECT);
            require(exit.waitFor(5, TimeUnit.SECONDS) && exit.exitValue() == 0,
                "standalone exit failed: " + new String(exit.getInputStream().readAllBytes(), StandardCharsets.UTF_8));
            require(h.fixture.waitFor(5, TimeUnit.SECONDS) && h.fixture.exitValue() != 0, "standalone VM did not exit");
        }
        System.out.println("PASS standalone scoped VM exit");
        try (Harness h = new Harness(line, 6, true, null)) {
            h.send(PROJECT + " " + OPERATION + " pyproject.toml");
            h.gate.await("\"event\":\"HIT\"", Duration.ofSeconds(4));
            require(h.gate.lines.stream().anyMatch(s -> s.contains("\"event\":\"HIT\"")
                && s.contains("\"operationId\":\"original-operation\"")), "optional operation was not bound from observed frame");
            Files.writeString(h.control, "resume", StandardCharsets.UTF_8);
            h.target.await("AFTER " + OPERATION, Duration.ofSeconds(4));
        }
        System.out.println("PASS optional operation binds observed durable identity");
        try (Harness h = new Harness(line, 6, false)) {
            h.send(PROJECT + " " + OPERATION + " pyproject.toml http");
            h.target.await("HTTP_WAITING " + OPERATION, Duration.ofSeconds(6));
            var interrupt = h.command("interruptCall", PROJECT);
            require(interrupt.waitFor(5, TimeUnit.SECONDS) && interrupt.exitValue() == 0,
                "HTTP interrupt failed: " + new String(interrupt.getInputStream().readAllBytes(), StandardCharsets.UTF_8));
            h.target.await("HTTP_INTERRUPTED " + OPERATION, Duration.ofSeconds(5));
        }
        System.out.println("PASS real HttpClient.send interrupted while socket response is withheld");
        try (Harness h = new Harness(line, 6, true, null, true)) {
            h.send("foreign-project no-trace pyproject.toml");
            h.target.await("AFTER no-trace", Duration.ofSeconds(4));
            h.send(PROJECT + " " + OPERATION + " pyproject.toml");
            h.gate.await("\"event\":\"HIT\"", Duration.ofSeconds(4));
            Files.writeString(h.control, "resume", StandardCharsets.UTF_8);
            h.target.await("AFTER " + OPERATION, Duration.ofSeconds(4));
            h.send(PROJECT + " " + OPERATION + " pyproject.toml");
            h.target.awaitCount("AFTER " + OPERATION, 2, Duration.ofSeconds(4));
            h.gate.await("\"event\":\"TRACE_COMPLETE\"", Duration.ofSeconds(5));
            require(h.gate.lines.stream().filter(s -> s.contains("\"event\":\"TRACE\"")).count() == 4,
                "trace must continue after resume exactly once per configured boundary");
            require(h.gate.lines.stream().noneMatch(s -> s.contains("no-trace")), "foreign trace emitted");
            require(h.operator.waitFor(5, TimeUnit.SECONDS) && h.operator.exitValue() == 0, "trace tail failed");
        }
        System.out.println("PASS same-connection repeated trace boundaries continue after one-shot gate resume");
        try (Harness h = new Harness(line, 6, true, OPERATION, true)) {
            h.send(PROJECT + " " + OPERATION + " pyproject.toml");
            h.gate.await("\"event\":\"HIT\"", Duration.ofSeconds(4));
            Files.writeString(h.control, "exit", StandardCharsets.UTF_8);
            require(h.operator.waitFor(5, TimeUnit.SECONDS) && h.operator.exitValue() == 0, "planned VM exit entered disconnected trace tail");
        }
        System.out.println("PASS planned VM exit skips trace tail");
        try (Harness h = new Harness(line, 6, true, OPERATION, true)) {
            // These unrelated request seats deliberately share identity. Only the original
            // HIT thread may be interrupted; re-scanning every thread is ambiguous and slow.
            for (int i = 0; i < 64; i++) h.send(PROJECT + " " + OPERATION + " pyproject.toml block");
            h.target.awaitCount("BLOCKED " + OPERATION, 64, Duration.ofSeconds(5));
            h.send(PROJECT + " " + OPERATION + " pyproject.toml tail");
            h.gate.await("\"event\":\"HIT\"", Duration.ofSeconds(4));
            Files.writeString(h.control, "resume", StandardCharsets.UTF_8);
            h.target.await("TAIL_BLOCKED " + OPERATION, Duration.ofSeconds(4));
            long start = System.nanoTime();
            Files.writeString(h.control, "interruptCall", StandardCharsets.UTF_8);
            h.target.await("TAIL_INTERRUPTED " + OPERATION, Duration.ofSeconds(3));
            require(h.target.count("BLOCK_INTERRUPTED " + OPERATION) == 0, "another request seat was interrupted");
            require(h.gate.lines.stream().noneMatch(s -> s.contains("SCOPE_NOT_UNIQUE")), "tail lost original request thread binding");
            System.out.println("PERF bound request interrupt milliseconds=" + TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - start));
        }
        System.out.println("PASS trace tail targets original HIT thread among 64 same-identity blocked peers");
        System.out.println("SELF_TEST_PASS");
    }

    private static void fixture() throws Exception {
        System.out.println("FIXTURE_READY");
        var input = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
        for (String line; (line = input.readLine()) != null;) {
            String[] p = line.split(" ");
            new Thread(() -> {
                if (p.length > 3 && p[3].equals("tail")) tailRequest(p[0], p[1], p[2]);
                else if (p.length > 3 && p[3].equals("http")) httpBlocking(p[0], p[1]);
                else if (p.length > 3) blocking(p[0], p[1], p[2]);
                else boundary(p[0], p[1], p[2]);
            }, "fixture-request").start();
        }
    }

    private static void boundary(String projectId, String operationId, String name) {
        String secret = "fixture-secret-must-never-be-printed";
        System.out.println("BEFORE " + operationId); // JDWP_TRACE
        int boundary = name.length(); // JDWP_BOUNDARY
        if (Thread.currentThread().isInterrupted()) System.out.println("AFTER_INTERRUPTED " + operationId);
        else System.out.println("AFTER " + operationId);
        if (boundary == 0 && secret.isEmpty()) throw new AssertionError();
    }

    private static void tailRequest(String projectId, String operationId, String name) {
        boundary(projectId, operationId, name);
        System.out.println("TAIL_BLOCKED " + operationId);
        try { Thread.sleep(120_000); }
        catch (InterruptedException ex) { System.out.println("TAIL_INTERRUPTED " + operationId); }
    }

    private static int markerLine(Path path) throws IOException {
        return markerLine(path, "// JDWP_BOUNDARY");
    }
    private static int markerLine(Path path, String marker) throws IOException {
        var lines = Files.readAllLines(path, StandardCharsets.UTF_8);
        for (int i = 0; i < lines.size(); i++) if (lines.get(i).endsWith(marker)) return i + 1;
        throw new AssertionError("fixture marker missing");
    }

    private static void blocking(String projectId, String operationId, String name) {
        System.out.println("BLOCKED " + operationId);
        try { Thread.sleep(120_000); }
        catch (InterruptedException ex) { System.out.println("BLOCK_INTERRUPTED " + operationId); }
    }

    private static void httpBlocking(String projectId, String operationId) {
        try (var server = new ServerSocket(0, 1, java.net.InetAddress.getByName("127.0.0.1"))) {
            Thread peer = new Thread(() -> {
                try (var socket = server.accept()) {
                    socket.getInputStream().read();
                    System.out.println("HTTP_WAITING " + operationId);
                    Thread.sleep(120_000);
                } catch (Exception ignored) { }
            });
            peer.setDaemon(true); peer.start();
            var request = java.net.http.HttpRequest.newBuilder(java.net.URI.create("http://127.0.0.1:" + server.getLocalPort()))
                .timeout(Duration.ofSeconds(30)).POST(java.net.http.HttpRequest.BodyPublishers.ofString("test")).build();
            java.net.http.HttpClient.newHttpClient().send(request, java.net.http.HttpResponse.BodyHandlers.ofString());
        } catch (InterruptedException ex) { System.out.println("HTTP_INTERRUPTED " + operationId); }
        catch (IOException ex) { System.out.println("HTTP_IO_FAILURE " + operationId); }
    }

    private static final class Harness implements AutoCloseable {
        final Path directory = Files.createTempDirectory("dependency-fault-gate-");
        final Path control = directory.resolve("control");
        final Process fixture;
        final Process operator;
        final Lines target;
        final Lines gate;
        final BufferedWriter input;
        final int port;
        Harness(int line, int hold) throws Exception {
            this(line, hold, true);
        }
        Harness(int line, int hold, boolean gated) throws Exception {
            this(line, hold, gated, OPERATION);
        }
        Harness(int line, int hold, boolean gated, String operation) throws Exception {
            this(line, hold, gated, operation, false);
        }
        Harness(int line, int hold, boolean gated, String operation, boolean trace) throws Exception {
            try (ServerSocket socket = new ServerSocket(0, 1, java.net.InetAddress.getLoopbackAddress())) { port = socket.getLocalPort(); }
            fixture = new ProcessBuilder(JAVA, "-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=127.0.0.1:" + port,
                "-cp", CP, getClass().getEnclosingClass().getName(), "fixture").redirectErrorStream(true).start();
            target = new Lines(fixture);
            target.await("FIXTURE_READY", Duration.ofSeconds(8));
            input = new BufferedWriter(new OutputStreamWriter(fixture.getOutputStream(), StandardCharsets.UTF_8));
            if (!gated) { operator = null; gate = null; return; }
            var arguments = new ArrayList<>(List.of(JAVA, "--add-modules", "jdk.jdi", "-cp", CP, "DependencyFaultGate", "gate",
                "--host", "127.0.0.1", "--port", Integer.toString(port), "--project", PROJECT,
                "--at", "DependencyFaultGateSelfTest:" + line, "--file", "pyproject.toml",
                "--control", control.toString(), "--max-hold-seconds", Integer.toString(hold), "--wait-seconds", "15"));
            if (operation != null) { arguments.add("--operation"); arguments.add(operation); }
            if (trace) {
                int traceLine = markerLine(Path.of("poc4/deploy/ai-python-environment/operators/DependencyFaultGateSelfTest.java"), "// JDWP_TRACE");
                arguments.addAll(List.of("--trace-at", "DependencyFaultGateSelfTest:" + traceLine,
                    "--trace-at", "DependencyFaultGateSelfTest:" + line, "--trace-after-seconds", "2"));
            }
            operator = new ProcessBuilder(arguments)
                .redirectErrorStream(true).start();
            gate = new Lines(operator);
            gate.await("\"event\":\"ARMED\"", Duration.ofSeconds(8));
        }
        void send(String value) throws IOException { input.write(value); input.newLine(); input.flush(); }
        Process command(String action, String project) throws IOException {
            return new ProcessBuilder(JAVA, "--add-modules", "jdk.jdi", "-cp", CP, "DependencyFaultGate", action,
                "--host", "127.0.0.1", "--port", Integer.toString(port), "--project", project,
                "--operation", OPERATION).redirectErrorStream(true).start();
        }
        @Override public void close() throws IOException {
            if (operator != null) operator.destroyForcibly();
            fixture.destroyForcibly();
            try {
                if (operator != null) operator.waitFor(5, TimeUnit.SECONDS);
                fixture.waitFor(5, TimeUnit.SECONDS);
            } catch (InterruptedException ex) { Thread.currentThread().interrupt(); }
            Files.deleteIfExists(control); Files.deleteIfExists(directory);
        }
    }

    private static final class Lines {
        final List<String> lines = new CopyOnWriteArrayList<>();
        Lines(Process process) {
            var thread = new Thread(() -> {
                try (var reader = new BufferedReader(new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
                    for (String line; (line = reader.readLine()) != null;) lines.add(line);
                } catch (IOException ignored) { }
            });
            thread.setDaemon(true); thread.start();
        }
        int count(String value) { return (int) lines.stream().filter(s -> s.equals(value)).count(); }
        void await(String value, Duration timeout) throws Exception {
            long deadline = System.nanoTime() + timeout.toNanos();
            while (System.nanoTime() < deadline) {
                if (lines.stream().anyMatch(s -> s.contains(value))) return;
                Thread.sleep(20);
            }
            throw new AssertionError("missing " + value + "; child output=" + lines);
        }
        void awaitCount(String value, int expected, Duration timeout) throws Exception {
            long deadline = System.nanoTime() + timeout.toNanos();
            while (System.nanoTime() < deadline) { if (count(value) >= expected) return; Thread.sleep(20); }
            throw new AssertionError("missing count for " + value);
        }
    }
    private static void require(boolean condition, String message) { if (!condition) throw new AssertionError(message); }
}
