package com.manao.poc4.ai;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import com.manao.poc4.api.ApiException;
import com.sun.net.httpserver.HttpServer;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import org.junit.jupiter.api.Test;

class HttpPiWorkerClientTest {
    @Test void decodesTheAuthenticatedFullStatusIncludingFrozenReport() throws Exception {
        HttpServer server=HttpServer.create(new InetSocketAddress("127.0.0.1",0),0);
        server.createContext("/",exchange -> {
            assertThat(exchange.getRequestHeaders().getFirst("X-Manao-Worker-Token")).isEqualTo("test-token");
            String json=exchange.getRequestURI().getPath().equals("/status")
                ? "{\"bootId\":\"boot\",\"instanceId\":\"worker-boot\",\"activeTaskId\":null,\"activeExecutionState\":null,\"activeKind\":null,\"modelConfigured\":true}"
                : "{\"taskId\":\"task\",\"instanceId\":\"worker-boot\",\"state\":\"COMPLETED\",\"protocolVersion\":1,\"workerEpoch\":7,\"requestSha256\":\"request\",\"executionState\":\"COMPLETED\",\"terminalDelivery\":{\"state\":\"PENDING\",\"reportId\":\"id\",\"reportSha256\":\"hash\",\"report\":{\"protocolVersion\":1,\"reportId\":\"id\",\"state\":\"COMPLETED\",\"summary\":\"完成\",\"failureCode\":null}}}";
            byte[] bytes=json.getBytes(StandardCharsets.UTF_8); exchange.sendResponseHeaders(200,bytes.length);
            exchange.getResponseBody().write(bytes);exchange.close();
        });server.start();
        try {
            var client=new HttpPiWorkerClient("http://127.0.0.1:"+server.getAddress().getPort(),"test-token",Duration.ofSeconds(2));
            assertThat(client.processStatus().bootId()).isEqualTo("boot");
            var status=client.status("task");
            assertThat(status.workerEpoch()).isEqualTo(7);
            assertThat(status.terminalDelivery().report().summary()).isEqualTo("完成");
        } finally {server.stop(0);}
    }
    @Test void preservesNotFoundAsDistinctFromAuthenticationAndMalformedJson() throws Exception {
        for (int status : new int[] {404,401,403,200}) {
            HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1",0),0);
            server.createContext("/tasks/task", exchange -> {
                assertThat(exchange.getRequestHeaders().getFirst("X-Manao-Worker-Token")).isEqualTo("test-token");
                byte[] bytes = "not-json".getBytes(StandardCharsets.UTF_8);
                exchange.sendResponseHeaders(status,bytes.length); exchange.getResponseBody().write(bytes); exchange.close();
            });
            server.start();
            try {
                var client = new HttpPiWorkerClient("http://127.0.0.1:"+server.getAddress().getPort(),"test-token",Duration.ofSeconds(2));
                String code = status==404 ? "AI_WORKER_NOT_FOUND" : status==200 ? "AI_WORKER_BAD_RESPONSE" : "AI_WORKER_UNAUTHORIZED";
                assertThatThrownBy(() -> client.status("task")).isInstanceOfSatisfying(ApiException.class, ex -> assertThat(ex.code()).isEqualTo(code));
            } finally { server.stop(0); }
        }
    }
}
