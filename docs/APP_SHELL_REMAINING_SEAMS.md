# App shell remaining seams map

This document captures the **current** implementation-aware hotspot audit for `src/app.js` after the controller extraction passes already landed. It is intentionally grounded in the code that exists today rather than in a target architecture.

## Audit scope

This audit reviewed:

- `src/app.js`
- current shell modules under `src/app/`
- directly related feature/render modules that still shape the remaining seams (`src/features/dashboard.js`, `src/features/notifications.js`, `src/onboarding.js`, and the feature action builders used by the shell controllers)

## Executive read: what still remains in `src/app.js`

`src/app.js` is no longer carrying the old feature-heavy callback bodies, but it still owns four real responsibilities:

1. **Top-level shell bootstrap**
   - imports core services, top-level renderers, and controller factories
   - resolves top-level DOM anchors once
   - creates the singleton mutable app state
   - creates the cross-cutting `runAction`, `refreshData`, `setActiveMembership`, and `bootstrapCompanyContext` integration helpers

2. **Top-level render sequencing**
   - renders header/navigation controllers first
   - decides whether onboarding/setup takes over the shell
   - renders dashboard, operations, assets, calendar, reports, account, and admin in the final signed-in order
   - restores operations scroll position and re-applies the active route/tab after rendering

3. **Auth/bootstrap lifecycle handling**
   - binds global browser events (`popstate`, logout click)
   - binds auth/notification UI once during startup
   - hydrates invite code from the URL
   - watches Firebase auth state and switches between signed-out and signed-in shell modes
   - performs the signed-in bootstrap sequence: resolve profile -> sync security snapshot -> bootstrap company context -> refresh app data -> render
   - performs the signed-out reset path: clear active company context, clear core state, reset notifications, and swap auth/app views

4. **Final dependency assembly for feature controllers**
   - instantiates operations/assets/account/admin controllers inside `render()` and passes them the app-level services they need
   - keeps small shared helpers that exist only to support those controller dependency bags (`normalizeAssetId`, `downloadFile`, `downloadJson`, `dedupeUrls`)

That is materially different from the earlier state: `src/app.js` now looks much more like an integration seam than a monolithic feature controller.

## Category-by-category seam map

### 1. Lifecycle/render sequencing that should stay centralized

These responsibilities are appropriate to keep in `src/app.js`:

- `resolveAppElements(document)` and `createInitialState()` at startup.
- The app-owned wrappers around `refreshAppData`, `setActiveMembershipState`, and `bootstrapCompanyContextState`, because they inject `render()` and shell-level notification syncing.
- The top-level `render()` order itself:
  - navigation/header/notifications first
  - onboarding branch next
  - signed-in feature sections after that
  - route/tab re-application last
- The final decision to call `renderOnboarding(...)` versus the signed-in section renderers.
- Browser-global event registration (`popstate`, logout click) and startup bindings.

Why this should stay centralized:

- The shell still needs one place that owns render order across unrelated sections.
- The refresh/bootstrap wrappers are integration points between shell state and already-extracted controllers, not standalone feature logic.
- Splitting lifecycle sequencing further would likely create indirection without reducing coupling meaningfully.

### 2. Auth/bootstrap lifecycle handling

This is the clearest remaining non-render hotspot in `src/app.js`, but most of it is still legitimate shell work.

What remains here today:

- signed-out reset behavior inside `watchAuth`
- signed-in bootstrap messaging and auth/app view toggling
- profile resolution and security snapshot sync
- permission bootstrap before membership/company hydration
- bootstrap error classification via `isPermissionRelatedError()` and `buildBootstrapErrorMessage()`

Assessment:

- **Mostly appropriate to keep centralized.** The auth watcher is the app entrypoint; moving it only to reduce file size would not improve boundaries by itself.
- The only sub-piece with mild extraction potential is the bootstrap reset/error helper layer, but that is small and tightly coupled to DOM state (`authView`, `appView`, `authMessage`) plus app state resets.

Recommendation:

- Keep the auth watcher in `src/app.js` for now.
- If a future pass needs a single additional extraction, extract only a tiny `appSessionLifecycle`/`authBootstrapLifecycle` helper that handles signed-in/signed-out shell transitions. Do **not** split it further unless tests around auth handoff become stronger first.

### 3. Remaining feature-specific glue

Only a small amount of feature-oriented glue still lives in `src/app.js`:

- `normalizeAssetId()`
- `downloadFile()` / `downloadJson()`
- `dedupeUrls()`
- creation of operations/assets/account/admin controllers during the render pass

Assessment by item:

- `normalizeAssetId()` and `dedupeUrls()` are now duplicated conceptually with similar helper logic inside `src/app/assetsController.js`. That duplication is real, but the helper functions in `src/app.js` exist only to feed admin-controller dependencies, so moving them right now would be a cleanup-only refactor.
- `downloadFile()` / `downloadJson()` are simple browser utility glue. They are not a hotspot by themselves.
- Controller instantiation inside `render()` is noisy, but it is final composition work, not hidden feature behavior.

