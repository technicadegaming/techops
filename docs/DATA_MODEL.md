# Data model

This document summarizes the current Firestore + Storage model as implemented today. It is intentionally practical rather than exhaustive.

If you are onboarding to the repo, read `README.md` first for the documentation map, then use this doc together with `docs/FRONTEND_STRUCTURE.md` so the current data model and frontend module boundaries stay aligned in your mental model.

## Scope and tenant rules

- The primary tenant boundary is `companyId` on Firestore documents plus `companies/{companyId}/...` in Storage.
- Client reads are additionally filtered by the active company context in `src/companyScope.js`; most app collections are treated as company-scoped in the browser even when rules still allow limited legacy admin access.
- Global admins can still read some legacy non-`companyId` records. When this doc says “company-scoped,” that means “expected in normal current operation.”
- **Confirmed** means the shape/behavior is directly visible in code or rules. **Inferred** means the field appears in UI/workflow usage but is not enforced by a schema.

## Firestore collections

### Legacy compatibility collections (`workspaces`, `workspace_members`)
- **Current status (confirmed):** the app’s committed defaults use `companies` and `companyMemberships`. Direct reads/writes to `workspaces` or `workspace_members` happen only if deployment-time `window.__APP_CONFIG__.collections` remaps canonical keys via runtime aliases in `src/app/runtimeCollections.js`.
- **Compatibility intent:** this keeps older environments bootable while rules/data are being aligned, without hard-deleting old data.
- **Operational guidance:** treat `companies` + `companyMemberships` as canonical for all new writes and troubleshooting. Keep legacy collections read-only for manual validation/backfill windows, then remove runtime alias overrides once migration is complete.

### `users`
- **Purpose:** one profile per Firebase Auth user.
- **Key fields (confirmed):** `id`, `email`, `emailLower`, `fullName`, `displayName`, `memberLabel`, `role`, `enabled`, `onboardingState`, `emailVerified`, `authProviders`, `lastLoginAt`, `securityLoginHistory`.
- **Tenant scoping:** not company-scoped. This is an identity/profile record used before and across company membership.
- **Relationships:** `users/{uid}` is the anchor for Auth, audit attribution, Storage access checks, and company memberships.
- **Rules/roles:** users can read/create their own profile; only admins can delete, and non-admin self-updates cannot freely change role. `enabled` and global `role` are used by rules and Storage checks.

## Related docs

- `docs/ARCHITECTURE.md` for the high-level system and module map.
- `docs/FRONTEND_STRUCTURE.md` for where company-scoped data is read and rendered in the browser app.
- `docs/SECURITY.md` for secrets/storage boundary guidance.
- `docs/FIREBASE_MIGRATION_NOTES.md` for the staged company-scoping rollout and runtime-config notes.

### `companies`
- **Purpose:** the top-level tenant/workspace record.
- **Key fields (confirmed):** `id`, `name`, `createdBy`, onboarding fields (`onboardingCompleted`), contact/HQ fields (`primaryEmail`, `primaryPhone`, `address`, `hqStreet`, `hqCity`, `hqState`, `hqZip`, `hqCountry`, `timeZone`), billing/trial fields, and optional profile fields like `businessType` / `industry`.
- **Tenant scoping:** each company document is itself a tenant root.
- **Relationships:** referenced by `companyMemberships`, `companyInvites`, `companyLocations`, `workers`, and almost every operational collection through `companyId`.
- **Rules/roles:** creator can create and initially manage the company; elevated company roles and global admins can update it.

### `companyMemberships`
- **Purpose:** links a user to a company with a company-local role.
- **Key fields (confirmed):** `id`, `companyId`, `userId`, `role`, `status`, optional `inviteId`, plus audit timestamps.
- **Tenant scoping:** company-scoped by `companyId`.
- **Relationships:** document id is expected to be `${companyId}_${userId}`. The active membership drives client company selection, permissions, and Storage/rules access.
- **Rules/roles:** company-elevated roles manage memberships; invite acceptance can self-create an active membership. Current role vocabulary in rules is `owner`, `admin`, `manager`, `assistant_manager`, `lead`, `staff`.

### `companyInvites`
- **Purpose:** pending/revoked/accepted invite records for company access.
- **Key fields (confirmed):** `id`, `companyId`, `email`, `role`, `inviteCode`, `token`, `status`, `acceptedAt`, `acceptedBy`, `revokedAt`, `revokedBy`, `expiresAt`.
- **Tenant scoping:** company-scoped by `companyId`.
- **Relationships:** accepted invites feed `companyMemberships`; invite codes are used by onboarding/join flows.
- **Rules/roles:** company-elevated roles create/manage invites. Pending invites may be readable by the invited email holder even before membership exists.

