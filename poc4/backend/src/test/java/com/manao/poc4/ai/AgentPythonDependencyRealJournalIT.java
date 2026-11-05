package com.manao.poc4.ai;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.manao.poc4.api.ApiException;
import com.manao.poc4.persistence.JdbcStoreTestSupport;
import com.manao.poc4.project.JdbcProjectRuntimeStore;
import com.manao.poc4.project.ProjectLifecycleGate;
import com.manao.poc4.project.ProjectRuntimeSpec;
import com.manao.poc4.workspace.*;
import java.lang.reflect.Constructor;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Proxy;
import java.net.URLClassLoader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.sql.Timestamp;
import java.time.Clock;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.IntConsumer;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;

/**
 * Opt-in local composition: real AI services + disposable MySQL + real workspace-agent classes,
 * journal and filesystem + pinned Docker helper/uv. The bridge replaces transport only; this is
 * deliberately not an HTTP/capability test. Build workspace-agent classes before invoking this IT.
 * Re-preparing on recovery, settling before receipts, or committing only one file breaks this test.
 */
class AgentPythonDependencyRealJournalIT {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String OWNER = "real-journal-owner";
    private static final String PROJECT = "real-journal-project";
    private static final String IMAGE = System.getProperty("manao.dependency.it.image",
        "sha256:89fce304654dd4a2cb1988c0ea89b9b4d29cfc51542e582661bf289d9f160810");
    private static final List<String> PATHS = List.of("pyproject.toml", "uv.lock");
    @TempDir Path root;

