# Security Notes

Use `README.md` for the contributor start path, `docs/DATA_MODEL.md` before changing tenant-scoped data/storage conventions, and `docs/DEPLOYMENT.md`/`docs/RELEASE_CHECKLIST.md` before release-sensitive work. This file is the concise source of truth for security-focused expectations.

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

- Run `npm run lint` and `npm run test --prefix functions` on every PR.
- Run `npm run test:rules` before merge/deploy whenever you touch Firestore rules, Storage rules, tenant scoping, storage path enforcement, or other security-sensitive access boundaries.
- `npm run test:rules` depends on the Firebase CLI being able to start local Firestore + Storage emulators; if emulator binaries are missing, warm/download them first and then re-run.
- Run `npm run test:app-shell` too when a security-sensitive change also touches shell/controller wiring in `src/app.js` or `src/app/*`.
- Log and monitor `permission-denied` spikes after authorization updates.
