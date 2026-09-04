# Ejari DLD Connection App

## Purpose

This Electron app is the desktop companion for keeping the authenticated MyDLD state on the
trusted local device and running DLD automation work locally.

## What It Does

1. receives a short-lived `taxrocket-connect://` launch request from the web app
2. can also accept a localhost handoff from the web app at `http://127.0.0.1:37219/connect`
3. registers itself as a trusted desktop device with the web app
4. opens the official MyDLD login in a controlled per-user desktop partition
5. lets the user complete official login manually
6. marks the trusted device as locally ready after successful login
7. polls local-agent jobs from the web app
8. downloads only the signed documents needed for the active job
9. runs the DLD flow locally inside the same trusted partition
10. uploads only job results and status back to the web app

## Current Status

This scaffold is implemented in the repo, but it still depends on:

- installing Electron locally
- packaging the app for distribution
- real DLD validation selectors configured in the main app env
- real DLD deterministic selectors configured in the main app env for local execution
- a successful desktop protocol registration is helpful, but the localhost bridge now exists as a more reliable fallback for already-running desktop sessions

## Local Dev

From the repo root:

```bash
npm --prefix electron-connect install
npm --prefix electron-connect run dev
```

Then in the web app, go to `/dld-connect` and use `Connect with Desktop App`.

## Windows Packaging

To build Windows artifacts:

```bash
npm --prefix electron-connect run dist:win
```

To build both the NSIS installer and the portable executable together:

```bash
npm --prefix electron-connect run release:win
```

This is configured to produce:

- NSIS installer
- portable Windows executable

Output directory:

- `electron-connect/dist`

From the repo root, upload the newest Windows installer to your configured Google Cloud Storage
installer path with:

```bash
npm run desktop-installer:upload
```

## Recommended Production Distribution

Recommended deployment split:

- main app on Hostinger
- desktop installer stored in Google Cloud Storage
- web app download button served through:
  - `/api/downloads/dld-connection/windows`

Recommended production env in the main app:

- `DESKTOP_INSTALLER_BUCKET_NAME`
- `DESKTOP_INSTALLER_WINDOWS_PATH`
- optional `DESKTOP_INSTALLER_WINDOWS_FILE_NAME`

With that set, the app download endpoint can redirect users to a signed Google Cloud Storage URL for the latest Windows installer.

Compatibility note:

- the desktop app still accepts the older `ejari-connect://` deep link for backward compatibility
- Tax Rocket production should now emit `taxrocket-connect://`
