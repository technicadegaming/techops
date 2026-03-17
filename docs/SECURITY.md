# Security Notes

## Secrets

- Never commit Firebase local secret files (`functions/.secret.local`).
- Keep local secret material in ignored files only.
- Use Firebase Secret Manager / `functions:secrets:set` for runtime secrets.

## Storage tenancy

Storage rules enforce company path scoping:

- `companies/{companyId}/evidence/**` for operational evidence.
- `companies/{companyId}/backups/**` for backup artifacts.

Legacy root paths (`/evidence/**`, `/backups/**`) are admin-only for controlled migration/cleanup.

## Enrichment permissions policy

Asset enrichment is intentionally restricted to:

- Global: owner/admin/manager+
- Company membership: owner/admin/manager

Lead/staff are blocked from enrichment triggers under this policy.

## Recommended operational checks

- Run function tests on every PR.
- Review rules changes with emulator checks before production deploy.
- Log and monitor `permission-denied` spikes after authorization updates.
