package com.manao.poc4.project;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.manao.poc4.api.ApiException;
import java.util.List;
import java.util.Set;
import org.junit.jupiter.api.Test;

class ProjectRuntimeSpecTest {
    private static final Set<Integer> RESERVED = Set.of(30080);

    @Test
    void acceptsInternalPort80ButRejectsReservedPublicPort() {
        var ok = new ProjectRuntimeSpec("java-spring-boot-web", false, false,
            List.of(new ProjectRuntimeSpec.Port("web", 80, 30081)));
        assertThatCode(() -> ok.validate(Set.of(30080))).doesNotThrowAnyException();
        var bad = new ProjectRuntimeSpec("java-spring-boot-web", false, false,
            List.of(new ProjectRuntimeSpec.Port("web", 8080, 30080)));
        assertThatThrownBy(() -> bad.validate(Set.of(30080)))
            .isInstanceOf(ApiException.class)
            .extracting(e -> ((ApiException) e).code()).isEqualTo("PUBLIC_PORT_RESERVED");
    }

    @Test
    void acceptsBoundaryInternalPorts() {
        for (int target : List.of(1, 80, 8080, 18081, 65535)) {
            var spec = new ProjectRuntimeSpec("java-spring-boot-web", false, false,
                List.of(new ProjectRuntimeSpec.Port("web", target, 30000)));
            assertThatCode(() -> spec.validate(RESERVED)).doesNotThrowAnyException();
        }
    }

    @Test
    void acceptsBoundaryPublicPorts() {
        for (int publicPort : List.of(30000, 31000)) {
            var spec = new ProjectRuntimeSpec("java-spring-boot-web", false, false,
                List.of(new ProjectRuntimeSpec.Port("web", 8080, publicPort)));
            assertThatCode(() -> spec.validate(RESERVED)).doesNotThrowAnyException();
        }
    }

    @Test
    void rejectsOutOfRangeTargetPorts() {
        for (int target : List.of(0, 65536)) {
            var spec = new ProjectRuntimeSpec("java-spring-boot-web", false, false,
                List.of(new ProjectRuntimeSpec.Port("web", target, 30081)));
            assertThatThrownBy(() -> spec.validate(RESERVED))
                .isInstanceOf(ApiException.class)
                .extracting(e -> ((ApiException) e).code()).isEqualTo("VALIDATION_ERROR");
        }
    }

    @Test
    void rejectsMissingAndOutOfRangePublicPorts() {
        // A missing publicPort arrives as 0 and must be rejected, never auto-filled.
        for (int publicPort : List.of(0, 29999, 31001)) {
            var spec = new ProjectRuntimeSpec("java-spring-boot-web", false, false,
                List.of(new ProjectRuntimeSpec.Port("web", 8080, publicPort)));
            assertThatThrownBy(() -> spec.validate(RESERVED))
                .isInstanceOf(ApiException.class)
                .extracting(e -> ((ApiException) e).code()).isEqualTo("VALIDATION_ERROR");
        }
    }

    @Test
    void rejectsDuplicatePublicPortsAndNames() {
        var duplicatePublic = new ProjectRuntimeSpec("java-spring-boot-web", false, false, List.of(
            new ProjectRuntimeSpec.Port("web", 8080, 30081),
            new ProjectRuntimeSpec.Port("api2", 9090, 30081)));
        assertThatThrownBy(() -> duplicatePublic.validate(RESERVED))
            .isInstanceOf(ApiException.class)
            .extracting(e -> ((ApiException) e).code()).isEqualTo("VALIDATION_ERROR");
        var duplicateName = new ProjectRuntimeSpec("java-spring-boot-web", false, false, List.of(
            new ProjectRuntimeSpec.Port("web", 8080, 30081),
            new ProjectRuntimeSpec.Port("web", 9090, 30082)));
        assertThatThrownBy(() -> duplicateName.validate(RESERVED))
            .isInstanceOf(ApiException.class)
            .extracting(e -> ((ApiException) e).code()).isEqualTo("VALIDATION_ERROR");
    }

    @Test
    void rejectsInvalidPortNames() {
        for (String name : List.of("", "Web", "web_1", "-web", "web-", "a".repeat(64))) {
            var spec = new ProjectRuntimeSpec("java-spring-boot-web", false, false,
                List.of(new ProjectRuntimeSpec.Port(name, 8080, 30081)));
            assertThatThrownBy(() -> spec.validate(RESERVED))
                .isInstanceOf(ApiException.class)
                .extracting(e -> ((ApiException) e).code()).isEqualTo("VALIDATION_ERROR");
        }
        var longest = new ProjectRuntimeSpec("java-spring-boot-web", false, false,
            List.of(new ProjectRuntimeSpec.Port("a".repeat(63), 8080, 30081)));
        assertThatCode(() -> longest.validate(RESERVED)).doesNotThrowAnyException();
        var dnsLabel = new ProjectRuntimeSpec("java-spring-boot-web", false, false,
            List.of(new ProjectRuntimeSpec.Port("2nd-web", 8080, 30081)));
        assertThatCode(() -> dnsLabel.validate(RESERVED)).doesNotThrowAnyException();
    }

