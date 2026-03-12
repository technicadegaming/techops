# WOW Technicade Operations Portal (Phase 1 Foundation)

This repository now uses a **static frontend + Firebase backend** architecture:
- Static site deployment can remain on GitHub Pages.
- Authentication and shared data are handled by Firebase.
- Browser `localStorage` is no longer the source of truth (only an optional migration source).

## Architecture overview

- `index.html`: app shell and login/app containers.
- `src/config.js`: centralized runtime config object.
- `src/firebase.js`: Firebase initialization.
- `src/auth.js`: login/register/logout + bootstrap-first-admin profile logic.
- `src/data.js`: Firestore data access layer with timestamp metadata and audit hooks.
- `src/roles.js`: role and permission helpers (`isAdmin`, `canDelete`, etc).
- `src/audit.js`: audit logger abstraction.
- `src/admin.js`: admin page (users, roles, backup/restore, import, AI settings scaffold, audit view).
- `src/migration.js`: one-time localStorage import utility.
- `src/backup.js`: export/validate/dry-run/restore backup utility.
- `src/aiAdapter.js`: secure server-integration placeholder for Phase 2 AI calls.
- `src/features/*`: dashboard/operations/assets/calendar/reports feature renderers.
- `firestore.rules`, `storage.rules`: role-aware security rule examples.

## Firebase setup

1. Create a Firebase project.
2. Enable **Authentication → Email/Password**.
3. Create **Cloud Firestore** in production mode.
4. Create **Storage** bucket.
5. Register a Web app and copy config values.
6. Provide config via one of these patterns:
   - Edit `src/config.js` defaults for local testing.
   - Prefer runtime injection in `index.html` before `src/app.js`:

```html
<script>
window.__APP_CONFIG__ = {
  firebase: {
    apiKey: "...",
    authDomain: "...",
    projectId: "...",
    storageBucket: "...",
    messagingSenderId: "...",
    appId: "..."
  },
  bootstrapAdmins: ["you@company.com"]
};
</script>
```

7. Deploy security rules:
   - Firestore rules from `firestore.rules`
   - Storage rules from `storage.rules`

## First admin bootstrap

- Add your email to `bootstrapAdmins` in config.
- Register that account from the login screen.
- On first login, the app auto-creates your `users/{uid}` document.
- If there are no existing users, the first user is promoted to `admin` automatically.

## Role model

Implemented roles:
- `admin`
- `manager`
- `assistant_manager`
- `lead`
- `staff`

Permission helpers exist in `src/roles.js`, including:
- `isAdmin`, `isManager`, `isAssistantManager`, `isLead`, `isStaff`
- `canDelete`, `canManageUsers`, `canManageBackups`, `canEditAssets`, `canEditTasks`, `canCloseTasks`, `canChangeAISettings`

## Data model collections

Firestore collections used:
- `users`
- `assets`
- `tasks`
- `operations`
- `manuals`
- `pmSchedules`
- `notes`
- `auditLogs`
- `appSettings`
- `backups`
- `taskAiRuns` (scaffold)
- `troubleshootingLibrary`

Metadata (`id`, `createdAt`, `createdBy`, `updatedAt`, `updatedBy`) is applied by the data layer.

## Migration from browser localStorage

Admin page includes **Import browser data** controls:
1. Click **Preview browser data**.
2. Click **Import browser data**.
3. Imported records are tagged with `migratedFromLocal: true`.
4. IDs are preserved when present; otherwise generated.

## Backup and restore

Admin page includes:
- JSON export (Firestore-backed snapshot)
- JSON restore validation
- dry-run preview
- restore execution hooks suitable for future R2 upload workflow

## Security notes

- App requires authentication before rendering protected content.
- UI controls are role-gated and security rules enforce backend authorization.
- Audit entries are written for create/update/delete-sensitive actions.
- Admin-only flows: user management, roles, backup/restore, AI settings scaffold, audit visibility.
- Prevents self-demotion if it would leave zero enabled admins.

## AI preparation (Phase 1 only)

Admin settings scaffold includes:
- `aiEnabled`
- `aiAutoAttach`
- `aiUseInternalKnowledge`
- `aiUseWebSearch`
- `aiAskFollowups`

`src/aiAdapter.js` provides a future server hook abstraction.

## Phase 2 (not implemented here)

- Secure backend endpoint for AI task troubleshooting suggestions.
- Task-linked AI run generation + persistence in `taskAiRuns`.
- Prompt orchestration, internal knowledge retrieval, and optional web search pipeline.
