// Real Electron/Squirrel integration with synthetic installed-version manifests.
// Pins match owl3d-desktop-app; this does not launch or install the full app.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const express = require('express');
const Q = require('q');
const Nuts = require('../../lib/nuts');
const Versions = require('../../lib/versions');

assert.equal(process.platform, 'win32');
const deps = process.argv[2];
const root = fs.mkdtempSync(path.join(process.env.LOCALAPPDATA, 'nuts-updater-'));
const packages = path.join(root, 'packages');
const appDir = path.join(root, 'app-2.6.0');
fs.mkdirSync(packages);
fs.cpSync(path.join(deps, 'node_modules/electron/dist'), appDir, { recursive: true });
fs.copyFileSync(path.join(deps, 'node_modules/electron-winstaller/vendor/Squirrel.exe'), path.join(root, 'Update.exe'));
const hash = '1379FCDCD443A0E71AAF10CC89406AC8A3F9AE5A';
const manifest = version => `${hash} owl3d-desktop-app-${version}-full.nupkg 212778363`;
const releases = [
  { tag_name: 'v2.4.2', body: '', published_at: '2026-10-20T10:54:23Z', assets: [
    { id: 1, name: 'RELEASES', size: 88, content_type: 'text/plain' },
    { id: 2, name: 'owl3d-desktop-app-2.4.2-full.nupkg', size: 212778363 }
  ] },
  { tag_name: 'v2.6.0', draft: true, assets: [] }
];
const backend = { releases: () => Q(releases), readAsset: () => Q(Buffer.from(manifest('2.4.2'))) };
const nuts = { init: () => Q(), backend, versions: new Versions(backend) };
const requests = [];
const serverApp = express();
serverApp.use((req, res, next) => { requests.push(req.path); next(); });
serverApp.get('/update/:platform/:version/RELEASES', (req, res, next) => Nuts.prototype.onUpdateWin.call(nuts, req, res, next));
serverApp.use((req, res) => res.status(404).end());
serverApp.use((err, req, res, next) => res.status(500).send(err.message));

// Electron uses Update.exe --checkForUpdate, then emits update-not-available.
// Any update event is a failure, and package downloads are refused by the server.
const main = path.join(root, 'check.cjs');
fs.writeFileSync(main, `
  const { app, autoUpdater } = require('electron');
  const fs = require('fs');
  const events = [];
  app.disableHardwareAcceleration();
  function finish(event, detail) {
    events.push(event);
    fs.writeFileSync(process.env.NUTS_RESULT, JSON.stringify({ events, detail }));
    app.exit(event === 'update-not-available' ? 0 : 1);
  }
  app.setPath('userData', process.env.NUTS_USER_DATA);
  autoUpdater.on('checking-for-update', () => events.push('checking-for-update'));
  autoUpdater.on('update-not-available', () => finish('update-not-available'));
  autoUpdater.on('update-available', () => finish('update-available'));
  autoUpdater.on('error', error => finish('error', String(error)));
  setTimeout(() => finish('timeout'), 45000);
  app.whenReady().then(() => {
    autoUpdater.setFeedURL({ url: process.env.NUTS_FEED });
    autoUpdater.checkForUpdates();
  });
`);

async function check(server, version) {
  const resultPath = path.join(root, `result-${version}.json`);
  const localReleases = path.join(packages, 'RELEASES');
  fs.writeFileSync(localReleases, manifest(version));
  requests.length = 0;
  const env = { ...process.env, NUTS_RESULT: resultPath, NUTS_USER_DATA: path.join(root, 'user-data'),
    NUTS_FEED: `http://127.0.0.1:${server.address().port}/update/win32_x64/${version}` };
  delete env.ELECTRON_RUN_AS_NODE;
  const code = await new Promise((resolve, reject) => {
    const child = spawn(path.join(appDir, 'electron.exe'), [main], { env, stdio: 'inherit', timeout: 60000 });
    child.on('error', reject);
    child.on('exit', resolve);
  });
  const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  console.log(JSON.stringify({ installed: version, published: '2.4.2', code, ...result, requests }));
  assert.equal(code, 0);
  assert.deepEqual(result.events, ['checking-for-update', 'update-not-available']);
  assert(requests.length > 0);
  assert(requests.every(url => url === `/update/win32_x64/${version}/RELEASES`));
  assert.equal(fs.readFileSync(localReleases, 'utf8'), manifest(version));
  // Squirrel may create its staged-rollout identifier on the first check.
  // It must not download packages or rewrite the installed-version manifest.
  assert(fs.readdirSync(packages).every(name => name === 'RELEASES' || name === '.betaId'));
}

(async () => {
  const server = await new Promise(resolve => { const s = serverApp.listen(0, '127.0.0.1', () => resolve(s)); });
  try {
    await check(server, '2.6.0');
    await check(server, '2.4.2');
  } finally {
    server.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
