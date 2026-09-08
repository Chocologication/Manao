package com.manao.poc4.project;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.manao.poc4.api.GlobalExceptionHandler;
import com.manao.poc4.persistence.DatabaseClock;
import com.manao.poc4.persistence.JdbcStoreTestSupport;
import com.manao.poc4.persistence.Repositories;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.ArrayList;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

class ProjectLimitTest {
    private JdbcStoreTestSupport database;
    private ProjectService service;
    private final String alice = UUID.randomUUID().toString();
    private final String bob = UUID.randomUUID().toString();

    @BeforeEach
    void setUp() {
        database = JdbcStoreTestSupport.create();
        var jdbc = database.jdbc();
        service = new ProjectService(jdbc, new DataSourceTransactionManager(jdbc.getDataSource()));
        for (String id : new String[]{alice, bob}) {
            jdbc.update("INSERT INTO app_user(id, username, password_hash, created_at) VALUES (?, ?, ?, ?)",
                id, "limit-test-" + id, "not-a-login-hash", Timestamp.from(Instant.now()));
        }
    }

    @AfterEach
    void tearDown() { if (database != null) database.close(); }

    @Test
    void apiAllowsEightProjectsAndRejectsNinthWithoutAffectingAnotherOwner() throws Exception {
        var mvc = MockMvcBuilders.standaloneSetup(new ProjectController(service))
            .setControllerAdvice(new GlobalExceptionHandler()).build();
        var owner = new UsernamePasswordAuthenticationToken(alice, "unused");
        mvc.perform(get("/api/v1/projects").principal(owner))
            .andExpect(status().isOk()).andExpect(jsonPath("$.limit").value(8));
        for (int i = 1; i <= 8; i++) {
            mvc.perform(post("/api/v1/projects").principal(owner).contentType("application/json")
                .content("{\"name\":\"project-" + i + "\"}"))
                .andExpect(status().isCreated()).andExpect(jsonPath("$.state").value("CREATING"));
        }
        // Existing policy still counts every project state, including failed test attempts.
        database.jdbc().update("UPDATE project SET state='FAILED' WHERE owner_id=?", alice);
        mvc.perform(post("/api/v1/projects").principal(owner).contentType("application/json")
            .content("{\"name\":\"project-9\"}"))
            .andExpect(status().isConflict()).andExpect(jsonPath("$.code").value("PROJECT_LIMIT_REACHED"));
        assertThat(service.list(alice)).hasSize(8);
        assertThat(service.create(bob, "bob-first")).isPresent();
        assertThat(service.get(bob, service.list(alice).get(0).id())).isEmpty();
    }

    @Test
    void concurrentCreatesCannotExceedEightProjects() throws Exception {
        for (int i = 0; i < 7; i++) assertThat(service.create(alice, "seed-" + i)).isPresent();
        var executor = Executors.newFixedThreadPool(4);
        var start = new CountDownLatch(1);
        var ready = new CountDownLatch(4);
        var results = new ArrayList<Future<Boolean>>();
        try {
            for (int i = 0; i < 4; i++) {
                String name = "concurrent-" + i;
                results.add(executor.submit(() -> {
                    ready.countDown();
                    if (!start.await(10, TimeUnit.SECONDS)) throw new AssertionError("start timed out");
                    return service.create(alice, name).isPresent();
                }));
            }
            assertThat(ready.await(10, TimeUnit.SECONDS)).isTrue();
            start.countDown();
            int created = 0;
            for (var result : results) if (result.get(20, TimeUnit.SECONDS)) created++;
            assertThat(created).isEqualTo(1);
            assertThat(service.list(alice)).hasSize(8);
        } finally {
            start.countDown();
            executor.shutdownNow();
            assertThat(executor.awaitTermination(10, TimeUnit.SECONDS)).isTrue();
        }
    }

    @Test
    void repositoryBoundaryAlsoAllowsEightAndRejectsNinth() throws Exception {
        try (var connection = database.jdbc().getDataSource().getConnection()) {
            var repositories = Repositories.create(connection, new DatabaseClock());
            for (int i = 1; i <= 8; i++) {
                assertThat(repositories.projects().createForOwner(UUID.randomUUID().toString(), alice, "repo-" + i)).isTrue();
            }
            assertThat(repositories.projects().createForOwner(UUID.randomUUID().toString(), alice, "repo-9")).isFalse();
            assertThat(repositories.projects().createForOwner(UUID.randomUUID().toString(), bob, "bob-first")).isTrue();
        }
        assertThat(service.list(alice)).hasSize(8);
    }
}
