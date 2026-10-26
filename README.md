# Student sign-up

A no-login registration form with a private, password-protected organizer roster, per-student deletion, and CSV export. It uses only Node.js built-ins; registrations are stored in a local JSON file outside the public web directory.

## Run locally

Use Node.js 20 or newer. Set an organizer password of at least 10 characters before starting the server. A longer, unique password is strongly recommended before collecting real contact details:

```powershell
$env:ADMIN_PASSWORD = "choose-a-long-private-password"
npm.cmd start
```

Open `http://localhost:3000` for the student form and `http://localhost:3000/owner` for the organizer view. Set `PORT` to change the port, or `DATA_FILE` to change where registrations are stored.

## Search engines

Search engines cannot index `localhost`; deploy the site to a public HTTPS domain first. Set `SITE_URL` to that domain's origin (for example, `https://signup.example.com`). The app then publishes `/robots.txt` and `/sitemap.xml`, keeps the student sign-up page indexable, and marks the organizer page and API responses `noindex`. Submit `https://your-domain/sitemap.xml` in Google Search Console and Bing Webmaster Tools after deployment. Indexing is controlled by those search engines and is not immediate.

## Verify

```powershell
npm test
```

## Before deployment

- Configure `ADMIN_PASSWORD` and `NODE_ENV=production` in the hosting provider's secret settings. Use HTTPS; production cookies are marked Secure.
- Attach persistent storage for the `data/` directory or set `DATA_FILE` to a persistent volume. The default local file is not suitable for ephemeral hosts or multiple app instances.
- Restrict server and backup access, set a retention/deletion policy, and confirm the hosting provider's data-processing terms before collecting real contact details.
- Email addresses are unique, but students are not authenticated. To avoid allowing someone to overwrite another student's contact details, duplicate addresses are rejected; students must contact the organizer to change a registration.

The server does not expose a public roster endpoint. Owner sign-in uses an in-memory session that expires after eight hours and is cleared when the server restarts. For a larger deployment, use a managed database and a mature authentication/session service.