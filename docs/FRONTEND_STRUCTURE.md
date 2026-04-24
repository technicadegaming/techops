# Frontend structure

This frontend is a framework-less Firebase web app. The structure is partly modularized, but the main app shell still coordinates a large amount of behavior.

For the recommended contributor reading order, start from `README.md`, then pair this document with `docs/DATA_MODEL.md` for tenant/data context and `docs/APP_SHELL_REMAINING_SEAMS.md` for the current “what still belongs in the shell” boundary.

## Current entry flow

1. `index.html` provides the entire static shell: auth forms, the top app header, tab container, section containers, and all global CSS.
2. It loads a single module entrypoint: `src/app.js`.
3. `src/app.js` creates the in-memory app state, resolves core DOM elements, watches Firebase Auth, bootstraps company context, refreshes Firestore data, wires tab/section rendering, and owns many cross-feature actions.
4. Feature renderers fill the pre-existing section containers (`dashboard`, `operations`, `assets`, `calendar`, `reports`, `account`, `admin`).

## What lives where today

### `index.html`
- Static HTML shell for both signed-out and signed-in views.
- Defines the global layout, tabs container, section mount points, and shared CSS.
- Does **not** contain runtime logic beyond loading `src/app.js`.
- If runtime config overrides are needed, `window.__APP_CONFIG__` must exist before this module load.

### `src/app.js`
- The real application orchestrator.
- Owns bootstrapping concerns that have not yet been split into a framework/router/store architecture:
  - auth lifecycle
  - active company and membership switching
  - top-level state instance
  - cross-feature refresh/render sequencing
  - notification materialization
  - top-level composition of operations, assets, calendar, reports, account, and admin render passes
  - final lifecycle sequencing around shared `refreshData()` / `render()` orchestration
  - glue code between generic data helpers and feature modules
- Practical takeaway: this file is still the main shell and integration layer. Contributors should avoid adding new standalone feature logic here unless it truly coordinates multiple domains.

## `src/app/*`: shell/support modules

These modules support `src/app.js` but do not replace it.

- `src/app/boot.js`: resolves shared DOM elements and handles invite-code hydration/persistence for onboarding.
- `src/app/router.js`: low-level tab visibility/building and lightweight route syncing for query-string deep links.
- `src/app/navigationController.js`: shell-level route/tab/navigation coordination, including shared tab opening, route mutation wrappers, focus-to-navigation glue, and popstate sync.
- `src/app/state.js`: initial state shape, shared constants, setup/onboarding UI state helpers, and some pure helpers like asset preview query keys.
- `src/app/renderApp.js`: light shell rendering helpers such as the tab strip and user badge.
- `src/app/dataRefresh.js`: company bootstrap, active membership persistence, company hydration, and bulk Firestore refresh into app state.
- `src/app/contextSwitcher.js`: header context shell wiring for active company/location selectors, scope badge sync, and related header DOM updates.
- `src/app/actions.js`: common action helpers for company-context enforcement and error reporting.
- `src/app/actionCenter.js`: shared action-center focus translation that mutates shell filters/routes for dashboard, reports, and notification-driven navigation.
- `src/app/onboardingController.js`: onboarding/setup shell wiring for workspace creation, invite acceptance, setup-step orchestration, and readiness dismissal.
- `src/app/notifications.js`: notification action-center shell wiring, including panel DOM listeners, badge rendering, and notification-to-route/app-context glue.
- `src/app/operationsController.js`: operations/task shell wiring for callback bag assembly, task AI polling/readback, evidence upload/removal orchestration, closeout/save-fix flows, and operations-to-navigation coordination.
- `src/app/assetsController.js`: assets shell wiring for callback/dependency assembly, asset save/edit/delete orchestration, intake review callbacks, documentation preview/enrichment coordination, and assets-to-navigation glue.
- `src/app/adminController.js`: admin shell wiring for callback/dependency assembly, backup/export action composition, documentation-review action glue, and admin render invocation support.
- `src/app/reportsController.js`: reports shell wiring for render-time navigation/focus callback assembly and report section render invocation support.
- `src/app/accountController.js`: account shell wiring for profile/security callback assembly and account section render invocation support.
- `src/app/authController.js`: signed-out auth shell wiring for login/register/Google/forgot-password form listeners, invite-code handoff syncing, and auth-form message orchestration.

**Important:** these are helper modules around a still-centralized app shell, not a fully separated app core.

## `src/features/*`: tab/domain modules

`src/features/*` is where most newer UI/domain work is being pushed.

Examples:
- `dashboard.js`, `operations.js`, `assets.js`, `calendar.js`, `reports.js`: tab renderers.
- `operationsActions.js`, `assetActions.js`, `adminActions.js`: action factories that let shell controllers pass shared dependencies/state into more focused feature behavior.
- `locationContext.js`, `workspaceReadiness.js`, `notifications.js`, `workflow.js`, `reportingSummary.js`, `documentationSuggestions.js`, `assetIntake.js`: smaller reusable domain helpers.

Manual reliability workflow note: `assets.js` now surfaces backend-provided `manualReviewState` + `enrichmentTerminalReason` so unresolved manual cases are explainable/reviewable instead of only showing generic `reviewState`.
Manual review queue helpers now live in `src/features/manualReviewQueue.js` so queue classification/evidence derivation stays feature-local instead of increasing shell complexity.