### `companyLocations`
- **Purpose:** physical/site-level locations inside a company.
- **Key fields (confirmed):** `id`, `companyId`, `name`, `address`, `timeZone`, `notes`; CSV/export/admin flows also use optional fields like `code`, `type`, `city`, `state`, `postalCode`.
- **Tenant scoping:** company-scoped.
- **Relationships:** referenced by assets/tasks/workers through `locationId` and/or `locationName`. Onboarding auto-creates at least one first location.
- **Rules/roles:** elevated company roles manage them.

### `workers`
- **Purpose:** assignable staff/technician roster for operations work. This is distinct from `users`, which are Auth identities.
- **Key fields (confirmed):** `id`, `companyId`, `displayName`, `email`, `role`, `enabled`, `available`, `accountStatus`, `defaultLocationId`, `locationName`; admin/export flows also use `skills`, `phone`.
- **Tenant scoping:** company-scoped.
- **Relationships:** tasks store `assignedWorkers` as worker identifiers/display values; onboarding creates an owner-linked worker record for the first admin.
- **Rules/roles:** elevated company roles manage workers.

### `assets`
- **Purpose:** equipment/asset registry.
- **Key fields (confirmed):** core identity fields such as `id`, `companyId`, `name`, `manufacturer`, `model`, `serialNumber`, `status`, `category`, `locationId`, `locationName`, `ownerWorkers`, `notes`; documentation/enrichment fields such as `manualLinks`, `manualLibraryRef`, `manualStoragePath`, `approvedManualIds`, `documentationSuggestions`, `supportResourcesSuggestion`, `supportContactsSuggestion`, `enrichmentStatus`, `enrichmentTerminalReason`, `enrichmentRequestedAt`, `enrichmentLastRunAt`, `reviewState`, `manualStatus`, `manualReviewState`, plus additive operator triage fields like `manualLibraryFlagged`, `manualLibraryFlaggedAt`, and `manualLibraryFlagReason`; service history fields such as `history` and `attachmentRefs`.
- **Canonical manual truth model (current):**
  - `manualStatus=manual_attached`: durable storage-backed manual truth (`manualLibraryRef` and/or `manualStoragePath`) is present and asset should read as attached/manual-ready.
  - `manualStatus=queued_for_review`: candidate manual evidence exists but cannot be treated as durable attachment yet.
  - `manualStatus=support_context_only`: only support/source/follow-up context exists; no durable manual is attached.
  - `manualStatus=no_public_manual`: no usable public manual/support evidence is currently available.
  - Legacy values (`attached`, `review_needed`, `support_only`, `no_manual`) are normalized to the canonical values above during repair/enrichment writes.
- **Tenant scoping:** company-scoped.
- **Relationships:** tasks link to assets via `assetId`; manuals and troubleshooting library entries frequently point back to an asset.
- **Rules/roles:** company lead+ can create/update via rules; manager+ is additionally required for some AI/manual tooling in functions.
- **Notes:** many asset subfields are **inferred** from UI and function usage rather than schema enforcement.

### `tasks`
- **Purpose:** active operational work items / service tickets.
- **Key fields (confirmed):** `id`, `companyId`, `assetId`, `assetName`, `locationId`, `locationName`, `title`, `description`/`summary`, `status`, `priority`, `severity`, `reporter`, `assignedWorkers`, `timeline`, due/completion timestamps, evidence attachment metadata, and AI snapshot fields like `currentAiRunId`, `aiStatus`, `aiUpdatedAt`, `aiFrontlineSummary`, `aiNextSteps`, `aiFollowupQuestions`, `aiFixState`, `aiLastCompletedRunSnapshot`.
- **Tenant scoping:** company-scoped.
- **Relationships:** central record for operations, AI troubleshooting, notifications, reports, and evidence uploads.
- **Rules/roles:** company lead+ can create/update/delete. UI allows open tasks without assignment, but in-progress work expects an assignee.

### `operations`
- **Purpose:** legacy/adjacent operations records preserved in the current app data model.
- **Key fields:** **confirmed only at collection level** (rules, list/clear/export usage). The current main task workflow uses `tasks` as the primary operational record.
- **Tenant scoping:** company-scoped.
- **Relationships:** still loaded, exported, and clearable, but not the main day-to-day task object.
- **Ambiguity:** field shape is not strongly documented in current code; treat as a legacy-compatible collection until a later cleanup pass confirms whether it can be narrowed or retired.

