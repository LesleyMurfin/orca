# Spec: Mobile HTML File Taps & Localhost Browser Loop (#25962)

## Current State

- **Upstream status**: `stablyai/orca#25962` is OPEN (reported via Discord bot by a user on public Wi-Fi paired to a home desktop). Only comment is `AmethystLiang`: "Thanks for reporting. Looking into it". Assignee is `Jinwoo-H`.
- **Reproduction status**: **NOT REPRODUCED** on physical device or paired desktop in this environment. Manual verification on paired host/phone remains unverified (`Visual Proof: N/A`).
- **Policy gate**: **DO NOT PUSH UPSTREAM** to `stablyai/orca` without device reproduction, validation of relative assets, and coordination with maintainers.
- **Fork status**: Fix for local HTML half committed (`65b148486d4`) on branch `ai/Discord-Github-Responses` and fork PR opened at `LesleyMurfin/orca#57`. Isolated worktree initialized at `bug-25962-mobile-browser-loop` on branch `ai/bug-25962-mobile-browser-loop`.
- **Upstream collisions identified**:
  1. `stablyai/orca#13234` (author `innocarpe`, open): Routes remote/SSH HTML to preview, but **deliberately preserves** local worktree HTML `openBrowser(file://…)` for relative asset resolution. Direct architectural conflict with our deletion of that path.
  2. `stablyai/orca#25491` (author `nwparker`, active Oct 2026): Edits `mobile-file-tap-open.ts` for headless fallback on `files.open`, keeping `openBrowser`.
  3. `stablyai/orca#6529` / `#6539` (historical): Parent mobile file-tap design explicitly committed to "preserve HTML browser behavior."
  4. Localhost screencast half (`use-mobile-browser-stream.ts`, `MobileBrowserPane.tsx`) actively maintained by `Jinwoo-H` (#22694, #22392).

## Related Issues & Upstream PR Inventory

### Related Issues
1. **stablyai/orca#25962** (Primary bug): Can't see Desktop's localhost or HTML files in mobile tab (infinite spinner). Assignee: Jinwoo-H.
2. **stablyai/orca#13144** (Direct product twin): "Support opening/previewing HTML files on Orca Mobile" by AmethystLiang.
3. **stablyai/orca#6539** (Parent specification): Mobile terminal file preview — explicitly set the design rule that "HTML files should preserve the existing browser preview behavior."
4. **stablyai/orca#21806** (Related localhost gap): Open remote workspace's localhost URL in the user's browser.
5. **stablyai/orca#11492** (Environment cause): Mobile browser screencast freezes/stops when host desktop display sleeps (matches desktop-at-home / phone-on-Wi-Fi scenario).
6. **stablyai/orca#14274** (Stream reliability): Mobile browser pane freezes on last frame after relay/socket reconnect.
7. **stablyai/orca#19585** (Adjacent interaction): Mobile link taps miss in streamed browser view.

### Upstream PRs & Collisions
1. **stablyai/orca#13234** (innocarpe, OPEN): Routes non-local HTML to mobile preview, but deliberately preserves local worktree HTML `openBrowser(file://…)` for relative asset resolution. Direct conflict with deleting that path.
2. **stablyai/orca#25491** (nwparker, ACTIVE Oct 2026): Edits `mobile-file-tap-open.ts` for headless fallback on `files.open`, keeping `openBrowser` across options and tests.
3. **stablyai/orca#23357** (Meapri): Predecessor to #25491 for device fallback when host lacks renderer (superseded by #25491).
4. **stablyai/orca#6529** (MeCKodo): Established the local-HTML-to-browser behavior.
5. **stablyai/orca#25263** (Fanzzzd, DRAFT): Screencast flow-control (`ackWindow`) for mobile browser stream performance on slow Wi-Fi.
6. **stablyai/orca#19549** (lqez): Mobile browser stream tap coordinates.

## Summary

Issue #25962 reports:
1. Static images in new tabs open and render properly on the mobile app.
2. Local HTML files open into an "infinite browser loop" (loading spinner).
3. `localhost` URLs open into the same infinite spinner.

Root cause analysis reveals two completely different mechanisms conflated under one user-visible symptom:
- **Local HTML taps**: In `mobile/src/session/mobile-file-tap-open.ts`, local HTML files were special-cased to call `openBrowser(fileUri)` instead of `files.open`. On remote-paired sessions (e.g. desktop at home, phone on public Wi-Fi), this launches host Chromium and starts a `browser.screencast` stream. If the desktop display sleeps, headless/Xvfb issues occur, or the stream stalls, mobile displays an infinite spinner.
- **Localhost URLs**: These are web URLs opened via terminal or browser bar. They must use the browser screencast stream, but lack error timeouts or paint-retention on idle/stall, leading to the same infinite spinner.

## Files to Touch

### Local HTML Path (Shipped on fork PR #57)
- `mobile/src/session/mobile-file-tap-open.ts` — routes local HTML through `files.open` / `fileTapOpenRun` (same as images/SSH).
- `mobile/src/session/mobile-file-tap-open.test.ts` — verified unit tests for `files.open` dispatch.
- `mobile/src/session/use-mobile-file-tap-handlers.ts` — dead `openBrowser` removed from tap options.
- `mobile/src/session/use-mobile-file-tap-handlers.test.ts` — updated option assertions.
- `mobile/src/session/use-mobile-session-file-actions.ts` — wiring cleanup.
- `mobile/src/session/mobile-native-chat-open-file.test.ts` — test option alignment.
- `mobile/src/test-support/rpc-recording/adapters/file-tap-open-mount-adapters.ts` — mock adapter alignment.

### Localhost / Screencast Follow-Up (Future Scope)
- `mobile/src/browser/use-mobile-browser-stream.ts` — frame ack timeout and error emission when stream produces 0 frames after ready.
- `mobile/src/browser/MobileBrowserPaneView.tsx` — surface distinct error state instead of permanent spinner overlay.

## Step-by-Step Validation & Reproduction Protocol

Before any PR is submitted upstream to `stablyai/orca`, execute the following physical/paired test protocol:

### Step 1: Baseline Repro on `origin/main`
1. Pair Orca Mobile (iOS/Android) with Orca Desktop running on a separate host (simulating remote/home desktop).
2. In a workspace on the desktop, generate `test.html` containing text and styled elements:
   ```html
   <!DOCTYPE html>
   <html>
     <head><link rel="stylesheet" href="./style.css"></head>
     <body><h1>Test Document</h1><p>Sample content</p></body>
   </html>
   ```
3. Tap `test.html` in the file tree or terminal output on mobile.
4. **Observe behavior**: Verify whether mobile enters an infinite loading spinner or opens the host browser screencast.
5. In terminal or chat, tap a `http://localhost:<port>` link with a running local web server.
6. **Observe behavior**: Record frame rates, screencast latency, and whether spinner resolves.

### Step 2: Validation of Fork Fix (`65b148486d4`)
1. Switch mobile pairing to host running branch `ai/bug-25962-mobile-browser-loop`.
2. Tap `test.html` in mobile file tree.
3. **Verify**: Opens immediately as a mobile file preview tab (using `files.open` RPC), matching image behavior.
4. **Crucial check for relative assets**: Does `MobileHtmlPreview` load `./style.css` and local image tags `<img>`?
   - If relative assets fail to render, document the tradeoff: file preview shows raw or isolated DOM without relative bundling. Assess if maintainers prefer that over an infinite spinner.

### Step 3: Upstream Coordination
1. Comment on issue #25962 linking fork PR #57 and detailing our findings to `Jinwoo-H` and `AmethystLiang`.
2. Ping `innocarpe` on PR #13234 regarding the conflict with local HTML `openBrowser(file://)` preservation.
3. Check status of `nwparker`'s PR #25491 to ensure no merge collision on `mobile-file-tap-open.ts`.

## Verification

Runnable automated test commands (from `mobile/` directory):

```bash
cd mobile && pnpm test src/session/mobile-file-tap-open.test.ts src/session/mobile-native-chat-open-file.test.ts src/session/use-mobile-file-tap-handlers.test.ts
```
Expected: 3 files passed, 25 tests passed.

Typecheck:
```bash
cd mobile && pnpm exec tsc -p tsconfig.json --noEmit
```
Expected: Clean exit (0 errors).

Lint & Format:
```bash
cd mobile && pnpm oxlint && pnpm oxfmt --check src/session/
```

## Notes for Next Agent

- **Zero Upstream Submissions**: Do not run `gh pr create --repo stablyai/orca`. The user has explicitly mandated that changes remain on the fork (`LesleyMurfin/orca`) until full device reproduction and validation.
- **Fork PR of Record**: `https://github.com/LesleyMurfin/orca/pull/57`.
- **Do not invent port-forwarding**: The mobile architecture uses host screencast pixels, not device loopback. `localhost` is supposed to run on host Chromium and stream frames.
