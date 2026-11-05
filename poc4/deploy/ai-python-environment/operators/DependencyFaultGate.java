import com.sun.jdi.*;
import com.sun.jdi.connect.AttachingConnector;
import com.sun.jdi.event.*;
import com.sun.jdi.request.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.time.Duration;
import java.util.*;

/** Operator-only, single-thread JDI gates. Never linked into product code or images. */
public final class DependencyFaultGate {
    private static final Set<String> IDENTITIES = Set.of("projectId", "operationId", "workspaceOperationId", "taskId", "toolCallId");
    private static final Set<String> ROOTS = Set.of("operation", "prepared", "manifest", "owner", "call", "request", "command", "verifier", "project");
    private static final Set<String> LINKS = Set.of("operation", "prepared", "manifest", "owner", "call", "request", "command", "verifier");
    private static final Set<String> OPTIONS = Set.of("host", "port", "project", "operation", "at", "file", "control", "max-hold-seconds", "wait-seconds", "thread-id", "trace-after-seconds");

    public static void main(String[] args) {
        int code;
        try { code = run(Options.parse(args)); }
        catch (Exception ex) { emit("ERROR", "code", ex.getClass().getSimpleName()); code = 2; }
        if (code != 0) System.exit(code);
    }

    private static int run(Options options) throws Exception {
        VirtualMachine vm = attach(options.port());
        try {
            if (options.mode().equals("gate")) return gate(vm, options);
            return command(vm, options);
        } finally {
            try { vm.dispose(); } catch (VMDisconnectedException ignored) { }
        }
    }

    private static VirtualMachine attach(int port) throws Exception {
        AttachingConnector connector = Bootstrap.virtualMachineManager().attachingConnectors().stream()
            .filter(c -> c.name().equals("com.sun.jdi.SocketAttach")).findFirst().orElseThrow();
        var arguments = connector.defaultArguments();
        arguments.get("hostname").setValue("127.0.0.1");
        arguments.get("port").setValue(Integer.toString(port));
        arguments.get("timeout").setValue("5000");
        return connector.attach(arguments);
    }

    private static int gate(VirtualMachine vm, Options options) throws Exception {
        if (Files.exists(options.control(), LinkOption.NOFOLLOW_LINKS)) throw new IllegalArgumentException("stale control");
        var manager = vm.eventRequestManager();
        List<Boundary> boundaries = new ArrayList<>(options.traces());
        boundaries.add(new Boundary(options.className(), options.line(), false));
        for (String className : boundaries.stream().map(Boundary::className).distinct().toList()) {
            var classPrepare = manager.createClassPrepareRequest();
            classPrepare.addClassFilter(className);
            classPrepare.setSuspendPolicy(EventRequest.SUSPEND_EVENT_THREAD);
            classPrepare.enable();
        }
        Set<String> installed = new HashSet<>();
        for (Boundary boundary : boundaries) {
            for (ReferenceType type : vm.classesByName(boundary.className())) {
                if (type.isPrepared()) install(manager, type, boundary, installed);
            }
        }
        emit("ARMED", "projectId", options.project(), "operationId", options.operation(), "class", options.className(), "line", options.line());
        long deadline = System.nanoTime() + options.waitTime().toNanos();
        Options scoped = options;
        while (System.nanoTime() < deadline) {
            EventSet set = vm.eventQueue().remove(100);
            if (set == null) continue;
            BreakpointEvent match = null;
            Scope matchedScope = null;
            try {
                for (Event event : set) {
                    if (event instanceof ClassPrepareEvent prepared) installMatching(manager, prepared.referenceType(), boundaries, installed);
                    if (event instanceof BreakpointEvent hit) {
                        Scope found = inspect(hit.thread());
                        if (Boolean.TRUE.equals(hit.request().getProperty("trace"))) {
                            if (scoped.matchesScope(found)) {
                                scoped = scoped.bind(found);
                                emitHit("TRACE", hit.thread(), hit.location(), scoped);
                            }
                        } else if (scoped.matches(found)) { match = hit; matchedScope = found; }
                    }
                    if (event instanceof VMDeathEvent || event instanceof VMDisconnectEvent) throw new VMDisconnectedException();
                }
                if (match != null) {
                    for (BreakpointRequest breakpoint : manager.breakpointRequests()) {
                        if (!Boolean.TRUE.equals(breakpoint.getProperty("trace"))) breakpoint.disable();
                    }
                    Options bound = scoped.bind(matchedScope).withThread(match.thread().uniqueID());
                    emitHit("HIT", match.thread(), match.location(), bound);
                    int outcome = hold(vm, set, match.thread(), bound, installed);
                    if (outcome == 10) return 0; // Explicit VM exit has no remaining trace interval.
                    return outcome == 0 && !bound.traceAfter().isZero() ? traceTail(vm, bound, installed) : outcome;
                }
            } finally {
                // The hold method owns the matched event set and resumes it exactly once.
                if (match == null) set.resume();
            }
        }
        emit("WAIT_TIMEOUT", "projectId", options.project());
        return 3;
    }