### `manualLibrary`
- **Purpose:** canonical shared manual/document registry reused across assets and companies when the same manual has already been acquired.
- **Key fields (confirmed):** `canonicalTitle`, `familyTitle`, `manufacturer`, `normalizedManufacturer`, `variant`, `sourcePageUrl`, `originalDownloadUrl`, `resolvedDownloadUrl`, `storagePath`, `contentType`, `fileSize`, `sha256`, `extension`, `matchType`, `matchConfidence`, `approvalState`, `approved`, `reviewRequired`, `catalogEntryId`, plus additive provenance/classification metadata used by deterministic manual-vs-non-manual gating and review workflows.
- **Integrity guardrails (confirmed):**
  - Non-durable outcomes (`unresolved`, `support_only`, `title_specific_source`, brochure/vendor/store/navigation/generic-support families) are blocked from creating/updating durable manual-library truth.
  - Rows can now be flagged for review with `integrityFlagged`, `quarantined`, `integrityStatus`, `integrityFlags`, and `integrityReviewSummary` without auto-delete behavior.
- **Tenant scoping:** shared library collection rather than company-scoped operational data; assets link into it through `manualLibraryRef` and `manualStoragePath`.
- **Relationships:** `manualLibrary` is the canonical shared manual identity; company/asset approval flows still materialize approved records into `manuals` for tenant-scoped ingestion history and chunk extraction.
- **Current usage:** asset enrichment and manual acquisition reuse approved `manualLibrary` hits before re-downloading manuals, and approved asset attachments persist `manualLibraryRef` / `manualStoragePath` back onto the asset.

### `manuals`
- **Purpose:** approved/manual-ingested documentation records for assets.
- **Key fields (confirmed):** `id`, `companyId`, `assetId`, `assetName`, `manufacturer`, `sourceUrl`, `sourceTitle`, `sourceType`, `manualType`, `cabinetVariant`, `family`, `manualConfidence`, `approvedBy`, `approvedAt`, extraction fields (`extractionStatus`, `extractionRequestedAt`, `extractionStartedAt`, `extractionCompletedAt`, `extractionFailedAt`, `extractionError`, `chunkCount`), file metadata (`storagePath`, `contentType`, `fileName`, `byteSize`, `sha256`).
- **Tenant scoping:** company-scoped.
- **Relationships:** linked from assets through `approvedManualIds`, `manualLinks`, and increasingly `manualLibraryRef` / `manualStoragePath`; each manual can have a `chunks` subcollection used by task AI.
- **Rules/roles:** company lead+ can read/write the collection through rules; functions additionally gate approval actions by company role.

#### `manuals/{manualId}/chunks`
- **Purpose:** extracted text chunks for AI retrieval.
- **Key fields (confirmed):** `id`, `manualId`, `companyId`, `assetId`, `chunkIndex`, `text`, `tokenCountApprox`, `charCount`, `sourceTitle`, `sourceUrl`, `manualType`, `cabinetVariant`, `family`, `manufacturer`, `manualConfidence`.
- **Tenant scoping:** company-scoped.
- **Relationships:** loaded by the task AI orchestrator to build internal documentation context.

### `appSettings`
- **Purpose:** application/company settings, currently centered on AI + notification preferences.
- **Key fields (confirmed):** default AI setting keys such as `aiEnabled`, `aiAutoAttach`, `aiUseInternalKnowledge`, `aiUseWebSearch`, `aiAskFollowups`, `aiModel`, `aiMaxWebSources`, `aiConfidenceThreshold`, `aiAllowManualRerun`, `aiSaveSuccessfulFixesToLibraryDefault`, `aiShortResponseMode`, `aiVerboseManagerMode`, `defaultTaskSeverity`, `taskIntakeRequiredFields`, `aiFeedbackCollectionEnabled`, `mobileConciseModeDefault`, plus `notificationPrefs` in company settings flows.
- **Tenant scoping:** company-scoped in current operation. The app reads `ai_{companyId}` first, then falls back to global `ai` / legacy `global` docs.
- **Relationships:** used by admin screens, task AI, and notification sync.
- **Rules/roles:** elevated company roles manage scoped settings.

### `auditLogs`
- **Purpose:** append-only audit/event log.
- **Key fields (confirmed):** `action`, `actionType`, `category`, `entityType`, `entityId`, `targetType`, `targetId`, `targetLabel`, `summary`, actor/user fields, `companyId`, `metadata`, `timestamp`.
- **Tenant scoping:** usually company-scoped, but rules also permit non-company audit writes for global/self profile actions.
- **Relationships:** written by generic data upserts, invite flows, manual approval, AI runs, and troubleshooting-library saves.
- **Rules/roles:** elevated company roles can read company-scoped audit logs; writes are append-only and updates/deletes are blocked.

