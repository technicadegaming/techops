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
