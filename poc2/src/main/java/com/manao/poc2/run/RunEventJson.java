package com.manao.poc2.run;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.stereotype.Component;

@Component
public class RunEventJson {

    private final ObjectMapper objectMapper;

    public RunEventJson(ObjectMapper objectMapper) {
        this.objectMapper = objectMapper;
    }

    public String toJson(RunEvent event) {
        try {
            return objectMapper.writeValueAsString(event);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Failed to serialize run event", e);
        }
    }
}