### `notifications`
- **Purpose:** per-user in-app notification feed materialized from task/AI/invite state.
- **Key fields (confirmed):** `id`, `companyId`, `userId`, `eventKey`, `type`, `title`, `message`, `route`, `status`, `readAt`, `dismissedAt`, `createdAt`, `updatedAt`.
- **Tenant scoping:** company-scoped.
- **Relationships:** generated client-side from tasks, PM state, invites, AI follow-ups, and asset documentation review signals; user-specific notification preferences live in `appSettings.notificationPrefs`.
- **Rules/roles:** company staff can update their own notification record status, but cannot freely rewrite another user’s notifications.

### `taskAiRuns`
- **Purpose:** durable record of each AI troubleshooting run.
- **Key fields (confirmed):** `id`, `taskId`, `assetId`, `companyId`, `status`, `triggerSource`, `model`, `settingsSnapshot`, `createdAt`, `createdBy`, `startedAt`, `updatedAt`, `followupQuestions`, `internalContextSummary`, `documentationMode`, `documentationSources`, `webContextSummary`, `finalSummary`, `probableCauses`, `immediateChecks`, `diagnosticSteps`, `recommendedFixes`, `toolsNeeded`, `partsPossiblyNeeded`, `safetyNotes`, `confidence`, `citations`, `rawResponseMeta`.
- **Tenant scoping:** company-scoped.
- **Relationships:** one task can have many runs; tasks keep a snapshot of the most recent completed/follow-up-required run.
- **Rules/roles:** company lead+ through rules, with additional callable authorization in functions.

### `taskAiFollowups`
- **Purpose:** stores follow-up questions/answers for AI runs that need more context.
- **Key fields (confirmed):** `id`, `taskId`, `runId`, `companyId`, `questions`, `answers`, `status`, `createdAt`, `createdBy`, `updatedAt`, `updatedBy`.
- **Tenant scoping:** company-scoped.
- **Relationships:** usually `id === runId`; tied to `taskAiRuns` and tasks with `aiStatus = followup_required`.
- **Rules/roles:** same general company-scoped protections as other operational collections.

### `troubleshootingLibrary`
- **Purpose:** reusable successful-fix knowledge base.
- **Key fields (confirmed):** `companyId`, `taskId`, `assetId`, `gameTitle`, `manufacturer`, `assetType`, `issueSummary`, `resolutionSummary`, `searchText`, `savedFromRunId`, `savedBy`, timestamps. Some fields are inferred from save flows and task/asset matching logic.
- **Tenant scoping:** company-scoped, with task AI also supporting legacy global (`companyId == null`) reads.
- **Relationships:** populated from completed AI/task closeout flows; later consulted by task AI as internal knowledge.
- **Rules/roles:** company lead+ in rules; functions require lead+ to save to the library.

### `backups`
- **Purpose:** legacy Firestore backup metadata collection.
- **Current reality:** Firestore rules still define `/backups/{docId}` as admin-only, but the current browser backup/export workflow mainly produces JSON/CSV exports and company-scoped Storage bundles rather than relying on this collection.
- **Tenant scoping:** Firestore `backups` itself is admin-only, not normal company-scoped content.
- **Recommendation:** treat Storage backup paths below as the current primary backup convention.

## Storage conventions

### Company evidence
- **Path (confirmed):** `companies/{companyId}/evidence/...`
- **Current usage:** task evidence uploads are stored under a task-specific prefix such as `companies/{companyId}/evidence/{taskId}/{timestamp-random-filename}`.
- **Access:** company staff can read/write; owner/admin/manager or global admin can delete.

### Company manuals
- **Path (confirmed):** `companies/{companyId}/manuals/{assetId}/{manualId}/source.{ext}`
- **Current usage:** approved manual source files are saved here by the manual-ingestion function; metadata is mirrored in `manuals` Firestore docs and extracted text goes to `manuals/{manualId}/chunks`.
- **Access:** same access pattern as evidence.

### Company backups
- **Path (confirmed):** `companies/{companyId}/backups/...`
- **Current usage:** reserved for company backup artifacts. Storage rules restrict this to owner/admin company roles (or global admin).

### Legacy root paths
- `evidence/...` and `backups/...` still exist in Storage rules as admin-only legacy cleanup/migration paths.

## Practical relationships to keep in mind

- `users` = identity; `workers` = assignable operational roster.
- `companies` + `companyMemberships` determine the active tenant and permission context.
- `tasks` are the main operations record; `operations` still exists but is not the primary task workflow.
- `manualLibrary` is the shared canonical manual registry; `manuals` is still the company/asset-scoped approval + chunk-extraction layer used by task AI today.
- `assets` can accumulate `manualLinks`, `manualLibraryRef`, approved `manuals`, task history, and troubleshooting-library history.
- `taskAiRuns` and `taskAiFollowups` are part of the task lifecycle, not a separate tenant model.
- `appSettings` and `notifications` are company-scoped operational support data, not global app config in the deployment sense.
