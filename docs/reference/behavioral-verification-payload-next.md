# Behavioral Verification Profile: `payload-next`

This specification defines the `payload-next` behavioral verification profile for production web applications built with Payload CMS and Next.js (App Router).

---

## 1. Scope & Frozen Production Boundary

In this architecture, frozen production is strictly scoped:
- **In Scope (Frozen Production):** Collection schemas, access control functions (`access`), lifecycle hooks (`hooks`), and custom blocks.
- **Explicit Non-Goals (Out of Scope):**
  - Next.js internals and framework plumbing.
  - Payload admin dashboard internals.
  - Visual CSS styling and presentational layout regressions.
  - 8-cell full matrix campaigns on standard marketing PRs.
  - CRAP scoring on React JSX / UI components.
  - Mutating upstream `next` or `payload` npm packages.
  - AI models marking tests as `PASS`.

`bverify` wraps existing, trusted industry tools: Playwright, Stryker, Vitest, and the Payload Local API. It routes verification runs and aggregates proofs; it does not replace or fork the underlying testing frameworks.

---

## 2. Auto-Detection Signatures

A repository is automatically classified under the `payload-next` profile when the root filesystem satisfies:
1. `payload.config.ts` or `payload.config.js` exists.
2. `next.config.*` (`.js`, `.mjs`, or `.ts`) exists.
3. Next.js App Router tree present at `app/` or `src/app/`.

---

## 3. Fast Path Verification Workflow ($\le 60\text{s}$)

The default execution mode on developer workstations and PR branches runs within approximately 60 seconds by bounding blast radius:

1. **Merge-Base Blast Radius:** Determine touched files against target branch base (`git merge-base HEAD origin/main`).
2. **Type Hygiene & Unit Run:** Execute `tsc --noEmit` followed by existing fast unit suites (`vitest run`).
3. **Targeted Stryker Mutation Testing:** Run Stryker **only** on modified files within:
   - `access/` or `src/access/`
   - `hooks/` or `src/hooks/`
   - Collection schema definitions under `collections/` or `src/collections/`
   Mutations outside these directories (e.g. JSX views, static assets) are pruned.
4. **Targeted Playwright Behavioral Rig:** Execute targeted Playwright specs against a seeded Payload Local API inside the official Playwright Linux container (`mcr.microsoft.com/playwright`).
5. **Compact Falsifiable Proof:** Emit a terse proof block ($\le 15$ lines) reporting surviving mutants, failed table assertion rows, and exit status.

---

## 4. Script-Table Acceptance Testing (FitNesse Shape)

Behavioral invariants for content governance, RBAC, and ISR cache revalidation are expressed as FitNesse-shaped fixture tables evaluated deterministically by the runtime rig (no FitNesse runtime required):

### Example 1: Draft vs. Published Read Visibility
| Query Context | Document Status | User Role | Record Returned? | Draft Flag | HTTP Status |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `/api/posts/slug-1` | `draft` | Anonymous | `false` | `null` | 404 |
| `/api/posts/slug-1?draft=true` | `draft` | Anonymous | `false` | `null` | 403 |
| `/api/posts/slug-1?draft=true` | `draft` | Editor | `true` | `true` | 200 |
| `/api/posts/slug-1` | `published` | Anonymous | `true` | `false` | 200 |

### Example 2: Access Control Rule Denying Read / Mutate
| User Role | Document Ownership | Requested Operation | Access Function Result | Error Returned |
| :--- | :--- | :--- | :--- | :--- |
| `guest` | Unowned | `read` | `false` | `UnauthorizedError` |
| `author` | Matching `userId` | `update` | `true` | `null` |
| `author` | Foreign `userId` | `update` | `false` | `ForbiddenError` |
| `admin` | Foreign `userId` | `delete` | `true` | `null` |

### Example 3: ISR Revalidation Stale State Post-Hook
| Action Trigger | Hook Executed | Cache Tag Targeted | ISR Revalidation Event | Page Cache State |
| :--- | :--- | :--- | :--- | :--- |
| Update Post `id=42` | `afterChange` | `posts:42` | `revalidateTag("posts:42")` | `PURGED` |
| Hook Throws Error | `afterChange` | `posts:42` | None | `STALE` |
| No-op Touch `id=42` | `beforeChange` (aborted) | `posts:42` | None | `UNCHANGED` |

---

## 5. Deterministic Rig: Seed & Clock Requirements

To achieve bit-level determinism and eliminate flaky runs:
- **Database Seeding:** Every behavioral run initializes an ephemeral SQLite or Postgres database seeded via Payload Local API before test execution.
- **Clock Pinning:** System clock is pinned to fixed UTC time (e.g. `2026-09-12T12:00:00.000Z`) to ensure scheduled publishing hooks, expirations, and timestamps evaluate deterministically.
- **Hermetic Playwright Linux Rig:** Visual golden diffs and browser assertions are accepted exclusively when executed inside the official Playwright Linux container (`mcr.microsoft.com/playwright`). Host-rendered screenshots vary across OS font rendering engines and are rejected.

---

## 6. Configuration Specification (`.bverify.yaml`)

```yaml
version: "1.0"
profile: payload-next
autodetect:
  payloadConfig: "src/payload.config.ts"
  nextConfig: "next.config.mjs"
  appDir: "src/app"

fastPath:
  maxDurationSeconds: 60
  mutationScope:
    - "src/access/**"
    - "src/collections/**/hooks/**"
    - "src/collections/**/access/**"
  runtime:
    containerImage: "mcr.microsoft.com/playwright:v1.45.0-jammy"
    seedCommand: "pnpm run seed:test"
    clock: "2026-09-12T12:00:00.000Z"

reporting:
  maxProofLines: 15
  format: terse
```
