# WOW Technicade Operations Portal

WOW Technicade is a frontend web app backed by Firebase services for shared, authenticated operations data.

## Architecture (current)

- **Frontend app**: static app (`index.html` + `src/*`) that renders operations, assets, scheduling, reports, admin, and AI actions.
- **Firebase Auth**: handles sign-in and user identity.
- **Cloud Firestore**: system-of-record for shared app data.
- **Cloud Storage**: file storage used by the app.
- **Cloud Functions**: server-side callable/triggered logic, including AI orchestration.

## AI request path

- Frontend calls Firebase callable functions (not direct browser-to-OpenAI).
- AI orchestration is implemented in `functions/src/index.js`.
- OpenAI access is server-side only, using Firebase Functions secret `OPENAI_API_KEY`.

## Key project files

- `functions/src/index.js` - callable + trigger entrypoints (including AI callables).
- `src/firebase.js` - Firebase app/auth/firestore/functions/storage initialization.
- `src/aiAdapter.js` - frontend AI adapter that calls backend functions.
- `firebase.json` - Firebase functions/firestore configuration for this repo.
- `firestore.indexes.json` - tracked Firestore composite/single-field index definitions.

## Notes

- Firestore indexes are source-controlled in `firestore.indexes.json`.
- Legacy browser-data migration utilities exist for one-time import, but browser storage is not the source of truth.
