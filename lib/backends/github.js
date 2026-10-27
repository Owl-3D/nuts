var _ = require('lodash');
var Q = require('q');
var util = require('util');
var Readable = require('node:stream').Readable;
var githubWebhook = require('github-webhook-handler');
var githubAuth = require('./github-auth');

var Backend = require('./backend');

function GitHubBackend() {
    var that = this;
    Backend.apply(this, arguments);

    this.opts = _.defaults(this.opts || {}, {
        proxyAssets: true
    });

    this.auth = githubAuth(this.opts);
    var cached, generation, expiresAt;
    this.releases = function() {
        if (!cached || generation !== that.cacheId || Date.now() >= expiresAt) {
            generation = that.cacheId;
            expiresAt = Date.now() + that.opts.cacheMaxAge;
            var pending = that._releases().fail(function(err) {
                // Keep only one promise; failed refreshes must be immediately retryable.
                if (cached === pending) cached = null;
                throw err;
            });
            cached = pending;
        }
        return cached;
    };

    // GitHub webhook to refresh list of versions
    this.webhookHandler = githubWebhook({
        path: '/refresh',
        secret: this.opts.refreshSecret
    });

    // Webhook from GitHub
    this.webhookHandler.on('release', function(event) {
        that.onRelease();
    });
    this.nuts.router.use(this.webhookHandler);
}
util.inherits(GitHubBackend, Backend);

// List all releases for this repository
GitHubBackend.prototype._releases = function() {
    var that = this;
    return Q((async function() {
        var url = that.auth.endpoint + '/repos/' + that.opts.repository + '/releases?per_page=100';
        var releases = [];
        var seen = new Set();
        while (url) {
            if (seen.has(url)) throw new Error('GitHub pagination loop');
            seen.add(url);
            var response = await that.auth.request(url);
            if (response.status !== 200) {
                await response.body?.cancel();
                throw new Error('GitHub releases returned an unexpected response');
            }
            var page = await response.json();
            if (!Array.isArray(page)) throw new Error('GitHub releases returned invalid data');
            releases = releases.concat(page);
            var next = (response.headers.get('link') || '').split(',').find(function(link) { return /;\s*rel="next"/.test(link); });
            url = next ? next.match(/<([^>]+)>/)[1] : null;
        }
        return releases;
    })());
};

// Return stream for an asset
GitHubBackend.prototype.serveAsset = function(asset, req, res) {
    if (!this.opts.proxyAssets) {
        res.redirect(asset.raw.browser_download_url);
    } else {
        return Backend.prototype.serveAsset.apply(this, arguments);
    }
};

// Return stream for an asset
GitHubBackend.prototype.getAssetStream = function(asset) {
    var that = this;
    return Q((async function() {
        var url = asset.raw.url;
        var response = await that.auth.request(url, 'application/octet-stream');
        // Signed asset locations need no GitHub credentials, including subsequent redirects.
        for (var redirects = 0; [301, 302, 303, 307, 308].includes(response.status); ++redirects) {
            var location = response.headers.get('location');
            await response.body?.cancel();
            if (!location || redirects >= 5) throw new Error('GitHub asset redirect failed');
            var target = new URL(location, url);
            if (target.protocol !== 'https:' || target.username || target.password) throw new Error('GitHub asset redirect must use HTTPS');
            url = target.href;
            var controller = new AbortController();
            var timeout = setTimeout(function() { controller.abort(); }, 30000);
            try {
                response = await fetch(url, {redirect: 'manual', signal: controller.signal});
            } catch (_) {
                throw new Error('GitHub asset download failed');
            } finally {
                clearTimeout(timeout);
            }
        }
        if (response.status !== 200 || !response.body || /json/i.test(response.headers.get('content-type') || '')) {
            await response.body?.cancel();
            throw new Error('GitHub asset download failed (HTTP ' + response.status + ')');
        }
        return Readable.fromWeb(response.body);
    })());
};


module.exports = GitHubBackend;
