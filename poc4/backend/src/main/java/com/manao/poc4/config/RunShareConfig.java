package com.manao.poc4.config;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.manao.poc4.log.JdbcLogStore;
import com.manao.poc4.run.RunStore;
import com.manao.poc4.share.JdbcRunShareStore;
import com.manao.poc4.share.RunShareService;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Conditional;
import org.springframework.context.annotation.Configuration;
import org.springframework.jdbc.core.JdbcTemplate;

@Configuration(proxyBeanMethods = false)
@Conditional(SecurityConfig.BackendAuthCondition.class)
public class RunShareConfig {
    @Bean
    JdbcRunShareStore runShareStore(JdbcTemplate jdbc) {
        return new JdbcRunShareStore(jdbc);
    }

    @Bean
    RunShareService runShareService(JdbcRunShareStore shares, RunStore runs, JdbcLogStore logs, ObjectMapper json) {
        return new RunShareService(shares, runs, logs, json);
    }
}
