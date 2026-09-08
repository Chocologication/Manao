package com.manao.poc4.workspace;

/** Error raised by the workspace-agent transport; code values come from the agent's error body. */
public final class WorkspaceAgentException extends RuntimeException {
    public enum TransportFailure {
        CONNECT,
        CONNECT_TIMEOUT,
        TIMEOUT,
        RESET,
        INTERRUPTED,
        OTHER
    }

    private final int status;
    private final String code;
    private final TransportFailure transportFailure;

    public WorkspaceAgentException(int status, String code, String message) {
        this(status, code, message, null);
    }

    public WorkspaceAgentException(int status, String code, String message, TransportFailure transportFailure) {
        super(message);
        this.status = status;
        this.code = code;
        this.transportFailure = transportFailure;
    }

    public int status() { return status; }
    public String code() { return code; }
    public TransportFailure transportFailure() { return transportFailure; }
}
