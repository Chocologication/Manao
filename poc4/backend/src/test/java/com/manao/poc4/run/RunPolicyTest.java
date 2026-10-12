package com.manao.poc4.run;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.manao.poc4.project.ProjectRuntimeSpec;
import com.manao.poc4.project.RuntimeTemplate;
import java.util.List;
import org.junit.jupiter.api.Test;

class RunPolicyTest {
    @Test
    void pythonServiceHasItsOwnPolicyAndLegacyJavaStillLoads() {
        var spec = new ProjectRuntimeSpec("python-fastapi-web", true, true, List.of());
        assertThat(spec.isService()).isTrue();
        assertThat(spec.primaryPort()).isEqualTo(8000);
        var policy = RunControllerTest.policy().forProject(spec);
        assertThat(policy.template()).isEqualTo(RuntimeTemplate.PYTHON_FASTAPI_WEB);
        assertThat(policy.toJson()).contains("\"language\":\"python\"")
            .doesNotContain("javaMajor");
        assertThat(RunPolicy.fromJson(policy.toJson())).isEqualTo(policy);
    }

    @Test
    void pythonServiceSnapshotHasNoJavaRuntimeAndRoundTrips() {
        var spec = new ProjectRuntimeSpec("python-fastapi-web", true, true, List.of());
        var policy = RunControllerTest.policy().forProject(spec);
        assertThat(policy.template()).isEqualTo(RuntimeTemplate.PYTHON_FASTAPI_WEB);
        assertThat(policy.isService()).isTrue();
        assertThat(policy.toJson()).contains("\"templateId\":\"python-fastapi-web\"")
            .contains("\"language\":\"python\"")
            .contains("\"pythonVersion\":\"3.13\"")
            .doesNotContain("javaMajor", "mavenMajor");
        assertThat(RunPolicy.fromJson(policy.toJson())).isEqualTo(policy);
    }

    @Test
    void allTemplatesProduceConsistentSnapshots() {
        for (String id : List.of("java-console", "java-spring-boot-web", "python-console", "python-fastapi-web")) {
            var policy = RunControllerTest.policy().forProject(new ProjectRuntimeSpec(id, false, false, List.of()));
            assertThat(policy.template().id()).isEqualTo(id);
            assertThat(policy.isService()).isEqualTo(id.endsWith("-web"));
            assertThat(RunPolicy.fromJson(policy.toJson())).isEqualTo(policy);
        }
    }

    @Test
    void oldJavaTaskAndServiceSnapshotsRemainReadable() {
        String task = "{\"command\":\"mvn -q -DskipTests compile exec:java\","
            + "\"runtime\":{\"javaMajor\":17,\"mavenMajor\":3},\"timeoutSeconds\":1800,"
            + "\"resources\":{\"requests\":{\"cpuMillis\":1000,\"memoryBytes\":1073741824,"
            + "\"ephemeralStorageBytes\":1073741824},\"limits\":{\"cpuMillis\":8000,"
            + "\"memoryBytes\":17179869184,\"ephemeralStorageBytes\":10737418240}}}";
        assertThat(RunPolicy.fromJson(task).template()).isEqualTo(RuntimeTemplate.JAVA_CONSOLE);
        String service = task.substring(0, task.length() - 1)
            + ",\"executionKind\":\"SERVICE\",\"startupTimeoutSeconds\":1800,"
            + "\"serviceLifetimeSeconds\":7200}";
        assertThat(RunPolicy.fromJson(service).template()).isEqualTo(RuntimeTemplate.JAVA_SPRING_BOOT_WEB);
        assertThat(RunPolicy.fromJson(service).isService()).isTrue();
        // A legacy SERVICE keeps its historical console command display; history is never rewritten.
        assertThat(RunPolicy.fromJson(service).command()).isEqualTo("mvn -q -DskipTests compile exec:java");
        assertThat(RunPolicy.fromJson(task).command()).isEqualTo("mvn -q -DskipTests compile exec:java");
        // A legacy-parsed snapshot re-serializes to the legacy shape (no templateId) and round-trips.
        RunPolicy legacyParsed = RunPolicy.fromJson(service);
        assertThat(legacyParsed.toJson()).doesNotContain("templateId");
        assertThat(RunPolicy.fromJson(legacyParsed.toJson())).isEqualTo(legacyParsed);
    }

    @Test
    void unknownAndConflictingNewPolicyNeverFallsBackToJava() {
        String valid = RunControllerTest.policy().forProject(
            new ProjectRuntimeSpec("python-console", false, false, List.of())).toJson();
        assertThatThrownBy(() -> RunPolicy.fromJson(valid.replace("python-console", "python-unknown")))
            .isInstanceOf(IllegalStateException.class);
        assertThatThrownBy(() -> RunPolicy.fromJson(valid.replace("\"language\":\"python\"", "\"language\":\"java\"")))
            .isInstanceOf(IllegalStateException.class);
        assertThatThrownBy(() -> RunPolicy.fromJson(valid.replace("python -u main.py", "mvn -q -DskipTests compile exec:java")))
            .isInstanceOf(IllegalStateException.class);
        // The execution kind must also agree with the template.
        assertThatThrownBy(() -> RunPolicy.fromJson(valid.replace(
                "\"executionKind\":\"TASK\"", "\"executionKind\":\"SERVICE\"")))
            .isInstanceOf(IllegalStateException.class);
    }

    @Test
    void explicitBlankOrNullTemplateIdIsRejectedInsteadOfReadAsLegacy() {
        // Legacy format means the field is genuinely ABSENT; a present but invalid templateId
        // is unknown data and must never fall back to the historical Java interpretation.
        String newFormat = RunControllerTest.policy().toJson();
        assertThatThrownBy(() -> RunPolicy.fromJson(
                newFormat.replace("\"templateId\":\"java-console\"", "\"templateId\":\"\"")))
            .isInstanceOf(IllegalStateException.class);
        assertThatThrownBy(() -> RunPolicy.fromJson(
                newFormat.replace("\"templateId\":\"java-console\"", "\"templateId\":null")))
            .isInstanceOf(IllegalStateException.class);
    }

    @Test
    void runtimeFieldsMustMatchTheirLanguage() {
        String python = RunControllerTest.policy().forProject(
            new ProjectRuntimeSpec("python-console", false, false, List.of())).toJson();
        // A python runtime carrying Java fields is conflicting data, never tolerated.
        assertThatThrownBy(() -> RunPolicy.fromJson(python.replace(
                "\"packageManager\":\"uv\"", "\"packageManager\":\"uv\",\"javaMajor\":17")))
            .isInstanceOf(IllegalStateException.class);
        // Missing required python fields must not be rewritten into an empty toolchain either.
        assertThatThrownBy(() -> RunPolicy.fromJson(python.replace("\"pythonVersion\":\"3.13\",", "")))
            .isInstanceOf(IllegalStateException.class);
        assertThatThrownBy(() -> RunPolicy.fromJson(python.replace("\"packageManager\":\"uv\"", "")))
            .isInstanceOf(IllegalStateException.class);
        // The same exclusion holds for a java runtime carrying python fields.
        String java = RunControllerTest.policy().toJson();
        assertThatThrownBy(() -> RunPolicy.fromJson(java.replace(
                "\"mavenMajor\":3", "\"mavenMajor\":3,\"pythonVersion\":\"3.13\"")))
            .isInstanceOf(IllegalStateException.class);
    }
}
