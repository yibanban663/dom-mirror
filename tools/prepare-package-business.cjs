'use strict';
// Build context contains the archive and test host, never the source runtime.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const output = path.resolve(process.argv[2]);
fs.mkdirSync(output, { recursive: true });
const packed = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', output], {
  cwd: root, encoding: 'utf8', timeout: 60000,
}))[0];
fs.renameSync(path.join(output, packed.filename), path.join(output, 'package.tgz'));
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const unpack = fs.mkdtempSync(path.join(output, 'unpack-'));
try {
  execFileSync('tar', ['-xzf', path.join(output, 'package.tgz'), '-C', unpack]);
  const files = Object.fromEntries(packed.files.map(({ path: file }) =>
    [file, sha256(fs.readFileSync(path.join(unpack, 'package', file)))]));
  fs.writeFileSync(path.join(output, 'expected.json'), JSON.stringify({ name: packed.name, version: packed.version,
    integrity: packed.integrity, archiveSha256: sha256(fs.readFileSync(path.join(output, 'package.tgz'))), files }, null, 2));
} finally { fs.rmSync(unpack, { recursive: true, force: true }); }
fs.copyFileSync(path.join(root, 'tools/package-business-host.cjs'), path.join(output, 'host.cjs'));
fs.copyFileSync(path.join(root, 'tools/Dockerfile.package-business'), path.join(output, 'Dockerfile'));
