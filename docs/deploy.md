# Deployment

Nuts can be easily be deployed to a state-less server or PaaS. It only uses the disk as a cache for assets.

### On Heroku:

Heroku is the perfect solution to host a Nuts instance.

[![Deploy](https://www.herokucdn.com/deploy/button.png)](https://heroku.com/deploy)

Heroku Git deployment does not require the Heroku GitHub OAuth integration.
Keep the application's GitHub source remote and Heroku deployment remote separate.
Test the selected commit, then push that commit to the Heroku remote's `master`
branch. The runtime's read-only GitHub App credentials are independent of this
deployment login; see [GitHub authentication](github.md).

Set all App config variables in one update using a secure local input or the
platform's secret-management UI. Config changes restart the app. A Heroku rollback
restores both the old slug and its configuration: after a repository transfer,
do not blindly roll back to an old personal-repository path or expired PAT.

### With docker

Nuts can also be run as a Docker container:

```
docker run -it -p 80:80 -e GITHUB_REPO=username/repo gitbook/nuts
```

### On your own server:

Use Node.js 22 and install the locked dependencies using:

```
$ npm ci
```

This service requires to be configured using environment variables:

```
# Set the port for the service
$ export PORT=6000

# Access token for the GitHub API (requires permissions to access the repository)
# If the repository is public you do not need to provide an access token
# you can also use GITHUB_USERNAME and GITHUB_PASSWORD
$ export GITHUB_TOKEN=...

# ID for the GitHub repository
$ export GITHUB_REPO=Username/MyApp

# Authentication for the private API
$ export API_USERNAME=hello
$ export API_PASSWORD=world

# Express's "trust proxy" setting for trusting X-Forwarded-* headers when
# behind a reverse proxy like nginx
# http://expressjs.com/en/guide/behind-proxies.html
$ export TRUST_PROXY=loopback
```

Then start the application using:

```
$ npm start
```
