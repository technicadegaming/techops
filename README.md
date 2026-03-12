# WOW Technicade Maintenance Portal

This package is a static GitHub Pages build for `wow.technicade.tech`.

## What is included
- `index.html` — the app
- `CNAME` — custom domain file for GitHub Pages

## Quickest deployment path
1. Create a new **public** GitHub repository.
2. Upload `index.html` and `CNAME` to the repository root.
3. In GitHub, open **Settings → Pages**.
4. Under **Build and deployment**, choose **Deploy from a branch**.
5. Select **main** and **/(root)**, then save.
6. In the same Pages screen, confirm the custom domain is `wow.technicade.tech`.
7. In your DNS provider, create a **CNAME** record:
   - **Name/Host:** `wow`
   - **Target/Value:** `YOUR-GITHUB-USERNAME.github.io`
8. Wait for GitHub Pages to publish, then enable **Enforce HTTPS** when it becomes available.

## Updating the site
- Edit `index.html`
- Commit and push to `main`
- GitHub Pages republishes automatically

## Notes
- This version stores notes, issue history, photos, and tasks in the browser using local storage.
- If you want shared multi-user data later, move the data layer to a database-backed host.
