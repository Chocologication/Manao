package com.manao.poc2;

import com.manao.poc2.run.KubernetesRunClient;
import com.manao.poc2.run.PodLogStreamer;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.bean.override.mockito.MockitoBean;

@SpringBootTest
class Poc2ApplicationTest {

    @MockitoBean
    private KubernetesRunClient runClient;

    @MockitoBean
    private PodLogStreamer podLogStreamer;

    @Test
    void contextLoads() {
    }
}
