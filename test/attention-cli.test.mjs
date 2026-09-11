import { test, expect } from 'bun:test';
import { execSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const cli = resolve('x-build/lib/x-build-cli.mjs');
const run = (cwd, args) => spawnSync('bun', [cli, 'attention', ...args], { cwd, encoding: 'utf8' });

test('attention json is clean and an absent read does not write', () => {
  const root = mkdtempSync(join(tmpdir(), 'attention-cli-'));
  const result = run(root, ['--json']);
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ items: [], state: 'no_data' });
  expect(existsSync(join(root, '.xm'))).toBe(false);
});

test('validates flags before writing and allows ack without note', () => {
  const root = mkdtempSync(join(tmpdir(), 'attention-cli-'));
  mkdirSync(join(root, '.xm/review'), { recursive: true });
  const ledger = join(root, '.xm/review/escape-ledger.jsonl');
  writeFileSync(ledger, JSON.stringify({ schema_v: 1, type: 'escape', id: 'known', ts: new Date().toISOString() }) + '\n');
  expect(run(root, ['--ack', 'known', '--since', 'soon']).status).toBe(2);
  expect(readFileSync(ledger, 'utf8')).not.toContain('"type":"ack"');
  expect(run(root, ['--ack', 'known', '--json']).status).toBe(0);
  expect(readFileSync(ledger, 'utf8')).toContain('"type":"ack"');
});

test('applies since before budget', () => {
  const root = mkdtempSync(join(tmpdir(), 'attention-cli-'));
  mkdirSync(join(root, '.xm/review'), { recursive: true });
  writeFileSync(join(root, '.xm/review/escape-ledger.jsonl'), [
    JSON.stringify({ schema_v: 1, type: 'revived', id: 'old', ts: '2020-01-01T00:00:00Z' }),
    JSON.stringify({ schema_v: 1, type: 'contested', id: 'new', ts: new Date().toISOString() }),
  ].join('\n') + '\n');
  const result = run(root, ['--since', '1d', '--budget', '1', '--json']);
  expect(JSON.parse(result.stdout).items.map(row => row.id)).toEqual(['new']);
});

test('warns when the oldest unacknowledged item is at least 14 days old', () => {
  const root = mkdtempSync(join(tmpdir(), 'attention-cli-'));
  mkdirSync(join(root, '.xm/review'), { recursive: true });
  writeFileSync(join(root, '.xm/review/escape-ledger.jsonl'), JSON.stringify({ schema_v: 1, type: 'contested', id: 'stale', ts: '2020-01-01T00:00:00Z' }) + '\n');
  const result = run(root, []);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('remain unacknowledged');
  expect(result.stdout).toContain('stale');
});

test('backfill refuses malformed inputs before writing partial rows',()=>{const root=mkdtempSync(join(tmpdir(),'attention-partial-')),task=join(root,'.xm/build/projects/p/worktrees/T1');mkdirSync(task,{recursive:true});writeFileSync(join(task,'panel-after.json'),'{bad');const ledger=join(root,'.xm/review/escape-ledger.jsonl'),result=run(root,['--backfill','--json']);expect(result.status).toBe(2);expect(result.stderr).toContain('backfill refused partial input');expect(existsSync(ledger)).toBe(false);});

test('linked-worktree attention reads canonical main-repo state',()=>{const main=mkdtempSync(join(tmpdir(),'attention-main-')),wt=main+'-wt';try{execSync('git init -q && git config user.email test@example.com && git config user.name Test',{cwd:main,shell:'/bin/bash'});writeFileSync(join(main,'a.js'),'x');execSync('git add a.js && git commit -qm base',{cwd:main,shell:'/bin/bash'});execSync(`git worktree add -qb feature ${JSON.stringify(wt)}`,{cwd:main,shell:'/bin/bash'});mkdirSync(join(main,'.xm/review'),{recursive:true});writeFileSync(join(main,'.xm/review/escape-ledger.jsonl'),JSON.stringify({schema_v:1,type:'contested',id:'main-state',ts:new Date().toISOString()})+'\n');const result=run(wt,['--json']);expect(result.status).toBe(0);expect(JSON.parse(result.stdout).items.map(row=>row.id)).toEqual(['main-state']);expect(existsSync(join(wt,'.xm'))).toBe(false);}finally{try{execSync(`git worktree remove --force ${JSON.stringify(wt)}`,{cwd:main,shell:'/bin/bash'});}catch{}rmSync(main,{recursive:true,force:true});rmSync(wt,{recursive:true,force:true});}});
