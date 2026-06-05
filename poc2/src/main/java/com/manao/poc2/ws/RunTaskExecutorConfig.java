package com.manao.poc2.ws;

import java.util.concurrent.Executor;
import java.util.concurrent.Executors;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class RunTaskExecutorConfig {

    @Bean
    Executor runTaskExecutor() {
        return Executors.newSingleThreadExecutor();
    }
}
