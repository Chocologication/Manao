package com.manao.poc4.project;

/** Per-owner creation quota shared by the API and both persistence entry points. */
public final class ProjectLimits {
    public static final int MAX_PROJECTS_PER_OWNER = 8;

    private ProjectLimits() { }
}
