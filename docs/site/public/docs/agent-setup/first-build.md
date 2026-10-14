# From Zero to First Build in Orca: A 10-Prompt Guided Script

When a new builder opens Orca, they should never have to wonder *"What do I even type first?"*

If you are non-technical (or introducing non-technical builders to Orca), you do not need to memorize Git commands, manage terminal multiplexers, or write complex configs. Let the agent do the heavy lifting through this guided 10-prompt ladder.

---

## Phase 1: Zero-Jargon Setup & Sanity Checks

Do not guess settings. Have the agent interview you and audit your environment:

1. **Intake & Orientation:**
   > *"I am brand new to Orca and non-technical. Reference https://www.onorca.dev/docs. Ask me 3 questions: (1) what OS I'm on, (2) what idea or app I want to build, and (3) my comfort level with tech. Explain which Orca features will help me most, then set up my workspace."*

2. **Environment & App Diagnostic:**
   > *"Verify my Orca installation and settings are configured correctly. In plain English: do I have all required tools installed on my machine, or do you need to help me install anything?"*

3. **Project Scaffolding:**
   > *"Create the initial project files from scratch for my idea."*

---

## Phase 2: First Working Feature

Focus on immediate visual feedback, not abstract architecture:

4. **Scope the Smallest Win:**
   > *"What is the simplest first piece of this project we can build right now so I can see it working?"*

5. **Build & Verify:**
   > *"Build that feature step-by-step and verify it runs."*

6. **Plain-English Walkthrough:**
   > *"In 2 plain sentences, explain what you built and how I can preview it on my screen."*

---

## Phase 3: Safety Nets & Scaling Up

Teach users Orca's superpowers early — especially worktrees and parallel execution:

7. **Save Points (No Git Knowledge Needed):**
   > *"How do we make save points so I can easily undo changes if something breaks?"*

8. **Automate the Boring Stuff:**
   > *"What repetitive tasks can you automate for me on this project?"*

9. **Parallel Worktrees:**
   > *"Show me how to run 2 tasks in parallel using Orca worktrees or subagents."*

10. **Habit Review:**
    > *"Summarize what we built today and give me 3 tips on how to prompt you best."*

---

## Two Universal Steering Commands

Keep these pinned in your head:
- **To keep momentum:** *"Looks good! What should we build next?"*
- **If an agent breaks code:** *"That broke. Undo the last change and explain what happened."*

---

## Reference Walkthrough
- Video Tour: [Christian Lempa - My NEW AI Terminal and Code Editor // Orca Review](https://www.youtube.com/watch?v=tzDDNWU21uQ)
- Documentation: https://www.onorca.dev/docs/first-session
