# Manao Project Goal

## Product Vision

Manao is intended to be an AI cloud development laboratory that turns the fragmented workflow of learning code, configuring an environment, running programs, reading errors, and improving an implementation into one browser-based, executable, observable, and traceable loop.

The long-term product should let a user:

1. Sign in and create a project from a standard environment template.
2. Edit and manage source code in a browser-based development workspace.
3. Run code in an isolated, containerized environment managed by Kubernetes.
4. Inspect logs, results, resource information, and execution history.
5. Use AI to explain code, analyze failures, generate suggestions, and guide further improvements.

The intended audience includes programming beginners, teachers and teaching assistants, competition teams, and platform administrators. The broader product direction therefore includes development, execution, analysis, administration, and demonstration capabilities rather than a simple AI chat page or a static online editor.

## Current Implementation Target: POC4

The current engineering effort intentionally narrows the product vision to a verifiable real-system slice named POC4. Its purpose is to prove the core cloud development loop before the wider product is attempted.

POC4 targets the following real workflow:

1. A fixed test user signs in and creates a private Java 17 Maven project.
2. The backend provisions a project workspace backed by a 10 GiB `ReadWriteMany` PVC.
3. The browser reads and edits project files through the backend and workspace agent; it never accesses the PVC or Kubernetes API directly.
4. The user explicitly saves changes and starts the policy-constrained `mvn clean test` Job.
5. The browser receives persisted and live container logs, and can open an interactive Shell in the active Maven Job container.
6. MySQL remains authoritative for users, projects, runs, log windows, terminal sessions, and audit records, while Kubernetes remains authoritative for Job and Pod execution facts.

This slice is deliberately designed to validate ownership checks, relative-path safety, file revisions, Run lifecycle rules, log replay/live behavior, terminal ticket and PTY behavior, command auditing, and recovery semantics against a real backend and Kubernetes cluster.

## Explicit POC4 Non-Goals

The following are outside the current POC4 acceptance scope:

- AI context retrieval, AI-generated patches, patch confirmation, and AI write workflows.
- Multi-language execution; Java/Maven is the first implementation target.
- Git integration, uploads, drag-and-drop, batch operations, project deletion, and collaborative editing.
- Team management, teaching workflows, and the platform administration console.
- Production-grade network isolation, egress allowlists, malicious-code sandboxing, billing, high availability, archival, and recoverable deletion.

These items remain part of the broader Manao direction or future standalone reviews; their absence from POC4 is a scope decision, not a claim that they are complete.

Stage 6 operational exception (2026-09-10): an owner-scoped project DELETE endpoint was added to reclaim E2E-created database and Kubernetes resources. This is test-environment lifecycle support, not delivery of a product deletion UI, archival, recoverable deletion or production storage lifecycle. Failure/concurrency cleanup is still being completed.

The next milestone remains a fully accepted Stage 6A development loop followed by Stage 6B, not immediate expansion into AI or multi-language features. See [current status and next work](what-we-have-done.md#next-work).

## Relationship to the Product Plan

POC4 is a validation milestone, not the finished Manao product. A successful POC4 would establish that the browser-to-backend-to-Kubernetes development loop is technically credible. It would not by itself prove production security, multi-language support, AI integration, multi-replica high availability, or the complete PRD feature set.

For the original product requirements, see [Manao PRD v4.0](Manao_PRD_V4-0.md). For the narrower POC4 acceptance scope, see the [POC4 design and implementation plan](../.worktree/ensoai-stage-6-real-backend-kubernetes/poc4/docs/plan.md) when working from the Stage 6 implementation worktree.
