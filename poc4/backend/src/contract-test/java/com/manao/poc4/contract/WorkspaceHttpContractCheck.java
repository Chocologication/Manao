package com.manao.poc4.contract;

import com.manao.poc4.kubernetes.FakeKubernetesGateway;
import com.manao.poc4.kubernetes.WorkspaceApiClient;
import com.manao.poc4.kubernetes.WorkspaceResourceFactory;
import com.manao.poc4.project.ProjectProvisioningService;
import com.manao.poc4.workspace.WorkspaceCapabilitySigner;
import com.manao.poc4.workspace.WorkspaceControllerTest.FakeStore;
import com.manao.poc4.workspace.WorkspaceOperationService;
import com.manao.poc4.workspace.WorkspaceService;
import com.manao.poc4.workspace.WorkspaceStore;
import com.manao.poc4.workspace.WorkspaceTemplate;
import com.manao.poc4.workspaceagent.WorkspaceAgentApplication;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyPairGenerator;
import java.security.interfaces.EdECPrivateKey;
import java.time.Clock;
import java.time.Instant;
import java.util.Arrays;
import java.util.Base64;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.web.servlet.context.ServletWebServerApplicationContext;

/** Real HTTP/filter/controller/filesystem check; only MySQL and Kubernetes are replaced by test stores. */
public final class WorkspaceHttpContractCheck {
    private static final String PROJECT = "11111111-1111-4111-8111-111111111111";

    public static void main(String[] args) throws Exception {
        Path root = Files.createDirectories(Path.of(args[0]).toAbsolutePath());
        var keys = KeyPairGenerator.getInstance("Ed25519").generateKeyPair();
        byte[] encoded = keys.getPublic().getEncoded();
        String publicKey = Base64.getEncoder().encodeToString(Arrays.copyOfRange(encoded, encoded.length - 32, encoded.length));
        // The combined test classpath contains backend starters. They are not agent dependencies.
        String exclusions = String.join(",", "org.springframework.boot.autoconfigure.jdbc.DataSourceAutoConfiguration",
            "org.springframework.boot.autoconfigure.flyway.FlywayAutoConfiguration",
            "org.springframework.boot.autoconfigure.security.servlet.SecurityAutoConfiguration",
            "org.springframework.boot.autoconfigure.security.servlet.SecurityFilterAutoConfiguration",
            "org.springframework.boot.autoconfigure.security.servlet.UserDetailsServiceAutoConfiguration",
            "org.springframework.boot.actuate.autoconfigure.security.servlet.ManagementWebSecurityAutoConfiguration");
        try (var context = SpringApplication.run(WorkspaceAgentApplication.class,
            "--server.address=127.0.0.1", "--server.port=0", "--manao.agent.root=" + root,
            "--MANAO_AGENT_PROJECT_ID=" + PROJECT, "--MANAO_AGENT_CAPABILITY_PUBLIC_KEY=" + publicKey,
            "--spring.autoconfigure.exclude=" + exclusions)) {
            int port = ((ServletWebServerApplicationContext) context).getWebServer().getPort();
            URI endpoint = URI.create("http://127.0.0.1:" + port);
            var client = new WorkspaceApiClient(ignored -> endpoint, new WorkspaceCapabilitySigner(
                ((EdECPrivateKey) keys.getPrivate()).getBytes().orElseThrow(), Clock.systemUTC()));
            var store = new FakeStore();
            store.projects.put(PROJECT, new WorkspaceStore.ProjectRecord(PROJECT, "contract-owner", "contract",
                "CREATING", 0, null, Instant.now()));
            var operations = new WorkspaceOperationService(store, client);
            var workspace = new WorkspaceService(store, operations, client);
            var factory = new WorkspaceResourceFactory("contract-only", "not-used",
                "registry.example/agent@sha256:" + "a".repeat(64),
                "registry.example/init@sha256:" + "b".repeat(64));
            new ProjectProvisioningService(store, new FakeKubernetesGateway(), workspace, factory,
                new WorkspaceTemplate(), publicKey, null, 3, 1).provision(PROJECT);
            check("READY".equals(store.projects.get(PROJECT).state()), "template provisioning did not reach READY");
            check(store.revision.get(PROJECT) == 21L, "template revision did not include file saves");
            for (var entry : new WorkspaceTemplate().files().entrySet()) {
                check(Files.readString(root.resolve(entry.getKey())).equals(entry.getValue()), "template bytes differ");
                check(client.content(PROJECT, entry.getKey()).content().equals(entry.getValue()), "HTTP content differs");
            }
            for (var operation : store.committed) {
                byte[] receipt = Files.readAllBytes(root.resolve(operation.receiptPath()));
                check(WorkspaceCapabilitySigner.sha256Hex(receipt).equals(operation.receiptSha256()), "stored receipt differs");
                check(client.receipt(PROJECT, operation.id()).orElseThrow().receiptSha256().equals(operation.receiptSha256()),
                    "HTTP receipt digest differs from stored bytes");
            }
            System.out.println("PASS template: 11 directories, 5 non-empty files, 21 committed operations and receipts");

            long revision = operations.apply(PROJECT, "SAVE", "README.md", null, null,
                "中文 + & UTF-8\n".getBytes(StandardCharsets.UTF_8), 21);
            revision = operations.apply(PROJECT, "RENAME", "README.md", "README copy.md", null, new byte[0], revision);
            check(Files.readString(root.resolve("README copy.md")).equals("中文 + & UTF-8\n"), "rename lost content");
            check(!Files.exists(root.resolve("README.md")), "rename left source file");
            revision = operations.apply(PROJECT, "DELETE", "README copy.md", null, null, new byte[0], revision);
            check(!Files.exists(root.resolve("README copy.md")), "delete left file");
            check(revision == 24L, "mutation revisions differ");
            System.out.println("PASS signed HTTP: UTF-8 save, rename with destination, delete with encoded query");

            // Model the DB commit being lost after the agent durably wrote the final receipt.
            var last = store.committed.get(store.committed.size() - 1);
            store.pending.put(PROJECT, last);
            store.revision.put(PROJECT, last.expectedRevision());
            check(operations.reconcilePending(PROJECT), "matching persisted receipt did not reconcile");
            check(store.pendingOperations(PROJECT).isEmpty(), "reconciliation left a pending operation");
            check(store.revision.get(PROJECT) == 24L, "reconciliation did not advance revision");
            System.out.println("PASS reconciliation: persisted receipt verified through the real HTTP response");

            var unauthorized = HttpClient.newHttpClient().send(HttpRequest.newBuilder(
                endpoint.resolve("/agent/v1/tree?path=")).GET().build(), HttpResponse.BodyHandlers.ofString());
            check(unauthorized.statusCode() == 401, "unsigned workspace request was accepted");
            System.out.println("PASS capability filter: unsigned access rejected");

            var tampered = new WorkspaceStore.OperationRecord(last.id(), PROJECT, last.expectedRevision(),
                last.beforeSha256(), last.afterSha256(), last.receiptPath(), "f".repeat(64));
            store.pending.put(PROJECT, tampered);
            check(!operations.reconcilePending(PROJECT), "mismatched receipt was accepted");
            check(store.pendingOperations(PROJECT).size() == 1, "mismatched pending evidence was removed");
            check("WORKSPACE_RECONCILIATION_REQUIRED".equals(store.failures.get(PROJECT)), "receipt mismatch did not fail closed");
            System.out.println("PASS fail-closed: mismatched digest retains pending evidence");
        }
    }

    private static void check(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }
}
