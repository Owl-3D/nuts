// Authentication stays server-side. Octokit owns JWT signing and token caching.
const {createPrivateKey} = require('node:crypto');

module.exports = function githubAuth(opts) {
    const appFields = [opts.appId, opts.installationId, opts.privateKey];
    const useApp = appFields.some(Boolean);
    if (useApp && (!appFields.every(Boolean) || !/^\d+$/.test(opts.appId) || !/^\d+$/.test(opts.installationId))) {
        throw new Error('Complete GitHub App configuration is required');
    }
    if (!useApp && !opts.token && !(opts.username && opts.password)) {
        throw new Error('GitHub credentials are required');
    }
    if (!/^[\w.-]+\/[\w.-]+$/.test(opts.repository || '')) {
        throw new Error('GitHub repository must be owner/name');
    }
    const endpoint = new URL(opts.endpoint || 'https://api.github.com');
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
        throw new Error('GitHub endpoint must be an HTTPS API URL');
    }
    if (useApp) {
        try {
            if (createPrivateKey(opts.privateKey).asymmetricKeyType !== 'rsa') throw new Error();
        } catch (_) {
            throw new Error('GitHub App configuration requires an RSA private key');
        }
    }
    let sdk;
    async function appToken(refresh) {
        if (!sdk) {
            sdk = Promise.all([import('@octokit/auth-app'), import('@octokit/request')]).then(([auth, http]) => auth.createAppAuth({
                appId: opts.appId, installationId: opts.installationId, privateKey: opts.privateKey,
                request: http.request.defaults({
                    baseUrl: endpoint.href.replace(/\/$/, ''),
                    request: {fetch: (url, init) => fetch(url, {...init, redirect: 'error', signal: AbortSignal.timeout(30000)})}
                })
            }));
        }
        const auth = await sdk;
        const scope = {type: 'installation', repositoryNames: [opts.repository.split('/')[1]], permissions: {contents: 'read'}};
        let result = await auth({...scope, refresh});
        // Also honor the server's actual expiry (including tokens shorter than 1h).
        if (Date.parse(result.expiresAt) <= Date.now() + 60000 && !refresh) result = await auth({...scope, refresh: true});
        if (!result.token || !Number.isFinite(Date.parse(result.expiresAt)) || Date.parse(result.expiresAt) <= Date.now() + 60000) {
            throw new Error('Invalid installation token lifetime');
        }
        return result.token;
    }
    function safeError(err) {
        const status = Number(err.status || err.statusCode);
        return new Error('GitHub request failed' + (status >= 400 && status <= 599 ? ' (HTTP ' + status + ')' : ''));
    }
    return {
        endpoint: endpoint.href.replace(/\/$/, ''),
        // Only send credentials to the configured API origin; never follow redirects here.
        async request(url, accept = 'application/vnd.github+json') {
            try {
                const target = new URL(url);
                if (target.origin !== endpoint.origin || target.username || target.password) throw new Error();
                for (let attempt = 0; attempt < (useApp ? 2 : 1); ++attempt) {
                    const authorization = useApp ? 'token ' + await appToken(attempt > 0)
                        : opts.token ? 'token ' + opts.token
                        : 'Basic ' + Buffer.from(opts.username + ':' + opts.password).toString('base64');
                    const controller = new AbortController();
                    const timeout = setTimeout(() => controller.abort(), 30000);
                    let result;
                    try {
                        result = await fetch(target.href, {
                            headers: {Authorization: authorization, Accept: accept, 'User-Agent': 'nuts', 'X-GitHub-Api-Version': '2022-11-28'},
                            redirect: 'manual', signal: controller.signal
                        });
                    } finally {
                        // Bound connection/header waits, not the duration of a large download.
                        clearTimeout(timeout);
                    }
                    if (result.status === 401 && useApp && attempt === 0) {
                        await result.body?.cancel();
                        continue;
                    }
                    if (result.status >= 400) {
                        await result.body?.cancel();
                        throw {status: result.status};
                    }
                    return result;
                }
            } catch (err) {
                // SDK error objects can contain JWTs/headers; do not expose them to logs or users.
                throw safeError(err);
            }
        }
    };
};
