# Manual Lookup Registry

## Overview

Scoot Business manual lookup now treats the workbook-backed `manual_lookup_master` data as the curated seed truth for deterministic manual matching. The import workflow preserves **manual PDF**, **alternate manual**, and **source/support page** as separate concepts so dead direct links do not block fallback recovery.

Lookup now runs as a two-stage pipeline shared by single-entry preview, Assets bulk research, onboarding intake review, and post-save asset enrichment:

1. **Stage 1: deterministic/manual-first**
   - Normalize title family and manufacturer aliases.
   - Reuse the workbook-backed catalog and existing approved company manuals.
   - Run the current deterministic discovery flow to recover exact manuals or title-specific support/source pages.
2. **Stage 2: manual research fallback**
   - Runs automatically whenever Stage 1 ends as `title_specific_source`, `support_only`, `family_match_needs_review`, or `unresolved`.
   - Uses the OpenAI Responses API with `web_search` enabled, optional `file_search` vector stores, and manufacturer/trusted-domain allowlists.
   - Logs `manualResearch:stage2_*` markers so operators can confirm when fallback started, skipped, returned, or failed validation.
   - Returns structured JSON that keeps manual, source, and support links separate, but backend verification/classification still makes the final manual-ready decision.

Fresh asset CSV intake is intentionally split from this result contract: operator uploads should provide source-of-truth asset identity fields plus optional search hints (`manualHintUrl`, `manualSourceHintUrl`, `supportHintUrl`, aliases/vendor metadata). System-managed enrichment output fields (`manualUrl`, `manualSourceUrl`, `supportUrl`, review/match status fields) remain authoritative only when written by backend enrichment/manual-acquisition persistence. Intake now marks imported rows as `queued` and immediately starts enrichment when available, so hint-only rows do not remain in a fake `searching_docs` state.

CSV direct-manual hints now have a guarded fast path: when `manualHintUrl` looks like a direct manual candidate, enrichment attempts it early, but only promotes it to durable attachment after normal fetch + verification + manual-grade checks succeed. Failed direct-hint attempts remain non-authoritative and are surfaced in terminal reasons (`csv_direct_manual_hint_failed_fetch`, `csv_direct_manual_hint_failed_validation`).

For temporary testing/bootstrap use, Admin import also exposes an explicit admin-only override mode that attempts immediate direct attach from CSV `manualHintUrl` values at intake time. Successful rows are intentionally marked as bootstrap provenance (`sourceType=csv_direct_bootstrap_manual`, `attachmentMode=csv_direct_bootstrap`, `manualProvenance=csv_direct_manual_import`) so they remain distinguishable from normal research/verification outcomes, and this mode intentionally does not queue enrichment fallback from import.

## Catalog import workflow

1. Update `functions/src/data/manualLookupWorkbookSeed.json` from the latest approved workbook rows.
2. Run `npm run manual-catalog:import` from the repo root to normalize workbook rows into `functions/src/data/manualLookupCatalog.json` (`npm run manual-catalog:import --prefix functions` remains equivalent inside scripts/CI).
3. Review the generated catalog diff and keep the change incremental.
4. Generate reference-only hint material from CSV with `npm run manual-catalog:extract-reference -- <path-to-csv> [output-json]`.
5. Optional/admin-only: import trusted CSV rows into Firestore `trustedManualCatalog` with `npm run manual-catalog:import-trusted -- <path-to-csv>`, but runtime short-circuit is disabled by default (`manualResearchEnableTrustedCatalogShortCircuit` must be explicitly set `true` to re-enable).
6. Run lint + functions tests + rules tests before deploy.

The normalized catalog supports:
- `canonicalTitle`
- `titleAliases`
- `manufacturerCanonical`
- `manufacturerAliases`
- `manualPdfUrl`
- `alternateManualUrl`
- `sourcePageUrl`
- `linkType`
- `matchStatus`
- `confidence`
- `notes`
- `lookupMethod`
- `variantHints`
- `familyHints`
- `trustTier`

The live lookup path now layers a deterministic title-family registry over the workbook catalog so shorthand/operator titles normalize before search and ranking. The same manual-first research contract now drives single-asset preview, Assets bulk “Research Titles”, onboarding intake, and admin import review:
- `assetNameOriginal`
- `assetNameNormalized`
- `manufacturer`
- `manufacturerInferred`
- `model`
- `category`
- `matchType` (`exact_manual`, `manual_page_with_download`, `title_specific_source`, `support_only`, `family_match_needs_review`, `unresolved`)
- `manualReady`
- `matchConfidence`
- `matchNotes`
- `manualUrl`
- `manualSourceUrl`
- `supportUrl`
- `supportEmail`
- `supportPhone`
- `variantWarning`
- `reviewRequired`
- `searchEvidence`
- `status` (`docs_found`, `followup_needed`, `no_match_yet`)
- `citations`
- `rawResearchSummary`
- `researchTimestamp`
- `researchSourceType`