    private static void installMatching(EventRequestManager manager, ReferenceType type, List<Boundary> boundaries, Set<String> installed) throws Exception {
        for (Boundary boundary : boundaries) if (boundary.className().equals(type.name())) install(manager, type, boundary, installed);
    }

    private static void install(EventRequestManager manager, ReferenceType type, Boundary boundary, Set<String> installed) throws Exception {
        List<Location> locations = type.locationsOfLine(boundary.line());
        if (locations.isEmpty()) throw new IllegalArgumentException("line unavailable");
        for (Location location : locations) {
            String key = type.name() + "/" + location.method().name() + "/" + location.codeIndex() + "/" + boundary.trace();
            if (!installed.add(key)) continue;
            var breakpoint = manager.createBreakpointRequest(location);
            breakpoint.setSuspendPolicy(EventRequest.SUSPEND_EVENT_THREAD);
            breakpoint.putProperty("trace", boundary.trace());
            breakpoint.enable();
            emit("BOUND", "class", type.name(), "method", location.method().name(), "line", boundary.line(), "kind", boundary.trace() ? "trace" : "gate");
        }
    }

    private static int hold(VirtualMachine vm, EventSet held, ThreadReference thread, Options options, Set<String> installed) throws Exception {
        long deadline = System.nanoTime() + options.holdTime().toNanos();
        boolean exited = false;
        try {
            while (System.nanoTime() < deadline) {
                if (Files.exists(options.control(), LinkOption.NOFOLLOW_LINKS)) {
                    if (!Files.isRegularFile(options.control(), LinkOption.NOFOLLOW_LINKS) || Files.size(options.control()) > 64)
                        throw new IllegalArgumentException("invalid control");
                    String action = Files.readString(options.control(), StandardCharsets.UTF_8).trim();
                    if (action.equals("resume")) { emit("RESUMED", "projectId", options.project()); return 0; }
                    if (action.equals("interruptCall")) {
                        if (options.operation() == null) throw new IllegalArgumentException("no observed operation");
                        thread.interrupt();
                        emit("INTERRUPTED", "projectId", options.project(), "operationId", options.operation(), "threadId", thread.uniqueID());
                        return 0;
                    }
                    if (action.equals("exit")) {
                        if (options.operation() == null) throw new IllegalArgumentException("no observed operation");
                        emit("VM_EXIT_REQUESTED", "projectId", options.project(), "operationId", options.operation());
                        exited = true;
                        vm.exit(97);
                        return 10;
                    }
                    throw new IllegalArgumentException("unknown control");
                }
                // Foreign events already queued before our one-shot disable must not stay suspended.
                EventSet other = vm.eventQueue().remove(50);
                if (other != null) traceEvents(vm, other, options, installed);
            }
            emit("HOLD_TIMEOUT", "projectId", options.project(), "operationId", options.operation());
            return 4;
        } finally {
            if (!exited) try { held.resume(); } catch (VMDisconnectedException ignored) { }
        }
    }

