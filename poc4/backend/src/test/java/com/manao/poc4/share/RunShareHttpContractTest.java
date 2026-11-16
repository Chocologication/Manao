package com.manao.poc4.share;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.manao.poc4.api.ApiException;
import com.manao.poc4.api.GlobalExceptionHandler;
import com.manao.poc4.auth.JwtService;
import com.manao.poc4.config.SecurityConfig;
import com.manao.poc4.config.StrictHttpJsonConfig;
import com.manao.poc4.persistence.JdbcStoreTestSupport;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.autoconfigure.jackson.JacksonAutoConfiguration;
import org.springframework.boot.autoconfigure.security.servlet.SecurityAutoConfiguration;
import org.springframework.boot.autoconfigure.web.servlet.DispatcherServletAutoConfiguration;
import org.springframework.boot.autoconfigure.web.servlet.WebMvcAutoConfiguration;
import org.springframework.boot.test.context.runner.WebApplicationContextRunner;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.web.FilterChainProxy;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.context.WebApplicationContext;

class RunShareHttpContractTest {
    private static final WebApplicationContextRunner RUNNER = new WebApplicationContextRunner()
        .withConfiguration(AutoConfigurations.of(DispatcherServletAutoConfiguration.class,
            WebMvcAutoConfiguration.class, SecurityAutoConfiguration.class, JacksonAutoConfiguration.class,
            org.springframework.boot.autoconfigure.http.HttpMessageConvertersAutoConfiguration.class))
        .withUserConfiguration(SecurityConfig.class, StrictHttpJsonConfig.class,
            GlobalExceptionHandler.class, ErrorProbe.class)
        .withPropertyValues("MANAO_JWT_SECRET=0123456789abcdef0123456789abcdef");

    @Test
    void shareErrorCodesSurviveTheRealHttpAllowlistWithFixedMessages() {
        try (var db = JdbcStoreTestSupport.create()) {
            RunShareTestFixtures.seedFinishedRun(db.jdbc(), "");
            RUNNER.withBean(JdbcTemplate.class, db::jdbc).run(context -> {
                MockMvc mvc = MockMvcBuilders.webAppContextSetup((WebApplicationContext) context)
                    .addFilters(context.getBean(FilterChainProxy.class)).build();
                String jwt = context.getBean(JwtService.class).issue("owner", 0).accessToken();
                Map<String, String> messages = Map.of(
                    "RUN_SHARE_NOT_TERMINAL", "Only terminal runs can be shared",
                    "RUN_SHARE_PREVIEW_CHANGED", "Run share preview changed",
                    "RUN_SHARE_ALREADY_ACTIVE", "An active run share already exists",
                    "RUN_SHARE_REQUEST_MISMATCH", "Run share request does not match the original request",
                    "RUN_SHARE_EXPIRED", "Run share has expired",
                    "RUN_SHARE_REVOKED", "Run share has been revoked",
                    "RUN_SHARE_NOT_FOUND", "Run share not found");
                for (var entry : messages.entrySet()) {
                    int expected = entry.getKey().endsWith("NOT_FOUND") ? 404
                        : entry.getKey().endsWith("EXPIRED") || entry.getKey().endsWith("REVOKED") ? 410 : 409;
                    var response = mvc.perform(get("/api/v1/share-error/" + entry.getKey())
                        .header("Authorization", "Bearer " + jwt)).andReturn().getResponse();
                    JsonNode body = context.getBean(ObjectMapper.class).readTree(response.getContentAsByteArray());
                    assertThat(response.getStatus()).isEqualTo(expected);
                    assertThat(body.path("code").asText()).isEqualTo(entry.getKey());
                    assertThat(body.path("message").asText()).isEqualTo(entry.getValue());
                    assertThat(body.toString()).doesNotContain("SECRET");
                }
                var unknown=mvc.perform(get("/api/v1/share-error/UNKNOWN_CODE")
                    .header("Authorization","Bearer "+jwt)).andReturn().getResponse();
                assertThat(context.getBean(ObjectMapper.class).readTree(unknown.getContentAsByteArray()).path("code").asText())
                    .isEqualTo("INTERNAL_ERROR");
            });
        }
    }

