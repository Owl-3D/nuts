# Use a dedicated GitHub App for release access

Status: Accepted, 2026-10-27.

## Context

The update server must keep reading private release metadata and assets without
depending on a person's expiring personal access token. It must retain existing
Squirrel feed behavior and stream installers without loading them into memory.

## Decision

Use an organization-owned GitHub App installed only on the release repository,
with Contents read and mandatory Metadata read. Use the official Octokit App
authentication SDK for JWT signing and installation-token acquisition/caching.
Every mint additionally narrows access to the configured repository and Contents
read. Keep the private key only in the server's secret configuration.

Run Node.js 22 and use its HTTP streaming primitives. One authentication module
serves both release queries and downloads, with one retry after an App-token401.
Authenticated requests never follow redirects; signed HTTPS asset redirects carry
no GitHub credentials. Release-cache failures are evicted. A bounded stream branch
keeps the disk cache from missing bytes while its output file is opening.

## Consequences

Installation tokens renew on demand without scheduled jobs or server restarts.
The private key still requires access control, recovery storage, and rotation.
App configuration is all-or-nothing. PAT mode remains available only when all App
settings are absent, allowing deployment before changing live authentication.
The existing release webhook and feed URLs remain compatible. This change does
not publish releases or change version-selection policy.

Alternatives: an expiring PAT requires manual rotation; a non-expiring PAT retains
a personal-account dependency. Both were rejected for the long-running service.
