package com.manao.poc4.workspace;

/** Error raised by the workspace-agent transport; code values come from the agent's error body. */
public final class WorkspaceAgentException extends RuntimeException {
    private final int status;
    private final String code;

    public WorkspaceAgentException(int status, String code, String message) {
        super(message);
        this.status = status;
        this.code = code;
    }

    public int status() { return status; }
    public String code() { return code; }
}