    @Test
    void rejectsMoreThanThreePublicPorts() {
        var three = new ProjectRuntimeSpec("java-spring-boot-web", false, false, List.of(
            new ProjectRuntimeSpec.Port("web", 8080, 30081),
            new ProjectRuntimeSpec.Port("api2", 9090, 30082),
            new ProjectRuntimeSpec.Port("api3", 9091, 30083)));
        assertThatCode(() -> three.validate(RESERVED)).doesNotThrowAnyException();
        var four = new ProjectRuntimeSpec("java-spring-boot-web", false, false, List.of(
            new ProjectRuntimeSpec.Port("web", 8080, 30081),
            new ProjectRuntimeSpec.Port("api2", 9090, 30082),
            new ProjectRuntimeSpec.Port("api3", 9091, 30083),
            new ProjectRuntimeSpec.Port("api4", 9092, 30084)));
        assertThatThrownBy(() -> four.validate(RESERVED))
            .isInstanceOf(ApiException.class)
            .extracting(e -> ((ApiException) e).code()).isEqualTo("VALIDATION_ERROR");
    }

    @Test
    void consoleTemplateRejectsPublicPorts() {
        var withPorts = new ProjectRuntimeSpec(ProjectRuntimeSpec.TEMPLATE_JAVA_CONSOLE, true, true,
            List.of(new ProjectRuntimeSpec.Port("web", 8080, 30081)));
        assertThatThrownBy(() -> withPorts.validate(RESERVED))
            .isInstanceOf(ApiException.class)
            .extracting(e -> ((ApiException) e).code()).isEqualTo("VALIDATION_ERROR");
        assertThatCode(() -> ProjectRuntimeSpec.console().validate(RESERVED)).doesNotThrowAnyException();
    }

    @Test
    void rejectsUnknownTemplates() {
        var unknown = new ProjectRuntimeSpec("python-console", false, false, List.of());
        assertThatThrownBy(() -> unknown.validate(RESERVED))
            .isInstanceOf(ApiException.class)
            .extracting(e -> ((ApiException) e).code()).isEqualTo("VALIDATION_ERROR");
    }

    @Test
    void keepsPublicPortOrderForPrimaryPort() {
        var spec = new ProjectRuntimeSpec(ProjectRuntimeSpec.TEMPLATE_JAVA_SPRING_BOOT_WEB, true, true, List.of(
            new ProjectRuntimeSpec.Port("web", 8080, 30081),
            new ProjectRuntimeSpec.Port("api2", 9090, 30082)));
        assertThat(spec.primaryPort()).isEqualTo(8080);
        assertThat(spec.isService()).isTrue();
        assertThat(ProjectRuntimeSpec.console().isService()).isFalse();
        assertThat(ProjectRuntimeSpec.console().templateId())
            .isEqualTo(ProjectRuntimeSpec.TEMPLATE_JAVA_CONSOLE);
        assertThat(ProjectRuntimeSpec.console().primaryPort()).isEqualTo(8080);
        assertThat(ProjectRuntimeSpec.console().publicPorts()).isEmpty();
    }

    @Test
    void normalizedJsonAndDigestAreStable() {
        var spec = new ProjectRuntimeSpec(ProjectRuntimeSpec.TEMPLATE_JAVA_SPRING_BOOT_WEB, true, false,
            List.of(new ProjectRuntimeSpec.Port("web", 8080, 30081),
                new ProjectRuntimeSpec.Port("api2", 9090, 30082)));
        ProjectRuntimeSpec parsed = ProjectRuntimeSpec.parse(spec.toJson());
        assertThat(parsed.toJson()).isEqualTo(spec.toJson());
        assertThat(parsed.publicPorts()).containsExactlyElementsOf(spec.publicPorts());
        assertThat(parsed.primaryPort()).isEqualTo(8080);
        assertThat(spec.creationDigest()).matches("[0-9a-f]{64}");
        assertThat(parsed.creationDigest()).isEqualTo(spec.creationDigest());
    }

    @Test
    void digestChangesWhenConfigurationChanges() {
        var base = new ProjectRuntimeSpec(ProjectRuntimeSpec.TEMPLATE_JAVA_SPRING_BOOT_WEB, true, false,
            List.of(new ProjectRuntimeSpec.Port("web", 8080, 30081)));
        var otherPort = new ProjectRuntimeSpec(ProjectRuntimeSpec.TEMPLATE_JAVA_SPRING_BOOT_WEB, true, false,
            List.of(new ProjectRuntimeSpec.Port("web", 8080, 30082)));
        var otherTemplate = new ProjectRuntimeSpec(ProjectRuntimeSpec.TEMPLATE_JAVA_CONSOLE, true, false,
            List.of());
        assertThat(base.creationDigest()).isNotEqualTo(otherPort.creationDigest());
        assertThat(base.creationDigest()).isNotEqualTo(otherTemplate.creationDigest());
    }
}
