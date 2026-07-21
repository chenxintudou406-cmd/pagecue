# 页知 PageCue

<p align="center">
  <img src="./extension/assets/pagecue-logo-1024.png" width="128" alt="PageCue logo" />
</p>

PageCue is a context-aware browser companion for Chrome and Edge. It matches page content locally and surfaces personal notes, team guidance, and frequently used tools at the right moment.

The Chinese product name is **页知**. PageCue remains the English brand name.

## Features

- Three member views: current page alerts, reminder library, and team toolbox.
- Knowledge reminders for reference material and operation reminders with named assignees and completion acknowledgement.
- Invite-code device binding; members cannot impersonate another account by editing a client-side ID.
- Personal memo creation, editing, and deletion; organization content remains read-only for members.
- One-time install permission with organization page groups registered automatically; personal site allowlists remain configurable.
- Include and exclude terms, AND/OR logic, case sensitivity, regular expressions, and cooldown periods.
- Throttled rescanning for SPAs and asynchronously loaded DOM content.
- In-page highlighting, match navigation, toolbar badges, and system notifications for important alerts.
- Confirm, complete, dismiss, locate, and usefulness feedback actions.
- An administration console for team reminders, page groups, audience targeting, tool links, publishing, direct deletion, and anonymous usage metrics.
- Append-only creation semantics for page groups, knowledge rules, and team tools, with creator/update audit records.
- Per-reminder member feedback details in the administration console, including confirmations, dismissals, snoozes, and usefulness votes.
- Local caching and an offline event queue. Full page content never leaves the browser.
- One-click organization publishing with Web Push delivery, delivery acknowledgements, and a 60-minute version-check fallback.
- Store-managed extension updates with on-demand update checks when the backend announces a newer package.
- Three severity levels: blue light highlights, yellow medium cards, and persistent red heavy cards. Knowledge uses bright glass; operations use dark glass.
- Two packages from one codebase: a Chrome/Edge side-panel build and a Chromium 109+ Sogou-compatible popup build.

## Requirements

- Node.js 20 or later
- Chrome or Microsoft Edge with Manifest V3 support

## Run locally

```powershell
npm.cmd install
npm.cmd test
npm.cmd start
```

Open the administration console at <http://127.0.0.1:8787/admin> and the rule demo at <http://127.0.0.1:8787/demo>.

## Load the extension

Download the matching package from the production service:

- Chrome/Edge: `https://pagecue.herotop.cn/downloads/pagecue-chrome-edge-3.1.2.zip`
- Sogou/360 compatibility: `https://pagecue.herotop.cn/downloads/pagecue-sogou-3.1.2.zip`

1. Open `chrome://extensions` in Chrome or `edge://extensions` in Edge.
2. Enable **Developer mode**.
3. Choose **Load unpacked** and select the extracted package directory. Use the Sogou package for Sogou Browser; it opens PageCue in a compact popup instead of the side panel.
4. Open PageCue from the extension toolbar, then open its settings.
5. The production service address `https://pagecue.herotop.cn` is configured automatically. Ask an administrator to create your member record and generate a one-time invitation code, then bind the device in PageCue settings.
6. Organization page groups are monitored automatically after binding. Personal sites can still be added from the extension settings. Open or refresh the target page once after installation.

PageCue requests browser page access once during installation. It only registers content monitoring for organization page groups and personal sites; matching remains local and existing tabs must be refreshed once after installation or a newly published page group.

## Production pilot

- Administration console: <https://pagecue.herotop.cn/admin>
- Rule demo: <https://pagecue.herotop.cn/demo>
- Health endpoint: <https://pagecue.herotop.cn/api/health>

The server runs as the `pagecue` Docker Compose project and stores mutable data under `/opt/pagecue/data`. The extension uses the production API by default, while advanced connection settings remain available for development and troubleshooting.

Database writes use an atomic replace operation. Time-based safety copies are retained under `/opt/pagecue/data/backups` before mutations so an interrupted write or accidental content change can be recovered without replacing the active database.

## WorkBuddy / WeCom inbound reminders

The lightweight integration under [`integrations/workbuddy`](./integrations/workbuddy) lets a WorkBuddy assistant convert an @mention in WeCom into an organization knowledge or operation reminder. Each message must explicitly name one submitter; the API stores and returns that business attribution instead of assuming the current chat participant. It uses a dedicated bearer token, an idempotent request ID, exact page-group/member-group/member resolution, and a Chinese result message that the assistant can return directly to the conversation.

- `GET /api/integrations/workbuddy/health`: verify authentication and service readiness.
- `POST /api/integrations/workbuddy/reminders`: create and push a reminder.
- `GET /api/integrations/workbuddy/requests/:requestId`: query a previous result.

Configure `WORKBUDDY_API_TOKEN` on the server and keep the matching token only in WorkBuddy's local credential file. A name parsed from an @mention is stored for audit context but is not treated as an authenticated PageCue user identity.

## Demo data

Local demo data is stored in [`data/db.json`](./data/db.json).

- `user_demo` is a standard member of the sales group. It must now be reached through an invitation-bound device token.
- `admin_demo` is an administrator in the sales and customer-service groups.

V3.0 uses hashed, revocable device tokens for members and signed server-side sessions for administrators. Personal alarms were retired; migration archives their records without deleting them. Larger deployments should still add SSO/OAuth, tenant isolation, and a managed database.

## Privacy model

Page matching runs locally in the browser. The server receives rule identifiers, the page domain, timestamps, and user actions, but it does not receive page text, form values, cookies, full URLs, or query parameters. See [`PRIVACY.md`](./PRIVACY.md) for details.

## Current limitations

- Supports regular DOM text and same-origin dynamic SPA content.
- Does not inspect browser-internal pages, the Chrome Web Store, canvas content, image text, or cross-origin iframes.
- V3.0 does not include personal alarms, semantic AI matching, scheduled page-change monitoring, mobile browsers, Safari, OCR, native outbound WeCom delivery, or third-party knowledge-base connectors. WorkBuddy can submit inbound WeCom requests through the dedicated API above.

## Development

```powershell
npm.cmd test
node --check server.js
node --check extension/background/service-worker.js
```

## Web Push configuration

Generate a VAPID key pair once:

```powershell
npx.cmd web-push generate-vapid-keys
```

Copy `.env.example` to `.env` for local or single-server deployment. The administration console requires `ADMIN_PHONE`, a scrypt-based `ADMIN_PASSWORD_HASH`, and a random `ADMIN_SESSION_SECRET` of at least 32 bytes. Store only the password hash, never the plaintext password. Administrator sessions use signed, HTTP-only, secure, same-site cookies and expire after eight hours. Five failed logins from the same address trigger a 15-minute lockout.

For Web Push, provide `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, and a real contact address in `VAPID_SUBJECT`. Managed hosting can inject all secrets from its secret manager. Never commit private keys, password hashes, or session secrets. Without VAPID configuration, publishing still succeeds and clients use the 60-minute fallback sync.

Production deployment also requires:

- An HTTPS API hostname and a TLS certificate with automatic renewal.
- A managed database instead of `data/db.json`.
- Real administrator and member authentication, tenant isolation, and server-side authorization.
- A production API origin granted in the extension connection settings.
- Stable Chrome Web Store and Microsoft Edge Add-ons identities for code updates.
- Monitoring, backups, rate limiting, push-subscription cleanup, and a hosted privacy policy.

The prototype uses the `web-push` package for standards-based push delivery.
