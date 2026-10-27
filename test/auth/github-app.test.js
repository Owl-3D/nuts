const {test} = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const express = require('express');
const Nuts = require('../..').Nuts;

const {privateKey, publicKey} = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: {type: 'pkcs8', format: 'pem'},
    publicKeyEncoding: {type: 'spki', format: 'pem'}
});
let installation = 100;
function config(extra) {
    return Object.assign({
        repository: 'example/desktop', appId: '123',
        installationId: String(++installation), privateKey,
        refreshSecret: 'test-webhook-secret',
        cache: path.join(os.tmpdir(), 'nuts-auth-test-' + installation)
    }, extra);
}
function response(body, status = 200, headers = {}) {
    return new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json', ...headers}});
}
function fixture(t, extra = {}, handler) {
    const opts = config(extra);
    const backend = Nuts(opts).backend;
    const calls = [];
    let mints = 0;
    t.mock.method(global, 'fetch', async (url, init = {}) => {
        url = String(url);
        calls.push({url, init});
        if (url.endsWith('/access_tokens')) {
            ++mints;
            const body = JSON.parse(init.body);
            assert.deepEqual(body.repositories, ['desktop']);
            assert.deepEqual(body.permissions, {contents: 'read'});
            const jwt = init.headers.authorization.replace(/^bearer /i, '');
            const parts = jwt.split('.');
            assert.equal(crypto.verify('RSA-SHA256', Buffer.from(parts.slice(0, 2).join('.')), publicKey, Buffer.from(parts[2], 'base64url')), true);
            return response({token: 'ghs_test_' + mints,
                expires_at: new Date(Date.now() + 3600000).toISOString(),
                permissions: {contents: 'read', metadata: 'read'}, repository_selection: 'selected'});
        }
        return handler ? handler(url, init, calls) : response([]);
    });
    return {backend, calls, mints: () => mints};
}
async function read(stream) {
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    return Buffer.concat(chunks).toString();
}
const asset = {raw: {url: 'https://api.github.com/repos/example/desktop/releases/assets/7'}};

