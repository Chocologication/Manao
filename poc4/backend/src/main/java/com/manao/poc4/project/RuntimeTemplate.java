package com.manao.poc4.project;

import com.manao.poc4.api.ApiException;

/**
 * The fixed runtime templates. Ids are the only external strings; HTTP requests never carry an
 * enum name. Every template owns its language, execution shape, display command and default
 * primary port, so no call site needs its own per-language switch and no provider registry is
 * introduced.
 */
public enum RuntimeTemplate {
    JAVA_CONSOLE("java-console", "java", false, 8080, "mvn -q -DskipTests compile exec:java"),
    JAVA_SPRING_BOOT_WEB("java-spring-boot-web", "java", true, 8080, "mvn -q -DskipTests spring-boot:run"),
    PYTHON_CONSOLE("python-console", "python", false, 8000, "python -u main.py"),
    PYTHON_FASTAPI_WEB("python-fastapi-web", "python", true, 8000, "python -u -m uvicorn app.main:app"),
    NODE_JAVASCRIPT_CONSOLE("node-javascript-console", "javascript", false, 3000, "pnpm start"),
    NODE_JAVASCRIPT_WEB("node-javascript-web", "javascript", true, 3000, "pnpm start"),
    NODE_TYPESCRIPT_CONSOLE("node-typescript-console", "typescript", false, 3000, "pnpm start"),
    NODE_TYPESCRIPT_WEB("node-typescript-web", "typescript", true, 3000, "pnpm start");

    private final String id;
    private final String language;
    private final boolean service;
    private final int defaultPort;
    private final String displayCommand;

    RuntimeTemplate(String id, String language, boolean service, int defaultPort, String displayCommand) {
        this.id = id;
        this.language = language;
        this.service = service;
        this.defaultPort = defaultPort;
        this.displayCommand = displayCommand;
    }

    /** Resolves an external template id; unknown ids are a request validation error. */
    public static RuntimeTemplate fromId(String id) {
        for (RuntimeTemplate template : values()) {
            if (template.id.equals(id)) {
                return template;
            }
        }
        throw new ApiException("VALIDATION_ERROR", 422, "Request validation failed");
    }

    public String id() { return id; }

    /** java | python | javascript | typescript; matches the snapshot discriminator. */
    public String language() { return language; }

    public boolean isNode() { return "javascript".equals(language) || "typescript".equals(language); }

    /** Web-style templates run as long-lived services; console templates stay bounded tasks. */
    public boolean isService() { return service; }

    /** Primary port without a public mapping: Java 8080, Python 8000, Node.js 3000. */
    public int defaultPort() { return defaultPort; }

    /** Server-derived display command; the Job never interprets database text as a shell line. */
    public String displayCommand() { return displayCommand; }
}
