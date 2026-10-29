package com.manao.poc4.ai;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import java.time.Duration;
import org.junit.jupiter.api.Test;

class ReconcileWorkBudgetTest {
    @Test void successfulStepReleasesItsSeatBeforeTheNextStepReturns() {
        var budget=new ReconcileWorkBudget("task");
        for(int i=0;i<100;i++) {
            assertThat(budget.io(() -> 1)).isEqualTo(1);
            assertThat(ReconcileWorkBudget.inFlight("task")).isFalse();
        }
    }
    @Test void theWholeTaskBudgetPreventsANewIoEvenWhenEachPriorCallFitsItsOwnLimit() {
        var budget=new ReconcileWorkBudget("task",Duration.ofMillis(120),Duration.ofMillis(100));
        assertThat(budget.io(() -> { java.util.concurrent.locks.LockSupport.parkNanos(Duration.ofMillis(70).toNanos()); return 1; })).isEqualTo(1);
        assertThatThrownBy(() -> budget.io(() -> { java.util.concurrent.locks.LockSupport.parkNanos(Duration.ofMillis(90).toNanos()); ReconcileWorkBudget.check(); return 2; }))
            .isInstanceOf(com.manao.poc4.api.ApiException.class);
        assertThatThrownBy(() -> budget.io(() -> 3)).isInstanceOf(com.manao.poc4.api.ApiException.class);
    }
}
