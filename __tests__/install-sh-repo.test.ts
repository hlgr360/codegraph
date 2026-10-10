/**
 * install.sh installs from the repo `CODEGRAPH_REPO` names, and from this
 * fork's releases when it names none.
 *
 * Runs the REAL install.sh with a stub `curl` first on PATH that records the
 * URL it was asked for and fails, so nothing is downloaded and the script
 * stops at the download. No network.
 *
 * POSIX only: install.sh is `/bin/sh` (Windows uses install.ps1).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const INSTALL_SH = path.join(__dirname, '..', 'install.sh');

let dir = '';
let log = '';

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-install-repo-'));
  log = path.join(dir, 'curl.log');
  fs.mkdirSync(path.join(dir, 'bin'));
  const curl = path.join(dir, 'bin', 'curl');
  fs.writeFileSync(curl, `#!/bin/sh\nfor a in "$@"; do case "$a" in http*) echo "$a" >> '${log}';; esac; done\nexit 22\n`);
  fs.chmodSync(curl, 0o755);
});

afterEach(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

function runInstall(env: Record<string, string>): string[] {
  spawnSync('sh', [INSTALL_SH], {
    env: {
      PATH: `${path.join(dir, 'bin')}:/usr/bin:/bin`,
      HOME: dir,
      CODEGRAPH_INSTALL_DIR: path.join(dir, 'install'),
      CODEGRAPH_BIN_DIR: path.join(dir, 'local-bin'),
      CODEGRAPH_VERSION: 'v1.6.2.1',
      ...env,
    },
    encoding: 'utf8',
  });
  return fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [];
}

describe.runIf(process.platform !== 'win32')('install.sh release repo', () => {
  it('downloads from the repo CODEGRAPH_REPO names', () => {
    const urls = runInstall({ CODEGRAPH_REPO: 'colbymchenry/codegraph' });
    expect(urls).toHaveLength(1);
    expect(urls[0]).toMatch(/^https:\/\/github\.com\/colbymchenry\/codegraph\/releases\/download\/v1\.6\.2\.1\/codegraph-(darwin|linux)-(arm64|x64)\.tar\.gz$/);
  });

  it("downloads from this fork's releases when no repo is named", () => {
    const urls = runInstall({});
    expect(urls[0]).toMatch(/^https:\/\/github\.com\/hlgr360\/codegraph\/releases\/download\/v1\.6\.2\.1\//);
  });
});