    private static int traceTail(VirtualMachine vm, Options options, Set<String> installed) throws Exception {
        long deadline = System.nanoTime() + options.traceAfter().toNanos();
        String consumed = readControl(options.control());
        while (System.nanoTime() < deadline) {
            String action = readControl(options.control());
            if (action != null && !action.equals(consumed)) {
                consumed = action;
                if (!action.equals("resume")) {
                    if (!Set.of("exit", "interruptCall").contains(action) || options.operation() == null)
                        throw new IllegalArgumentException("invalid trace control");
                    int outcome = command(vm, options.withMode(action));
                    if (outcome != 0 || action.equals("exit")) return outcome;
                }
            }
            EventSet set = vm.eventQueue().remove(100);
            if (set != null) traceEvents(vm, set, options, installed);
        }
        emit("TRACE_COMPLETE", "projectId", options.project(), "operationId", options.operation());
        return 0;
    }

    private static String readControl(Path path) throws Exception {
        if (!Files.exists(path, LinkOption.NOFOLLOW_LINKS)) return null;
        if (!Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS) || Files.size(path) > 64)
            throw new IllegalArgumentException("invalid control");
        return Files.readString(path, StandardCharsets.UTF_8).trim();
    }

    private static void traceEvents(VirtualMachine vm, EventSet set, Options options, Set<String> installed) throws Exception {
        try {
            for (Event event : set) {
                if (event instanceof ClassPrepareEvent prepared)
                    installMatching(vm.eventRequestManager(), prepared.referenceType(), options.traces(), installed);
                if (event instanceof BreakpointEvent hit && Boolean.TRUE.equals(hit.request().getProperty("trace"))
                        && options.matchesScope(inspect(hit.thread()))) emitHit("TRACE", hit.thread(), hit.location(), options);
                if (event instanceof VMDeathEvent || event instanceof VMDisconnectEvent) throw new VMDisconnectedException();
            }
        } finally { try { set.resume(); } catch (VMDisconnectedException ignored) { } }
    }

    private static int command(VirtualMachine vm, Options options) throws Exception {
        // A standalone destructive command requires a unique, currently executing scoped call.
        List<ThreadReference> matched = new ArrayList<>();
        try {
            for (ThreadReference thread : vm.allThreads()) {
                if (options.threadId() != null && thread.uniqueID() != options.threadId()) continue;
                boolean retained = false;
                thread.suspend();
                try {
                    if (options.matches(inspect(thread))) { matched.add(thread); retained = true; }
                } catch (IncompatibleThreadStateException | InvalidStackFrameException ignored) {
                    // Thread disappeared or has no inspectable Java frame; it is not authority.
                } finally { if (!retained) thread.resume(); }
            }
            if (matched.size() != 1) {
                emit("SCOPE_NOT_UNIQUE", "projectId", options.project(), "matchingThreads", matched.size());
                return 5;
            }
            ThreadReference thread = matched.get(0);
            if (options.mode().equals("exit")) {
                emit("VM_EXIT_REQUESTED", "projectId", options.project(), "operationId", options.operation());
                vm.exit(97);
            } else {
                thread.interrupt();
                emit("INTERRUPTED", "projectId", options.project(), "operationId", options.operation(), "threadId", thread.uniqueID());
            }
            return 0;
        } finally {
            for (ThreadReference thread : matched) try { thread.resume(); } catch (VMDisconnectedException ignored) { }
        }
    }

    private static Scope inspect(ThreadReference thread) throws IncompatibleThreadStateException {
        Scope scope = new Scope();
        Set<Long> seen = new HashSet<>();
        for (StackFrame frame : thread.frames()) {
            if (frame.location().method().isNative()) continue;
            // No target method invocation, no arbitrary object traversal, no object/value dump.
            try {
                for (LocalVariable local : frame.visibleVariables()) {
                    String name = local.name();
                    if (IDENTITIES.contains(name) || name.equals("name") || name.equals("path")) scope.accept(name, frame.getValue(local));
                    else if (ROOTS.contains(name)) inspectObject(frame.getValue(local), name, scope, seen, 0);
                }
            } catch (AbsentInformationException ignored) { }
            // Record arguments remain available even if LocalVariableTable is stripped.
            for (Value argument : frame.getArgumentValues()) {
                if (argument instanceof ObjectReference && !(argument instanceof StringReference))
                    inspectObject(argument, "argument", scope, seen, 0);
            }
            ObjectReference receiver = frame.thisObject();
            if (receiver != null && frame.location().declaringType().name().equals(
                    "com.manao.poc4.workspaceagent.WorkspaceCapabilityFilter")) {
                inspectObject(receiver, "filter", scope, seen, 0);
            }
        }
        return scope;
    }

    private static void inspectObject(Value value, String role, Scope scope, Set<Long> seen, int depth) {
        if (!(value instanceof ObjectReference object) || value instanceof StringReference || depth > 4 || !seen.add(object.uniqueID())) return;
        for (Field field : object.referenceType().allFields()) {
            if (field.isStatic()) continue;
            String name = field.name();
            if (IDENTITIES.contains(name) || name.equals("name") || name.equals("path")) scope.accept(name, object.getValue(field));
            else if (name.equals("id") && (role.equals("operation") || object.referenceType().name().endsWith("$OperationRecord")))
                scope.accept("operationId", object.getValue(field));
            else if (name.equals("id") && role.equals("project")) scope.accept("projectId", object.getValue(field));
            else if (LINKS.contains(name)) inspectObject(object.getValue(field), name, scope, seen, depth + 1);
        }
    }

    private static final class Scope {
        final Set<String> projects = new HashSet<>();
        final Set<String> operations = new HashSet<>();
        final Set<String> filenames = new HashSet<>();
        void accept(String name, Value value) {
            if (!(value instanceof StringReference string)) return;
            String text = string.value();
            if (text.length() > 256) return;
            if (name.equals("projectId")) projects.add(text);
            if (name.equals("operationId") || name.equals("workspaceOperationId")) operations.add(text);
            if (name.equals("name") || name.equals("path")) {
                String normalized = text.replace('\\', '/');
                filenames.add(normalized.substring(normalized.lastIndexOf('/') + 1));
            }
        }
    }

    private static void emitHit(String event, ThreadReference thread, Location location, Options options) {
        emit(event, "projectId", options.project(), "operationId", options.operation(), "threadId", thread.uniqueID(),
            "class", location.declaringType().name(), "method", location.method().name(), "line", location.lineNumber());
    }

    private static synchronized void emit(String event, Object... pairs) {
        StringBuilder json = new StringBuilder("{\"event\":").append(quoted(event));
        for (int i = 0; i < pairs.length; i += 2) {
            Object value = pairs[i + 1];
            if (value == null) continue;
            json.append(',').append(quoted(pairs[i].toString())).append(':');
            json.append(value instanceof Number ? value : quoted(value.toString()));
        }
        System.out.println(json.append('}'));
    }

    private static String quoted(String value) {
        StringBuilder result = new StringBuilder("\"");
        for (char c : value.toCharArray()) {
            if (c == '"' || c == '\\') result.append('\\').append(c);
            else if (c < 32) result.append(String.format("\\u%04x", (int) c));
            else result.append(c);
        }
        return result.append('"').toString();
    }

    private record Options(String mode, int port, String project, String operation, String className, int line,
                           String filename, Path control, Duration holdTime, Duration waitTime, Long threadId,
                           List<Boundary> traces, Duration traceAfter) {
        boolean matches(Scope scope) {
            return matchesScope(scope) && (filename == null || scope.filenames.contains(filename));
        }
        boolean matchesScope(Scope scope) {
            return scope.projects.equals(Set.of(project))
                && (operation == null ? scope.operations.size() <= 1 : scope.operations.equals(Set.of(operation)));
        }
        Options bind(Scope scope) {
            String bound = operation != null ? operation : scope.operations.stream().findFirst().orElse(null);
            return new Options(mode, port, project, bound, className, line, filename, control, holdTime, waitTime, threadId, traces, traceAfter);
        }
        Options withMode(String action) {
            return new Options(action, port, project, operation, className, line, null, control, holdTime, waitTime, threadId, traces, traceAfter);
        }
        Options withThread(long id) {
            return new Options(mode, port, project, operation, className, line, filename, control, holdTime, waitTime, id, traces, traceAfter);
        }
        static Options parse(String[] args) {
            if (args.length < 1 || !Set.of("gate", "exit", "interruptCall").contains(args[0])) throw new IllegalArgumentException("mode");
            Map<String, String> values = new HashMap<>();
            List<Boundary> traces = new ArrayList<>();
            for (int i = 1; i < args.length; i += 2) {
                if (i + 1 == args.length || !args[i].startsWith("--")) throw new IllegalArgumentException("argument");
                String key = args[i].substring(2);
                if (key.equals("trace-at")) { traces.add(Boundary.parse(args[i + 1])); continue; }
                if (!OPTIONS.contains(key) || values.putIfAbsent(key, args[i + 1]) != null) throw new IllegalArgumentException("option");
            }
            if (!required(values, "host").equals("127.0.0.1")) throw new IllegalArgumentException("loopback required");
            int port = number(required(values, "port"), 1, 65535);
            String project = identifier(required(values, "project"));
            String operation = values.containsKey("operation") ? identifier(values.get("operation")) : null;
            if (!args[0].equals("gate") && operation == null) throw new IllegalArgumentException("command needs operation");
            String className = null;
            int line = 0;
            Path control = null;
            if (args[0].equals("gate")) {
                String at = required(values, "at");
                int separator = at.lastIndexOf(':');
                if (separator <= 0) throw new IllegalArgumentException("class:line required");
                className = at.substring(0, separator);
                if (!className.matches("[A-Za-z_$][A-Za-z0-9_.$]*")) throw new IllegalArgumentException("class");
                line = number(at.substring(separator + 1), 1, Integer.MAX_VALUE);
                control = Path.of(required(values, "control")).toAbsolutePath().normalize();
            }
            String file = values.get("file");
            if (file != null && !Set.of("pyproject.toml", "uv.lock").contains(file)) throw new IllegalArgumentException("managed filename required");
            int hold = number(values.getOrDefault("max-hold-seconds", "20"), 1, 120);
            int wait = number(values.getOrDefault("wait-seconds", "60"), 1, 600);
            int after = number(values.getOrDefault("trace-after-seconds", "0"), 0, 600);
            if (traces.size() > 16 || after > 0 && traces.isEmpty()) throw new IllegalArgumentException("trace configuration");
            Long threadId = values.containsKey("thread-id") ? Long.parseLong(values.get("thread-id")) : null;
            if (threadId != null && threadId <= 0) throw new IllegalArgumentException("thread");
            return new Options(args[0], port, project, operation, className, line, file, control,
                Duration.ofSeconds(hold), Duration.ofSeconds(wait), threadId, List.copyOf(traces), Duration.ofSeconds(after));
        }
        private static String required(Map<String, String> values, String key) {
            String value = values.get(key);
            if (value == null || value.isBlank()) throw new IllegalArgumentException("missing option");
            return value;
        }
        private static String identifier(String value) {
            if (!value.matches("[A-Za-z0-9_.:-]{1,160}")) throw new IllegalArgumentException("identifier");
            return value;
        }
        private static int number(String value, int minimum, int maximum) {
            int result = Integer.parseInt(value);
            if (result < minimum || result > maximum) throw new IllegalArgumentException("range");
            return result;
        }
    }

    private record Boundary(String className, int line, boolean trace) {
        static Boundary parse(String value) {
            int separator = value.lastIndexOf(':');
            if (separator <= 0) throw new IllegalArgumentException("trace class:line required");
            String className = value.substring(0, separator);
            if (!className.matches("[A-Za-z_$][A-Za-z0-9_.$]*")) throw new IllegalArgumentException("trace class");
            return new Boundary(className, Options.number(value.substring(separator + 1), 1, Integer.MAX_VALUE), true);
        }
    }
}