    @Test
    void realSecurityChainEnforcesOwnerAndStrictRequestsAndPublicWhitelist() {
        withHttp((jdbc,mvc,json,jwt,service) -> {
            for(var request : java.util.List.of(get("/api/v1/run-shares"),
                delete("/api/v1/run-shares/missing"),post("/api/v1/projects/project/runs/run/shares"),
                post("/api/v1/public/run-shares/token"),delete("/api/v1/public/run-shares/token"),
                get("/api/v1/public/run-shares/token/nested"),get("/api/v1/public/run-shares"))) {
                var response=mvc.perform(request).andReturn().getResponse();
                assertThat(response.getStatus()).isEqualTo(401);noStore(response);
            }
            var preview=mvc.perform(get("/api/v1/projects/project/runs/run/share-preview")
                .header("Authorization",jwt)).andReturn().getResponse();
            assertThat(preview.getStatus()).isEqualTo(200);noStore(preview);
            var previewBody=json.readTree(preview.getContentAsByteArray());
            assertThat(previewBody.path("kind").asText()).isEqualTo("PREVIEW");
            assertThat(previewBody.path("share").isNull()).isTrue();
            String request=json.writeValueAsString(new RunShareContracts.PublishRequest(java.util.UUID.randomUUID().toString(),
                previewBody.path("snapshotDigest").asText(),"<b>标题</b>","说明"));
            var unknown=mvc.perform(post("/api/v1/projects/project/runs/run/shares").header("Authorization",jwt)
                .contentType("application/json").content(request.substring(0,request.length()-1)+",\"ownerId\":\"other\"}"))
                .andReturn().getResponse();
            assertThat(unknown.getStatus()).isEqualTo(422);noStore(unknown);
            var published=mvc.perform(post("/api/v1/projects/project/runs/run/shares").header("Authorization",jwt)
                .contentType("application/json").content(request)).andReturn().getResponse();
            assertThat(published.getStatus()).isEqualTo(201);
            JsonNode share=json.readTree(published.getContentAsByteArray());
            assertThat(share.properties().stream().map(Map.Entry::getKey).toList())
                .containsExactlyInAnyOrder("id","title","sourceProjectName","createdAt","expiresAt","status","sharePath");
            String id=share.path("id").asText();String token=share.path("sharePath").asText().substring(8);
            var publicResponse=mvc.perform(get("/api/v1/public/run-shares/"+token)).andReturn().getResponse();
            assertThat(publicResponse.getStatus()).isEqualTo(200);noStore(publicResponse);
            JsonNode body=json.readTree(publicResponse.getContentAsByteArray());
            assertThat(body.properties().stream().map(Map.Entry::getKey).toList()).containsExactlyInAnyOrder(
                "title","description","createdAt","expiresAt","snapshot");
            assertThat(body.path("snapshot").properties().stream().map(Map.Entry::getKey).toList()).containsExactlyInAnyOrder("run","logText");
            assertThat(body.path("snapshot").path("run").properties().stream().map(Map.Entry::getKey).toList())
                .containsExactlyInAnyOrder("state","exitCode","createdAt","startedAt","finishedAt","language","runtimeLabel");
            assertThat(body.path("snapshot").path("logText").asText()).isEqualTo("日志\n\"\\🙂");
            assertThat(body.path("createdAt").asText()).endsWith("Z");
            assertThat(java.time.Instant.parse(body.path("expiresAt").asText()))
                .isEqualTo(java.time.Instant.parse(body.path("createdAt").asText()).plusSeconds(72*3600));
            var existing=mvc.perform(get("/api/v1/projects/project/runs/run/share-preview").header("Authorization",jwt)).andReturn().getResponse();
            var existingBody=json.readTree(existing.getContentAsByteArray());
            assertThat(existingBody.path("kind").asText()).isEqualTo("EXISTING");
            assertThat(existingBody.path("snapshot").isNull()).isTrue();assertThat(existingBody.path("snapshotDigest").isNull()).isTrue();
            var retry=mvc.perform(post("/api/v1/projects/project/runs/run/shares").header("Authorization",jwt)
                .contentType("application/json").content(request)).andReturn().getResponse();assertThat(retry.getStatus()).isEqualTo(200);
            jdbc.update("INSERT INTO app_user(id,username,password_hash,created_at) VALUES('other','other','hash',UTC_TIMESTAMP(6))");
            String other="Bearer "+new JwtService("0123456789abcdef0123456789abcdef",java.time.Duration.ofMinutes(15)).issue("other",0).accessToken();
            assertThat(mvc.perform(delete("/api/v1/run-shares/"+id).header("Authorization",other)).andReturn().getResponse().getStatus()).isEqualTo(404);
            var otherList=json.readTree(mvc.perform(get("/api/v1/run-shares").header("Authorization",other)).andReturn().getResponse().getContentAsByteArray());
            assertThat(otherList.path("items")).isEmpty();
            assertThat(mvc.perform(get("/api/v1/run-shares").param("limit","51").header("Authorization",jwt)).andReturn().getResponse().getStatus()).isEqualTo(422);
            assertThat(mvc.perform(delete("/api/v1/run-shares/"+id).header("Authorization",jwt)).andReturn().getResponse().getStatus()).isEqualTo(204);
            var revoked=mvc.perform(get("/api/v1/public/run-shares/"+token)).andReturn().getResponse();
            assertThat(revoked.getStatus()).isEqualTo(410);assertThat(json.readTree(revoked.getContentAsByteArray()).path("code").asText()).isEqualTo("RUN_SHARE_REVOKED");noStore(revoked);
        });
    }

