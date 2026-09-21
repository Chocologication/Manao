package com.manao.poc4.kubernetes;

import static org.assertj.core.api.Assertions.assertThat;

import com.manao.poc4.persistence.RunState;
import com.manao.poc4.run.RunRecord;
import io.fabric8.kubernetes.api.model.batch.v1.Job;
import io.fabric8.kubernetes.api.model.batch.v1.JobBuilder;
import io.fabric8.kubernetes.api.model.Pod;
import io.fabric8.kubernetes.api.model.PodBuilder;
import java.time.Instant;
import java.util.Map;
import org.junit.jupiter.api.Test;

class ResourceIdentityVerifierTest {
    private static final String RUN = "run-1";
    private static final String PROJECT = "prj-1";
    private static final String JOB_UID = "job-uid-1";

    private final ResourceIdentityVerifier verifier = new ResourceIdentityVerifier();

    private RunRecord run() {
        return new RunRecord(RUN, PROJECT, 0, RunState.RUNNING, "{}", "manao-run-" + RUN,
            null, null, null, null, null, 0L, Instant.parse("2026-08-29T11:00:00Z"), 0L);
    }

    private Job job() {
        return new JobBuilder()
            .withNewMetadata().withName("manao-run-" + RUN).withUid(JOB_UID)
            .withLabels(Map.of("manao.poc4/run-id", RUN, "manao.poc4/project-id", PROJECT))
            .endMetadata()
            .withNewSpec().endSpec()
            .build();
    }

    private Pod pod(boolean running, String containerName) {
        return pod(running, containerName, JOB_UID);
    }

    private Pod pod(boolean running, String containerName, String ownerUid) {
        PodBuilder builder = new PodBuilder()
            .withNewMetadata().withName("manao-run-" + RUN + "-pod")
            .withOwnerReferences(new io.fabric8.kubernetes.api.model.OwnerReferenceBuilder()
                .withApiVersion("batch/v1").withKind("Job").withName("manao-run-" + RUN)
                .withUid(ownerUid).withController(true).build())
            .endMetadata()
            .withNewSpec().withContainers(new io.fabric8.kubernetes.api.model.ContainerBuilder()
                .withName(containerName).build()).endSpec()
            .withNewStatus().withPhase(running ? "Running" : "Pending").endStatus();
        if (running) {
            builder.editOrNewStatus().addNewContainerStatus().withName(containerName)
                .withNewState().withNewRunning().endRunning().endState().endContainerStatus().endStatus();
        }
        return builder.build();
    }

    @Test
    void acceptsMatchingJobAndRunningApplicationContainer() {
        assertThat(verifier.verify(run(), job(), pod(true, "maven"))).isTrue();
    }

    @Test
    void ownershipCheckRequiresTheJobUidInEveryOwnerReference() {
        assertThat(verifier.verifyOwnership(run(), job(), pod(true, "maven"))).isTrue();
        // Same name, different UID: a look-alike Job is refused before any fact is read.
        assertThat(verifier.verifyOwnership(run(), job(), pod(true, "maven", "different-job-uid"))).isFalse();
        assertThat(verifier.verify(run(), job(), pod(true, "maven", "different-job-uid"))).isFalse();
        // A Job without a UID can never own a verified Pod.
        Job uidLess = job();
        uidLess.getMetadata().setUid(null);
        assertThat(verifier.verifyOwnership(run(), uidLess, pod(true, "maven"))).isFalse();
    }

    @Test
    void rejectsLabelOwnerReferenceContainerOrStateMismatches() {
        assertThat(verifier.verify(run(), job(), pod(false, "maven"))).isFalse();
        assertThat(verifier.verify(run(), job(), pod(true, "sidecar"))).isFalse();
        assertThat(verifier.verify(run(), job(), pod(true, "maven"))).isTrue();

        Job wrongRunLabel = job();
        wrongRunLabel.getMetadata().getLabels().put("manao.poc4/run-id", "other-run");
        assertThat(verifier.verify(run(), wrongRunLabel, pod(true, "maven"))).isFalse();

        Pod orphanPod = pod(true, "maven");
        orphanPod.getMetadata().setOwnerReferences(java.util.List.of());
        assertThat(verifier.verify(run(), job(), orphanPod)).isFalse();
    }
}