**Practical rule:** if you are adding logic for one area of the product, prefer placing pure helpers, rendering, and area-specific actions in `src/features/*` instead of expanding `src/app.js`.

## Core service/domain modules outside `src/app/*`

### `src/config.js`
- Defines committed browser-safe defaults (Firebase client config, collection names, billing defaults).
- Merges runtime overrides from `window.__APP_CONFIG__`.
- This is deployment/runtime config, not user/company settings.

### `src/firebase.js`
- Initializes Firebase app services for the browser (`auth`, `db`, `storage`, `functions`).
- Used by nearly every data/auth/service module.

### `src/auth.js`
- Firebase Auth wrapper plus user-profile synchronization.
- Handles login/register/logout flows, Google sign-in, password reset, email verification, bootstrap admin detection, and security snapshot/profile updates.

### `src/company.js`
- Company and membership workflow helper.
- Handles company creation, first location/owner worker creation, invite generation/acceptance, membership listing, and legacy bootstrap-company adoption.

### `src/data.js`
- Generic Firestore CRUD/query layer used across the app.
- Applies active company scoping on reads/writes, adds audit metadata, and centralizes app settings/audit/profile helpers.
- This is the main low-level data access layer for browser code.

### `src/onboarding.js`
- Renders the onboarding and setup-wizard experiences.
- Focuses on account-to-company handoff, first location creation, initial workers/invites, and first asset setup.

### `src/backup.js`
- Browser-side export/import helpers for CSV/JSON backup workflows.
- Builds company-scoped export bundles and restore payload handling; it does not replace Firebase-managed backups.

### Other notable modules
- `src/companyScope.js`: tracks the active company context used by `src/data.js`.
- `src/storagePaths.js`: central path builders for company evidence/backups/manuals.
- `src/roles.js`: permission context + role predicates used in the UI.
- `src/aiAdapter.js`: browser wrapper around callable functions for task AI and documentation enrichment.
- `src/admin.js`: large admin tab renderer; still a major legacy-style rendering module.

## How company scoping works client-side

Company scoping is implemented in layers:

1. After auth, `src/app/dataRefresh.js` resolves the user’s memberships and picks/stores an active membership.
2. That active membership sets the current company in `src/companyScope.js`.
3. `src/data.js` uses that active company context to:
   - query company-scoped collections with `where('companyId', '==', activeCompanyId)` when possible
   - inject `companyId` into writes for company-scoped collections
   - filter out records from other companies in memory
4. Firestore/Storage rules then enforce the server-side boundary.

This means a contributor usually should **not** hand-roll ad hoc `companyId` filtering in random UI code if the operation already goes through `src/data.js`.

## What is modularized vs. what is still transitional

### Already modularized enough to build on
- Pure helpers and derived summaries.
- Tab-specific renderers.
- Feature-specific action factories.
- Company-scope helpers and storage path helpers.
- Firebase/Auth/data access wrappers.

### Still transitional / should be handled carefully
- `src/app.js` remains the central integration file.
- `src/admin.js` is still large and renderer-heavy.
- Some business logic still spans renderer code, action factories, and `src/app.js` callbacks.
- The app uses shared mutable state rather than a formal state-management layer.

Be honest about the current shape: this is **not** a component framework app with strict boundaries yet. It is a progressively modularized vanilla JS application.

See also: [`docs/APP_SHELL_REFACTOR_PLAN.md`](./APP_SHELL_REFACTOR_PLAN.md) for the current implementation-aware decomposition plan for `src/app.js`.
For the current stabilization-oriented follow-up after those extractions, also see [`docs/APP_SHELL_REMAINING_SEAMS.md`](./APP_SHELL_REMAINING_SEAMS.md).

## Contribution guidance

### Prefer adding code in:
- `src/features/*` for single-domain rendering, helpers, and actions.
- `src/app/*` for shell-level helpers that support multiple tabs or bootstrapping.
- `src/data.js`, `src/company.js`, `src/auth.js`, `src/storagePaths.js`, or `src/companyScope.js` when the change is clearly data/service scoped.

### Avoid piling more complexity into:
- `src/app.js`, unless the logic genuinely coordinates multiple modules or lifecycle phases.
- `index.html`, beyond minimal shell/container changes or globally shared styles.
- `src/admin.js`, if the code can reasonably live in a focused admin helper/action module instead.

### Safe mental model for new contributors
- Treat `index.html` as the static shell.
- Treat `src/app.js` as the current app controller.
- Treat `src/app/*` as controller support modules.
- Treat `src/features/*` as the preferred home for domain-specific frontend work.
- Treat `src/data.js` + `src/companyScope.js` as the client-side tenant boundary helpers.

## Related docs

- `README.md` for the contributor start path and validation commands.
- `docs/DATA_MODEL.md` for the Firestore + Storage model behind the UI.
- `docs/APP_SHELL_REFACTOR_PLAN.md` for the extraction history and decomposition plan.
- `docs/APP_SHELL_REMAINING_SEAMS.md` for the current shell boundary and stabilization recommendation.
- `docs/FIREBASE_MIGRATION_NOTES.md` for runtime-config/bootstrap context that still affects shell startup behavior.
