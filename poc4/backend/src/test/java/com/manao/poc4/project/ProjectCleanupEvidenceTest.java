package com.manao.poc4.project;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.manao.poc4.kubernetes.WorkspaceResourceFactory;
import io.fabric8.kubernetes.client.KubernetesClient;
import io.fabric8.kubernetes.client.KubernetesClientBuilder;
import io.fabric8.kubernetes.client.KubernetesClientException;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfSystemProperty;

/**
 * Read-only leftover verification for one cleanup invocation. Ordinary builds skip this class.
 * It never starts Spring, migrates, or issues SQL/Kubernetes mutations.
 */
@EnabledIfSystemProperty(named = "manao.stage6.cleanup.verify", matches = "true")
class ProjectCleanupEvidenceTest {
    private static final String PROTECTED = "083b8efd-9f57-4cb4-aa6f-646b37bd6d57";
    private static final ObjectMapper JSON = new ObjectMapper();

    @Test
    void registeredProjectsHaveNoOwnerScopedResidue() throws Exception {
        String invocationId = requiredEnv("STAGE6_INVOCATION_ID");
        Path root = Path.of(requiredEnv("STAGE6_CLEANUP_LEDGER_DIR")).toAbsolutePath().normalize();
        assertThat(Files.isDirectory(root)).as("STAGE6_CLEANUP_LEDGER_DIR must be a directory").isTrue();
        String dbUrl = requiredEnv("STAGE6_VERIFY_DB_URL");
        assertThat(dbUrl).startsWith("jdbc:mysql:");
        String dbUser = requiredEnv("STAGE6_VERIFY_DB_USERNAME");
        String dbPassword = requiredEnv("STAGE6_VERIFY_DB_PASSWORD");
        String kubeconfigPath = requiredEnv("KUBECONFIG");
        assertThat(Files.isReadable(Path.of(kubeconfigPath))).as("KUBECONFIG must be readable").isTrue();
        String namespace = requiredEnv("MANAO_K8S_NAMESPACE");

        List<ProjectCleanupEvidenceParser.LedgerEntry> entries = loadEntries(root, invocationId);
        assertThat(entries).as("ledger must contain registered projects").isNotEmpty();

        io.fabric8.kubernetes.client.Config config = io.fabric8.kubernetes.client.Config.fromKubeconfig(
            null, Files.readString(Path.of(kubeconfigPath)), null);
        try (KubernetesClient client = new KubernetesClientBuilder().withConfig(config).build();
             Connection connection = DriverManager.getConnection(dbUrl, dbUser, dbPassword)) {
            connection.setReadOnly(true);
            List<String> failures = new ArrayList<>();
            for (ProjectCleanupEvidenceParser.LedgerEntry entry : entries) {
                if (PROTECTED.equals(entry.projectId())) {
                    failures.add(entry.projectId() + ": PROTECTED_DIAGNOSTIC");
                    continue;
                }
                ProjectCleanupEvidenceParser.DbCounts db = countDatabase(connection, entry);
                ProjectCleanupEvidenceParser.ClusterCounts cluster = countCluster(client, namespace, entry.projectId());
                boolean runSnapshotPresent = entry.runIds() != null;
                ProjectCleanupEvidenceParser.Verdict verdict = ProjectCleanupEvidenceParser.verdict(
                    invocationId, root, entry, db, cluster, runSnapshotPresent);
                if (!verdict.verified()) {
                    failures.add(entry.projectId() + ": " + verdict.reasons());
                } else {
                    stampVerified(entry.ledgerPath());
                }
            }
            assertThat(failures).as("registered cleanup entries must be independently verified").isEmpty();
        }
    }

    private static List<ProjectCleanupEvidenceParser.LedgerEntry> loadEntries(Path root, String invocationId)
        throws Exception {
        List<ProjectCleanupEvidenceParser.LedgerEntry> entries = new ArrayList<>();
        try (DirectoryStream<Path> stream = Files.newDirectoryStream(root, "*.json")) {
            for (Path file : stream) {
                String name = file.getFileName().toString();
                if ("manifest.json".equals(name) || "hold.json".equals(name) || "teardown-report.json".equals(name)) {
                    continue;
                }
                JsonNode node = JSON.readTree(Files.readString(file));
                if (!node.has("entryId") || !node.has("invocationId")) {
                    continue;
                }
                if (!invocationId.equals(text(node, "invocationId"))) {
                    continue;
                }
                List<String> runIds = new ArrayList<>();
                boolean hasRunIds = node.has("runIds");
                if (hasRunIds && node.get("runIds").isArray()) {
                    node.get("runIds").forEach(item -> runIds.add(item.asText()));
                }
                entries.add(new ProjectCleanupEvidenceParser.LedgerEntry(
                    text(node, "invocationId"),
                    text(node, "ownerId"),
                    node.has("projectId") && !node.get("projectId").isNull() ? node.get("projectId").asText() : null,
                    text(node, "state"),
                    hasRunIds ? runIds : null,
                    file.toAbsolutePath().normalize()));
            }
        }
        return entries;
    }

