package com.manao.poc4.project;

import static org.assertj.core.api.Assertions.assertThat;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;

class ProjectAuthorizationTest {
    @Test
    void ownerScopedQueriesHideOtherOwnersAndEnforceThreeProjectLimit() {
        FakeStore store = new FakeStore();
        ProjectService service = new ProjectService(store);
        service.create("alice", "one");
        service.create("alice", "two");
        service.create("alice", "three");
        assertThat(service.list("alice")).hasSize(3);
        assertThat(service.list("bob")).isEmpty();
        assertThat(service.create("alice", "four")).isEmpty();
        String id = service.list("alice").get(0).id();
        assertThat(service.get("bob", id)).isEmpty();
        assertThat(service.get("alice", id)).isPresent();
    }

    private static final class FakeStore implements ProjectService.Store {
        private final List<ProjectService.Project> projects = new ArrayList<>();
        public List<ProjectService.Project> listForOwner(String ownerId) { return projects.stream().filter(p -> p.ownerId().equals(ownerId)).toList(); }
        public boolean create(String id, String ownerId, String name) { if (listForOwner(ownerId).size() >= 3) return false; projects.add(new ProjectService.Project(id, ownerId, name, "READY", Instant.now(), null)); return true; }
        public ProjectService.Project findForOwner(String ownerId, String projectId) { return projects.stream().filter(p -> p.ownerId().equals(ownerId) && p.id().equals(projectId)).findFirst().orElse(null); }
    }
}
