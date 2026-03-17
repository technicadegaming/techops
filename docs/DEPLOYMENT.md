# Deployment

## Prerequisites

- Firebase CLI authenticated to the correct project.
- Node.js 20+
- Verified local tests.

## Validate before deploy

```bash
npm run lint
npm run test --prefix functions
```

## Deploy commands

```bash
firebase deploy --only hosting
firebase deploy --only functions
firebase deploy --only firestore:rules,storage
```

Use targeted deploys during incremental rollouts to reduce blast radius.

## Rollback guidance

- Re-deploy last known-good functions artifact.
- Re-deploy prior rules file version if a rule regression is detected.
- Avoid destructive schema changes without migration scripts.
