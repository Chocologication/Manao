package com.manao.poc4.ai;

import static org.assertj.core.api.Assertions.assertThat;
import org.junit.jupiter.api.Test;

class NodeJUnitReportTest {
    private static String wrap(String xml) {
        return Fabric8DevelopmentBuildExecutor.REPORT_BEGIN + "\n" + xml + "\n" + Fabric8DevelopmentBuildExecutor.REPORT_END;
    }

    @Test void nodeTopLevelCasesAreCountedFromRealJUnitShape() {
        var reports = Fabric8DevelopmentBuildExecutor.parseReports(wrap("""
            <?xml version="1.0" encoding="utf-8"?>
            <testsuites>
              <testcase name="greets the user" classname="test"/>
              <testcase name="failure"><failure message="assertion failed"/></testcase>
              <testcase name="skipped"><skipped/></testcase>
            </testsuites>
            """));
        assertThat(reports).singleElement().satisfies(report -> {
            assertThat(report.testClass()).isEqualTo("node:test");
            assertThat(report.tests()).isEqualTo(3); assertThat(report.failures()).isEqualTo(1);
            assertThat(report.skipped()).isEqualTo(1); assertThat(report.sha256()).hasSize(64);
        });
    }

    @Test void namedSuitesAndExternalEntityRejectionRemainSupported() {
        var reports = Fabric8DevelopmentBuildExecutor.parseReports(wrap("""
            <testsuites><testsuite name="app" tests="2" failures="0" errors="0" skipped="0"/></testsuites>
            """));
        assertThat(reports).singleElement().satisfies(report -> assertThat(report.tests()).isEqualTo(2));
        assertThat(Fabric8DevelopmentBuildExecutor.parseReports(wrap("""
            <!DOCTYPE testsuites [<!ENTITY xxe SYSTEM "file:///not-readable">]>
            <testsuites><testcase name="&xxe;"/></testsuites>
            """))).isEmpty();
    }
}
