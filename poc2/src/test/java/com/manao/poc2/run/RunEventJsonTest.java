package com.manao.poc2.run;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

class RunEventJsonTest {

    private final ObjectMapper objectMapper = new ObjectMapper();
    private final RunEventJson eventJson = new RunEventJson(objectMapper);

    @Test
    @DisplayName("serializes log event with type jobName and message")
    void toJson_whenLogEvent_returnsStableFields() throws Exception {
        String json = eventJson.toJson(RunEvent.log("job-123", "Hello World"));

        JsonNode node = objectMapper.readTree(json);
        assertThat(node.get("type").asText()).isEqualTo("log");
        assertThat(node.get("jobName").asText()).isEqualTo("job-123");
        assertThat(node.get("message").asText()).isEqualTo("Hello World");
        assertThat(node.has("code")).isFalse();
    }

    @Test
    @DisplayName("serializes exit event with exit code")
    void toJson_whenExitEvent_returnsCode() throws Exception {
        String json = eventJson.toJson(RunEvent.exit("job-123", 0));

        JsonNode node = objectMapper.readTree(json);
        assertThat(node.get("type").asText()).isEqualTo("exit");
        assertThat(node.get("jobName").asText()).isEqualTo("job-123");
        assertThat(node.get("code").asInt()).isEqualTo(0);
        assertThat(node.has("message")).isFalse();
    }

    @Test
    @DisplayName("serializes error event with message")
    void toJson_whenErrorEvent_returnsMessage() throws Exception {
        String json = eventJson.toJson(RunEvent.error("job-123", "failed"));

        JsonNode node = objectMapper.readTree(json);
        assertThat(node.get("type").asText()).isEqualTo("error");
        assertThat(node.get("jobName").asText()).isEqualTo("job-123");
        assertThat(node.get("message").asText()).isEqualTo("failed");
    }
}
