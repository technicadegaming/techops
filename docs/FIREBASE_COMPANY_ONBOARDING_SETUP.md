# Firebase Setup: Company Onboarding + Scoped Workspace

## New Firestore collections
- `companies`
- `companyMemberships`
- `companyInvites`
- `companyLocations`
- `workers`
- `importHistory`

## Added/required fields
- `companyId` on scoped records (`assets`, `tasks`, `operations`, `manuals`, `notes`, `pmSchedules`, `appSettings`, `taskAiRuns`, `taskAiFollowups`, `troubleshootingLibrary`, `workers`, `companyLocations`, `importHistory`, `companyInvites`).
- Invite fields: `inviteCode`, `token`, `status`, `email`, `role`, `createdAt`, `expiresAt`.
- Worker fields: `displayName`, `email`, `role`, `enabled`, `available`, `shiftStart`, `skills`, `phone`, `defaultLocationId`, `accountStatus`, `companyId`.

## Security rules updates (recommended)
1. Keep current role checks for backward compatibility.
2. Add `membership(companyId)` function that validates user has active membership.
3. Restrict scoped collections to matching `request.resource.data.companyId` on write and membership on read.
4. Keep a temporary migration exception to allow owner/admin reading legacy records missing `companyId` until adoption is complete.

## Invite flow notes
- Admin creates invite in `companyInvites`.
- User signs in and enters `inviteCode`.
- App creates `companyMemberships/{companyId_uid}` and marks invite accepted.
- Outbound email is not required yet.

## Indexes likely needed
- `companyMemberships`: `userId,status`
- `companyMemberships`: `companyId,createdAt`
- `companyInvites`: `inviteCode,status`
- scoped collections: `companyId,updatedAt`

## Functions/env vars
- None strictly required for this pass.
- Optional future hard-delete function for company deletion should run with Admin SDK and audit logging.

## Bootstrap repair and finalization
- Browser onboarding may derive completion from live facts (company, active membership, and required locations), but stale bootstrap metadata must be finalized server-side.
- Use the callable `finalizeOnboardingBootstrap` for idempotent repair of `users.onboardingState`, `users.role`, `companies.onboardingCompleted`, `companies.onboardingState`, and stale membership roles when live workspace facts already satisfy onboarding.
- Do not weaken Firestore rules to allow newly-created users to patch these bootstrap fields directly from the browser during auth/bootstrap refresh.
