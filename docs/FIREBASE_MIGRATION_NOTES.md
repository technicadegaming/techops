# Migration Notes: Single-Company -> Company-Scoped

## Safety goals
- Existing data remains accessible.
- Existing admin account remains valid.
- No destructive auto-migration on app load.
- Bootstrap admin elevation is explicit runtime config, not a committed default.

## Rollout order
1. Deploy app code.
2. Deploy updated Firestore rules with temporary legacy read allowance.
3. Sign in as existing admin.
4. Let bootstrap create/adopt first `companies` + `companyMemberships` record if none exists and legacy data is present.
5. Verify existing tasks/assets still show.
6. Start using Admin import/invite/location tools.

## Legacy adoption behavior
- If a signed-in bootstrap admin has no membership and legacy data exists, app creates a bootstrap company and owner membership.
- Scoped reads allow legacy records without `companyId` for the active company during transition.
- New writes include `companyId` automatically.

## Runtime config notes
- Firebase web client config is safe to keep in committed browser config.
- Privilege-affecting values such as `bootstrapAdmins` should be provided explicitly via `window.__APP_CONFIG__` at runtime when needed.

## Backfill recommendation (manual/admin-driven)
- Create an admin-only script or one-time utility to set `companyId` on legacy docs in batches.
- Validate counts before and after backfill.

## Testing checklist
- Existing admin can sign in without account recreation.
- Existing legacy data still appears after bootstrap.
- New user can create company (owner flow).
- Invited user can join using invite code.
- Danger Zone clear/reset only affects active company-scoped records.

## Safe cleanup guidance
- Use “Clear tasks/assets/workers” for test cleanup.
- Use “Reset workspace” to wipe operational data but keep company profile + memberships.
- Do not run hard delete in production until backups are validated.