test('partial App configuration cannot silently use a PAT', () => {
    assert.throws(() => Nuts({repository: 'example/desktop', appId: '123', token: 'pat'}), /App configuration/);
});
test('official SDK scopes and signs one mint for concurrent operations, reusing the token', async t => {
    const f = fixture(t);
    await Promise.all(Array.from({length: 12}, () => f.backend._releases()));
    await f.backend._releases();
    assert.equal(f.mints(), 1);
    assert.ok(f.calls.filter(c => !c.url.endsWith('/access_tokens')).every(c => c.init.headers.Authorization === 'token ghs_test_1'));
});
test('refreshes before expiry for release queries and after expiry for downloads', async t => {
    let now = Date.now();
    t.mock.method(Date, 'now', () => now);
    const f = fixture(t, {}, url => url.includes('/assets/') ? new Response('installer') : response([]));
    await f.backend._releases();
    now += 3590000;
    await f.backend._releases();
    assert.equal(f.mints(), 2);
    now += 3610000;
    assert.equal(await read(await f.backend.getAssetStream(asset)), 'installer');
    assert.equal(f.mints(), 3);
});
test('401 forces one refresh and retry; repeated 401 is bounded and sanitized', async t => {
    let requests = 0;
    const f = fixture(t, {}, () => ++requests === 1 ? response({message: 'secret'}, 401) : response([]));
    await f.backend._releases();
    assert.equal(f.mints(), 2);
    assert.equal(requests, 2);
    t.mock.restoreAll();
    const bad = fixture(t, {}, () => response({message: privateKey}, 401));
    await assert.rejects(bad.backend._releases(), err => err.message === 'GitHub request failed (HTTP 401)' && !err.request && !err.cause);
    assert.equal(bad.mints(), 2);
});
test('release pagination preserves all pages and rejects off-origin links', async t => {
    const f = fixture(t, {}, url => url.includes('page=2') ? response([{id: 2}]) : response([{id: 1}], 200, {
        link: '<https://api.github.com/repositories/42/releases?page=2>; rel="next"'
    }));
    assert.deepEqual(await f.backend._releases(), [{id: 1}, {id: 2}]);
    t.mock.restoreAll();
    const bad = fixture(t, {}, () => response([], 200, {link: '<https://evil.example/releases>; rel="next"'}));
    await assert.rejects(bad.backend._releases(), /GitHub/);
    assert.equal(bad.calls.some(c => c.url.includes('evil.example')), false);
});
test('failed release cache can recover on the next request', async t => {
    let fail = true;
    const f = fixture(t, {}, () => fail ? response({}, 503) : response([{id: 1}]));
    await assert.rejects(f.backend.releases());
    fail = false;
    assert.deepEqual(await f.backend.releases(), [{id: 1}]);
});
test('asset redirect strips credentials, including 307 and same-host different port', async t => {
    const f = fixture(t, {}, (url, init) => {
        if (url.includes('/assets/')) return new Response(null, {status: 307, headers: {location: 'https://api.github.com:444/signed-asset'}});
        assert.equal(init.headers?.Authorization, undefined);
        assert.equal(init.headers?.authorization, undefined);
        return new Response('installer bytes');
    });
    assert.equal(await read(await f.backend.getAssetStream(asset)), 'installer bytes');
    assert.equal(f.mints(), 1);
});
test('asset 401 renews before streaming; error bodies are never returned as installers', async t => {
    let tries = 0;
    const f = fixture(t, {}, () => ++tries === 1 ? response({}, 401) : new Response('bytes'));
    assert.equal(await read(await f.backend.getAssetStream(asset)), 'bytes');
    assert.equal(f.mints(), 2);
    t.mock.restoreAll();
    const bad = fixture(t, {}, () => response({secret: privateKey}, 404));
    await assert.rejects(bad.backend.getAssetStream(asset), /HTTP 404/);
});
test('asset redirect refuses plaintext and API metadata URLs cannot exfiltrate credentials', async t => {
    const f = fixture(t, {}, () => new Response(null, {status: 302, headers: {location: 'http://evil.example/asset'}}));
    await assert.rejects(f.backend.getAssetStream(asset), /GitHub/);
    await assert.rejects(f.backend.getAssetStream({raw: {url: 'https://evil.example/asset'}}), /GitHub/);
    assert.equal(f.calls.some(c => c.url.includes('evil.example')), false);
});
test('streaming starts without buffering the entire installer', async t => {
    let consumed = 0;
    const f = fixture(t, {}, () => new Response(new ReadableStream({
        pull(controller) {
            if (++consumed > 1000) controller.close();
            else controller.enqueue(new Uint8Array(65536));
        }
    })));
    const stream = await f.backend.getAssetStream(asset);
    assert.ok(consumed < 1000);
    stream.destroy();
});
test('PAT mode keeps working without minting App tokens', async t => {
    const backend = Nuts({repository: 'example/desktop', token: 'test-pat'}).backend;
    let calls = 0;
    t.mock.method(global, 'fetch', async (url, init) => {
        ++calls;
        assert.equal(init.headers.Authorization, 'token test-pat');
        assert.equal(String(url).includes('/access_tokens'), false);
        return String(url).includes('/assets/') ? new Response('pat bytes') : response([]);
    });
    await backend._releases();
    assert.equal(await read(await backend.getAssetStream(asset)), 'pat bytes');
    assert.equal(calls, 2);
});

