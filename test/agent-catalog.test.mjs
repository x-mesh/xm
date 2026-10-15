import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAgentPrompt, listAgents, matchAgents } from '../xm/lib/agent-catalog.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(REPO, 'xm', 'lib', 'agent-catalog.mjs');
const CATALOG = JSON.parse(readFileSync(join(REPO, 'xm', 'agent-catalog', 'catalog.json'), 'utf8')).agents;
const MIN_SCORE = 2;

function cli(...args) {
  return spawnSync('node', [CLI, ...args], { encoding: 'utf8', timeout: 10_000, env: { ...process.env, NO_COLOR: '1' } });
}

describe('agent catalog integrity', () => {
  test('every agent has a unique name, a known tier, and resolvable full and slim prompts', () => {
    const names = CATALOG.map((agent) => agent.name);
    expect(new Set(names).size).toBe(names.length);
    for (const agent of CATALOG) {
      expect(['core', 'domain']).toContain(agent.tier);
      expect(getAgentPrompt(agent.name).trim().length).toBeGreaterThan(0);
      expect(getAgentPrompt(agent.name, true).trim().length).toBeGreaterThan(0);
    }
  });

  test('listAgents exposes only name, description, and tags', () => {
    const agents = listAgents();
    expect(agents).toHaveLength(CATALOG.length);
    for (const agent of agents) expect(Object.keys(agent).sort()).toEqual(['description', 'name', 'tags']);
  });
});

describe('matchAgents', () => {
  test('maps Korean topic words to catalog terms', () => {
    expect(matchAgents('결제 API 설계', 3)[0].name).toBe('api-designer');
  });

  test('an agent-name keyword ranks that agent first', () => {
    expect(matchAgents('security review', 3)[0].name).toBe('security');
  });

  test('searches core agents only unless all is set', () => {
    expect(matchAgents('blockchain smart contract', 3).map((agent) => agent.name)).not.toContain('blockchain');
    expect(matchAgents('blockchain smart contract', 3, true)[0].name).toBe('blockchain');
  });

  test('returns no agents when nothing reaches the minimum score, instead of padding', () => {
    expect(matchAgents('zzqx qqv', 3)).toEqual([]);
  });

  test('every returned agent meets the minimum score and the count is a ceiling', () => {
    const matches = matchAgents('SQL database schema migration api review security', 4, true);
    expect(matches.length).toBeLessThanOrEqual(4);
    for (const agent of matches) expect(agent.score).toBeGreaterThanOrEqual(MIN_SCORE);
  });

  test('a stopword-only topic falls back to the first core agents with score 0', () => {
    const expected = CATALOG.filter((agent) => agent.tier === 'core').slice(0, 3).map((agent) => agent.name);
    const matches = matchAgents('the of', 3);
    expect(matches.map((agent) => agent.name)).toEqual(expected);
    expect(matches.every((agent) => agent.score === 0)).toBe(true);
  });

  test('replaces the last slot with an eligible agent from another domain when all picks share one', () => {
    const ranked = matchAgents('api migration', CATALOG.length).map((agent) => agent.name);
    expect(ranked.slice(0, 2)).toEqual(['api-designer', 'database']);
    const picked = matchAgents('api migration', 2);
    expect(picked.map((agent) => agent.name)).toEqual(['api-designer', 'refactor']);
    expect(picked[1].score).toBeGreaterThanOrEqual(MIN_SCORE);
  });
});

describe('getAgentPrompt', () => {
  test('rejects an agent that is not in the catalog', () => {
    expect(() => getAgentPrompt('no-such-agent')).toThrow(/Agent not found in catalog/);
  });

  test('slim returns the inline catalog prompt and full returns the rules file', () => {
    const agent = CATALOG.find((entry) => entry.system_prompt);
    expect(getAgentPrompt(agent.name, true)).toBe(agent.system_prompt);
    expect(getAgentPrompt(agent.name)).toBe(readFileSync(join(REPO, 'xm', 'agent-catalog', 'rules', agent.file), 'utf8'));
  });
});

describe('agent-catalog CLI', () => {
  test('match prints the ranked agents', () => {
    const result = cli('match', '결제 API 설계', '--count', '2');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('api-designer');
  });

  test('match without a topic and get with an unknown agent exit non-zero', () => {
    expect(cli('match').status).toBe(1);
    const unknown = cli('get', 'no-such-agent');
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toContain('no-such-agent');
  });
});
