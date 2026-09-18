package com.manao.poc4.project;

import static org.assertj.core.api.Assertions.assertThat;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;

class ProjectAuthorizationTest {
    @Test
    void ownerScopedQueriesHideOtherOwnersAndEnforceEightProjectLimit() {
        FakeStore store = new FakeStore();
        ProjectService service = new ProjectService(store);
        for (int i = 1; i <= 8; i++) assertThat(service.create("alice", "project-" + i)).isPresent();
        assertThat(service.list("alice")).hasSize(8);
        assertThat(service.list("bob")).isEmpty();
        assertThat(service.create("alice", "ninth")).isEmpty();
        String id = service.list("alice").get(0).id();
        assertThat(service.get("bob", id)).isEmpty();
        assertThat(service.get("alice", id)).isPresent();
    }

    @Test
    void publicViewDoesNotExposeArbitraryFailureReason() {
        ProjectController controller = new ProjectController(new ProjectService(new FakeStore()));
        var view = controller.getViewForTest(new ProjectService.Project("id", "alice", "demo", "FAILED", Instant.parse("2026-01-01T00:00:00Z"), "path=/workspace/secret"));
        assertThat(view.failureReason()).isNull();
    }

    private static final class FakeStore implements ProjectService.Store {
        private final List<ProjectService.Project> projects = new ArrayList<>();
        public List<ProjectService.Project> listForOwner(String ownerId) { return projects.stream().filter(p -> p.ownerId().equals(ownerId)).toList(); }
        public boolean create(String id, String ownerId, String name) { if (listForOwner(ownerId).size() >= ProjectLimits.MAX_PROJECTS_PER_OWNER) return false; projects.add(new ProjectService.Project(id, ownerId, name, "READY", Instant.now(), null)); return true; }
        public ProjectService.Project findForOwner(String ownerId, String projectId) { return projects.stream().filter(p -> p.ownerId().equals(ownerId) && p.id().equals(projectId)).findFirst().orElse(null); }
    }
}
