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

Use `README.md` for the contributor start path and `docs/RELEASE_CHECKLIST.md` for the full release gate. Before merging and before deploying, run the baseline checks plus any change-specific suites that apply:

```bash
npm run lint
npm run test --prefix functions
```

Add these when relevant:

```bash
npm run test:app-shell
npm run test:rules
```

- Run `npm run test:app-shell` when a change touches `src/app.js`, `src/app/*`, or the app-shell/controller seams described in `docs/APP_SHELL_REMAINING_SEAMS.md`.
- Run `npm run test:rules` for Firestore rules, Storage rules, tenant-scoping behavior, storage path enforcement, or other security-sensitive access changes.

## Recommended deploy order

Apply deploys in this order to reduce blast radius and avoid temporary policy drift:

1. Firestore rules
2. Storage rules
3. Firestore indexes (if changed)
4. Cloud Functions
5. GitHub Pages/frontend publish only when browser assets or root-site docs changed

### Commands

```bash
firebase deploy --only firestore:rules
firebase deploy --only storage
firebase deploy --only firestore:indexes
firebase deploy --only functions
```

The frontend is currently served from GitHub Pages on `wow.technicade.tech`, confirmed by the root `CNAME` file and the lack of a `hosting` block in `firebase.json`. Do not treat `firebase deploy --only hosting` as the normal frontend release path unless the repo later adds a Firebase Hosting target intentionally.

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
5. GitHub Pages serves the expected frontend version for `wow.technicade.tech` and core app routes load.

## Rollback / recovery guidance

- **Functions rollback:** deploy the last known-good functions revision.
- **Rules rollback:** re-deploy prior `firestore.rules` / `storage.rules` versions from source control.
- **Frontend rollback:** restore or republish the previous known-good GitHub Pages artifact/commit.
- If tenant isolation is at risk, prioritize rules rollback first, then function/frontend recovery.

## CI alignment notes

The repository CI (`.github/workflows/ci.yml`) runs lint, functions tests, and emulator-based rules tests. Keep local and CI commands aligned with `package.json` scripts. CI now also caches Firebase emulator binaries in `~/.cache/firebase/emulators` so `npm run test:rules` is less exposed to repeated download failures on every workflow run.

For local runs, remember that `npm run test:rules` still depends on the Firebase CLI being able to download emulator artifacts at least once per machine/cache. If the CLI hits a 403 or another artifact-fetch failure, resolve that environment/network issue first and then retry the rules suite.
