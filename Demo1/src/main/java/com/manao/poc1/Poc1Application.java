package com.manao.poc1;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.EnableConfigurationProperties;

@SpringBootApplication
@EnableConfigurationProperties(Poc1Properties.class)
public class Poc1Application {

    public static void main(String[] args) {
        SpringApplication.run(Poc1Application.class, args);
    }
}
