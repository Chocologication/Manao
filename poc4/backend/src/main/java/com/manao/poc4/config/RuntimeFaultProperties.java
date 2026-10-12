package com.manao.poc4.config;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.ConstructorBinding;

/**
 * Acceptance-only runtime fault injection. The dependency-pending fault (deploy README 11.4,
 * Task 11) arms ONE canary package name: the first-party dependency commit of exactly that
 * package fails closed after prepare and durable registration, provisioning the e2e
 * FAILED-reconciliation case with the production reconciliation scene. The value must stay
 * empty in every normal deployment; arming and disarming are operator actions recorded in the
 * acceptance record.
 */
@ConfigurationProperties(prefix = "manao.runtime", ignoreUnknownFields = false)
public record RuntimeFaultProperties(String dependencyPendingFaultPackage) {
    public RuntimeFaultProperties {
        dependencyPendingFaultPackage = blank(dependencyPendingFaultPackage)
            ? "" : dependencyPendingFaultPackage.trim();
    }

    private static boolean blank(String value) { return value == null || value.isBlank(); }
}
