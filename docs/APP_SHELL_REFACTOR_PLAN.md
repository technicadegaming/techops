# App shell refactor plan

This document captures the next frontend cleanup group for the current app shell. It is intentionally implementation-aware: it describes how `src/app.js` is wired today, what should move later, and what should remain centralized for now.

## Why this plan exists

`src/app.js` is still the main integration seam for the browser app. It is responsible for:

- app bootstrap and auth handoff
- global in-memory state ownership
- route/tab coordination
- company and location context switching
- notification synthesis and action-center wiring
- onboarding/setup wizard orchestration
- cross-feature refresh/render sequencing
- large action dependency assembly for operations, assets, account, and admin

That central role is expected in the current transitional architecture, but it also makes future changes high-risk because multiple concerns are coupled in one file.

This pass does **not** change runtime behavior. It only proposes a decomposition path that can be executed in small, reversible PRs.

## Progress update

- Completed first extraction pass: notification/action-center shell wiring now lives in `src/app/notifications.js`, while `src/app.js` still owns top-level state and refresh/render orchestration.
- Completed second extraction pass: shared action-center focus and route-filter translation now lives in `src/app/actionCenter.js`, with `src/app.js` still acting as the integration seam that wires focus handlers into dashboard, reports, and notifications.
- Completed third extraction pass: company/location header context shell wiring now lives in `src/app/contextSwitcher.js`, while membership/data hydration and route/render orchestration remain in `src/app.js` and `src/app/dataRefresh.js`.
- Completed fourth extraction pass: onboarding/setup callback wiring now lives in `src/app/onboardingController.js`, while `src/app.js` still decides when onboarding/setup renders and still owns top-level lifecycle sequencing.
- Completed fifth extraction pass: route/tab/navigation shell coordination now lives in `src/app/navigationController.js`, while `src/app/router.js` remains the low-level tab/URL helper layer and `src/app.js` still owns final render/lifecycle sequencing.
- Completed sixth extraction pass: operations/task action wiring now lives in `src/app/operationsController.js`, while `src/app.js` still owns top-level render ordering and cross-feature lifecycle sequencing.
- Completed seventh extraction pass: admin action/dependency assembly now lives in `src/app/adminController.js`, while `src/app.js` still owns top-level lifecycle sequencing and final admin render ordering.
- Completed eighth extraction pass: reports shell wiring now lives in `src/app/reportsController.js`, while `src/app.js` still owns top-level render ordering, lifecycle sequencing, and final report-section inclusion in the overall shell render.

## Current hotspot audit

### What still lives in `src/app.js`

`src/app.js` is still doing four different kinds of work at once:

1. **Shell lifecycle / orchestration**
   - creates the singleton app state
   - resolves shell DOM elements
   - bridges auth changes into app bootstrap
   - owns the top-level `render()` and `refreshData()` flow
   - applies route changes and top-level tab switching

2. **Shell UI wiring**
   - active company switcher rendering and membership change behavior
   - active location switcher rendering and route syncing
   - notification bell/panel rendering and click handlers
   - account shell wiring and logout/auth form listeners

3. **Workflow orchestration that spans features**
   - onboarding company creation and invite acceptance handoff
   - setup wizard step submission and readiness dismissal
   - report/dashboard focus -> route/filter mutations
   - task/asset/admin refresh coordination after writes

4. **Feature-heavy glue that is not really shell-specific**
   - task AI status/polling/readback logic
   - task evidence upload/removal
   - task closeout/save/follow-up orchestration
   - action factory dependency assembly for operations/assets/admin
   - asset save/enrichment fallback helpers

### Modules that already exist and should be used more

The app already has support modules that can absorb more shell logic without changing architecture:

- `src/app/boot.js` for DOM/bootstrap helpers
- `src/app/router.js` for low-level tab/router state changes
- `src/app/navigationController.js` for shell-level route/tab/navigation coordination across dashboard, reports, notifications, and tab-opening callbacks
- `src/app/dataRefresh.js` for membership/company/data hydration
- `src/app/state.js` for shared state helpers
- `src/app/actions.js` for common action wrappers
- `src/features/locationContext.js` for company/location scope selection helpers
- `src/features/notifications.js` for notification candidate generation
- `src/features/operationsActions.js`, `src/features/assetActions.js`, and `src/features/adminActions.js` for feature action composition

### Service/domain logic that should stay outside the shell

The following responsibilities are already in the right layer and should **not** be pulled into `src/app/*` during cleanup:

- auth/profile persistence in `src/auth.js`
- Firestore CRUD and company scoping in `src/data.js`
- company/membership/invite workflows in `src/company.js`
- storage path construction in `src/storagePaths.js`
- Firebase callable wrappers in `src/aiAdapter.js`
- permission rules in `src/roles.js`
- tab renderer internals in `src/features/*.js`, `src/admin.js`, and `src/onboarding.js`

## Pain points in `src/app.js` today

### 1. One file mixes shell lifecycle with feature-specific side effects

The same file that handles auth bootstrap also contains task AI polling, evidence uploads, closeout persistence, asset enrichment fallback state, and notification click routing. That makes routine edits risky because the mental model spans unrelated areas.

### 2. `render()` is a high-coupling assembly point

The top-level `render()` function currently:

- renders shell controls
- conditionally renders onboarding/setup
- mutates filters based on dashboard/report focus callbacks
- constructs operations, asset, account, and admin action objects inline
- triggers tab activation and post-render scrolling

That makes `render()` both a view coordinator and a feature controller.

### 3. Dependency injection is useful but still assembled inline

The app already uses factories such as `createAssetActions()` and `createAdminActions()`, but `src/app.js` still constructs very large dependency bags around them. This means the hotspot has shifted from "raw feature logic" to "glue code concentration" rather than disappearing.

### 4. Global shell widgets are still bespoke

Notification center, company switching, and location switching all have shell-level state interactions, but they are still implemented directly in `src/app.js` instead of in focused app-shell modules.

### 5. Transitional seams are implicit rather than named

Some logic truly belongs at the app integration layer, but today it is hard to tell which parts are intentionally central versus simply not extracted yet.

## Decomposition map

The goal is **not** to eliminate `src/app.js`. The goal is to reduce it to a clearer app controller that composes smaller shell modules and feature action builders.

### Keep in `src/app.js` for now

These are still appropriate top-level seams in the current architecture:

- app state creation
- initial DOM bootstrapping via `resolveAppElements()`
- auth watcher registration
- the final orchestration order of `bootstrapCompanyContext() -> refreshData() -> render()`
- the final composition point that chooses whether onboarding or the signed-in tabs render
- cross-feature render ordering between dashboard/operations/assets/calendar/reports/account/admin

Those concerns are central by nature and can remain in `src/app.js` even after smaller extractions.

## Candidate extraction targets

### Priority 1: Notification/app-context wiring

**Current responsibility in `src/app.js`:**

- notification preference application
- candidate materialization into `notifications`
- unread/read/dismiss/open actions
- panel rendering and bell badge updates
- routing from notification action payloads into tab/focus changes

**Suggested destination:**

- new `src/app/notifications.js`
- keep pure candidate generation in `src/features/notifications.js`

**Why this is a good first slice:**

- already has a clear boundary around top-header UI and action-center state
- mostly shell glue around an existing feature helper (`buildNotificationCandidates()`)
- low visual risk if extraction preserves the same DOM contract (`notificationBell`, `notificationBadge`, `notificationPanel`)

**Dependencies / risk notes:**

- depends on `state.route`, `state.adminSection`, `refreshData()`, `render()`, `pushRouteState()`, and `applyActionCenterFocus()`
- writes notifications through `upsertEntity()` and company context helpers
- risk is medium, not low, because notification click behavior fans out into routing and focus changes

**Safe extraction shape:**

- move helper functions first without changing call sites
- then expose `createNotificationController({ state, render, refreshData, pushRouteState, ... })`
- keep final invocation from `src/app.js`

### Priority 2: Onboarding/setup orchestration

**Current responsibility in `src/app.js`:**

- `renderOnboarding()` callback bag
- company creation handoff
- invite acceptance handoff
- setup wizard step persistence
- readiness dismissal
- step-to-step route and feedback transitions

**Suggested destination:**

- new `src/app/onboardingController.js`
- keep rendering in `src/onboarding.js`

**Why this is a strong extraction target:**

- behavior is already grouped in one conditional branch inside `render()`
- mostly orchestration over existing service/domain modules (`company.js`, `data.js`, `features/assetIntake.js`, `workspaceReadiness.js`)
- extracting the callback builder would shrink `render()` substantially without changing the onboarding renderer

**Dependencies / risk notes:**

- touches many write paths: companies, locations, workers, invites, assets, settings
- step 4 asset creation includes CSV/list parsing, review-state defaults, and AI trigger side effects
- risk is medium-high because onboarding is a multi-write workflow and a common bootstrap path

