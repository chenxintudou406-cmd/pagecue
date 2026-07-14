# PageCue V1 Privacy Notice

PageCue only performs page matching on HTTP or HTTPS sites that the user explicitly authorizes.

## Data processed locally

- Visible text on the current page is used to evaluate keyword, exclusion, and regular-expression rules.
- Full page text exists only in the content script's runtime memory. It is not written to extension storage or sent to the server.
- PageCue does not read or upload cookies, passwords, form input values, browser history, canvas images, or cross-origin iframe content.

## Data sent to the server

- User ID, organization ID, and rule or memo ID.
- The current page domain, excluding the full URL, path, and query parameters.
- Action events such as triggered, opened, confirmed, dismissed, snoozed, and usefulness feedback.
- Personal memos deliberately created by a user and organization content published by an administrator.

This data is used only to deliver contextual reminders, synchronize authorized content, and measure product reliability. It is not used for advertising, behavioral profiling, or resale. When the service is offline, the extension queues up to 100 events locally and retries after connectivity returns.

## Permission usage

- `storage`: caches rules, content, cooldown state, and connection settings.
- `scripting`: injects the local matching script only into user-authorized sites.
- `sidePanel`: displays current alerts, the memo library, and the toolbox.
- `notifications`: displays system notifications for alerts marked as important by an administrator.
- `tabs`: reads the current tab title and domain and maintains alert state for that tab.
- Optional host permissions: granted per site by the user and removable at any time.

Before a production release, this notice must include the operating entity, a contact email address, retention periods, account closure and deletion procedures, and a publicly hosted HTTPS version.