    @Test void partialRenameThenLostReplyRecoversOriginalJournalAndSettlesExactlyOnce() throws Exception {
        for (String path : PATHS) Files.copy(Path.of("src/main/resources/workspace-template-python", path), root.resolve(path));
        byte[] beforePyproject = Files.readAllBytes(root.resolve("pyproject.toml"));
        byte[] beforeLock = Files.readAllBytes(root.resolve("uv.lock"));
        AtomicInteger firstRenames = new AtomicInteger();
        try (var agent = new RealAgent(root); var db = JdbcStoreTestSupport.create()) {
            agent.reconstruct(n -> {
                firstRenames.incrementAndGet();
                if (n == 1) throw new IllegalStateException("test-only interruption after first durable rename");
            });
            var jdbc = db.jdbc();
            var now = new Timestamp(System.currentTimeMillis());
            jdbc.update("INSERT INTO app_user(id,username,password_hash,created_at) VALUES (?,?,'unused',?)", OWNER, OWNER, now);
            jdbc.update("INSERT INTO project(id,owner_id,name,state,workspace_revision,runtime_spec_json,created_at,updated_at) VALUES (?,?,'real-journal','READY',7,?,?,?)",
                PROJECT, OWNER, new ProjectRuntimeSpec("python-console", false, false, List.of()).toJson(), now, now);
            var store = new WorkspaceJdbcStore(jdbc, new DataSourceTransactionManager(jdbc.getDataSource()));
            var runtime = new JdbcProjectRuntimeStore(jdbc);
            var gate = new ProjectLifecycleGate();
            String taskId = UUID.randomUUID().toString();
            var tasks = new AgentTaskStore(jdbc, new DataSourceTransactionManager(jdbc.getDataSource()), Clock.systemUTC());
            tasks.createTask(OWNER, PROJECT, new AgentContracts.TaskRequest(taskId, "add pytest", 7), null,
                () -> new AgentProjectEnvironmentService(runtime, AgentProjectEnvironmentTest.policy()).forProject(PROJECT));
            var request = new AgentContracts.ToolRequest("actual-pair-call", "python_dependencies", 7,
                JSON.createObjectNode().put("action", "add").put("packageName", "pytest").put("version", "9.0.2").put("group", "test"));
            var tools = tools(tasks, store, runtime, gate, agent.bridge);

            assertThatThrownBy(() -> tools.invoke(taskId, request)).isInstanceOf(ApiException.class);
            assertThat(firstRenames).hasValue(1);
            var call = tasks.findToolCall(taskId, request.toolCallId()).orElseThrow();
            var operation = store.findOperation(PROJECT, call.workspaceOperationId()).orElseThrow();
            Path journal = root.resolve(".manao/python-dependencies").resolve(operation.id());
            byte[] manifest = Files.readAllBytes(journal.resolve("manifest.json"));
            byte[] afterPyproject = Files.readAllBytes(journal.resolve("pyproject.toml"));
            byte[] afterLock = Files.readAllBytes(journal.resolve("uv.lock"));
            assertThat(afterPyproject).isNotEqualTo(beforePyproject);
            assertThat(afterLock).isNotEqualTo(beforeLock);
            assertThat(Files.readAllBytes(root.resolve("pyproject.toml"))).isEqualTo(afterPyproject);
            assertThat(Files.readAllBytes(root.resolve("uv.lock"))).isEqualTo(beforeLock);
            assertThat(JSON.readTree(manifest).path("requestSha256").asText()).isEqualTo(operation.requestSha256());
            assertThat(operation.requestSha256()).isEqualTo(PythonDependencyService.requestDigest(
                PROJECT, "ADD", "pytest", "9.0.2", "test", 7));
            assertThat(operation.state()).isEqualTo("PENDING");
            assertThat(agent.bridge.receipt(PROJECT, operation.id())).isEmpty();
            assertThat(store.findProject(PROJECT).workspaceRevision()).isEqualTo(7);
            assertThat(tasks.findForOwner(OWNER, PROJECT, taskId).orElseThrow().changedPaths()).isEmpty();
            assertThat(tasks.hasPendingReceipts(taskId)).isTrue();
            assertThat(tasks.hasLiveToolClaims(taskId)).isFalse();
            System.out.println("PARTIAL operation=" + operation.id() + " request=" + operation.requestSha256()
                + " pyprojectAfter=" + hash(afterPyproject) + " lockStillBefore=" + hash(beforeLock));

            // New backend and agent objects, same durable rows and original journal. The real
            // transaction skips the already-applied pyproject and renames only the old lock.
            AtomicInteger resumedRenames = new AtomicInteger();
            agent.reconstruct(n -> resumedRenames.incrementAndGet());
            agent.loseNextCommitReply = true;
            var restarted = new AgentTaskStore(jdbc, new DataSourceTransactionManager(jdbc.getDataSource()), Clock.systemUTC());
            var recoveryTools = tools(restarted, store, runtime, gate, agent.bridge);
            restarted.beginClose(taskId, "AI_CLOSED");
            assertThat(recoveryTools.finishForClose(taskId)).isFalse();
            assertThat(resumedRenames).hasValue(1);
            assertThat(agent.bridge.receipt(PROJECT, operation.id())).isPresent();
            assertThat(hash(Files.readAllBytes(root.resolve(".manao/receipts/" + operation.id() + ".json"))))
                .isEqualTo(operation.receiptSha256());
            assertThat(Files.readAllBytes(root.resolve("pyproject.toml"))).isEqualTo(afterPyproject);
            assertThat(Files.readAllBytes(root.resolve("uv.lock"))).isEqualTo(afterLock);
            assertThat(store.findOperation(PROJECT, operation.id()).orElseThrow().state()).isEqualTo("PENDING");
            assertThat(store.findProject(PROJECT).workspaceRevision()).isEqualTo(7);
            assertThat(restarted.currentForOwner(OWNER, PROJECT)).isPresent();
            assertThat(restarted.hasPendingReceipts(taskId)).isTrue();
            assertThat(recoveryTools.getCall(taskId, request.toolCallId())).isEmpty();

            // Lose the reply AFTER real receipt publication, then reconstruct both sides again.
            // The third commit is receipt replay: not a new resolve or a second file application.
            AtomicInteger replayRenames = new AtomicInteger();
            agent.reconstruct(n -> replayRenames.incrementAndGet());
            var finalTasks = new AgentTaskStore(jdbc, new DataSourceTransactionManager(jdbc.getDataSource()), Clock.systemUTC());
            var finalTools = tools(finalTasks, store, runtime, gate, agent.bridge);
            assertThat(finalTools.finishForClose(taskId)).isTrue();
            assertThat(replayRenames).hasValue(0);
            assertThat(agent.prepares).hasValue(1);
            assertThat(agent.resolutions).hasValue(1);
            assertThat(agent.commits).hasValue(3);
            assertThat(agent.committedOperationIds).containsExactly(operation.id(), operation.id(), operation.id());
            assertThat(agent.committedRequestDigests).containsExactly(operation.requestSha256(), operation.requestSha256(), operation.requestSha256());
            assertThat(Files.readAllBytes(journal.resolve("manifest.json"))).isEqualTo(manifest);
            assertThat(store.findOperation(PROJECT, operation.id()).orElseThrow().requestSha256()).isEqualTo(operation.requestSha256());
            assertThat(store.findProject(PROJECT).workspaceRevision()).isEqualTo(8);
            var result = finalTools.getCall(taskId, request.toolCallId()).orElseThrow();
            assertThat(result.workspaceRevision()).isEqualTo("8");
            assertThat(result.data().path("kind").asText()).isEqualTo("python_dependencies");
            assertThat(result.data().path("operationId").asText()).isEqualTo(operation.id());
            assertThat(result.data().path("action").asText()).isEqualTo("add");
            assertThat(result.data().path("packageName").asText()).isEqualTo("pytest");
            assertThat(result.data().path("group").asText()).isEqualTo("test");
            assertThat(result.data().path("state").asText()).isEqualTo("COMMITTED");
            assertThat(result.data().path("changedPaths")).isEqualTo(JSON.valueToTree(PATHS));
            var task = finalTasks.findForOwner(OWNER, PROJECT, taskId).orElseThrow();
            assertThat(task.workspaceRevision()).isEqualTo("8");
            assertThat(task.changedPaths()).containsExactlyElementsOf(PATHS);
            assertThat(store.pendingOperations(PROJECT)).isEmpty();
            assertThat(finalTasks.hasPendingReceipts(taskId)).isFalse();
            assertThat(finalTasks.hasLiveToolClaims(taskId)).isFalse();

            agent.verifyLockedInstall();
            assertThat(Files.readAllBytes(root.resolve("pyproject.toml"))).isEqualTo(afterPyproject);
            assertThat(Files.readAllBytes(root.resolve("uv.lock"))).isEqualTo(afterLock);
            new AgentTaskSettlementService(finalTasks, gate, mock(PiWorkerClient.class), finalTools)
                .settleCloseIntent(taskId, "AI_CLOSED", "closed after real journal recovery");
            assertThat(finalTasks.settlementView(taskId).state()).isEqualTo("FAILED");
            assertThat(finalTasks.currentForOwner(OWNER, PROJECT)).isEmpty();
            assertThat(finalTools.getCall(taskId, request.toolCallId()).orElseThrow()).isEqualTo(result);
            assertThat(store.findProject(PROJECT).workspaceRevision()).isEqualTo(8);
            assertThat(store.pendingOperations(PROJECT)).isEmpty();
            assertThat(store.hasActiveRun(PROJECT)).isFalse();
            assertThat(agent.prepares).hasValue(1);
            assertThat(agent.commits).hasValue(3);
            System.out.println("SETTLED revision=8 prepares=1 uvResolutions=1 commits=3 renames=1+1+0 pending=0 claims=0");
        }
    }

