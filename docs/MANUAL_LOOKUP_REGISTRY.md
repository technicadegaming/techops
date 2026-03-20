# Manual Lookup Registry

## Overview

Scoot Business manual lookup now treats the workbook-backed `manual_lookup_master` data as the curated seed truth for deterministic manual matching. The import workflow preserves **manual PDF**, **alternate manual**, and **source/support page** as separate concepts so dead direct links do not block fallback recovery.

## Catalog import workflow

1. Update `functions/src/data/manualLookupWorkbookSeed.json` from the latest approved workbook rows.
2. Run `npm run manual-catalog:import --prefix functions` to normalize workbook rows into `functions/src/data/manualLookupCatalog.json`.
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

This separation prevents dead catalog PDF seeds from short-circuiting deterministic discovery.

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
