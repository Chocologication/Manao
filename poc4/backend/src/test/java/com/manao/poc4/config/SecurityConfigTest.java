package com.manao.poc4.config;

import static org.assertj.core.api.Assertions.assertThat;
import javax.sql.DataSource;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

class SecurityConfigTest {
    @Test
    void missingJwtSecretFailsBackendContextEvenWithoutRealDatabaseConnection() {
        new ApplicationContextRunner()
            .withUserConfiguration(SecurityConfig.class)
            .withBean(DataSource.class, () -> new DriverManagerDataSource("jdbc:invalid:test"))
            // The account store needs the JDBC template bean; the failing bean under test is
            // still the empty JWT secret, not a missing collaborator.
            .withBean(org.springframework.jdbc.core.JdbcTemplate.class,
                () -> org.mockito.Mockito.mock(org.springframework.jdbc.core.JdbcTemplate.class))
            .withPropertyValues("MANAO_JWT_SECRET=")
            .run(context -> assertThat(context.getStartupFailure()).isNotNull());
    }
}
