package com.manao.poc4;

import com.manao.poc4.config.BackendProperties;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.EnableConfigurationProperties;

@SpringBootApplication
@EnableConfigurationProperties(BackendProperties.class)
public class Poc4BackendApplication {
    public static void main(String[] args) {
        SpringApplication.run(Poc4BackendApplication.class, args);
    }
}
