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
    }
}
