require('should');
var Q = require('q');

var Nuts = require('../lib/nuts');
var Versions = require('../lib/versions');

// GitHub releases as the API lists them: a published 2.4.2, an older 2.3.2,
// and a 2.6.0 draft that the feed must ignore.
function release(tag, opts) {
    opts = opts || {};
    return {
        tag_name: 'v' + tag,
        draft: !!opts.draft,
        body: '',
        published_at: '2026-10-20T10:54:23Z',
        assets: [
            { id: tag + '-releases', name: 'RELEASES', size: 88, content_type: 'text/plain', download_count: 0 },
            { id: tag + '-nupkg', name: 'owl3d-desktop-app-' + tag + '-full.nupkg', size: 212778363, content_type: 'application/octet-stream', download_count: 0 }
        ]
    };
}

var SHA = '1379FCDCD443A0E71AAF10CC89406AC8A3F9AE5A';

function fakeServer(releases) {
    var backend = {
        releases: function() { return Q(releases); },
        readAsset: function(asset) {
            var tag = asset.id.split('-')[0];
            return Q(new Buffer(SHA + ' owl3d-desktop-app-' + tag + '-full.nupkg 212778363'));
        }
    };
    return {
        init: function() { return Q(); },
        backend: backend,
        versions: new Versions(backend)
    };
}

function get(server, version) {
    var d = Q.defer();
    var res = {
        headers: {},
        header: function(k, v) { this.headers[k] = v; },
        attachment: function() {},
        send: function(body) { d.resolve({ status: 200, body: String(body) }); }
    };
    var req = {
        protocol: 'https',
        params: { platform: 'win32_x64', version: version },
        originalUrl: '/update/win32_x64/' + version + '/RELEASES',
        get: function() { return 'owl3d-desktop-release-server.herokuapp.com'; }
    };
    Nuts.prototype.onUpdateWin.call(server, req, res, function(err) {
        d.resolve({ status: 500, body: err && err.message });
    });
    return d.promise;
}

describe('Squirrel.Windows RELEASES', function() {
    var published = [release('2.4.2'), release('2.3.2'), release('2.6.0', { draft: true })];

    it('serves the newest release to an older client', function() {
        return get(fakeServer(published), '2.3.2').then(function(r) {
            r.status.should.be.exactly(200);
            r.body.should.containEql('/download/2.4.2/owl3d-desktop-app-2.4.2-full.nupkg');
        });
    });

    it('serves the same release to an up-to-date client', function() {
        return get(fakeServer(published), '2.4.2').then(function(r) {
            r.status.should.be.exactly(200);
            r.body.should.containEql('owl3d-desktop-app-2.4.2-full.nupkg');
        });
    });

    it('answers "no update" (200, nothing newer) to a client newer than every published release', function() {
        return get(fakeServer(published), '2.6.0').then(function(r) {
            r.status.should.be.exactly(200);
            r.body.should.containEql('owl3d-desktop-app-2.4.2-full.nupkg');
            r.body.should.not.containEql('2.6.0');
        });
    });

    it('answers "no update" to a version string that is not semver', function() {
        return get(fakeServer(published), 'dev').then(function(r) {
            r.status.should.be.exactly(200);
            r.body.should.containEql('owl3d-desktop-app-2.4.2-full.nupkg');
        });
    });

    it('serves 2.6.1 to a 2.6.0 client once 2.6.1 is published', function() {
        var withNext = [release('2.6.1')].concat(published);
        return get(fakeServer(withNext), '2.6.0').then(function(r) {
            r.status.should.be.exactly(200);
            r.body.should.containEql('/download/2.6.1/owl3d-desktop-app-2.6.1-full.nupkg');
        });
    });

    it('still fails when nothing is published at all', function() {
        return get(fakeServer([release('2.6.0', { draft: true })]), '2.6.0').then(function(r) {
            r.status.should.be.exactly(500);
            r.body.should.be.exactly('Version not found');
        });
    });
});
