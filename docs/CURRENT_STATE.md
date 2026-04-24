# Current state snapshot (April 23, 2026)

This file is an implementation-aware recovery snapshot, not a future roadmap. It documents what is currently wired, what has been verified locally, and what remains risky.

## Deployment topology (confirmed)

- Frontend is static and served from repository root (`index.html` + `src/*`) via GitHub Pages.
- Custom domain is tracked via root `CNAME` (`wow.technicade.tech`).
- `firebase.json` contains Functions, Firestore, Storage, and emulator config only (no `hosting` block).
- Firebase backend wiring in committed frontend config points to project `scootbusiness-d3112`.

## Runtime entry points (confirmed)

- Frontend shell entry: `index.html` loading `./src/app.js` as an ES module.
- Browser Firebase bootstrap: `src/firebase.js` using `appConfig.firebase` from `src/config.js`.
- Functions entry: `functions/src/index.js`.
- Rules + indexes: `firestore.rules`, `storage.rules`, `firestore.indexes.json`.

## App boot and auth flow (confirmed)

1. `src/app.js` resolves DOM shell elements from `src/app/boot.js`.
2. Auth form handlers are bound through `src/app/authController.js`.
3. Auth state listener (`watchAuth`) hydrates user/profile context and drives signed-out vs signed-in render.
4. Company bootstrap and active membership selection are routed through `src/app/dataRefresh.js` + `src/companyScope.js`.
5. Section rendering delegates to `src/features/*` renderers, with shell/controller orchestration in `src/app/*`.

## Core callable surface (confirmed)

`functions/src/index.js` exports the current callable/on-document contract:

- `finalizeOnboardingBootstrap`
- `analyzeTaskTroubleshooting`
- `answerTaskFollowup`
- `regenerateTaskTroubleshooting`
- `enrichAssetDocumentation`
- `previewAssetDocumentationLookup`
- `researchAssetTitles`
- `repairAssetDocumentationState`
- `approveAssetManual`
- `backfillApprovedAssetManualLinkage`
- `fetchWebContextForTask`
- `saveTaskFixToTroubleshootingLibrary`
- `onTaskCreatedQueueAi` (Firestore trigger)

## Tenant/data model highlights (confirmed in code + rules)

- Tenant boundary is `companyId` in Firestore and `companies/{companyId}/...` in Storage.
- Core operational collections in active use include: `companies`, `companyMemberships`, `companyInvites`, `companyLocations`, `workers`, `assets`, `tasks`, `manualLibrary`, `manuals`, `taskAiRuns`, `taskAiFollowups`, `troubleshootingLibrary`, `notifications`, `appSettings`, `auditLogs`.
- Manual/AI flow is catalog-first + manual library reuse, with `manuals/{manualId}/chunks` as task AI retrieval context.

## Verified local command status (this environment)

- `npm install` ✅ pass.
- `npm install --prefix functions` ✅ pass (engine warning because runtime here is Node 22 while functions target Node 20).
- `npm run lint` ✅ pass.
- `npm run test --prefix functions` ✅ pass (192 tests).
- `npm run test:app-shell` ✅ pass (26 tests).
- `npm run test:rules` ⚠️ blocked by emulator binary download error (`403 Forbidden` while fetching Firestore emulator artifact), so rules assertions did not execute.

## Known risks / follow-up priorities

1. Rules test reliability depends on Firebase emulator artifact availability; first successful cache warm-up is still a hard external dependency.
2. App shell remains intentionally centralized in `src/app.js`; future changes should keep extracting seam-by-seam into `src/app/*` and `src/features/*` rather than widening shell responsibilities.
3. Manual/AI flows are broad and feature-rich; retain high test coverage discipline for callable contracts and policy gating before changing enrichment behavior.
4. Manual enrichment now persists canonical `manualStatus` (`manual_attached`, `queued_for_review`, `support_context_only`, `no_public_manual`) plus explicit `manualReviewState` and `enrichmentTerminalReason` so attached/review/unresolved semantics are consistent and triageable.
5. Assets view now includes an operator-facing manual review queue that groups unresolved/review-needed cases and exposes candidate evidence/provenance, rejection context, and review actions (rerun, approve/reject candidate, needs-title-clarification, manual-library flagging).
6. `benchmark:manual-research` now uses a gold-set fixture split into `healthy_controls`, `anchor_failures`, and `ambiguous_cases`, and reports bucket-level rates (`healthyControlPassRate`, `anchorFailurePassRate`, `ambiguousTruthfulnessRate`) plus existing retrieval/attachment metrics in JSON and a compact CLI summary. It remains a fixture/stub harness and should not be interpreted as live internet success rate.
7. Manual-library integrity checks now exist and are intentionally conservative: suspicious durable rows are flagged/quarantined for operator review, not auto-deleted or silently rewritten.

## Recovery hardening changes made in this snapshot

- Aligned emulator/rules test project defaults to `scootbusiness-d3112` to match active repo/backend configuration and reduce onboarding confusion.
- Removed `CNAME` from `.gitignore` so custom-domain tracking remains explicit and reviewable in git history.
- Added manual-library integrity guardrails to block non-durable candidate promotion and a report utility (`functions/scripts/reportManualLibraryIntegrity.js`) to detect/optionally flag suspicious rows.