Recommendation:

- Treat these helpers as **low-value extraction candidates** unless another change already touches admin/export plumbing.
- If they move later, prefer a tiny shared browser utility module rather than another controller split.

### 4. Remaining cross-feature coordination

This is the most legitimate ongoing responsibility in `src/app.js`.

Current examples:

- `refreshData()` injects notification syncing into app-level data refresh.
- `setActiveMembership()` injects `refreshData` and `render` into membership switching.
- `bootstrapCompanyContext()` injects `refreshData` and `render` into company bootstrap.
- dashboard focus callbacks still feed into navigation routing via `navigationController.applyShellFocusAndPush(...)` during top-level render.
- notification routing, onboarding, reports, account, admin, and operations all depend on the same central state and render loop.

Assessment:

- This coordination is exactly what a healthy app shell should still do.
- There is still coupling, but it is mostly **intentional integration coupling**, not misplaced feature logic.

Recommendation:

- Keep this coordination in `src/app.js`.
- Future work should prioritize tests/docs around these seams over further mechanical extraction.

### 5. Dead/simple glue that is not worth extracting right now

The following pieces are too small or too coupled to justify a dedicated extraction pass today:

- `isPermissionRelatedError()` and `buildBootstrapErrorMessage()` used only for auth/bootstrap failure presentation
- `applyActionCenterFocus()` local wrapper that delegates to `src/app/actionCenter.js`
- `withActiveCompanyId` / `withRequiredCompanyId` local closures that bind current state into app actions
- one-line startup bindings (`bindAuthUi`, `bindNotificationUi`, `hydrateInviteCodeFromRoute`, logout click, `popstate` listener)

These are all acceptable as local shell glue.

## What should stay in `src/app.js`

The file is now at a healthier boundary if it continues to own:

- app state creation
- shell DOM resolution
- auth watcher registration and signed-in/signed-out shell transitions
- app bootstrap/refresh sequencing
- final render ordering across sections
- final dependency composition for section controllers

That is a reasonable definition of a top-level app shell in this codebase.

## What is still a good extraction candidate

There is only one clearly arguable extraction left, and it is optional:

### Optional next extraction: auth/bootstrap session lifecycle helper

Scope:

- the `watchAuth(...)` callback body
- signed-out reset behavior
- signed-in bootstrap view toggling/error handling
- bootstrap error message helpers

Why this is the only credible next slice:

- it is the last sizable block in `src/app.js` that is not directly about render assembly
- it has a coherent boundary around auth-session transitions
- it could make `src/app.js` read more like `initialize -> register listeners -> render orchestration`

Why it is **not** urgent:

- it is tightly coupled to shell DOM visibility and app state resets
- it does not remove feature complexity the way earlier extractions did
- it risks turning a straightforward top-level bootstrap path into an extra layer of indirection

## What is too coupled or too low-value to extract now

### Keep centralized due to coupling

- `render()` ordering across dashboard/operations/assets/calendar/reports/account/admin
- the refresh/bootstrap wrappers that thread `render()` and notification sync into app state changes
- route/tab re-application after the signed-in render pass

### Low-value utility cleanup only

- `normalizeAssetId()`
- `downloadFile()` / `downloadJson()`
- `dedupeUrls()`

These can wait until a future admin/assets cleanup naturally touches them.

## Recommended priority order for any remaining extractions

1. **If and only if another shell cleanup is still desired:** extract a very small auth/bootstrap lifecycle helper around `watchAuth(...)`.
2. **Otherwise stop extracting `src/app.js`.**
3. Shift follow-up work toward stabilization:
   - targeted tests around auth/bootstrap and route/render sequencing
   - regression coverage for onboarding handoff, membership switching, and notification refresh behavior
   - documentation of app-shell responsibilities and controller boundaries

## Stop-here recommendation

**Recommended decision: stop extracting `src/app.js` for now and shift to stabilization/tests/docs.**

Reasoning:

- The feature-heavy logic has already been moved into dedicated controllers.
- What remains is mostly legitimate app-shell integration work.
- Further extractions would now optimize for file size/shape more than for architectural clarity.
- The next biggest risk is not lack of extraction; it is regression risk across auth/bootstrap, render sequencing, and cross-feature coordination.

## Practical next phase

Instead of another mechanical extraction pass, the best next step is:

- keep `src/app.js` as the top-level integration seam
- add or strengthen tests around the remaining high-coupling flows
- use this document as the boundary reference when future feature changes touch the shell

If a future hotspot emerges again inside `src/app.js`, revisit this map and only extract the auth/bootstrap session lifecycle if it becomes meaningfully harder to maintain than it is today.
