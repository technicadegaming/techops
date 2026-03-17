# Next Phase Execution Plan

This plan assumes current CI/lint, storage hardening, initial app-shell modularization, and secret rotation are complete.

## Guiding constraints
- Keep current Firebase architecture.
- Avoid framework migration and full rewrites.
- Avoid destructive schema/data changes.
- Ship in small, reviewable increments.
- Keep branding aligned to Scoot Business when low risk.

## Phase A — Frontend modularization
**Objective:** Continue decomposing monolithic frontend logic without changing product behavior.

### Work items
1. Extract additional domain modules from `src/app.js` (task ops, assets, reporting helpers).
2. Standardize module boundaries (boot, state, data, actions, rendering, feature adapters).
3. Add lightweight module-level smoke tests where practical (pure logic only).
4. Rename obvious low-risk legacy WOW labels in user-facing strings to Scoot Business.

### Exit criteria
- App behavior unchanged in core workflows.
- Smaller app-shell entry with clear imports and ownership boundaries.
- Lint/tests pass.

## Phase B — Firestore/Storage security and rules tests
**Objective:** Improve confidence in tenant isolation and role restrictions.

### Work items
1. Add/expand Firestore rules tests for cross-company read/write denial cases.
2. Add/expand Storage rules tests for `companies/{companyId}/evidence/**` and `.../backups/**`.
3. Verify manager/admin/staff role matrix for sensitive actions (including enrichment policy paths).
4. Document emulator test workflow for rules validation.

### Exit criteria
- Rules test coverage includes allow/deny cases for tenancy boundaries.
- No regressions in current permissions model.
- Clear docs for local verification before deploy.

## Phase C — Deployment safeguards and branch/release hygiene
**Objective:** Reduce release risk through guardrails and disciplined release flow.

### Work items
1. Add CI checks that block deploy workflows on failing lint/tests.
2. Add branch/release checklist docs (preflight, staged deploy order, rollback notes).
3. Ensure rules/functions deploy steps are explicit and independently executable.
4. Add non-destructive release notes template for operator-visible changes.

### Exit criteria
- Deployment process is explicit, repeatable, and review-gated.
- Release hygiene docs are concise and followed by default.

## Phase D — Product enhancements (uploads, search, reporting, UX)
**Objective:** Deliver high-value features after modularization/security/release safety are in place.

### Work items
1. Implement actual evidence uploads to Storage (replace plain text evidence references gradually).
2. Add search/filter improvements for operations records.
3. Improve reporting export/readability for multi-location operators.
4. Apply low-risk UX polish (loading states, empty states, clearer status messaging).

### Exit criteria
- Uploads work end-to-end with tenant-safe storage paths.
- Enhancements are behind safe defaults and do not break current workflows.
- Lint/tests pass; docs updated for new operator flows.

## Recommended sequencing
A → B → C → D, with PRs kept small and reversible.
