import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { scanAll } from '../xm/lib/install/scan.mjs';
import { renderCodexWithDiagnostics } from '../xm/lib/install/transform/codex.mjs';

const ROOT=join(import.meta.dirname,'..');
const readJson=path=>JSON.parse(readFileSync(join(ROOT,path),'utf8'));

describe('xm mutate dispatch and packaging',()=>{
  test('mutate is xm-native so the wrapper and engine ship together',()=>{const market=readJson('.claude-plugin/marketplace.json').plugins.find(entry=>entry.name==='mutate');expect(market).toBeUndefined();expect(readFileSync(join(ROOT,'xm/lib/x-build/mutate.mjs'),'utf8')).toContain('export async function cmdMutate');});

  test('xm-native metadata keeps mutate explicit-only',()=>{const metadata=readFileSync(join(ROOT,'xm/skills/mutate/agents/openai.yaml'),'utf8');expect(metadata).toContain('allow_implicit_invocation: false');expect(metadata).toContain('$xm:mutate');});

  test('wrapper is thin and explicitly does not generate tests',()=>{const skill=readFileSync(join(ROOT,'xm/skills/mutate/SKILL.md'),'utf8');expect(skill).toContain('xm build mutate --project <project> --task <task-id>');expect(skill).toContain('does not create tests');expect(skill).toContain('Never write mutation logic in this skill');});

  test('wrapper can request a missing task id without broad tools',()=>{const skill=readFileSync(join(ROOT,'xm/skills/mutate/SKILL.md'),'utf8');expect(skill).toContain('  - Bash');expect(skill).toContain('  - AskUserQuestion');});

  test('missing arguments trigger read-only discovery and a bounded choice',()=>{const skill=readFileSync(join(ROOT,'xm/skills/mutate/SKILL.md'),'utf8');expect(skill).toContain('xm build mutate --list --json');expect(skill).toContain('show up to three structured choices');expect(skill).toContain('Do not guess or auto-select');expect(skill).toContain('--project <project>');});

  test('bundle exposes slash and Codex qualified forms plus flat alias',()=>{const skills=scanAll({skillsDir:join(ROOT,'xm','skills'),libDir:join(ROOT,'xm','lib')}),rendered=renderCodexWithDiagnostics(skills,{scope:'local',installRoot:ROOT,pluginVersion:'0.0.0'});const plugin=rendered.outputs.find(item=>item.relativePath.endsWith('plugins/xm/skills/mutate/SKILL.md')),alias=rendered.outputs.find(item=>item.relativePath.endsWith('.agents/skills/xm-mutate/SKILL.md'));expect(plugin).toBeTruthy();expect(alias).toBeTruthy();expect(plugin.content).toContain('$xm:mutate');expect(alias.content).toMatch(/^---\nname: xm-mutate\n/);});

  test('README plugin count matches the marketplace',()=>{const count=readJson('.claude-plugin/marketplace.json').plugins.length,readme=readFileSync(join(ROOT,'README.md'),'utf8');expect(readme).toContain(`${count} plugins, each installable individually`);});
});
