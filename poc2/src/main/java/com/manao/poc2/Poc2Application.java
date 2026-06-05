package com.manao.poc2;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.EnableConfigurationProperties;

@SpringBootApplication
@EnableConfigurationProperties(Poc2Properties.class)
public class Poc2Application {

    public static void main(String[] args) {
        SpringApplication.run(Poc2Application.class, args);
    }
}