    private static ProjectCleanupEvidenceParser.DbCounts countDatabase(Connection connection,
                                                                        ProjectCleanupEvidenceParser.LedgerEntry entry)
        throws Exception {
        String projectId = entry.projectId();
        String ownerId = entry.ownerId();
        long projects = count(connection, "SELECT COUNT(*) FROM project WHERE id=? AND owner_id=?", projectId, ownerId);
        long operations = count(connection, "SELECT COUNT(*) FROM workspace_operation WHERE project_id=?", projectId);
        long runs = count(connection, "SELECT COUNT(*) FROM run WHERE project_id=?", projectId);
        long tickets = count(connection, "SELECT COUNT(*) FROM log_ticket WHERE project_id=?", projectId);
        long sessions = count(connection, "SELECT COUNT(*) FROM terminal_session WHERE project_id=?", projectId);
        long audits = count(connection, "SELECT COUNT(*) FROM terminal_audit WHERE project_id=?", projectId);
        long chunks = 0;
        if (entry.runIds() != null) {
            for (String runId : entry.runIds()) {
                chunks += count(connection, "SELECT COUNT(*) FROM run_log_chunk WHERE run_id=?", runId);
            }
        }
        return new ProjectCleanupEvidenceParser.DbCounts(projects, operations, runs, tickets, sessions, audits, chunks);
    }

    private static ProjectCleanupEvidenceParser.ClusterCounts countCluster(KubernetesClient client, String namespace,
                                                                            String projectId) {
        if (projectId == null || projectId.isBlank()) {
            return new ProjectCleanupEvidenceParser.ClusterCounts(0, 0, 0, 0, false);
        }
        Map<String, String> labels = WorkspaceResourceFactory.projectResourceLabels(projectId);
        try {
            int jobs = client.batch().v1().jobs().inNamespace(namespace).withLabels(labels).list().getItems().size();
            int pods = client.pods().inNamespace(namespace).withLabels(labels).list().getItems().size();
            int services = client.services().inNamespace(namespace).withLabels(labels).list().getItems().size();
            int pvcs = client.persistentVolumeClaims().inNamespace(namespace).withLabels(labels).list().getItems().size();
            return new ProjectCleanupEvidenceParser.ClusterCounts(jobs, pods, services, pvcs, false);
        } catch (KubernetesClientException ex) {
            if (ex.getCode() == 403) {
                return new ProjectCleanupEvidenceParser.ClusterCounts(0, 0, 0, 0, true);
            }
            throw ex;
        }
    }

    private static long count(Connection connection, String sql, String... parameters) throws Exception {
        try (PreparedStatement statement = connection.prepareStatement(sql)) {
            for (int index = 0; index < parameters.length; index++) {
                statement.setString(index + 1, parameters[index]);
            }
            try (ResultSet rows = statement.executeQuery()) {
                assertThat(rows.next()).isTrue();
                return rows.getLong(1);
            }
        }
    }

    private static void stampVerified(Path ledgerPath) throws Exception {
        JsonNode node = JSON.readTree(Files.readString(ledgerPath));
        if (node instanceof ObjectNode objectNode && "API_CLEANED".equals(objectNode.path("state").asText())) {
            objectNode.put("state", "VERIFIED");
            Files.writeString(ledgerPath, JSON.writeValueAsString(objectNode));
        }
    }

    private static String requiredEnv(String name) {
        String value = System.getenv(name);
        if (value == null || value.isBlank()) {
            throw new AssertionError(name + " is required for leftover verification");
        }
        return value;
    }

    private static String text(JsonNode node, String field) {
        return node.has(field) && !node.get(field).isNull() ? node.get(field).asText() : "";
    }
}
