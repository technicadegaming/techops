# Manual Lookup Registry

## Overview

Scoot Business manual lookup now treats the workbook-backed `manual_lookup_master` data as the curated seed truth for deterministic manual matching. The import workflow preserves **manual PDF**, **alternate manual**, and **source/support page** as separate concepts so dead direct links do not block fallback recovery.

## Catalog import workflow

1. Update `functions/src/data/manualLookupWorkbookSeed.json` from the latest approved workbook rows.
2. Run `npm run manual-catalog:import` from the repo root to normalize workbook rows into `functions/src/data/manualLookupCatalog.json` (`npm run manual-catalog:import --prefix functions` remains equivalent inside scripts/CI).
3. Review the generated catalog diff and keep the change incremental.
4. Run lint + functions tests + rules tests before deploy.

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

The live lookup path now layers a deterministic title-family registry over the workbook catalog so shorthand/operator titles normalize before search and ranking. The preview/import engine returns the same match summary shape for both single-asset preview and bulk intake review rows:
- `inputTitle`
- `canonicalTitle`
- `manufacturer`
- `matchType` (`exact_manual`, `manual_page_with_download`, `title_specific_source`, `support_only`, `family_match_needs_review`, `unresolved`)
- `manualReady`
- `confidence`
- `matchNotes`
- `manualUrl`
- `manualSourceUrl`
- `supportEmail`
- `supportPhone`
- `supportUrl`
- `alternateTitles`
- `variantWarning`
- `reviewRequired`

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
- `manualUrl`: the downstream-safe manual target exposed by the enrichment summary. This only counts as manual-ready when it is either a direct document URL or a verified title-specific HTML page with a real downloadable manual link.
- `manualSourceUrl`: the title-specific product/support page that produced the manual URL.
- `supportUrl`: generic or title-specific support context that helps operators research, but does not satisfy docs-found on its own.

This separation prevents dead catalog PDF seeds from short-circuiting deterministic discovery and keeps source/support context from being promoted to a found manual.

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
6. Deploy hosting only if UI changes are included.

## Risk notes

- Workbook-seeded rows should remain conservative; do not promote low-trust mirrors to exact matches.
- Prefer source-page recovery over adding speculative PDF links.
- Family-level matches must keep lower confidence unless the workbook explicitly maps the family.
