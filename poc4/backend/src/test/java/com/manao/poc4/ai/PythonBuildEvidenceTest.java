package com.manao.poc4.ai;

import static org.assertj.core.api.Assertions.assertThat;
import com.manao.poc4.ai.AgentContracts.BuildGoal;
import org.junit.jupiter.api.Test;

class PythonBuildEvidenceTest {
    static String report(String xml) {
        return "pytest output\nMANAO-PYTEST-REPORT-BEGIN\n" + xml
            + "\nMANAO-PYTEST-REPORT-END state=complete bytes="
            + xml.getBytes(java.nio.charset.StandardCharsets.UTF_8).length + "\n";
    }
    private PythonBuildEvidence parse(int exit, String xml) {
        return PythonBuildEvidence.from(BuildGoal.TEST, exit, report(xml), false);
    }
    @Test void nestedSuitesAreCountedOnce() {
        var evidence = parse(0, "<testsuites tests='2'><testsuite tests='2' failures='0' errors='0' skipped='1'><testsuite tests='2' failures='0' errors='0' skipped='1'/></testsuite></testsuites>");
        assertThat(evidence.verificationStatus()).isEqualTo(PythonBuildEvidence.VerificationStatus.PASS);
        assertThat(evidence.testSummary().tests()).isEqualTo(2);
        assertThat(evidence.testSummary().reportComplete()).isTrue();
    }
    @Test void failureCollectionErrorsAllSkippedAndZeroTestsRemainDistinct() {
        assertThat(parse(1, "<testsuite tests='1' failures='1' errors='0' skipped='0'/>").verificationStatus()).hasToString("FAILED");
        assertThat(parse(2, "<testsuite tests='1' failures='0' errors='1' skipped='0'/>").verificationStatus()).hasToString("FAILED");
        assertThat(parse(0, "<testsuite tests='2' failures='0' errors='0' skipped='2'/>").verificationStatus()).hasToString("SKIPPED");
        assertThat(parse(0, "<testsuite tests='0' failures='0' errors='0' skipped='0'/>").verificationStatus()).hasToString("NO_TESTS");
        assertThat(PythonBuildEvidence.from(BuildGoal.TEST, 5, "", false).verificationStatus()).hasToString("NO_TESTS");
        assertThat(parse(1, "<testsuite tests='1' failures='0' errors='0' skipped='0'/>").verificationStatus()).hasToString("FAILED");
    }
    @Test void missingMalformedTruncatedOversizedOrExternalEntityReportsCannotPass() {
        for (String output : java.util.List.of("", report("<broken>"),
                report("<!DOCTYPE testsuite [<!ENTITY x SYSTEM 'file:///etc/passwd'>]><testsuite tests='1' failures='0' errors='0' skipped='0'>&x;</testsuite>"),
                report("<testsuite tests='1' failures='0' errors='0' skipped='0'/>").replace("state=complete", "state=truncated"),
                report("<testsuite tests='1' failures='0' errors='0' skipped='0'/>").replace("bytes=", "bytes=9"),
                report(" ".repeat(65537)), report("<testsuites/>"),
                report("<testsuite tests='1' failures='0' errors='0' skipped='2'/>") )) {
            assertThat(PythonBuildEvidence.from(BuildGoal.TEST, 0, output, false).verificationStatus()).hasToString("UNKNOWN");
        }
        assertThat(PythonBuildEvidence.from(BuildGoal.TEST, 0, report("<testsuite tests='1' failures='0' errors='0' skipped='0'/>"), true).verificationStatus()).hasToString("UNKNOWN");
        assertThat(PythonBuildEvidence.from(BuildGoal.TEST, null, report("<testsuite tests='1' failures='0' errors='0' skipped='0'/>"), false).verificationStatus()).hasToString("UNKNOWN");
    }
    @Test void syntaxRequiresRealFilesAndConsistentBoundedReport() {
        String good = "{\"language\":\"python\",\"checkKind\":\"syntax\",\"verificationStatus\":\"PASS\",\"filesChecked\":2,\"errors\":[]}\n";
        var evidence = PythonBuildEvidence.from(BuildGoal.COMPILE, 0, good, false);
        assertThat(evidence.verificationStatus()).hasToString("PASS");
        assertThat(evidence.filesChecked()).isEqualTo(2);
        assertThat(PythonBuildEvidence.from(BuildGoal.COMPILE, 1, good.replace("PASS", "NO_SOURCE").replace(":2", ":0"), false).verificationStatus()).hasToString("NO_SOURCE");
        assertThat(PythonBuildEvidence.from(BuildGoal.COMPILE, 1, good.replace("PASS", "FAILED").replace("[]", "[{\"path\":\"main.py\",\"message\":\"invalid syntax\"}]"), false).verificationStatus()).hasToString("FAILED");
        assertThat(PythonBuildEvidence.from(BuildGoal.COMPILE, 0, good.replace(":2", ":0"), false).verificationStatus()).hasToString("UNKNOWN");
        assertThat(PythonBuildEvidence.from(BuildGoal.COMPILE, null, good, false).verificationStatus()).hasToString("UNKNOWN");
    }
}