    private static AgentProjectTools tools(AgentTaskStore tasks, WorkspaceJdbcStore store,
            JdbcProjectRuntimeStore runtime, ProjectLifecycleGate gate, WorkspaceAgent agent) {
        var operations = new WorkspaceOperationService(store, agent, gate);
        var dependencies = new PythonDependencyService(store, operations, agent, gate, runtime, tasks);
        return new AgentProjectTools(tasks, store, new WorkspaceService(store, operations, agent, gate, tasks),
            operations, gate, mock(DevelopmentBuildExecutor.class), null, null, new AgentPythonDependencyTools(tasks, dependencies));
    }

    private static String hash(byte[] bytes) throws Exception {
        return java.util.HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
    }

    /** Transport bridge only: every prepare, commit and receipt invokes real agent classes. */
    private static final class RealAgent implements AutoCloseable {
        final Path root;
        final URLClassLoader loader;
        final AtomicInteger prepares = new AtomicInteger();
        final AtomicInteger resolutions = new AtomicInteger();
        final AtomicInteger commits = new AtomicInteger();
        final List<String> committedOperationIds = new ArrayList<>();
        final List<String> committedRequestDigests = new ArrayList<>();
        final WorkspaceAgent bridge;
        Object editor;
        Object transaction;
        Object files;
        boolean loseNextCommitReply;

        RealAgent(Path root) throws Exception {
            this.root = root;
            Path classes = Path.of("../workspace-agent/target/classes").toAbsolutePath().normalize();
            assertThat(classes.resolve("com/manao/poc4/workspaceagent/PythonDependencyTransaction.class")).exists();
            loader = new URLClassLoader(new java.net.URL[]{classes.toUri().toURL()}, getClass().getClassLoader());
            bridge = (WorkspaceAgent) Proxy.newProxyInstance(getClass().getClassLoader(), new Class<?>[]{WorkspaceAgent.class},
                (proxy, method, args) -> {
                    if (args == null || !PROJECT.equals(args[0])) throw new AssertionError("unexpected project/bridge method");
                    return switch (method.getName()) {
                        case "prepare" -> {
                            prepares.incrementAndGet();
                            Object change = JSON.readValue(JSON.writeValueAsBytes(args[3]), type("PythonDependencyEditor$DependencyChange"));
                            yield JSON.convertValue(invoke(editor, "prepare", new Class<?>[]{String.class, String.class, change.getClass()},
                                args[1], args[2], change), WorkspaceAgent.PreparedPythonDependencies.class);
                        }
                        case "commit" -> {
                            commits.incrementAndGet();
                            var original = (WorkspaceAgent.PythonDependencyCommit) args[1];
                            committedOperationIds.add(original.prepared().operationId());
                            committedRequestDigests.add(original.prepared().requestSha256());
                            Object command = JSON.readValue(JSON.writeValueAsBytes(args[1]), type("PythonDependencyTransaction$PythonDependencyCommit"));
                            Object result = invoke(transaction, "commit", new Class<?>[]{command.getClass()}, command);
                            if (loseNextCommitReply) {
                                loseNextCommitReply = false;
                                throw new WorkspaceAgentException(503, "IO_ERROR", "test-only lost reply after durable commit");
                            }
                            yield JSON.convertValue(result, WorkspaceAgent.PreparedPythonDependencies.class);
                        }
                        case "receipt" -> ((Optional<?>) invoke(files, "receipt", new Class<?>[]{String.class}, args[1]))
                            .map(receipt -> JSON.convertValue(receipt, WorkspaceAgent.FetchedReceipt.class));
                        default -> throw new AssertionError("unexpected bridge method: " + method.getName());
                    };
                });
        }

