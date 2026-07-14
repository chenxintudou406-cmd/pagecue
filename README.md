# PageCue

<p align="center">
  <img src="./extension/assets/pagecue-logo-1024.png" width="128" alt="PageCue logo" />
</p>

PageCue is a context-aware browser companion for Chrome and Edge. It matches page content locally and surfaces personal notes, team guidance, and frequently used tools at the right moment.

The current Chinese product name is **前衍提醒**. PageCue is the working English brand name during product validation.

## Features

- A side panel with current alerts, a memo library, and a team toolbox.
- Personal memo creation, editing, and deletion; organization content remains read-only for members.
- Explicit per-site permissions and configurable site allowlists.
- Include and exclude terms, AND/OR logic, case sensitivity, regular expressions, and cooldown periods.
- Throttled rescanning for SPAs and asynchronously loaded DOM content.
- In-page highlighting, match navigation, toolbar badges, and system notifications for important alerts.
- Snooze, confirm, dismiss, and usefulness feedback actions.
- An administration console for team reminders, page groups, audience targeting, tool links, publishing, withdrawal, and anonymous usage metrics.
- Local caching and an offline event queue. Full page content never leaves the browser.

## Requirements

- Node.js 20 or later
- Chrome or Microsoft Edge with Manifest V3 support

## Run locally

```powershell
npm.cmd test
npm.cmd start
```

Open the administration console at <http://127.0.0.1:8787/admin> and the rule demo at <http://127.0.0.1:8787/demo>.

## Load the extension

1. Open `chrome://extensions` in Chrome or `edge://extensions` in Edge.
2. Enable **Developer mode**.
3. Choose **Load unpacked** and select the `extension` directory in this repository.
4. Open PageCue from the extension toolbar, then open its settings.
5. Keep the default local service address and the demo user ID `user_demo`.
6. Grant access to the current site, then open or refresh the demo page.

Pages that were already open must be refreshed once after a new site permission is granted.

## Demo data

Local demo data is stored in [`data/db.json`](./data/db.json).

- `user_demo` is a standard member of the sales group and the extension's default identity.
- `admin_demo` is an administrator in the sales and customer-service groups.

The V1 demo identity header validates the product workflow; it is not production authentication. A production deployment should add SSO or OAuth, server-side sessions, HTTPS, a managed database, organization invitations, and administrator authorization checks.

## Privacy model

Page matching runs locally in the browser. The server receives rule identifiers, the page domain, timestamps, and user actions, but it does not receive page text, form values, cookies, full URLs, or query parameters. See [`PRIVACY.md`](./PRIVACY.md) for details.

## Current limitations

- Supports regular DOM text and same-origin dynamic SPA content.
- Does not inspect browser-internal pages, the Chrome Web Store, canvas content, image text, or cross-origin iframes.
- V1 does not include semantic AI matching, scheduled page-change monitoring, mobile browsers, Safari, OCR, or third-party knowledge-base connectors.

## Development

```powershell
npm.cmd test
node --check server.js
node --check extension/background/service-worker.js
```

The prototype currently uses only Node.js built-in modules and does not require an install step.
