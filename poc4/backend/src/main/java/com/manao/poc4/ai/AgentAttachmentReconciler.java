package com.manao.poc4.ai;

/** Startup catch-up and bounded periodic batches; logical expiry never waits for this job. */
public final class AgentAttachmentReconciler {
    private static final org.slf4j.Logger LOG=org.slf4j.LoggerFactory.getLogger(AgentAttachmentReconciler.class);
    private final AgentAttachmentService attachments;
    public AgentAttachmentReconciler(AgentAttachmentService attachments){this.attachments=attachments;}
    @org.springframework.context.event.EventListener(org.springframework.boot.context.event.ApplicationReadyEvent.class)
    @org.springframework.scheduling.annotation.Scheduled(fixedDelay=600_000,initialDelay=600_000)
    public synchronized void reconcile(){
        try {
            var result=attachments.reapExpired(100);
            if(result.failed()>0)LOG.warn("attachment cleanup: confirmedDeleted={}, retryableFailures={}",result.deleted(),result.failed());
        }catch(RuntimeException ex){LOG.warn("attachment cleanup unavailable; next cycle will retry");}
    }
}
