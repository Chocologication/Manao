package com.manao.poc4.project;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfSystemProperty;

/**
 * Read-only real leftover verification. Ordinary builds skip this class; it runs only when
 * {@code -Dmanao.stage6.cleanup.verify=true} and the private STAGE6_VERIFY_* / kubeconfig inputs
 * are provided. It must never start Spring, migrate, or issue SQL/Kubernetes mutations.
 */
@EnabledIfSystemProperty(named = "manao.stage6.cleanup.verify", matches = "true")
class ProjectCleanupEvidenceTest {
    @Test
    void registeredProjectsHaveNoOwnerScopedResidue() {
        throw new UnsupportedOperationException(
            "real leftover verification is gated and waits for explicit Stage C authorization");
    }
}
