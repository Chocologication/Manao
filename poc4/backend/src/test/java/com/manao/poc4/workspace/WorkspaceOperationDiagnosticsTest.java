package com.manao.poc4.workspace;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import com.manao.poc4.api.ApiException;
import com.manao.poc4.workspace.WorkspaceControllerTest.FakeStore;
import com.manao.poc4.workspace.WorkspaceControllerTest.StubAgent;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.slf4j.LoggerFactory;

class WorkspaceOperationDiagnosticsTest {
    private static final String PROJECT = "prj-diagnostics";
    private final FakeStore store = new FakeStore();
    private final StubAgent agent = new StubAgent();
    private final WorkspaceOperationService service = new WorkspaceOperationService(store, agent);
    private final Logger logger = (Logger) LoggerFactory.getLogger(WorkspaceOperationService.class);
    private final ListAppender<ILoggingEvent> logs = new ListAppender<>();
    private ch.qos.logback.classic.Level previousLevel;

    @BeforeEach
    void captureLogs() {
        previousLevel = logger.getLevel();
        logger.setLevel(ch.qos.logback.classic.Level.WARN);
        logs.start();
        logger.addAppender(logs);
    }

    @AfterEach
    void detachLogs() {
        logger.detachAppender(logs);
        logs.stop();
        logger.setLevel(previousLevel);
    }

    @Test
    void logsAgentHttpFailureWithoutExposingItsMessageOrDiscardingPendingEvidence() {
        agent.mutator = command -> { throw new WorkspaceAgentException(415, "IO_ERROR",
            "TOP_SECRET token=secret /workspace/internal"); };
        assertFailsClosed();
        assertSafeDiagnostic("phase=MUTATE", "httpStatus=415", "agentCode=IO_ERROR");
    }

    @Test
    void unrecognizedAgentCodesAreNotCopiedIntoDiagnostics() {
        agent.mutator = command -> { throw new WorkspaceAgentException(503,
            "TOP_SECRET\nforged-log", "token=secret"); };
        assertFailsClosed();
        assertSafeDiagnostic("phase=MUTATE", "httpStatus=503", "agentCode=UNKNOWN");
    }

    @Test
    void runtimeFailuresRetainTheStageButNotTheUntrustedExceptionText() {
        agent.mutator = command -> { throw new IllegalStateException("TOP_SECRET token=secret"); };
        assertFailsClosed();
        assertSafeDiagnostic("phase=MUTATE", "httpStatus=none", "agentCode=none");
    }

    @Test
    void receiptMismatchIsDistinguishableFromHttpTransportFailure() {
        agent.mutator = command -> new WorkspaceAgent.MutationResult(command.operationId(), command.path(),
            command.expectedBeforeSha256(), command.expectedAfterSha256(),
            ".manao/receipts/" + command.operationId() + ".json", "mismatched-digest");
        assertFailsClosed();
        assertSafeDiagnostic("phase=VERIFY_RESULT", "httpStatus=none", "agentCode=none");
    }

    @Test
    void logsTransportFailureClassificationWithoutExceptionDetails() {
        agent.mutator = command -> { throw new WorkspaceAgentException(503, "IO_ERROR",
            "TOP_SECRET token=secret", WorkspaceAgentException.TransportFailure.RESET); };
        assertFailsClosed();
        assertSafeDiagnostic("transportFailure=RESET");
    }

    private void assertFailsClosed() {
        assertThatThrownBy(() -> service.apply(PROJECT, "CREATE", "src", null, "directory", new byte[0], 0))
            .isInstanceOfSatisfying(ApiException.class, ex -> {
                assertThat(ex.code()).isEqualTo("PROJECT_LOCKED");
                assertThat(ex.status()).isEqualTo(409);
                assertThat(ex.getMessage()).isEqualTo("Project is locked");
            });
        assertThat(store.failures).containsEntry(PROJECT, "WORKSPACE_RECONCILIATION_REQUIRED");
        assertThat(store.pendingOperations(PROJECT)).hasSize(1);
        assertThat(store.committed).isEmpty();
        assertThat(store.deletedOperations).isEmpty();
    }

    private void assertSafeDiagnostic(String... fields) {
        assertThat(logs.list).hasSize(1);
        ILoggingEvent event = logs.list.get(0);
        assertThat(event.getFormattedMessage()).contains(fields).contains("projectId=" + PROJECT,
            "operationId=" + store.pendingOperations(PROJECT).get(0).id())
            .doesNotContain("TOP_SECRET", "token=", "/workspace", "forged-log");
        assertThat(event.getThrowableProxy()).isNull();
    }
}