The backend callable `researchAssetTitles` is now the authoritative bulk/manual research contract. It returns one validated final row per requested title with the same research summary shape used by preview/bulk intake, and the UI should treat that validated row as source of truth rather than raw Stage 1 crawler output:

```json
{
  "originalTitle": "Quick Drop",
  "normalizedTitle": "Quik Drop",
  "canonicalTitleFamily": "Quik Drop",
  "manufacturer": "Bay Tek Games",
  "manufacturerInferred": true,
  "matchType": "exact_manual",
  "manualReady": true,
  "reviewRequired": false,
  "variantWarning": "",
  "manualUrl": "https://...",
  "manualSourceUrl": "https://...",
  "supportUrl": "https://...",
  "supportEmail": "support@example.com",
  "supportPhone": "(555) 555-5555",
  "confidence": 0.93,
  "matchNotes": "Exact manual found on trusted source.",
  "citations": [{ "url": "https://...", "title": "..." }],
  "rawResearchSummary": "Short machine-readable research summary."
}
```

The result contract now also includes deterministic review queue metadata in `pipelineMeta.manualReviewState` and (after asset persistence) `assets.manualReviewState` + `assets.enrichmentTerminalReason` so unresolved/manual-rejected cases can be triaged explicitly (`queued_for_review`, `brochure_only_evidence`, `dead_seeded_pdf_needs_source_followup`, `hint_hydration_issue`, etc.).

## Canonical persisted manual lifecycle state

Asset persistence now uses a normalized `manualStatus` lifecycle model so attachment/review/unresolved semantics are consistent across fresh enrichment and repair/backfill paths:

- `manual_attached`: durable manual attached (`manualLibraryRef`/`manualStoragePath` evidence exists).
- `queued_for_review`: manual-like evidence exists, but attachment is not yet durable/approved.
- `support_context_only`: only support/source context exists, without durable manual truth.
- `no_public_manual`: no manual or support context currently available.

Operational review routing still uses `manualReviewState` for detailed queue buckets (`needs_title_clarification`, `brochure_only_evidence`, `hint_hydration_issue`, `dead_seeded_pdf_needs_source_followup`, etc.), while `enrichmentTerminalReason` keeps the low-level reason code.

Post-selection failures now use explicit terminal reasons tied to the exact stage that failed after a candidate was selected:
- `selected_manual_fetch_failed`
- `selected_manual_validation_failed`
- `selected_manual_acquisition_failed`
- `selected_manual_storage_write_failed`
- `selected_manual_asset_persist_failed`
- `selected_manual_selected_but_no_durable_fields_written`
- `selected_manual_terminalized_inconsistently`

These reasons are emitted in `pipelineMeta.terminalStateReason` and paired with `pipelineMeta.postSelectionState` / `pipelineTrace.stages.post_selection_state_machine` so triage can distinguish retrieval misses from post-selection durability failures.

## Benchmark harness status

`npm run benchmark:manual-research --prefix functions` now reports both aggregate and per-scenario outputs:
- `recallAt1`, `recallAt5`, `anyUsableCandidateRate`, `autoAttachedRate`
- `brochureFalsePositiveRate`
- `hintHydrationSuccessRate`
- `titlePageExtractionSuccessRate`
- `acquisitionSuccessAfterManualGradeSelectionRate`
- `terminalReasonDistribution`
- scenario-level pass/fail checks against fixture expectations
- gold-set bucket rates: `healthyControlPassRate`, `anchorFailurePassRate`, `ambiguousTruthfulnessRate`
- compact human-readable terminal summary in addition to machine-readable JSON output

This remains a fixture/stub reliability harness (not a live internet crawl benchmark).

## Verification and trust tiers

Verification now stores URL-level metadata in suggestion objects, including:
- HTTP status
- content type
- verification kind (`direct_pdf`, `manual_html`, `support_html`, `other`)
- soft-404 detection
- resolved URL

Trust expectations:
1. **Official direct PDFs**
2. **Official/authorized title-specific manual pages**
3. **Official source pages that can be followed to extract manuals**
4. **Authorized distributors** when the workbook or title evidence is explicit
5. **Generic manual libraries** only when exact-title evidence is unusually strong

## Manual / source / support separation

