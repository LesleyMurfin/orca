# Feature Education Direction

## Goal

Orca needs clearer in-product education without turning every educational surface into one onboarding flow. Users should be able to discover the core workflows that make Orca valuable, then continue into deeper capabilities when they are ready.

The new direction separates three jobs:

- First-run onboarding gets the user into a usable workspace.
- The sidebar Getting started with Orca surface tracks adoption of important workflows.
- Contextual tours teach specific surfaces at the moment the user reaches them.

This keeps setup, product practice, and just-in-time education from competing for the same UI.

## Decision

Add a standalone `Getting started with Orca` surface in the top-left navigation area above `Tasks`. It should use the existing onboarding/checklist visual language where useful, but it is not part of the onboarding tour and should not be mounted inside the Explore Orca tour.

The Getting started with Orca row shows core progress only, for example `2/8`. The count should be visible in the sidebar because the user should understand there is remaining high-value work without opening the modal.

The surface should avoid the label "Setup Orca". Some steps are real setup, but others are product workflows like starting multiple agents or creating workspaces. Use `Getting started with Orca` in the sidebar and `Getting started` in the modal.

## Surface Model

Sidebar:

- Place the `Getting started with Orca` button in the small top-left navigation group above `Tasks` and above `Automation`.
- Show only the core completion count as `{done}/{total}`.
- Treat it as a normal navigation affordance into a modal or panel, not as a blocking wizard.

Checklist modal:

- Title: `Getting started`.
- Show Core and Advanced sections.
- Core progress should be prominent in the header.
- Advanced progress can be visible inside the checklist, but should not drive the sidebar badge.
- Completed steps use a green checkmark.
- Incomplete steps use an empty circle.

The visual language should stay close to the existing onboarding checklist patterns and the style guide tokens. Do not invent a separate gamified achievement UI.

## Core Steps

Core steps represent the minimum set of actions that make Orca useful for parallel agent work:

1. Pick a default agent.
2. Configure notifications.
3. Start 2 agents in one worktree.
4. Create 2 worktrees.
5. Enable task sources.
6. Enable advanced agent capabilities.
7. Configure a setup script.
8. Add 2 projects.

The ordering intentionally puts multi-agent and workspace behavior before task sources. The product value should not depend on a GitHub, GitLab, Linear, or other provider connection being configured first.

## Advanced Steps

Advanced steps expose higher-leverage workflows after the core path is underway:

1. Start a browser and send an element to an agent.
2. Add notes and send them to an agent.
3. Add an automation.
4. Try mobile.
5. Configure agent tracking.

Advanced steps should be useful prompts, not requirements. They should not block completion of the core progress count.

## Completion Signals

Prefer real state over manually dismissed tutorial state. A step should complete when Orca can infer the user has actually configured or used the workflow.

Core completion signals:

- Default agent: a non-empty default agent preference exists.
- Add 2 projects: at least two git repositories have been added.
- Notifications: notifications are enabled and agent completion notifications are configured.
- Two agents in one worktree: the user has split the terminal pane, or at least two agent sessions are present in the same worktree.
- Two worktrees: at least two worktrees exist.
- Task sources: at least one supported task source is connected or enabled.
- Agent capabilities: required agent capability setup has been completed or the capability is already installed.
- Setup script: at least one git repository has an effective setup script from local or imported hook settings.

Advanced completion signals:

- Browser element: the user has used browser grab/element handoff behavior.
- Notes: the user has sent notes or review context to an agent.
- Automation: at least one automation exists or has been created.
- Mobile: mobile pairing or mobile usage has been enabled.
- Agent tracking: agent tracking has been explicitly configured.

Local feature interaction state can support completion when the app cannot cheaply infer durable state. It should not replace durable state where durable state exists.

## Relationship To Tours

Onboarding remains first-run guidance. It should get the user through account, project, and workspace creation paths with as little interruption as possible.

Explore Orca remains a product tour and demo surface. It can teach broad capabilities, but it should not own the Checklist and should not be responsible for marking setup-style steps complete.

Contextual tours are just-in-time education for specific surfaces. They should appear when the user reaches a relevant feature, highlight real UI, and suppress themselves when the user has already interacted with that feature.

Feature tips remain lightweight announcements or education prompts. They are not a checklist and should not become a second progress system.

## Non-Goals

- Do not make the Checklist a blocker for using Orca.
- Do not require users to complete advanced steps.
- Do not turn this into a gamified achievement system.
- Do not mirror every checklist state transition into telemetry.
- Do not assume GitHub-only task sources or local-only execution.
- Do not make the setup script step global-only if the relevant state is repository scoped.

## Telemetry And Privacy

Checklist progress should primarily be local product state. Avoid adding telemetry for every progress calculation or every inferred state change.

If telemetry is added later, it should answer a specific product question, use low-cardinality fields, and avoid paths, repository names, task titles, URLs, prompt text, notes, or other user-authored content.

## Open Questions

- Should the Checklist become dismissible or collapse after all core steps are complete?
- Should advanced completion ever appear in the sidebar, or remain visible only inside the modal?
- Should setup script completion be based on any repository with an effective setup script, or only the active repository?
- Should the core list eventually adapt by role or agent provider, or stay universal for all users?
