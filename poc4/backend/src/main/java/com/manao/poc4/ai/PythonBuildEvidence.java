package com.manao.poc4.ai;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Pattern;
import javax.xml.XMLConstants;
import javax.xml.parsers.DocumentBuilderFactory;
import org.w3c.dom.Element;

/** Bounded image-owned syntax / pytest evidence; an exit code alone never establishes a pass. */
public record PythonBuildEvidence(String language, String checkKind, VerificationStatus verificationStatus,
        Integer filesChecked, List<SyntaxError> errors, TestSummary testSummary) {
    public enum VerificationStatus { PASS, FAILED, NO_TESTS, SKIPPED, UNKNOWN, NO_SOURCE }
    public record SyntaxError(String path, String message) { }
    public record TestSummary(int tests, int failures, int errors, int skipped, boolean reportComplete) { }
    private static final int MAX_BYTES = 65536;
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String BEGIN = "MANAO-PYTEST-REPORT-BEGIN\n";
    private static final Pattern END = Pattern.compile("\nMANAO-PYTEST-REPORT-END state=(complete|missing|truncated) bytes=([0-9]+)(?:\n|$)");

    public static PythonBuildEvidence from(AgentContracts.BuildGoal goal, Integer exitCode, String output, boolean truncated) {
        String kind = goal == AgentContracts.BuildGoal.COMPILE ? "syntax" : "pytest";
        var unknown = new PythonBuildEvidence("python", kind, VerificationStatus.UNKNOWN, null, List.of(), null);
        if (truncated || exitCode == null || output == null) return unknown;
        if (goal == AgentContracts.BuildGoal.TEST && exitCode == 5)
            return new PythonBuildEvidence("python", kind, VerificationStatus.NO_TESTS, null, List.of(), null);
        try {
            if (goal == AgentContracts.BuildGoal.COMPILE) return syntax(exitCode, output, unknown);
            if (goal != AgentContracts.BuildGoal.TEST) return unknown;
            int start = output.lastIndexOf(BEGIN);
            if (start < 0 || (start > 0 && output.charAt(start - 1) != '\n')) return unknown;
            start += BEGIN.length();
            var end = END.matcher(output);
            if (!end.find(start) || !"complete".equals(end.group(1))) return unknown;
            byte[] payload = output.substring(start, end.start()).getBytes(StandardCharsets.UTF_8);
            if (payload.length == 0 || payload.length > MAX_BYTES || payload.length != Integer.parseInt(end.group(2))) return unknown;
            var factory = DocumentBuilderFactory.newInstance();
            factory.setFeature(XMLConstants.FEATURE_SECURE_PROCESSING, true);
            factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
            factory.setFeature("http://xml.org/sax/features/external-general-entities", false);
            factory.setFeature("http://xml.org/sax/features/external-parameter-entities", false);
            factory.setAttribute(XMLConstants.ACCESS_EXTERNAL_DTD, "");
            factory.setAttribute(XMLConstants.ACCESS_EXTERNAL_SCHEMA, "");
            factory.setXIncludeAware(false);
            factory.setExpandEntityReferences(false);
            var builder = factory.newDocumentBuilder();
            builder.setErrorHandler(new org.xml.sax.helpers.DefaultHandler() {
                @Override public void error(org.xml.sax.SAXParseException e) throws org.xml.sax.SAXException { throw e; }
                @Override public void fatalError(org.xml.sax.SAXParseException e) throws org.xml.sax.SAXException { throw e; }
            });
            Element root = builder.parse(new ByteArrayInputStream(payload)).getDocumentElement();
            int[] counts = counts(root);
            var summary = new TestSummary(counts[0], counts[1], counts[2], counts[3], true);
            VerificationStatus status = exitCode != 0 || counts[1] > 0 || counts[2] > 0 ? VerificationStatus.FAILED
                : counts[0] == 0 ? VerificationStatus.NO_TESTS : counts[3] == counts[0] ? VerificationStatus.SKIPPED : VerificationStatus.PASS;
            return new PythonBuildEvidence("python", kind, status, null, List.of(), summary);
        } catch (Exception malformed) {
            return unknown;
        }
    }

    private static PythonBuildEvidence syntax(int exitCode, String output, PythonBuildEvidence unknown) throws Exception {
        JsonNode found = null;
        for (String line : output.split("\n")) {
            if (!line.startsWith("{")) continue;
            if (line.getBytes(StandardCharsets.UTF_8).length + 1 > MAX_BYTES) return unknown;
            JsonNode candidate = JSON.readTree(line);
            if ("python".equals(candidate.path("language").asText()) && "syntax".equals(candidate.path("checkKind").asText())) {
                if (found != null) return unknown;
                found = candidate;
            }
        }
        if (found == null || !found.path("filesChecked").canConvertToInt() || !found.path("filesChecked").isIntegralNumber()
                || !found.path("errors").isArray()) return unknown;
        int checked = found.path("filesChecked").intValue();
        if (checked < 0 || checked > 1000) return unknown;
        List<SyntaxError> errors = new ArrayList<>();
        for (var error : found.path("errors")) {
            if (!error.path("message").isTextual() || error.path("message").asText().length() > 2048) return unknown;
            String path = error.path("path").isTextual() ? error.path("path").asText() : null;
            if (path != null && (path.length() > 4096 || path.startsWith("/") || path.contains("\\") || path.contains(".."))) return unknown;
            errors.add(new SyntaxError(path, error.path("message").asText()));
        }
        VerificationStatus status = VerificationStatus.valueOf(found.path("verificationStatus").asText());
        boolean valid = switch (status) {
            case PASS -> exitCode == 0 && checked > 0 && errors.isEmpty();
            case FAILED -> exitCode != 0 && checked > 0 && !errors.isEmpty();
            case NO_SOURCE -> exitCode != 0 && checked == 0 && errors.isEmpty();
            case UNKNOWN -> true;
            default -> false;
        };
        return valid ? new PythonBuildEvidence("python", "syntax", status, checked, List.copyOf(errors), null) : unknown;
    }

    /** Sum leaf suites only: parent attributes aggregate descendants and must never be counted twice. */
    private static int[] counts(Element element) {
        if (!("testsuite".equals(element.getTagName()) || "testsuites".equals(element.getTagName()))) throw new IllegalArgumentException();
        int[] result = new int[4];
        boolean nested = false;
        for (var child = element.getFirstChild(); child != null; child = child.getNextSibling()) {
            if (child instanceof Element suite && ("testsuite".equals(suite.getTagName()) || "testsuites".equals(suite.getTagName()))) {
                nested = true;
                int[] values = counts(suite);
                for (int i = 0; i < 4; i++) result[i] = Math.addExact(result[i], values[i]);
            }
        }
        if (!nested) {
            if (!"testsuite".equals(element.getTagName())) throw new IllegalArgumentException();
            String[] attributes = {"tests", "failures", "errors", "skipped"};
            for (int i = 0; i < 4; i++) {
                result[i] = Integer.parseInt(element.getAttribute(attributes[i]));
                if (result[i] < 0) throw new IllegalArgumentException();
            }
        }
        if ((long) result[1] + result[2] + result[3] > result[0]) throw new IllegalArgumentException();
        return result;
    }
}