        Class<?> type(String name) throws Exception { return loader.loadClass("com.manao.poc4.workspaceagent." + name); }

        void reconstruct(IntConsumer afterRename) throws Exception {
            Constructor<?> constructor = type("PythonDependencyTransaction").getDeclaredConstructor(Path.class, IntConsumer.class);
            constructor.setAccessible(true);
            transaction = constructor.newInstance(root, afterRename);
            files = type("WorkspaceFileService").getConstructor(Path.class).newInstance(root);
            Class<?> resolverType = type("PythonDependencyEditor$Resolver");
            Object resolver = Proxy.newProxyInstance(loader, new Class<?>[]{resolverType}, (proxy, method, args) -> {
                if (!method.getName().equals("resolve")) throw new AssertionError("single-change fixture only");
                resolutions.incrementAndGet();
                var change = JSON.valueToTree(args[1]);
                docker((Path) args[0], false, List.of("--entrypoint", "/usr/local/bin/python3"),
                    List.of("-I", "/opt/manao-python/dependency_helper.py", "/scratch", change.path("action").asText(),
                        change.path("packageName").asText(), change.path("version").asText(""), "120", change.path("group").asText()));
                return null;
            });
            Constructor<?> editorConstructor = type("PythonDependencyEditor").getDeclaredConstructor(Path.class, transaction.getClass(), resolverType);
            editorConstructor.setAccessible(true);
            editor = editorConstructor.newInstance(root, transaction, resolver);
        }

        void verifyLockedInstall() throws Exception {
            docker(root, true, List.of("--entrypoint", "sh"), List.of("-c",
                "uv --version && python3 --version && UV_PROJECT_ENVIRONMENT=/tmp/verified-venv UV_CACHE_DIR=/tmp/uv-cache "
                + "uv sync --project /scratch --locked --no-dev --group test --no-build --no-config --no-python-downloads "
                + "--python /usr/local/bin/python3 && /tmp/verified-venv/bin/python -m pytest --version"));
        }

        void docker(Path scratch, boolean readOnly, List<String> options, List<String> arguments) throws Exception {
            String name = "manao-real-dependency-it-" + UUID.randomUUID();
            Path log = Files.createTempFile("manao-real-dependency-it-", ".log");
            var command = new ArrayList<>(List.of("docker", "run", "--rm", "--name", name, "--label", "manao.test=real-dependency-journal",
                "--mount", "type=bind,source=" + scratch.toAbsolutePath() + ",target=/scratch" + (readOnly ? ",readonly" : "")));
            command.addAll(options);
            command.add(IMAGE);
            command.addAll(arguments);
            Process process = null;
            try {
                process = new ProcessBuilder(command).redirectErrorStream(true).redirectOutput(log.toFile()).start();
                if (!process.waitFor(150, TimeUnit.SECONDS)) {
                    new ProcessBuilder("docker", "rm", "-f", name).redirectErrorStream(true).redirectOutput(ProcessBuilder.Redirect.DISCARD)
                        .start().waitFor(20, TimeUnit.SECONDS);
                    process.destroyForcibly();
                    throw new AssertionError("owned Docker helper exceeded 150 seconds");
                }
                String output = Files.readString(log, StandardCharsets.UTF_8);
                assertThat(process.exitValue()).as("Docker helper/locked install: %s", output).isZero();
                System.out.println("DOCKER " + IMAGE + " " + output.strip());
            } finally {
                if (process != null && process.isAlive()) process.destroyForcibly();
                Files.deleteIfExists(log);
            }
        }

        static Object invoke(Object target, String name, Class<?>[] signature, Object... args) throws Exception {
            try { return target.getClass().getMethod(name, signature).invoke(target, args); }
            catch (InvocationTargetException ex) {
                if (ex.getCause() instanceof RuntimeException runtime) throw runtime;
                if (ex.getCause() instanceof Error error) throw error;
                throw ex;
            }
        }

        @Override public void close() throws Exception { loader.close(); }
    }
}
