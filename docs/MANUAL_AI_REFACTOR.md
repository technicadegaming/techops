# Manual / AI recovery baseline

## Canonical model

- `manualLibrary` is the canonical shared manual/document record.
- `manuals` remains the company/asset-scoped approval and extraction layer used for approved source files under `companies/{companyId}/manuals/{assetId}/{manualId}/source.*` and for extracted `manuals/{manualId}/chunks` text.
- `assets` should link to shared manual records through `manualLibraryRef` and `manualStoragePath` while preserving `manualLinks` as compatibility/fallback fields.

## Asset intake / documentation flow

1. Single-title lookup is the main primitive.
2. Bulk intake reuses the same lookup contract and row-shaping logic rather than inventing a separate research system.
3. Lookup checks deterministic catalog/shared-library/manual reuse paths first, then falls back to staged research/acquisition.
4. Assets keep the chosen shared manual linkage plus support/source metadata for review.

## Task AI flow

1. Tasks load task + asset context.
2. Task AI prefers approved extracted manual chunks from `manuals/{manualId}/chunks`.
3. If chunks are not ready, task AI should still use the asset-linked `manualLibrary` record as shared-document context.
4. Troubleshooting-library fixes and support/manual links remain fallback context.
5. Normal troubleshooting should not rediscover manuals from scratch.

## Compatibility / legacy paths intentionally preserved

- `manualLinks` is still read as a fallback/manual attachment field.
- `manuals` is still required for company-scoped approval history and chunk extraction.
- Older flows that only know about `manualLinks` or approved `manuals` are not removed in this pass.

## Explicitly deferred

- Preventive-maintenance extraction/calendar automation.
- Destructive migrations removing legacy manual fields.
- Broad app-shell or onboarding rewrites.

## Next safe steps

1. Backfill approved `manualLibrary` links on older assets where they are missing.
2. Improve ingestion coverage so more approved shared manuals also materialize `manuals/{manualId}/chunks` for AI retrieval.
3. Add targeted follow-up tests around asset approval flows that bridge `manualLibrary` into `manuals` extraction records.

## Stabilization note (manual flow simplification)
- `assets.manualStatus` is now the simple asset-facing contract for docs UI: `attached`, `support_only`, `review_needed`, or `no_manual`.
- `manualLibrary` remains the shared canonical record and `manuals/{manualId}/chunks` remains the tenant/task-AI extraction layer, but the asset UI should not require understanding that split just to know whether a manual is attached.
- Support/product links remain secondary evidence and must not be presented as an attached manual.

## Admin repair note (stale enrichment cleanup)
- Use `repairAssetDocumentationState` when an older asset already has a terminal `manualStatus` but still shows stale legacy enrichment-running state such as `queued`, `searching_docs`, or `in_progress`.
- For single-asset recovery, the callable can now be run directly against one `assetId` to safely attach an already-approved exact shared manual when validated, or else finalize the asset as `support_only` / `no_manual` while clearing stale running state.
- Keep broader cleanup passes cautious: validate one asset first, then use `dryRun` + scoped review before any company-wide batch apply.
- Prefer narrow targeting with a single `assetId`; if you need a wider pass, scope it by `companyId` and a small `limit`.
- The single-asset repair only auto-attaches when exact approved evidence is already present; otherwise it terminalizes stale enrichment metadata without guessing a manual attachment.
