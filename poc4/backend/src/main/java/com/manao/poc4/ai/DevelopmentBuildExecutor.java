package com.manao.poc4.ai;

/**
 * The development build seam between the project tools and the cluster (stage one, design
 * section 5). Stage one defines only this interface so the tools and their tests can be written
 * against it; the real Fabric8 executor arrives with the isolated Maven build and runs a
 * read-only source copy in a scratch workspace. Implementations must never report success
 * without a confirmed exit result and a proven cleanup, and they never advance the workspace
 * revision — builds read the saved sources and write only their own scratch space.
 *
 * <p>The three entry points separate the one-shot execution from everything a replayed or
 * abandoned call may ever do: {@link #build} is reserved for a call whose execution has never
 * started, {@link #observe} recovers a build that is already recorded under a durable identity
 * (creating nothing, never re-executing it), and {@link #close} finishes such a build through
 * the shared cleanup path.</p>
 */
public interface DevelopmentBuildExecutor {

    /**
     * Runs one build goal against the task's saved source revision; the sources stay untouched.
     * Only a call that is provably fresh (no recorded build identity) may take this path.
     */
    AgentContracts.BuildResult build(AgentContracts.BuildRequest request);

    /**
     * Recovers one build already recorded under the given durable identity: nothing is created
     * and nothing is re-executed — the recorded Job/Pod identity is only observed to its
     * termination. Evidence that has vanished stays an unsettled, unconfirmed result; a
     * recovery never rebuilds a build whose outcome is unknown.
     */
    AgentContracts.BuildResult observe(AgentContracts.BuildRequest request,
                                       AgentContracts.BuildIdentity identity);

    /**
     * Closes one build recorded under the given identity through the shared finish path: the
     * still-observable log is collected, the Job and its Pods are deleted by the original
     * identity, and the close is confirmed only once everything is 404. No exit code is ever
     * invented for a closed build.
     */
    AgentContracts.BuildResult close(AgentContracts.BuildRequest request,
                                     AgentContracts.BuildIdentity identity);

    /** One scheduler step; implementations with wait loops must override with a single observation. */
    default AgentContracts.BuildResult closeStep(AgentContracts.BuildRequest request,AgentContracts.BuildIdentity identity) {
        return close(request,identity);
    }

    /**
     * Answers whether a build side effect may exist under this call's stable commandId at
     * all. False ONLY after a successful cluster query that proves no Job was ever created
     * under the deterministic name (and no stray pod remains); true when a Job exists or
     * the answer is unclear, so an uncertain answer never releases a project.
     */
    boolean hasRecordedSideEffect(AgentContracts.BuildRequest request);
}
