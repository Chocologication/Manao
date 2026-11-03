package com.manao.poc4.workspaceagent;

import static org.assertj.core.api.Assertions.*;
import java.nio.charset.StandardCharsets;
import java.security.KeyPairGenerator;
import java.time.Clock;
import java.util.Arrays;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.*;

class WorkspaceAttachmentFilterTest {
    @Test void unknownLengthBodiesStopAtLimitPlusOneForAllSpringRouteSpellings() throws Exception {
        byte[] encoded=KeyPairGenerator.getInstance("Ed25519").generateKeyPair().getPublic().getEncoded();
        var filter=new WorkspaceCapabilityFilter(new WorkspaceCapabilityVerifier("project",Arrays.copyOfRange(encoded,encoded.length-32,encoded.length),Clock.systemUTC()));
        for(String path:new String[]{"/agent/v1/attachments/id","/agent/v1/attachments;x/id","/agent/v1/att%61chments/id"}) {
            var count=new AtomicInteger();
            var request=new MockHttpServletRequest("PUT",path){
                @Override public int getContentLength(){return -1;}
                @Override public long getContentLengthLong(){return -1;}
                @Override public jakarta.servlet.ServletInputStream getInputStream(){return new jakarta.servlet.ServletInputStream(){
                    @Override public int read(){return count.incrementAndGet()<=10_000_100?1:-1;}
                    @Override public boolean isFinished(){return false;}@Override public boolean isReady(){return true;}
                    @Override public void setReadListener(jakarta.servlet.ReadListener listener){}
                };}
            };
            var response=new MockHttpServletResponse();
            filter.doFilter(request,response,(req,res)->{throw new AssertionError("oversize reached controller");});
            assertThat(response.getStatus()).as(path).isEqualTo(413);
            assertThat(count.get()).as(path).isEqualTo(10_000_001);
        }
    }
}