async function assetServer(t, backend, bytes) {
    backend.cache.init();
    const app = express();
    const target = {...asset, id: '7', filename: 'installer.zip', size: Buffer.byteLength(bytes)};
    app.get('/asset', (req, res, next) => backend.serveAsset(target, req, res).fail(next));
    app.use((err, req, res, next) => { if (res.headersSent) res.destroy(); else res.status(500).end(); });
    const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    t.after(async () => {
        await new Promise(resolve => server.close(resolve));
        fs.rmSync(backend.cache.path, {recursive: true, force: true});
    });
    return () => new Promise((resolve, reject) => {
        http.get('http://127.0.0.1:' + server.address().port + '/asset', res => {
            let output = '';
            res.on('data', chunk => output += chunk);
            res.on('end', () => resolve(output));
            res.on('error', reject);
        }).on('error', reject);
    });
}
test('real HTTP cache miss and hit contain identical complete installer bytes', async t => {
    const bytes = 'FIRST-CHUNK;SECOND-CHUNK;';
    let downloads = 0;
    const f = fixture(t, {}, () => {
        ++downloads;
        return new Response(new ReadableStream({start(controller) {
            controller.enqueue(Buffer.from('FIRST-CHUNK;'));
            setTimeout(() => { controller.enqueue(Buffer.from('SECOND-CHUNK;')); controller.close(); }, 30);
        }}));
    });
    const download = await assetServer(t, f.backend, bytes);
    assert.equal(await download(), bytes);
    await f.backend.cache.wait('7');
    assert.equal((await f.backend.cache.get('7')).toString(), bytes);
    assert.equal(await download(), bytes);
    assert.equal(downloads, 1);
});
test('concurrent immediate HTTP downloads do not stall or cache an empty installer', async t => {
    const bytes = 'complete installer contents';
    const f = fixture(t, {}, () => new Response(bytes));
    const download = await assetServer(t, f.backend, bytes);
    assert.deepEqual(await Promise.all(Array.from({length: 8}, download)), Array(8).fill(bytes));
    await f.backend.cache.wait('7');
    assert.equal((await f.backend.cache.get('7')).toString(), bytes);
    assert.equal(await download(), bytes);
});
test('failed mint is sanitized and the next request recovers', async t => {
    const backend = Nuts(config()).backend;
    let fail = true;
    t.mock.method(global, 'fetch', async url => {
        if (String(url).endsWith('/access_tokens')) {
            if (fail) return response({message: privateKey}, 403);
            return response({token: 'ghs_recovered', expires_at: new Date(Date.now() + 3600000).toISOString(), permissions: {contents: 'read'}});
        }
        return response([]);
    });
    await assert.rejects(backend.releases(), err => err.message === 'GitHub request failed (HTTP 403)' && !err.request && !err.cause);
    fail = false;
    assert.deepEqual(await backend.releases(), []);
});
test('upstream stream failure does not leave a partial installer in the disk cache', async t => {
    const f = fixture(t, {}, () => new Response(new ReadableStream({start(controller) {
        controller.enqueue(Buffer.from('partial'));
        setTimeout(() => controller.error(new Error('connection lost')), 20);
    }})));
    const download = await assetServer(t, f.backend, 'partial and missing remainder');
    await assert.rejects(download());
    await f.backend.cache.wait('7').catch(() => {});
    assert.equal(f.backend.cache.has('7'), false);
    assert.equal('7' in f.backend.cache.pending, false);
});
test('header deadlines are cleared while a healthy body continues streaming', async t => {
    const realTimeout = setTimeout;
    t.mock.method(global, 'setTimeout', (fn, ms, ...args) => realTimeout(fn, ms === 30000 ? 5 : ms, ...args));
    const f = fixture(t, {}, (url, init) => new Response(new ReadableStream({start(controller) {
        init.signal.addEventListener('abort', () => controller.error(new Error('aborted after headers')));
        realTimeout(() => { controller.enqueue(Buffer.from('slow installer')); controller.close(); }, 20);
    }})));
    assert.equal(await read(await f.backend.getAssetStream(asset)), 'slow installer');
});
test('webhook invalidation and TTL refresh a bounded release cache', async t => {
    let now = Date.now();
    t.mock.method(Date, 'now', () => now);
    let requests = 0;
    const f = fixture(t, {cacheMaxAge: 100}, () => response([{id: ++requests}]));
    assert.deepEqual(await f.backend.releases(), [{id: 1}]);
    assert.deepEqual(await f.backend.releases(), [{id: 1}]);
    f.backend.onRelease();
    assert.deepEqual(await f.backend.releases(), [{id: 2}]);
    now += 101;
    assert.deepEqual(await f.backend.releases(), [{id: 3}]);
});