**Safe extraction shape:**

- first extract only `createOnboardingActions({ state, render, refreshData, ... })`
- do **not** change onboarding step order, payload shapes, or persistence rules in the first refactor
- keep `render()` responsible for deciding whether onboarding mode is active

### Priority 3: App-shell route/tab/focus coordination

**Current responsibility in `src/app.js`:**

- top-level `openTab()` wrapper
- location route updates
- report/dashboard focus mapping into filters and admin section changes
- popstate handling
- post-render scroll restore for operations tab

**Suggested destination:**

- extend `src/app/router.js`
- or add `src/app/navigation.js` if `router.js` should stay narrowly focused on query-string/tab DOM behavior

**Why this is a good extraction target:**

- logic is clearly shell-level rather than feature-specific
- multiple features already push focus actions through the same seam
- extracting focus translation would make the remaining `render()` path easier to reason about

**Dependencies / risk notes:**

- depends on mutable `state.operationsUi`, `state.adminSection`, and `state.route`
- currently used by dashboard, reports, notifications, and route popstate
- risk is medium because subtle routing regressions are easy to introduce

**Safe extraction shape:**

- first extract pure or near-pure helpers such as `applyFocusToState(state, focus)` and `syncRouteLocationFilter(...)`
- later group popstate/openTab wrappers into a small navigation controller
- leave final `openTabUi()` call in `src/app.js` until later

### Priority 4: Company/location selection flow

**Current responsibility in `src/app.js`:**

- company switcher rendering and active membership switching
- location switcher rendering and route updates
- scope badge updates

**Suggested destination:**

- new `src/app/contextSwitchers.js`
- continue using `src/app/dataRefresh.js` for membership/company hydration
- continue using `src/features/locationContext.js` for location option derivation

**Why this is a practical slice:**

- both switchers live in the app header and are shell widgets
- extraction would clarify the boundary between state hydration (`dataRefresh.js`) and header control rendering
- mostly glue code, not feature logic

**Dependencies / risk notes:**

- company switching invokes `setActiveMembership()` which can refresh all data and re-render the whole app
- location switching mutates the route, which impacts assets/reports/calendar/dashboard derived views
- risk is medium because these controls affect tenant and scope context

**Safe extraction shape:**

- extract render/bind helpers first, keep callbacks passed from `src/app.js`
- do not move membership persistence or company hydration out of `src/app/dataRefresh.js`

### Priority 5: Operations task AI + evidence coordination

**Current responsibility in `src/app.js`:**

- AI task UI state bookkeeping
- callable result normalization
- task AI run polling and merge-into-state logic
- evidence upload path creation and metadata generation
- evidence upload/removal storage + Firestore orchestration
- task closeout/save-fix/follow-up flows that sit beside operations action assembly

**Suggested destination:**

- new `src/features/operationsController.js` or `src/features/operationsOrchestration.js`
- keep renderer in `src/features/operations.js`
- keep service/domain primitives in `src/aiAdapter.js`, `src/storagePaths.js`, `src/data.js`

**Why this is important but not first:**

- it is a major source of size inside `src/app.js`
- however, it is more behavior-heavy than the shell-widget slices above
- extracting too early risks mixing refactor and logic change

**Dependencies / risk notes:**

- touches Firestore, Storage, audit logging, AI callable retries, and `state.operationsUi`
- strongly coupled to task timeline mutations and follow-up status display
- risk is high; treat this as a later extraction after shell-only slices are separated

**Safe extraction shape:**

- first extract pure helpers (AI status mapping, evidence metadata/path helpers)
- second extract a controller that returns operations callbacks
- only then consider reducing inline operations action composition further

### Priority 6: Admin/report/export orchestration glue

**Current responsibility in `src/app.js`:**

- reports focus callback mutates admin section / route filters
- admin renderer dependency bag includes backup/export helpers and invite actions
- download helpers live in the shell even though they mainly support admin/export flows

**Suggested destination:**

- move generic download helpers into `src/app/downloads.js` or `src/features/adminDownloads.js`
- optionally add `src/app/reportFocus.js` or fold report focus mapping into navigation helpers

**Why this is useful:**

- removes incidental utility code from `src/app.js`
- makes admin/report integration seams explicit without touching `src/admin.js`

**Dependencies / risk notes:**