    @Test
    void publicAndPreviewErrorsAreOpaqueAndNeverCacheable() {
        withHttp((jdbc,mvc,json,jwt,service) -> {
            var missing=mvc.perform(get("/api/v1/public/run-shares/missing")).andReturn().getResponse();
            assertThat(missing.getStatus()).isEqualTo(404);noStore(missing);
            for(var item : Map.of("missing",404,"run",409).entrySet()) {
                jdbc.update("UPDATE run SET state='RUNNING' WHERE id='run'");
                var r=mvc.perform(get("/api/v1/projects/project/runs/"+item.getKey()+"/share-preview").header("Authorization",jwt)).andReturn().getResponse();
                assertThat(r.getStatus()).isEqualTo(item.getValue());noStore(r);
            }
            jdbc.update("UPDATE run SET state='SUCCEEDED' WHERE id='run'");
            var share=service.publish("owner","project","run",RunShareLifecycleTest.request(service,"project","run")).share();
            String url="/api/v1/public/run-shares/"+RunShareLifecycleTest.token(share);
            for(String update : java.util.List.of("run_snapshot_json=NULL","run_snapshot_json='{}'","log_text=NULL")) {
                jdbc.update("UPDATE run_share SET "+update+" WHERE id=?",share.id());
                var corrupt=mvc.perform(get(url)).andReturn().getResponse();assertThat(corrupt.getStatus()).isEqualTo(500);noStore(corrupt);
                assertThat(json.readTree(corrupt.getContentAsByteArray()).path("code").asText()).isEqualTo("INTERNAL_ERROR");
            }
            jdbc.update("UPDATE run_share SET expires_at=UTC_TIMESTAMP(6) WHERE id=?",share.id());
            var expired=mvc.perform(get(url)).andReturn().getResponse();assertThat(expired.getStatus()).isEqualTo(410);noStore(expired);
            assertThat(json.readTree(expired.getContentAsByteArray()).path("code").asText()).isEqualTo("RUN_SHARE_EXPIRED");
            jdbc.execute("RENAME TABLE run_share TO run_share_unavailable");
            try { var down=mvc.perform(get(url)).andReturn().getResponse();assertThat(down.getStatus()).isEqualTo(500);noStore(down);
                assertThat(down.getContentAsString()).doesNotContain("SELECT","run_share_unavailable","log_text"); }
            finally { jdbc.execute("RENAME TABLE run_share_unavailable TO run_share"); }
        });
    }

    @Test
    void escapedMultibyteNearFiveMiBLogsRoundTripThroughJdbcAndHttpWithoutTruncation() {
        withHttp((jdbc,mvc,json,jwt,service) -> {
            String unit="\"\\\n日志🙂";
            String text=unit.repeat((5*1024*1024-256)/unit.getBytes(java.nio.charset.StandardCharsets.UTF_8).length);
            jdbc.update("UPDATE run_log_chunk SET text_utf8=?,byte_length=? WHERE run_id='run'",text,text.getBytes(java.nio.charset.StandardCharsets.UTF_8).length);
            var share=service.publish("owner","project","run",RunShareLifecycleTest.request(service,"project","run")).share();
            var response=mvc.perform(get("/api/v1/public/run-shares/"+RunShareLifecycleTest.token(share))).andReturn().getResponse();
            assertThat(response.getStatus()).isEqualTo(200);noStore(response);
            assertThat(json.readTree(response.getContentAsByteArray()).path("snapshot").path("logText").asText()).isEqualTo(text);
        });
    }

    private static void noStore(org.springframework.mock.web.MockHttpServletResponse response) {
        assertThat(response.getHeader("Cache-Control")).contains("no-store");
    }

    @FunctionalInterface interface HttpCheck {
        void run(JdbcTemplate jdbc,MockMvc mvc,ObjectMapper json,String jwt,RunShareService service) throws Exception;
    }
    private void withHttp(HttpCheck check) {
        try(var db=JdbcStoreTestSupport.create()) {
            RunShareTestFixtures.seedFinishedRun(db.jdbc(),"日志\n\"\\🙂");
            RUNNER.withUserConfiguration(RunShareController.class,PublicRunShareController.class,com.manao.poc4.config.RunShareConfig.class)
                .withBean(JdbcTemplate.class,db::jdbc)
                .withBean(com.manao.poc4.run.RunStore.class,() -> new com.manao.poc4.run.JdbcRunStore(db.jdbc()))
                .withBean(com.manao.poc4.log.JdbcLogStore.class,() -> new com.manao.poc4.log.JdbcLogStore(db.jdbc()))
                .run(context -> {
                    MockMvc mvc=MockMvcBuilders.webAppContextSetup((WebApplicationContext)context).addFilters(context.getBean(FilterChainProxy.class)).build();
                    check.run(db.jdbc(),mvc,context.getBean(ObjectMapper.class),"Bearer "+context.getBean(JwtService.class).issue("owner",0).accessToken(),context.getBean(RunShareService.class));
                });
        }
    }

    @RestController
    static class ErrorProbe {
        @GetMapping("/api/v1/share-error/{code}")
        void fail(@PathVariable String code) {
            int status = code.endsWith("NOT_FOUND") ? 404
                : code.endsWith("EXPIRED") || code.endsWith("REVOKED") ? 410 : 409;
            throw new ApiException(code, status, "SECRET untrusted payload");
        }
    }
}
