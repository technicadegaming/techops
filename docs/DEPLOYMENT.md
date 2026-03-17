# Deployment

This guide covers release-safe deploy practices for Scoot Business TechOps.

## Prerequisites

- Firebase CLI authenticated to the correct project.
- Node.js 20+.
- Dependencies installed in both root and functions package.

```bash
npm install
npm install --prefix functions
```

## Pre-deploy validation

Run all checks before merging and before deploying:

```bash
npm run lint
npm run test --prefix functions
npm run test:rules
```

## Recommended deploy order

Apply deploys in this order to reduce blast radius and avoid temporary policy drift:

1. Firestore rules
2. Storage rules
3. Firestore indexes (if changed)
4. Cloud Functions
5. Hosting

### Commands

```bash
firebase deploy --only firestore:rules
firebase deploy --only storage
firebase deploy --only firestore:indexes
firebase deploy --only functions
firebase deploy --only hosting
```

If no index changes are present, skip the indexes step.

## Secret handling expectations

- Do not commit local secret files (for example `functions/.secret.local`).
- Store sensitive values in Firebase-managed secrets/configuration for the target environment.
- Confirm required secrets exist and are current before deploying functions.

## Post-deploy verification (smoke checks)

After deploy, verify:

1. Authentication sign-in works for expected user roles.
2. Firestore reads/writes remain company scoped (`companyId` boundaries).
3. Storage writes are restricted to `companies/{companyId}/...` paths.
4. Cloud Functions respond without auth/regression errors.
5. Hosting serves expected version and core app routes load.

## Rollback / recovery guidance

- **Functions rollback:** deploy the last known-good functions revision.
- **Rules rollback:** re-deploy prior `firestore.rules` / `storage.rules` versions from source control.
- **Hosting rollback:** re-deploy the previous known-good hosting artifact.
- If tenant isolation is at risk, prioritize rules rollback first, then function/hosting recovery.

## CI alignment notes

The repository CI (`.github/workflows/ci.yml`) runs lint, functions tests, and emulator-based rules tests. Keep local and CI commands aligned with `package.json` scripts.
