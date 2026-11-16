package com.manao.poc4.completion;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.manao.poc4.config.SecurityConfig;
import java.net.URI;
import java.net.http.HttpClient;
import java.time.Duration;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Conditional;
import org.springframework.context.annotation.Configuration;

@Configuration(proxyBeanMethods = false)
@Conditional(SecurityConfig.BackendAuthCondition.class)
public class CodeCompletionConfig {
    @Bean
    DeepSeekFimClient deepSeekFimClient(ObjectMapper json,
                                        @Value("${MANAO_FIM_API_KEY:}") String apiKey,
                                        @Value("${MANAO_FIM_MODEL:deepseek-flash}") String model) {
        var http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(2))
            .followRedirects(HttpClient.Redirect.NEVER).build();
        return new DeepSeekFimClient(http, json, URI.create("https://api.deepseek.com/beta/completions"),
            apiKey, model, Duration.ofSeconds(5));
    }
}