- `manualPdfUrl`: direct manual file when known-good.
- `alternateManualUrl`: additional valid manual variant.
- `sourcePageUrl`: live product/support/source page for follow-up extraction and operator review.
- `manualUrl`: the downstream-safe manual target exposed by the enrichment summary. It now prefers the shared Firebase Storage manual-library path after successful acquisition/materialization; source/support pages alone do not qualify.
- `manualSourceUrl`: the title-specific product/support page that produced the manual URL before it was materialized into the shared library.
- Shared caching now writes canonical files to `manualLibrary` Firestore documents plus `manual-library/<normalizedManufacturer>/<normalizedTitle>/<sha256>.<ext>` in Firebase Storage, and result rows may include `manualLibraryRef`, `manualStoragePath`, and `manualVariant` metadata.
- `supportUrl`: generic or title-specific support context that helps operators research, but does not satisfy docs-found on its own.
- Raw crawler/search anchors are never promoted directly. Deterministic validation must reject generic header/footer/navigation, services/installations, account/cart/login, search/category, newsletter/blog, and similar junk links before anything can become `manualUrl`.

This separation prevents dead catalog PDF seeds from short-circuiting deterministic discovery and keeps source/support context from being promoted to a found manual. CSV imports are treated as `referenceOnly`/`notTrustedCatalog` hints for normalization, alias expansion, adapter probing, and ranking confidence unless admins explicitly enable trusted short-circuit behavior.

For crawled HTML pages and Stage 2 fallbacks, the backend now rejects chrome/junk candidates before classification, including:
- header/footer/nav/search links
- generic support or category pages without title-specific manual proof
- consultative-services / installations / office-coffee / careers / contact-only paths
- cart / login / account flows
- support/product pages that mention the title but do not provide real manual/download evidence

## Approvable match types

Only the following may become `docs_found` automatically or be approved as manuals:

- `exact_manual`
- `manual_page_with_download`

The following always remain review-required context and must **not** be promoted to approved manuals on their own:

- `title_specific_source`
- `support_only`
- `family_match_needs_review`
- `unresolved`

Manual-library acquisition now enforces the same durability rule at write-time: support-only/source-only/brochure/vendor/store/navigation/generic-support candidates are rejected before any shared `manualLibrary` record is created or overwritten.

## Manual-library integrity scanning / quarantine

- Use `node functions/scripts/reportManualLibraryIntegrity.js` to scan all `manualLibrary` rows and emit suspicious records (non-mutating by default).
- Use `node functions/scripts/reportManualLibraryIntegrity.js --apply` to mark suspicious rows with review metadata (`integrityFlagged`, `quarantined`, `integrityFlags`, `integrityReviewSummary`).
- The integrity scanner is additive and safe-by-default: it does not auto-delete rows and does not silently rewrite canonical/manual attachment fields.

## Internal manual reuse

- Approved manuals already stored for the same company/manufacturer/title family are reused before Stage 2 web research runs.
- Optional Responses API `file_search` vector stores can be configured for company-approved/internal documentation so repeated multi-location title imports reuse approved/internal evidence first.
- Stage 2 fallback results are cached additively in Firestore to reduce repeated lookup cost for the same company/title combination.

## Environment/config surface

The additive AI/manual-research settings surface is:

- `OPENAI_API_KEY` Firebase secret.
  - Stage 2 manual-research uses the same exported secret binding as deployed callable/triggers and falls back to `process.env.OPENAI_API_KEY` only when explicitly present at runtime.
  - OpenAI `401` auth failures are normalized/logged as `openai-auth-invalid` and the pipeline continues with deterministic scraping fallback.
- `manualResearchModel` (falls back to `aiModel`).
- `manualResearchReasoningEffort` (`low` or `medium` recommended).
- `manualResearchWebSearchEnabled` (`true` by default).
- `manualResearchFileSearchEnabled` (`true` by default when vector stores are configured).
- `manualResearchVectorStoreIds` (optional array of Responses API vector store ids).
- `manualResearchMaxWebSources` (default `5`).
- Manufacturer/trusted-domain allowlists derived from the deterministic manufacturer registry and extendable in code.

## Regression-test strategy

Coverage should include workbook-seeded titles such as Quik Drop, Sink It, Fast and Furious, Jurassic Park, Air FX, StepManiaX, and Break The Plate. Regression tests should also prove:
- dead catalog entries do not block fallback discovery
- direct verified PDFs outrank support/manual-library pages
- source-page extraction can recover manuals
- family fallback requires explicit evidence
- previously verified manuals survive weaker refreshes

## Recommended deploy/test order

1. `npm run lint`
2. `npm run test --prefix functions`
3. `npm run test:rules`
4. Deploy rules first if any changed.
5. Deploy functions.
6. Publish GitHub Pages only if UI/static-site changes are included; do not assume Firebase Hosting is active for the frontend.

## Risk notes

- Workbook-seeded rows should remain conservative; do not promote low-trust mirrors to exact matches.
- Prefer source-page recovery over adding speculative PDF links.
- Family-level matches must keep lower confidence unless the workbook explicitly maps the family.
