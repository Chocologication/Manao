package com.manao.poc4.ai;

/**
 * The development build seam between the project tools and the cluster (stage one, design
 * section 5). Stage one defines only this interface so the tools and their tests can be written
 * against it; the real Fabric8 executor arrives with the isolated Maven build and runs a
 * read-only source copy in a scratch workspace. Implementations must never report success
 * without a confirmed exit result and a proven cleanup, and they never advance the workspace
 * revision — builds read the saved sources and write only their own scratch space.
 */
public interface DevelopmentBuildExecutor {

    /** Runs one build goal against the task's saved source revision; the sources stay untouched. */
    AgentContracts.BuildResult build(AgentContracts.BuildRequest request);
}
