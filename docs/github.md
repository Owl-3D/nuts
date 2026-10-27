# GitHub Integration

## Server authentication with a GitHub App

For a long-running private release server, create an organization-owned GitHub App
dedicated to release reading. Install it on **only the release repository**, with
repository **Contents: Read-only** (Metadata read is mandatory). No user OAuth,
client secret, device flow, or App webhook is needed. The existing repository
release webhook below can remain in place.

Configure these server-side secrets/settings together:

- `GITHUB_REPO`: `owner/repository`
- `GITHUB_APP_ID`: numeric App ID (not its client ID)
- `GITHUB_APP_INSTALLATION_ID`: numeric installation ID
- `GITHUB_APP_PRIVATE_KEY`: the complete downloaded RSA PEM, with actual newlines

Store the private key in the hosting platform's secret store. Never commit it,
put it in command-line arguments/logs, or ship it in the desktop client. Retain a
secure recovery copy. Rotate keys by adding a second key, replacing the server
secret, verifying fresh token acquisition, then removing the old key in GitHub.

Nuts uses the official `@octokit/auth-app` SDK. It requests installation tokens
limited to the configured repository name and Contents read, caches them in
memory, and renews them before expiry on demand. No timer, GitHub Actions job, or
hourly Heroku config update is needed. A rejected token gets one forced refresh
and retry. Auth errors are sanitized, failed release queries are not retained in
the release cache, and credentials are never forwarded to asset redirects.

All three App settings must be present and valid. Partial App configuration fails
startup; it never silently falls back to a personal token. With no App settings,
the existing `GITHUB_TOKEN` or username/password configuration remains supported
for transition. Once App access is verified, remove the obsolete PAT from the
server and revoke it if it is not used elsewhere.

Run on Node.js 22. `npm test` includes real SDK signing with disposable test keys,
token expiry/retry/concurrency, pagination, credential-safe streaming, and legacy
Squirrel feed-format tests. Before production cutover, verify published release
asset hashes using the actual installation and repeat after token renewal.

References: [GitHub App best practices](https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/best-practices-for-creating-a-github-app),
[Octokit App authentication](https://github.com/octokit/auth-app.js).

## Release cache webhook

By default Nuts fetches releases from GitHub Releases; but since Nuts is caching information, there might be a delay before the creation of the release and the release being served to users.

To solve this issue, you can setup a webhook between Nuts and GitHub, to notify your nuts instance each time GitHub Releases are updated (created/removed/updated).

### Webhook URL

Add a [GitHub Webhook](https://help.github.com/articles/about-webhooks/) with the url:

```
http://download.myapp.com/refresh
```

Where download.myapp.com, is the URL of your Nuts server.

It'll refresh versions cache everytime you update a release on GitHub.

### Secret

The GitHub Webhook secret can be configured as a environment variable on Nuts: `GITHUB_SECRET` (default value is `secret`).