- `renderAdmin()` still points at the large legacy-style `src/admin.js` renderer
- admin wiring is broad, but much of it is already delegated to `createAdminActions()`
- risk is low-medium if limited to download helpers and report-focus translation; high if it tries to split `src/admin.js` itself

**Safe extraction shape:**

- move only reusable helper utilities first
- do not split `src/admin.js` in the same pass

### Priority 7: Task/asset refresh coordination helpers

**Current responsibility in `src/app.js`:**

- repeated `await refreshData(); render();`
- repeated optimistic local UI mutations before/after async writes
- repeated route syncing after actions complete

**Suggested destination:**

- extend `src/app/actions.js` with shell-safe helpers such as `refreshAndRender()` or `runActionAndRefresh()`

**Why this is a good cleanup enabler:**

- reduces boilerplate across future extraction targets
- can be introduced without changing feature logic

**Dependencies / risk notes:**

- very low architectural risk
- main risk is hiding control flow too aggressively; helpers should stay small and explicit

**Safe extraction shape:**

- add only minimal helpers for common post-write sequences
- do not introduce a generic command bus or new framework-like abstraction

## Suggested sequencing in small PR-sized steps

### Step 1: Planning/doc pass

- add this document
- optionally cross-link it from `docs/FRONTEND_STRUCTURE.md`

### Step 2: Extract shell notification controller

- add `src/app/notifications.js`
- move notification helper functions from `src/app.js` with no behavior change
- keep `render()` and auth lifecycle in `src/app.js`

### Step 3: Extract company/location switcher helpers

- add `src/app/contextSwitchers.js`
- move header switcher rendering/binding only
- continue using `setActiveMembership()` from `src/app/dataRefresh.js`

### Step 4: Extract onboarding callback builder

- add `src/app/onboardingController.js`
- move `renderOnboarding(..., actions)` callback construction out of `render()`
- do not change onboarding renderer or persistence semantics

### Step 5: Extract route/focus translation helpers

- extend `src/app/router.js` or add `src/app/navigation.js`
- centralize dashboard/report/notification focus mapping and route mutation helpers
- keep final top-level tab orchestration in `src/app.js`

### Step 6: Extract operations orchestration helpers

- start with AI/evidence pure helpers
- then move operations callback construction into `src/features/operationsController.js`
- validate task AI, evidence, closeout, and follow-up flows very carefully

### Step 7: Pull incidental admin/export utilities out of the shell

- move download helpers and report/admin glue utilities into small focused modules
- leave `src/admin.js` decomposition for a later cleanup group

## What should explicitly NOT be moved yet

### Do not move core Firebase/data/company services

`src/auth.js`, `src/data.js`, `src/company.js`, `src/storagePaths.js`, and `src/aiAdapter.js` are already domain/service modules. Pulling them into app-shell folders would blur boundaries rather than improve them.

### Do not split `src/admin.js` in the first app-shell refactor pass

`src/admin.js` is large, but it is a separate hotspot. Mixing an admin renderer split with app-shell extraction would create a broad, hard-to-review PR.

### Do not introduce a new global state framework

The current app is a progressively modularized vanilla JS application. This plan assumes the same mutable state model and Firebase architecture remain in place.

### Do not move cross-feature render ordering out of `src/app.js` yet

The signed-in shell still needs one place that decides render order and active tab behavior. That top-level composition is not the immediate problem; the oversized helper and callback bodies are.

### Do not "DRY" everything at once

Many flows repeat `refreshData()` + `render()` intentionally. Small helper extraction is useful, but broad abstraction would increase uncertainty during cleanup.

## First actual refactor pass recommendation

The recommended first implementation pass is:

1. create `src/app/notifications.js`
2. move notification helper functions and DOM wiring there
3. keep exported API narrow, for example a controller factory or a small set of shell notification functions
4. leave `src/features/notifications.js` as the source of candidate generation
5. verify bell badge, mark-read, dismiss, open-navigation, and mark-all behavior without changing UX

This is the best first slice because it removes meaningful mass from `src/app.js` while staying close to existing shell seams.

## Expected end state after several small passes

After the planned cleanup steps, `src/app.js` should still exist, but it should read more like a coordinator:

- initialize state and shell elements
- register auth + browser event listeners
- refresh/bootstrap app context
- delegate shell widget wiring to `src/app/*`
- delegate feature action builders to `src/features/*`
- decide whether onboarding or signed-in views render
- invoke the tab renderers in order

That is a realistic improvement path for the current architecture without forcing a framework rewrite or behavior refactor.
