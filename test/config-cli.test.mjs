import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { loadWorktreeConfig, WORKTREE_CONFIG_DEFAULTS } from '../x-build/lib/x-build/worktree-shared.mjs';
import { SCHEMA } from '../x-build/lib/config-schema.mjs';
import { validateSet, shadowingTiers, setNestedKey, getNestedKey } from '../x-build/lib/shared-config.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(__dirname, '..', 'x-build', 'lib', 'x-config-cli.mjs');

function run(args, root) {
  const result = spawnSync('node', [CLI_PATH, ...args], {
    // Pin XM_LANG=ko so the Korean assertions below stay language-deterministic
    // regardless of the dev's locale / XM_LANG (i18n tests set their own signals).
    env: { ...process.env, XM_ROOT: root, XM_LANG: 'ko' },
    encoding: 'utf8',
    timeout: 10000,
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status ?? 1,
  };
}

function withRoot(fn) {
  const tmp = mkdtempSync(join(tmpdir(), 'xm-config-'));
  try {
    return fn(tmp);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

describe('xm config phase', () => {
  const PLAN_ROLES = ['architect', 'planner', 'critic', 'security', 'researcher'];

  test('phase plan=opus writes overrides for all plan-group roles', () => {
    withRoot((root) => {
      const w = run(['phase', 'plan=opus'], root);
      expect(w.exitCode).toBe(0);
      const written = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'));
      for (const role of PLAN_ROLES) expect(written.model_overrides[role]).toBe('opus');
    });
  });

  test('phase plan=default removes exactly the plan-group keys, preserving others', () => {
    withRoot((root) => {
      run(['set', 'model_overrides', '{"writer":"sonnet"}'], root);
      run(['phase', 'plan=opus', 'implement=sonnet'], root);
      const w = run(['phase', 'plan=default'], root);
      expect(w.exitCode).toBe(0);
      const written = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'));
      for (const role of PLAN_ROLES) expect(written.model_overrides[role]).toBeUndefined();
      expect(written.model_overrides.executor).toBe('sonnet');       // implement group untouched
      expect(written.model_overrides['deep-executor']).toBe('sonnet');
      expect(written.model_overrides.writer).toBe('sonnet');         // unrelated override preserved
    });
  });

  test('multiple assignments in one call', () => {
    withRoot((root) => {
      const w = run(['phase', 'plan=opus', 'implement=sonnet', 'review=opus'], root);
      expect(w.exitCode).toBe(0);
      const written = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'));
      expect(written.model_overrides.architect).toBe('opus');
      expect(written.model_overrides.executor).toBe('sonnet');
      expect(written.model_overrides.reviewer).toBe('opus');
    });
  });

  test('invalid slot fails with non-zero exit and no write', () => {
    withRoot((root) => {
      const w = run(['phase', 'bogus=opus'], root);
      expect(w.exitCode).not.toBe(0);
      expect(w.stdout + w.stderr).toContain('bogus');
      expect(existsSync(join(root, 'config.json'))).toBe(false);
    });
  });

  test('invalid model fails with non-zero exit', () => {
    withRoot((root) => {
      const w = run(['phase', 'plan=gpt5'], root);
      expect(w.exitCode).not.toBe(0);
      expect(w.stdout + w.stderr).toContain('haiku, sonnet, opus, inherit, default');
    });
  });

  test('bare phase prints the resolved matrix with all three slot headers', () => {
    withRoot((root) => {
      // Write directly — `set model_profile` triggers the SKILL frontmatter
      // sync tool, which would rewrite repo files as a test side effect.
      writeFileSync(join(root, 'config.json'), JSON.stringify({ model_profile: 'economy' }));
      const w = run(['phase'], root);
      expect(w.exitCode).toBe(0);
      expect(w.stdout).toContain('plan');
      expect(w.stdout).toContain('implement');
      expect(w.stdout).toContain('review');
      expect(w.stdout).toContain('economy');
    });
  });
});

describe('xm config CLI', () => {
  test('set then get round-trips a scalar (with type coercion)', () => {
    withRoot((root) => {
      const w = run(['set', 'agent_max_count', '8'], root);
      expect(w.exitCode).toBe(0);
      const written = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'));
      expect(written.agent_max_count).toBe(8); // coerced to number, not "8"

      const r = run(['get', 'agent_max_count'], root);
      expect(r.stdout.trim()).toBe('8');
    });
  });

  test('set writes nested dotted keys', () => {
    withRoot((root) => {
      run(['set', 'budget.max_usd', '5'], root);
      const written = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'));
      expect(written.budget.max_usd).toBe(5);
    });
  });

  test('reset clears config to empty object', () => {
    withRoot((root) => {
      run(['set', 'mode', 'normal'], root);
      const w = run(['reset'], root);
      expect(w.exitCode).toBe(0);
      const written = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'));
      expect(written).toEqual({});
    });
  });

  test('show renders effective config', () => {
    withRoot((root) => {
      const r = run(['show'], root);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('Effective');
    });
  });

  test('unknown subcommand prints usage', () => {
    withRoot((root) => {
      const r = run(['bogus'], root);
      expect(r.stdout + r.stderr).toContain('Usage');
    });
  });

  test('prototype-pollution keys are rejected', () => {
    withRoot((root) => {
      run(['set', '__proto__.polluted', 'yes'], root);
      expect({}.polluted).toBeUndefined();
    });
  });
});

// ── get/show consistency (t2) ──────────────────────────────────────────
//
// These scenarios need a real global (~/.xm) AND local (.xm) layer to exist at
// once. XM_ROOT collapses both into one file, so instead we isolate HOME (drives
// os.homedir() → global) and cwd (drives the local .xm/ lookup) and run WITHOUT
// XM_ROOT so readSharedConfig performs its default → global → local merge.

function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

// Extract the `mode` value from the `Effective (merged)` block of `show` output.
function effectiveMode(showStdout) {
  const clean = stripAnsi(showStdout);
  const idx = clean.indexOf('Effective');
  const section = idx >= 0 ? clean.slice(idx) : clean;
  const m = section.match(/mode:\s*(\S+)/);
  return m ? m[1] : null;
}

function withHomeAndProject(fn) {
  const base = mkdtempSync(join(tmpdir(), 'xm-config-merged-'));
  const home = join(base, 'home');
  const proj = join(base, 'proj');
  mkdirSync(join(home, '.xm'), { recursive: true });
  mkdirSync(join(proj, '.xm'), { recursive: true });
  try {
    return fn({ home, proj });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

function writeXmConfig(root, obj) {
  writeFileSync(join(root, '.xm', 'config.json'), JSON.stringify(obj));
}

function runIn(args, { home, cwd }) {
  const env = { ...process.env, HOME: home, XM_LANG: 'ko' };
  delete env.XM_ROOT; // force the merged (non-collapsed) read path
  const result = spawnSync('node', [CLI_PATH, ...args], {
    env, cwd, encoding: 'utf8', timeout: 10000,
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status ?? 1,
  };
}

describe('xm config get/show consistency (t2)', () => {
  test('get <key> (no flag) equals show Effective when local overrides global', () => {
    withHomeAndProject(({ home, proj }) => {
      writeXmConfig(home, { mode: 'developer' }); // global
      writeXmConfig(proj, { mode: 'normal' });     // local wins in the merge

      const g = runIn(['get', 'mode'], { home, cwd: proj });
      const s = runIn(['show'], { home, cwd: proj });

      expect(g.exitCode).toBe(0);
      // Before the fix this returned 'developer' (global-only) while show said
      // 'normal' — the two disagreed on the same key.
      expect(g.stdout.trim()).toBe('normal');
      expect(effectiveMode(s.stdout)).toBe('normal');
      expect(g.stdout.trim()).toBe(effectiveMode(s.stdout));
    });
  });

  test('get (no flag) annotates the source tier on stderr, value stays clean on stdout', () => {
    withHomeAndProject(({ home, proj }) => {
      writeXmConfig(home, { mode: 'developer' });
      writeXmConfig(proj, { mode: 'normal' });

      const g = runIn(['get', 'mode'], { home, cwd: proj });
      expect(g.stdout.trim()).toBe('normal');        // machine-parseable value only
      expect(stripAnsi(g.stderr)).toContain('(local)'); // source is user-visible
    });
  });

  test('get --global / --local keep tier-only behavior (back-compat)', () => {
    withHomeAndProject(({ home, proj }) => {
      writeXmConfig(home, { mode: 'developer' });
      writeXmConfig(proj, { mode: 'normal' });

      // --global reads only the global tier (developer), distinct from the merged
      // no-flag result (normal) — proving the flag still selects a single tier.
      expect(runIn(['get', 'mode', '--global'], { home, cwd: proj }).stdout.trim()).toBe('developer');
      // --local preserves the historical (pre-fix) resolveScope read.
      expect(runIn(['get', 'mode', '--local'], { home, cwd: proj }).stdout.trim()).toBe('normal');
    });
  });

  test('get (no flag) reports (default) source when the key is unset in both tiers', () => {
    withHomeAndProject(({ home, proj }) => {
      writeXmConfig(home, {});
      writeXmConfig(proj, {});
      const g = runIn(['get', 'mode'], { home, cwd: proj });
      expect(g.stdout.trim()).toBe('developer');       // DEFAULT_CONFIG.mode
      expect(stripAnsi(g.stderr)).toContain('(default)');
    });
  });
});

describe('xm config set schema validation (t2)', () => {
  test('unregistered key warns but still saves (back-compat)', () => {
    withRoot((root) => {
      const w = run(['set', 'foobar', '123'], root);
      expect(w.exitCode).toBe(0);
      expect(stripAnsi(w.stdout)).toContain('미등록');
      const written = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'));
      expect(written.foobar).toBe(123); // save still happened
    });
  });

  test('enum mismatch warns with the allowed values but still saves', () => {
    withRoot((root) => {
      const w = run(['set', 'mode', 'weird'], root);
      expect(w.exitCode).toBe(0);
      const out = stripAnsi(w.stdout);
      expect(out).toContain('developer');
      expect(out).toContain('normal');
      expect(out).toContain('weird');
      const written = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'));
      expect(written.mode).toBe('weird');
    });
  });

  test('type mismatch warns but still saves', () => {
    withRoot((root) => {
      // 'abc' cannot coerce to a number, so it stays a string against integer schema.
      const w = run(['set', 'agent_max_count', 'abc'], root);
      expect(w.exitCode).toBe(0);
      expect(stripAnsi(w.stdout)).toContain('타입 불일치');
      const written = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'));
      expect(written.agent_max_count).toBe('abc');
    });
  });

  test('valid value against schema produces no warning', () => {
    withRoot((root) => {
      const w = run(['set', 'mode', 'normal'], root);
      expect(w.exitCode).toBe(0);
      expect(stripAnsi(w.stdout)).not.toContain('⚠');
      expect(stripAnsi(w.stdout)).not.toContain('허용값');
    });
  });
});

// ── non-TTY guard (t3 / FM6) ────────────────────────────────────────────
//
// The bare (no-subcommand) invocation enters the interactive wizard. Under a
// piped/redirected stdin the wizard's readline never resolves on EOF, leaving
// the entry point's top-level await unsettled (Node exit 13 — a silent failure).
// The guard must convert that into an explicit exit 1 + usage. spawnSync already
// gives the child a piped (non-TTY) stdin, so `run([])` reproduces the case.

describe('xm config non-TTY guard (t3)', () => {
  test('bare invocation without a TTY exits 1 with subcommand usage', () => {
    withRoot((root) => {
      const w = run([], root); // no subcommand → wizard entry, stdin is non-TTY
      expect(w.exitCode).toBe(1);
      const out = stripAnsi(w.stdout + w.stderr);
      // Usage lists the representative non-interactive subcommands (R3 / FM6).
      expect(out).toContain('xm config show');
      expect(out).toContain('xm config get <key>');
      expect(out).toContain('xm config set <key> <value>');
      expect(out).toContain('xm config phase plan=opus');
      // The wizard menu must NOT render — the guard fired before createRL().
      expect(out).not.toContain('설정할 항목을 선택하세요');
    });
  });

  test('XM_CONFIG_WIZARD_STDIN=1 bypasses the guard and the wizard consumes piped stdin', () => {
    withRoot((root) => {
      // '0' is the wizard's "나가기(exit)" menu item, so a bypassed wizard reads
      // the piped line, matches no config branch, closes readline, exits cleanly.
      const result = spawnSync('node', [CLI_PATH], {
        env: { ...process.env, XM_ROOT: root, XM_CONFIG_WIZARD_STDIN: '1', XM_LANG: 'ko' },
        input: '0\n',
        encoding: 'utf8',
        timeout: 10000,
      });
      expect(result.status).toBe(0);
      // Proof the guard was bypassed: the wizard menu actually rendered.
      expect(stripAnsi(result.stdout ?? '')).toContain('설정할 항목을 선택하세요');
    });
  });
});

// ── interactive wizard core (t4) ────────────────────────────────────────
//
// The wizard is a while-loop category menu with a per-item write-scope engine.
// These scenarios drive it via piped stdin under XM_CONFIG_WIZARD_STDIN=1 (the
// t3 test-only guard bypass). Menu path per line:
//   main: 1=모델 3=실행 0=나가기 · model: 1=프로필 2=오버라이드 3=페이즈 0=뒤로
//   scope: 1=global 2=local Enter=제안

// XM_ROOT collapses global/local into one file — enough for menu-flow, EOF, and
// validation scenarios that don't need to tell the two tiers apart.
function runWizard(input, root) {
  const result = spawnSync('node', [CLI_PATH], {
    env: { ...process.env, XM_ROOT: root, XM_CONFIG_WIZARD_STDIN: '1', XM_LANG: 'ko' },
    input, encoding: 'utf8', timeout: 10000,
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status ?? 1,
  };
}

// Scope-sensitive scenarios need distinct global (~/.xm via HOME) and local
// (.xm via cwd) files, so drop XM_ROOT and isolate HOME + cwd like the t2 tests.
function runWizardIn(input, { home, cwd }) {
  const env = { ...process.env, HOME: home, XM_CONFIG_WIZARD_STDIN: '1', XM_LANG: 'ko' };
  delete env.XM_ROOT;
  const result = spawnSync('node', [CLI_PATH], {
    env, cwd, input, encoding: 'utf8', timeout: 10000,
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status ?? 1,
  };
}

describe('xm config interactive wizard (t4)', () => {
  test('menu → 모델 → 역할 오버라이드 편집 → 종료 saves and exits cleanly', () => {
    withRoot((root) => {
      // 모델(1) → 오버라이드(2) → scope global(1) → reviewer=opus → Enter(끝) → 뒤로(0) → 나가기(0)
      const w = runWizard('1\n2\n1\nreviewer=opus\n\n0\n0\n', root);
      expect(w.exitCode).toBe(0);
      const out = stripAnsi(w.stdout);
      expect(out).toContain('설정할 항목을 선택하세요'); // main menu rendered
      expect(out).toContain('모델 설정');               // category submenu rendered
      const written = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'));
      expect(written.model_overrides.reviewer).toBe('opus');
      // Exit summary lists the saved item (FM3).
      const summaryIdx = out.indexOf('설정 요약');
      expect(summaryIdx).toBeGreaterThan(-1);
      expect(out.slice(summaryIdx)).toContain('reviewer');
    });
  });

  test('모델 항목을 local 스코프로 저장 가능 (global 하드코딩 제거)', () => {
    withHomeAndProject(({ home, proj }) => {
      // 모델(1) → 오버라이드(2) → scope LOCAL(2) → architect=opus → Enter → 뒤로 → 나가기
      const w = runWizardIn('1\n2\n2\narchitect=opus\n\n0\n0\n', { home, cwd: proj });
      expect(w.exitCode).toBe(0);
      // Landed in the project (local) file...
      const local = JSON.parse(readFileSync(join(proj, '.xm', 'config.json'), 'utf8'));
      expect(local.model_overrides.architect).toBe('opus');
      // ...and NOT in global — the old wizard hard-coded { global: true } here.
      const globalPath = join(home, '.xm', 'config.json');
      const global = existsSync(globalPath) ? JSON.parse(readFileSync(globalPath, 'utf8')) : {};
      expect(global.model_overrides).toBeUndefined();
    });
  });

  test('local override 존재 시 global 쓰기 전 무효화 경고 후 계속 저장', () => {
    withHomeAndProject(({ home, proj }) => {
      writeXmConfig(proj, { agent_max_count: 2 }); // local shadows the global write
      writeXmConfig(home, {});
      // 실행(3) → 8 → scope global(1) → 경고 → 계속(y) → 나가기(0)
      const w = runWizardIn('3\n8\n1\ny\n0\n', { home, cwd: proj });
      expect(w.exitCode).toBe(0);
      const out = stripAnsi(w.stdout);
      expect(out).toContain('override 중');
      expect(out).toContain('effective 값에 반영되지 않습니다');
      // User confirmed → the (shadowed) global write still happened...
      const global = JSON.parse(readFileSync(join(home, '.xm', 'config.json'), 'utf8'));
      expect(global.agent_max_count).toBe(8);
      // ...while the local value that shadows it is untouched.
      const local = JSON.parse(readFileSync(join(proj, '.xm', 'config.json'), 'utf8'));
      expect(local.agent_max_count).toBe(2);
    });
  });

  test('EOF 중단 시 이미 저장된 항목 유지 + 요약 출력 (FM3)', () => {
    withRoot((root) => {
      // 실행(3) → 6 → scope(1) → save, then stdin ends before the next menu prompt.
      const w = runWizard('3\n6\n1\n', root);
      expect(w.exitCode).toBe(0); // EOF is caught, not a crash
      const out = stripAnsi(w.stdout);
      expect(out).toContain('입력 종료');
      // The item saved before EOF is on disk.
      const written = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'));
      expect(written.agent_max_count).toBe(6);
      // And the exit summary still ran, naming the saved item.
      const summaryIdx = out.indexOf('설정 요약');
      expect(summaryIdx).toBeGreaterThan(-1);
      expect(out.slice(summaryIdx)).toContain('agent_max_count');
    });
  });

  test('잘못된 입력 3회 시 항목 취소 후 메뉴 복귀, 저장 없음 (FM4)', () => {
    withRoot((root) => {
      // 실행(3) → 99(>max) → abc(type) → -1(<min) → 3회 실패 취소 → 나가기(0)
      const w = runWizard('3\n99\nabc\n-1\n0\n', root);
      expect(w.exitCode).toBe(0);
      const out = stripAnsi(w.stdout);
      expect(out).toContain('최댓값 10 초과');   // enum/range guidance re-asks
      expect(out).toContain('타입 불일치');
      expect(out).toContain('3회 입력 실패');
      // Nothing was written for the cancelled item.
      const written = existsSync(join(root, 'config.json'))
        ? JSON.parse(readFileSync(join(root, 'config.json'), 'utf8')) : {};
      expect(written.agent_max_count).toBeUndefined();
    });
  });
});

// ── vendor mapping wizard category (t4 / R4) ────────────────────────────
//
// The vendor category lives under the model category (main:1 → model:4 → vendor).
// It edits vendor_models.<vendor>.<tier> overrides (layered on cost-engine's
// builtin VENDOR_MODELS) and vendor_profiles. Install detection reuses x-panel's
// isAvailable via a dual-path dynamic import; the X_PANEL_CMD_<VENDOR> env override
// makes isAvailable resolve to existsSync(<path>), so pointing a vendor at a
// non-existent path deterministically renders it as "미감지" without touching PATH.
// Menu path (line mode, XM_CONFIG_WIZARD_STDIN=1):
//   main: 1=모델  ·  model: 4=vendor  ·  vendor: 1=claude 2=codex 3=profiles 0=뒤로
//   tier: 1=haiku 2=sonnet 3=opus 0=뒤로

// Wizard runner that can inject extra env (e.g. X_PANEL_CMD_* detection overrides).
function runVendorWizard(input, root, extraEnv = {}) {
  const result = spawnSync('node', [CLI_PATH], {
    env: { ...process.env, XM_ROOT: root, XM_CONFIG_WIZARD_STDIN: '1', XM_LANG: 'ko', ...extraEnv },
    input, encoding: 'utf8', timeout: 10000,
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status ?? 1,
  };
}

describe('xm config vendor mapping wizard (t4)', () => {
  test('vendor_models.codex.sonnet 편집 → config에 verbatim 저장 (DoD)', () => {
    withRoot((root) => {
      // 모델(1) → vendor(4) → codex(2) → sonnet(2) → gpt-5.4 → scope global(1)
      //   → tier 뒤로(0) → vendor 뒤로(0) → 모델 뒤로(0) → 나가기(0)
      const w = runVendorWizard('1\n4\n2\n2\ngpt-5.4\n1\n0\n0\n0\n0\n', root);
      expect(w.exitCode).toBe(0);
      const written = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'));
      // Stored verbatim under the nested vendor.tier path (no coercion).
      expect(written.vendor_models.codex.sonnet).toBe('gpt-5.4');
      // Exit summary names the saved nested key (FM3 item-level save).
      const out = stripAnsi(w.stdout);
      const summaryIdx = out.indexOf('설정 요약');
      expect(summaryIdx).toBeGreaterThan(-1);
      expect(out.slice(summaryIdx)).toContain('vendor_models.codex.sonnet');
    });
  });

  test('model[:effort] 접미사(valid)는 그대로 저장', () => {
    withRoot((root) => {
      // codex.opus = gpt-5.5:high (effort suffix valid → stored verbatim)
      const w = runVendorWizard('1\n4\n2\n3\ngpt-5.5:high\n1\n0\n0\n0\n0\n', root);
      expect(w.exitCode).toBe(0);
      const written = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'));
      expect(written.vendor_models.codex.opus).toBe('gpt-5.5:high');
    });
  });

  test('미설치 vendor는 "미감지"로 표시되지만 선택 가능 (감지 경로)', () => {
    withRoot((root) => {
      // X_PANEL_CMD_CODEX points at a non-existent path → isAvailable('codex')
      // === existsSync(path) === false, so codex renders as 미감지 regardless of PATH.
      // Just enter the vendor menu and exit: 모델(1) → vendor(4) → 뒤로(0) → 뒤로(0) → 나가기(0)
      const w = runVendorWizard('1\n4\n0\n0\n0\n', root, {
        X_PANEL_CMD_CODEX: join(root, 'no-such-codex-binary'),
      });
      expect(w.exitCode).toBe(0);
      const out = stripAnsi(w.stdout);
      expect(out).toContain('codex: 미감지');
      // The undetected row still renders in the menu (editable, not gated out).
      expect(out).toContain('vendor 모델 매핑');
      // Entering the menu writes nothing.
      expect(existsSync(join(root, 'config.json'))).toBe(false);
    });
  });

  test('effort 오타는 vendor.effort_unknown 경고 후 재질문, 3회 실패 시 취소 (FM4)', () => {
    withRoot((root) => {
      // codex → sonnet → 잘못된 effort x3 → 취소 → 메뉴 복귀 → 나가기
      const w = runVendorWizard('1\n4\n2\n2\ngpt:hihg\ngpt:hihg\ngpt:hihg\n0\n0\n0\n0\n', root);
      expect(w.exitCode).toBe(0);
      const out = stripAnsi(w.stdout);
      expect(out).toContain("알 수 없는 effort 'hihg'"); // vendor.effort_unknown
      expect(out).toContain('3회 입력 실패');             // common.max_attempts
      // Nothing saved for the cancelled item — a bad effort must never persist.
      const written = existsSync(join(root, 'config.json'))
        ? JSON.parse(readFileSync(join(root, 'config.json'), 'utf8')) : {};
      expect(written.vendor_models).toBeUndefined();
    });
  });

  test("'clear'는 해당 tier 오버라이드만 제거하고 빈 vendor를 정리", () => {
    withRoot((root) => {
      // Seed two overrides; clearing opus must prune opus but keep sonnet.
      writeFileSync(join(root, 'config.json'), JSON.stringify({
        vendor_models: { codex: { sonnet: 'gpt-5.4', opus: 'gpt-5.5:high' } },
      }));
      // codex(2) → opus(3) → clear → scope global(1) → 뒤로 → 뒤로 → 나가기
      const w = runVendorWizard('1\n4\n2\n3\nclear\n1\n0\n0\n0\n0\n', root);
      expect(w.exitCode).toBe(0);
      const written = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'));
      expect(written.vendor_models.codex.opus).toBeUndefined(); // cleared
      expect(written.vendor_models.codex.sonnet).toBe('gpt-5.4'); // sibling preserved
    });
  });

  test('clear가 마지막 오버라이드를 지우면 빈 vendor 서브객체를 제거', () => {
    withRoot((root) => {
      writeFileSync(join(root, 'config.json'), JSON.stringify({
        vendor_models: { codex: { opus: 'gpt-5.5:high' } },
      }));
      const w = runVendorWizard('1\n4\n2\n3\nclear\n1\n0\n0\n0\n0\n', root);
      expect(w.exitCode).toBe(0);
      const written = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'));
      // codex sub-object pruned once its last tier override is gone.
      expect(written.vendor_models.codex).toBeUndefined();
    });
  });

  test('vendor_profiles: codex=economy 저장, del로 제거', () => {
    withRoot((root) => {
      // 모델(1) → vendor(4) → profiles(3) → scope global(1) → codex=economy → Enter(끝)
      //   → vendor 뒤로(0) → 모델 뒤로(0) → 나가기(0)
      const w = runVendorWizard('1\n4\n3\n1\ncodex=economy\n\n0\n0\n0\n', root);
      expect(w.exitCode).toBe(0);
      const written = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'));
      expect(written.vendor_profiles.codex).toBe('economy');
    });
  });

  test('vendor_profiles: 잘못된 프로필 값은 재질문하고 저장하지 않음', () => {
    withRoot((root) => {
      // profiles → scope → codex=turbo(허용 밖) → Enter(끝) → 뒤로 → 뒤로 → 나가기
      const w = runVendorWizard('1\n4\n3\n1\ncodex=turbo\n\n0\n0\n0\n', root);
      expect(w.exitCode).toBe(0);
      const written = existsSync(join(root, 'config.json'))
        ? JSON.parse(readFileSync(join(root, 'config.json'), 'utf8')) : {};
      // 'turbo' is not economy/default/max → nothing written.
      expect(written.vendor_profiles).toBeUndefined();
    });
  });
});

// ── worktree 3-tier category (t5) ───────────────────────────────────────
//
// The worktree category resolves worktree.* through worktree-shared.mjs's
// loadWorktreeConfig (build-local `.xm/build/config.json` > shared `.xm/config.json`
// > global `~/.xm/config.json` > defaults). These scenarios drive the wizard via
// piped stdin under XM_CONFIG_WIZARD_STDIN=1 (t3 guard bypass). Menu path:
//   main: 5=worktree 0=나가기
//   worktree: 1-10=scalar key  11=gate_policy  0=뒤로
//   scalar key: value → tier[1=build-local 2=shared 3=global]
//
// Under XM_ROOT the shared/global tiers collapse into one file, but build-local
// ($XM_ROOT/build/config.json) stays distinct — enough to prove build-local
// isolation and the resolver-backed effective merge.

// Read `worktree` from a config file, tolerating absence.
function readWorktree(path) {
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, 'utf8')).worktree;
}

describe('xm config worktree category (t5)', () => {
  test('worktree.max_parallel을 build-local tier에 기록 → .xm/build/config.json에만 반영 (DoD)', () => {
    withRoot((root) => {
      // worktree(5) → max_parallel(4) → 9 → tier build-local(1) → 뒤로(0) → 나가기(0)
      const w = runWizard('5\n4\n9\n1\n0\n0\n', root);
      expect(w.exitCode).toBe(0);

      // Landed in the build-local file only.
      const buildLocal = readWorktree(join(root, 'build', 'config.json'));
      expect(buildLocal.max_parallel).toBe(9);

      // The shared file did NOT receive the key (build-local write is isolated).
      const shared = readWorktree(join(root, 'config.json'));
      expect(shared?.max_parallel).toBeUndefined();
    });
  });

  test('테이블 effective 병합이 worktree-shared resolver와 일치 (DoD)', () => {
    withRoot((root) => {
      // build-local overrides max_parallel; shared supplies base.
      mkdirSync(join(root, 'build'), { recursive: true });
      writeFileSync(join(root, 'build', 'config.json'), JSON.stringify({ worktree: { max_parallel: 9 } }));
      writeFileSync(join(root, 'config.json'), JSON.stringify({ worktree: { max_parallel: 3, base: 'main' } }));

      // worktree(5) → 뒤로(0) → 나가기(0): print the table, then exit.
      const w = runWizard('5\n0\n0\n', root);
      expect(w.exitCode).toBe(0);
      const out = stripAnsi(w.stdout);
      // build-local wins max_parallel; shared supplies base.
      expect(out).toMatch(/max_parallel\s+9 \(build-local\)/);
      expect(out).toMatch(/base\s+main \(shared\)/);

      // Prove the wizard's effective equals the resolver's own output.
      const prev = process.env.XM_ROOT;
      process.env.XM_ROOT = root;
      try {
        const eff = loadWorktreeConfig({ buildRootDir: join(root, 'build') });
        expect(eff.max_parallel).toBe(9);
        expect(eff.base).toBe('main');
      } finally {
        if (prev === undefined) delete process.env.XM_ROOT; else process.env.XM_ROOT = prev;
      }
    });
  });

  test('build-local이 가리는 키를 shared에 쓰면 shadow 경고 후 취소 가능 (3-tier confirmShadow)', () => {
    withRoot((root) => {
      mkdirSync(join(root, 'build'), { recursive: true });
      writeFileSync(join(root, 'build', 'config.json'), JSON.stringify({ worktree: { max_parallel: 9 } }));

      // worktree(5) → max_parallel(4) → 5 → tier shared(2) → shadow 경고 → 거절(n) → 뒤로(0) → 나가기(0)
      const w = runWizard('5\n4\n5\n2\nn\n0\n0\n', root);
      expect(w.exitCode).toBe(0);
      const out = stripAnsi(w.stdout);
      expect(out).toContain('override 중');
      expect(out).toContain('effective 값에 반영되지 않습니다');

      // Declined → shared did not get the shadowed write; build-local unchanged.
      const shared = readWorktree(join(root, 'config.json'));
      expect(shared?.max_parallel).toBeUndefined();
      expect(readWorktree(join(root, 'build', 'config.json')).max_parallel).toBe(9);
    });
  });

  test('gate_policy 서브키는 per-key로 저장되고 형제 severity 목록은 병합으로 유지', () => {
    withRoot((root) => {
      // worktree(5) → gate_policy(13, 스칼라 12개 뒤) → block_confirmed(1) → "1 2"(critical,high) → tier build-local(1) → 뒤로(0) → 나가기(0)
      const w = runWizard('5\n13\n1\n1 2\n1\n0\n0\n', root);
      expect(w.exitCode).toBe(0);

      // Only block_confirmed was written to disk — siblings are NOT materialized.
      const gp = readWorktree(join(root, 'build', 'config.json')).gate_policy;
      expect(gp).toEqual({ block_confirmed: ['critical', 'high'] });

      // The resolver still merges the untouched siblings from defaults (per-key merge).
      const prev = process.env.XM_ROOT;
      process.env.XM_ROOT = root;
      try {
        const eff = loadWorktreeConfig({ buildRootDir: join(root, 'build') }).gate_policy;
        expect(eff.block_confirmed).toEqual(['critical', 'high']);        // our write
        expect(eff.block_unreviewed).toEqual(['critical', 'high']);       // default, preserved
        expect(eff.allow_low).toBe(true);                                 // default, preserved
      } finally {
        if (prev === undefined) delete process.env.XM_ROOT; else process.env.XM_ROOT = prev;
      }
    });
  });

  test("gate_phase는 config-schema enum이 아닌 gate-panel VALID_PHASES(before/after/release)로 'release' 허용", () => {
    withRoot((root) => {
      // worktree(5) → gate_phase(6) → release(3) → tier build-local(1) → 뒤로(0) → 나가기(0)
      const w = runWizard('5\n6\n3\n1\n0\n0\n', root);
      expect(w.exitCode).toBe(0);
      const buildLocal = readWorktree(join(root, 'build', 'config.json'));
      expect(buildLocal.gate_phase).toBe('release');
    });
  });
});

// ── budget / gates / misc / panel categories (t9) ───────────────────────
//
// These four categories complete the wizard's placeholders. They reuse the t4
// scope engine (chooseScope/confirmShadow/saveKey) and t5 category style. Driven
// via piped stdin under XM_CONFIG_WIZARD_STDIN=1 (t3 guard bypass). Menu paths:
//   main: 2=예산 4=게이트 6=기타 7=panel 0=나가기
//   budget:  1=max_usd 2=window_hours 3=projects 0=뒤로
//   gates:   1-5=(research/plan/execute/verify/close)-exit 0=뒤로
//   misc:    1=mode 2=drift 3=scan_roots 4=pipelines 0=뒤로
//   panel:   read-only (no submenu)

describe('xm config budget category (t9)', () => {
  test('budget.window_hours를 local 스코프로 저장 → 프로젝트 .xm/config.json에 기록 (DoD)', () => {
    withHomeAndProject(({ home, proj }) => {
      // 예산(2) → 윈도우(2) → 48 → scope local(2) → 뒤로(0) → 나가기(0)
      const w = runWizardIn('2\n2\n48\n2\n0\n0\n', { home, cwd: proj });
      expect(w.exitCode).toBe(0);
      const local = JSON.parse(readFileSync(join(proj, '.xm', 'config.json'), 'utf8'));
      expect(local.budget.window_hours).toBe(48);
      // global untouched — budget.* defaults to the local tier (schema scope).
      const globalPath = join(home, '.xm', 'config.json');
      const global = existsSync(globalPath) ? JSON.parse(readFileSync(globalPath, 'utf8')) : {};
      expect(global.budget).toBeUndefined();
    });
  });

  test('budget.max_usd에 0을 입력하면 무제한(null)으로 저장', () => {
    withRoot((root) => {
      // 예산(2) → max_usd(1) → 0 → scope(Enter=local) → 뒤로(0) → 나가기(0)
      const w = runWizard('2\n1\n0\n\n0\n0\n', root);
      expect(w.exitCode).toBe(0);
      const written = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'));
      expect(written.budget.max_usd).toBeNull();
    });
  });

  test('budget.projects는 행 단위로 추가/삭제되고 형제 프로젝트는 병합으로 유지', () => {
    withRoot((root) => {
      // 예산(2) → projects(3) → scope(Enter) → web=5 → api=2 → del web → Enter(끝) → 뒤로(0) → 나가기(0)
      const w = runWizard('2\n3\n\nweb=5\napi=2\ndel web\n\n0\n0\n', root);
      expect(w.exitCode).toBe(0);
      const projects = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8')).budget.projects;
      // web deleted, api survives with its own cap (per-key edit, not wholesale).
      expect(projects).toEqual({ api: { max_usd: 2 } });
    });
  });
});

describe('xm config gates category (t9)', () => {
  test('gates.plan-exit를 global 스코프로 편집 (DoD)', () => {
    withHomeAndProject(({ home, proj }) => {
      // 게이트(4) → plan-exit(2) → auto(1) → scope global(1) → 뒤로(0) → 나가기(0)
      const w = runWizardIn('4\n2\n1\n1\n0\n0\n', { home, cwd: proj });
      expect(w.exitCode).toBe(0);
      const global = JSON.parse(readFileSync(join(home, '.xm', 'config.json'), 'utf8'));
      expect(global.gates['plan-exit']).toBe('auto');
      // local untouched — gates.* defaults to global (schema scope).
      const localPath = join(proj, '.xm', 'config.json');
      const local = existsSync(localPath) ? JSON.parse(readFileSync(localPath, 'utf8')) : {};
      expect(local.gates).toBeUndefined();
    });
  });

  test('게이트 enum 밖의 값은 재질문 (auto/human-verify/quality)', () => {
    withRoot((root) => {
      // 게이트(4) → research-exit(1) → human-verify(2) → scope(Enter) → 뒤로(0) → 나가기(0)
      const w = runWizard('4\n1\n2\n\n0\n0\n', root);
      expect(w.exitCode).toBe(0);
      const written = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'));
      expect(written.gates['research-exit']).toBe('human-verify');
    });
  });
});

describe('xm config misc category (t9)', () => {
  test('pipelines 깨진 JSON은 재질문하고 저장하지 않음 (FM4)', () => {
    withRoot((root) => {
      // 기타(6) → pipelines(4) → 깨진 JSON x3 → 취소 → 뒤로(0) → 나가기(0)
      const w = runWizard('6\n4\n{bad\n{"still":bad}\nnope\n0\n0\n', root);
      expect(w.exitCode).toBe(0);
      const out = stripAnsi(w.stdout);
      expect(out).toContain('JSON 파싱 실패');
      expect(out).toContain('3회 입력 실패');
      // Nothing was written — a broken paste must never silently save (coerceValue
      // is deliberately bypassed for pipelines).
      const written = existsSync(join(root, 'config.json'))
        ? JSON.parse(readFileSync(join(root, 'config.json'), 'utf8')) : {};
      expect(written.pipelines).toBeUndefined();
    });
  });

  test('pipelines 유효한 JSON 객체는 파싱되어 저장됨', () => {
    withRoot((root) => {
      // 기타(6) → pipelines(4) → 유효 JSON → scope(Enter) → 뒤로(0) → 나가기(0)
      const w = runWizard('6\n4\n{"review":["x-review","x-eval"]}\n\n0\n0\n', root);
      expect(w.exitCode).toBe(0);
      const written = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'));
      expect(written.pipelines).toEqual({ review: ['x-review', 'x-eval'] });
    });
  });

  test('pipelines에 JSON 배열/스칼라를 주면 객체가 아니라며 재질문', () => {
    withRoot((root) => {
      // 기타(6) → pipelines(4) → 배열 → 스칼라 → 문자열 → 3회 실패 → 뒤로(0) → 나가기(0)
      const w = runWizard('6\n4\n[1,2]\n42\n"x"\n0\n0\n', root);
      expect(w.exitCode).toBe(0);
      const out = stripAnsi(w.stdout);
      expect(out).toContain('JSON 객체여야 합니다');
      const written = existsSync(join(root, 'config.json'))
        ? JSON.parse(readFileSync(join(root, 'config.json'), 'utf8')) : {};
      expect(written.pipelines).toBeUndefined();
    });
  });

  test('scan_roots는 경로를 추가하고 번호로 삭제', () => {
    withRoot((root) => {
      // 기타(6) → scan_roots(3) → scope(Enter) → /a/b → /c/d → del 1 → Enter(끝) → 뒤로(0) → 나가기(0)
      const w = runWizard('6\n3\n\n/a/b\n/c/d\ndel 1\n\n0\n0\n', root);
      expect(w.exitCode).toBe(0);
      const written = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'));
      expect(written.scan_roots).toEqual(['/c/d']);
    });
  });

  test('mode를 normal로 편집', () => {
    withRoot((root) => {
      // 기타(6) → mode(1) → normal(2) → scope(Enter) → 뒤로(0) → 나가기(0)
      const w = runWizard('6\n1\n2\n\n0\n0\n', root);
      expect(w.exitCode).toBe(0);
      const written = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'));
      expect(written.mode).toBe('normal');
    });
  });
});

// ── panel category (t9) — now EDITABLE (models/judge delegate to `xm panel
// setup`; timeout_s / model_overrides are direct writes) ─────────────────────
//
// The old policy (read-only, no submenu) was replaced by a user decision to allow
// editing from BOTH the wizard and `xm panel setup`, without duplicating panel's
// validation. Delegation is exercised via XM_PANEL_SETUP_STUB: pointing it at the
// real x-panel-cli.mjs runs the actual setup (verifying config reflection + panel's
// per-key merge), pointing it at a recorder verifies the delegated argv (--global).
// Menu path (line mode): main 7=panel · panel: 1=models 2=judge 3=timeout_s
//   4=model_overrides 0=뒤로 · scope: 1=global 2=local.
const PANEL_CLI = join(__dirname, '..', 'x-panel', 'lib', 'x-panel-cli.mjs');

// A stand-in for `xm panel setup` that records the argv it was spawned with (so a
// test can assert --models / --global) and prints a setup-shaped success line so
// the wizard treats the delegation as saved.
const PANEL_RECORDER = `
import { writeFileSync } from 'node:fs';
writeFileSync(process.env.REC_OUT, JSON.stringify(process.argv.slice(2)));
console.log('saved panel defaults -> ' + process.env.REC_OUT);
`;

describe('xm config panel category (t9)', () => {
  test('panel 카테고리는 편집 가능 — 병합 안내를 표시하고 "읽기 전용" 문구가 없다 (신규 계약)', () => {
    withRoot((root) => {
      // panel(7) → 뒤로(0) → 나가기(0). Entering + backing out writes nothing.
      const w = runWizard('7\n0\n0\n', root);
      expect(w.exitCode).toBe(0);
      const out = stripAnsi(w.stdout);
      expect(out).toContain('panel (cross-vendor 프로바이더)'); // editable submenu title
      expect(out).toContain('키 단위 병합');                    // panel.merge_note surfaced
      expect(out).not.toContain('읽기 전용');                   // old read-only wording gone
      // No edit made → no config file, empty summary.
      expect(existsSync(join(root, 'config.json'))).toBe(false);
      expect(out).toContain('변경된 항목 없음');
    });
  });

  test('timeout_s 편집 → panel.timeout_s 직접 저장 (DoD: config 반영)', () => {
    withRoot((root) => {
      // panel(7) → timeout(3) → 300 → scope global(1) → 뒤로(0) → 나가기(0)
      const w = runWizard('7\n3\n300\n1\n0\n0\n', root);
      expect(w.exitCode).toBe(0);
      const written = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'));
      expect(written.panel.timeout_s).toBe(300);
    });
  });

  test('timeout_s min(30) 미만은 재질문 후 유효값 저장', () => {
    withRoot((root) => {
      // panel(7) → timeout(3) → 10(<min, 재질문) → 300(유효) → scope(1) → 뒤로 → 나가기
      const w = runWizard('7\n3\n10\n300\n1\n0\n0\n', root);
      expect(w.exitCode).toBe(0);
      const out = stripAnsi(w.stdout);
      expect(out).toContain('최솟값 30'); // validate.min replayed for the sub-30 input
      const written = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'));
      expect(written.panel.timeout_s).toBe(300);
    });
  });

  test('model_overrides 행 추가/삭제 → 병합 보존 (DoD)', () => {
    withRoot((root) => {
      // panel(7) → overrides(4) → scope global(1) → cursor=kimi-k2.5 → codex=gpt-5.5
      //   → del cursor → Enter(끝) → 뒤로(0) → 나가기(0)
      const w = runWizard('7\n4\n1\ncursor=kimi-k2.5\ncodex=gpt-5.5\ndel cursor\n\n0\n0\n', root);
      expect(w.exitCode).toBe(0);
      const written = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'));
      // cursor removed, codex sibling preserved through the per-key writes.
      expect(written.panel.model_overrides).toEqual({ codex: 'gpt-5.5' });
    });
  });

  test('models 편집은 xm panel setup에 위임되고 panel.models가 반영됨 (실제 CLI 위임)', () => {
    withRoot((root) => {
      // Stub = the real x-panel-cli.mjs → runs the actual `setup` command.
      // panel(7) → models(1) → claude,codex → scope global(1) → 뒤로(0) → 나가기(0)
      const w = runVendorWizard('7\n1\nclaude,codex\n1\n0\n0\n', root, { XM_PANEL_SETUP_STUB: PANEL_CLI });
      expect(w.exitCode).toBe(0);
      const written = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'));
      expect(written.panel.models).toEqual(['claude', 'codex']);
    });
  });

  test('models 위임은 panel의 per-key 병합으로 기존 judge를 보존', () => {
    withRoot((root) => {
      writeFileSync(join(root, 'config.json'), JSON.stringify({ panel: { judge: 'rule' } }));
      const w = runVendorWizard('7\n1\nagy,codex\n1\n0\n0\n', root, { XM_PANEL_SETUP_STUB: PANEL_CLI });
      expect(w.exitCode).toBe(0);
      const written = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'));
      expect(written.panel.judge).toBe('rule');            // untouched sibling
      expect(written.panel.models).toEqual(['agy', 'codex']);
    });
  });

  test('위임 argv 검증 — global 스코프는 --global 포함, local은 미포함 (recorder stub)', () => {
    withRoot((root) => {
      const stub = join(root, 'rec.mjs');
      const recOut = join(root, 'rec.json');
      writeFileSync(stub, PANEL_RECORDER);
      const env = { XM_PANEL_SETUP_STUB: stub, REC_OUT: recOut };

      // global(1)
      runVendorWizard('7\n1\nclaude,codex\n1\n0\n0\n', root, env);
      const gArgs = JSON.parse(readFileSync(recOut, 'utf8'));
      expect(gArgs).toEqual(['setup', '--models', 'claude,codex', '--global']);

      // local(2)
      runVendorWizard('7\n1\nclaude,codex\n2\n0\n0\n', root, env);
      const lArgs = JSON.parse(readFileSync(recOut, 'utf8'));
      expect(lArgs).toEqual(['setup', '--models', 'claude,codex']);
    });
  });

  test('judge 편집: rule 외 값은 확인 질문, 취소 시 위임하지 않음', () => {
    withRoot((root) => {
      const stub = join(root, 'rec.mjs');
      const recOut = join(root, 'rec.json');
      writeFileSync(stub, PANEL_RECORDER);
      // panel(7) → judge(2) → 'llm' → 확인(N) → 뒤로(0) → 나가기(0)
      const w = runVendorWizard('7\n2\nllm\nN\n0\n0\n', root, { XM_PANEL_SETUP_STUB: stub, REC_OUT: recOut });
      expect(w.exitCode).toBe(0);
      const out = stripAnsi(w.stdout);
      expect(out).toContain('알려진 판정기가 아닙니다'); // non-rule confirm prompt
      expect(existsSync(recOut)).toBe(false);           // cancelled → setup never spawned
    });
  });
});

describe('xm config panel.* schema validation (F-panel)', () => {
  test('panel.timeout_s 유효값은 경고 없이 저장', () => {
    withRoot((root) => {
      const w = run(['set', 'panel.timeout_s', '450'], root);
      expect(w.exitCode).toBe(0);
      expect(stripAnsi(w.stdout)).not.toContain('⚠');
      const written = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'));
      expect(written.panel.timeout_s).toBe(450);
    });
  });

  test('panel.timeout_s min(30) 미만은 경고하되 저장은 됨 (back-compat)', () => {
    withRoot((root) => {
      const w = run(['set', 'panel.timeout_s', '5'], root);
      expect(w.exitCode).toBe(0);
      expect(stripAnsi(w.stdout)).toContain('최솟값 30');
      const written = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'));
      expect(written.panel.timeout_s).toBe(5); // warning, not a block
    });
  });

  test('panel.model_overrides 객체는 타입 경고 없이 저장', () => {
    withRoot((root) => {
      const w = run(['set', 'panel.model_overrides', '{"codex":"gpt-5.5"}'], root);
      expect(w.exitCode).toBe(0);
      expect(stripAnsi(w.stdout)).not.toContain('⚠');
      const written = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'));
      expect(written.panel.model_overrides.codex).toBe('gpt-5.5');
    });
  });

  test('그 외 panel.* dotted 키는 미등록 경고 (managed leaf가 아님)', () => {
    withRoot((root) => {
      const w = run(['set', 'panel.foo', 'bar'], root);
      expect(w.exitCode).toBe(0);
      expect(stripAnsi(w.stdout)).toContain('미등록');
    });
  });
});

// ── i18n language resolution (ko/en) ────────────────────────────────────
//
// The config CLI resolves its output language via:
//   --lang flag > XM_LANG env > config `lang` key > OS locale (ko*) > en.
// These tests exercise each rung. They build env from scratch — every language
// signal (XM_LANG / LANG / LC_ALL / LC_MESSAGES / LC_CTYPE) is stripped, then only
// the one under test is set — so the result never depends on the dev's locale.

function runLang(args, { root, cwd, input, lang, locale } = {}) {
  const env = { ...process.env };
  delete env.XM_LANG;
  delete env.LANG;
  delete env.LC_ALL;
  delete env.LC_MESSAGES;
  delete env.LC_CTYPE;
  if (root) env.XM_ROOT = root;
  if (lang !== undefined) env.XM_LANG = lang;
  if (locale !== undefined) env.LANG = locale;
  if (input !== undefined) env.XM_CONFIG_WIZARD_STDIN = '1';
  const result = spawnSync('node', [CLI_PATH, ...args], {
    env, cwd, input, encoding: 'utf8', timeout: 10000,
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status ?? 1,
  };
}

describe('xm config i18n language resolution', () => {
  test('--lang en renders the wizard menu in English (flag beats everything)', () => {
    withRoot((root) => {
      // --lang en, no XM_LANG; '0' exits the (guard-bypassed) wizard immediately.
      const w = runLang(['--lang', 'en'], { root, input: '0\n', locale: 'ko_KR.UTF-8' });
      expect(w.exitCode).toBe(0);
      const out = stripAnsi(w.stdout);
      expect(out).toContain('Choose a setting to configure');
      // The flag must win over the ko locale — no Korean menu title.
      expect(out).not.toContain('설정할 항목을 선택하세요');
    });
  });

  test('XM_LANG=en makes the unregistered-key warning English', () => {
    withRoot((root) => {
      const w = runLang(['set', 'foobar', '123'], { root, lang: 'en' });
      expect(w.exitCode).toBe(0);
      const out = stripAnsi(w.stdout);
      expect(out).toContain("unregistered key 'foobar'");
      expect(out).not.toContain('미등록');
      // The value still saves (back-compat) regardless of language.
      const written = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'));
      expect(written.foobar).toBe(123);
    });
  });

  test('config lang:ko beats the locale (LANG=en_US) when XM_LANG is absent', () => {
    withRoot((root) => {
      writeFileSync(join(root, 'config.json'), JSON.stringify({ lang: 'ko' }));
      // Bare, non-interactive invocation → the TTY guard prints its header, which
      // is localized via common.xm_config + guard.tty_only. No XM_LANG; ko config
      // must override the en locale.
      const w = runLang([], { root, locale: 'en_US.UTF-8' });
      expect(w.exitCode).toBe(1); // guard fired
      const out = stripAnsi(w.stdout + w.stderr);
      expect(out).toContain('대화형 위저드는 TTY에서만 실행됩니다');
      expect(out).not.toContain('runs only in a TTY');
    });
  });

  test('no lang signal + LANG=C falls back to English', () => {
    withRoot((root) => {
      const w = runLang([], { root, locale: 'C' });
      expect(w.exitCode).toBe(1); // guard fired
      const out = stripAnsi(w.stdout + w.stderr);
      expect(out).toContain('the interactive wizard runs only in a TTY');
      expect(out).not.toContain('대화형 위저드는 TTY에서만');
    });
  });

  test('config lang:en is overridden by --lang ko (flag > config)', () => {
    withRoot((root) => {
      writeFileSync(join(root, 'config.json'), JSON.stringify({ lang: 'en' }));
      const w = runLang(['--lang=ko'], { root, input: '0\n' });
      expect(w.exitCode).toBe(0);
      const out = stripAnsi(w.stdout);
      expect(out).toContain('설정할 항목을 선택하세요');
      expect(out).not.toContain('Choose a setting to configure');
    });
  });
});

// ── vendor_models / vendor_profiles schema registration (t3 / R3) ────────
//
// R3 registers two object keys so a nested `set` lands like any first-class key:
// getSchemaEntry resolves `vendor_models.codex.opus` via its top segment, so the
// "unregistered" warning must NOT fire, and the value round-trips through `get`.
// The dotted leaf has no exact schema entry, so no enum/type check applies — the
// builtin tier→model table stays owned by cost-engine's VENDOR_MODELS.

describe('xm config vendor_models set-time spec validation (review F2)', () => {
  test('typo effort warns at set time but still saves (FM2 back-compat)', () => {
    withRoot((root) => {
      const w = run(['set', 'vendor_models.codex.opus', 'gpt-5.5:hgh'], root);
      expect(w.exitCode).toBe(0);
      const out = stripAnsi(w.stdout);
      expect(out).toContain('unknown effort');       // parseModelSpec warning surfaced
      const written = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'));
      expect(written.vendor_models.codex.opus).toBe('gpt-5.5:hgh'); // save still happened
    });
  });

  test('unknown tier segment warns with the canonical tier list', () => {
    withRoot((root) => {
      const w = run(['set', 'vendor_models.codex.light', 'gpt-5.4'], root);
      expect(w.exitCode).toBe(0);
      const out = stripAnsi(w.stdout);
      expect(out).toContain('haiku, sonnet, opus');  // enum-style warning names valid tiers
    });
  });

  test('valid model:effort spec stays warning-free', () => {
    withRoot((root) => {
      const w = run(['set', 'vendor_models.codex.sonnet', 'gpt-5.4:medium'], root);
      expect(stripAnsi(w.stdout)).not.toContain('⚠');
    });
  });
});

describe('xm config vendor keys (t3)', () => {
  test('vendor_models.codex.opus round-trips with no schema warning', () => {
    withRoot((root) => {
      const w = run(['set', 'vendor_models.codex.opus', 'gpt-5.5:high'], root);
      expect(w.exitCode).toBe(0);
      const out = stripAnsi(w.stdout);
      // Registered key → none of the validateSet warnings fire (ko output under XM_LANG=ko).
      expect(out).not.toContain('⚠');
      expect(out).not.toContain('미등록');
      expect(out).not.toContain('타입 불일치');
      expect(out).not.toContain('허용값');

      // The nested spec (including the :effort suffix) is stored verbatim, not coerced.
      const written = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'));
      expect(written.vendor_models.codex.opus).toBe('gpt-5.5:high');

      const r = run(['get', 'vendor_models.codex.opus'], root);
      expect(r.stdout.trim()).toBe('gpt-5.5:high');
    });
  });

  test('vendor_profiles.codex round-trips with no schema warning', () => {
    withRoot((root) => {
      const w = run(['set', 'vendor_profiles.codex', 'economy'], root);
      expect(w.exitCode).toBe(0);
      const out = stripAnsi(w.stdout);
      expect(out).not.toContain('⚠');
      expect(out).not.toContain('미등록');

      const written = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'));
      expect(written.vendor_profiles.codex).toBe('economy');

      const r = run(['get', 'vendor_profiles.codex'], root);
      expect(r.stdout.trim()).toBe('economy');
    });
  });
});

describe('config-schema group metadata (t3)', () => {
  const VALID_GROUPS = new Set([
    'model', 'vendor', 'cross_vendor', 'budget', 'gates', 'worktree', 'misc', 'panel',
  ]);

  test('every SCHEMA entry declares a group from the 8-category vocabulary', () => {
    for (const entry of SCHEMA) {
      expect(VALID_GROUPS.has(entry.group)).toBe(true);
    }
  });

  test('SCHEMA still has no import statements (zero-import leaf)', () => {
    const src = readFileSync(join(__dirname, '..', 'x-build', 'lib', 'config-schema.mjs'), 'utf8');
    expect(/^import /m.test(src)).toBe(false);
  });
});

// ── eval.auto registration (x-op Post-Strategy Eval Gate) ───────────────
//
// x-op SKILL.md promises an auto-eval toggle read from the project's
// .xm/config.json (`eval.auto`), but the key was never registered — so
// `xm config set eval.auto` warned "미등록" and the wizard/dashboard never
// showed it. Local scope keeps writes where the SKILL.md consumer reads.

describe('config-schema eval.auto registration', () => {
  test('eval.auto is a local-scope boolean defaulting to false', () => {
    const entry = SCHEMA.find((e) => e.key === 'eval.auto');
    expect(entry).toBeTruthy();
    expect(entry.type).toBe('boolean');
    expect(entry.scope).toBe('local');
    expect(entry.default).toBe(false);
    expect(entry.group).toBe('misc');
  });

  test('xm config set eval.auto true round-trips with no unregistered-key warning', () => {
    withRoot((root) => {
      const w = run(['set', 'eval.auto', 'true'], root);
      expect(w.exitCode).toBe(0);
      expect(stripAnsi(w.stdout)).not.toContain('미등록');
      const written = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'));
      expect(written.eval.auto).toBe(true);
    });
  });
});

// ── WORKTREE_CONFIG_DEFAULTS <-> config-schema worktree.* sync (P7, t8) ─────
//
// worktree-shared.mjs (runtime truth, per PRD A5) and config-schema.mjs
// (dashboard/CLI registry) both hand-maintain the same 13 worktree.* fields
// (11 + gate_max_rounds/pre_gate from the gate-optimization plan §3E/§3F).
// The only defense against the two drifting apart is this field-by-field
// comparison — see PRD Risks P7 and Acceptance Criteria item 9.

describe('WORKTREE_CONFIG_DEFAULTS <-> config-schema worktree.* sync (P7)', () => {
  const worktreeEntries = SCHEMA.filter((e) => e.key.startsWith('worktree.'));
  const schemaLeaves = new Set(worktreeEntries.map((e) => e.key.slice('worktree.'.length)));
  const runtimeLeaves = new Set(Object.keys(WORKTREE_CONFIG_DEFAULTS));

  test('exactly 13 worktree.* fields on both sides (P7 field count parity)', () => {
    expect(runtimeLeaves.size).toBe(13);
    expect(worktreeEntries.length).toBe(13);
  });

  test('every WORKTREE_CONFIG_DEFAULTS key has a matching config-schema worktree.* entry', () => {
    for (const leaf of runtimeLeaves) {
      expect(schemaLeaves.has(leaf)).toBe(true);
    }
  });

  test('every config-schema worktree.* entry has a matching WORKTREE_CONFIG_DEFAULTS key', () => {
    for (const leaf of schemaLeaves) {
      expect(runtimeLeaves.has(leaf)).toBe(true);
    }
  });

  test('field-by-field default value parity (gate_policy deep-equal, scalars ===)', () => {
    for (const entry of worktreeEntries) {
      const leaf = entry.key.slice('worktree.'.length);
      const runtimeDefault = WORKTREE_CONFIG_DEFAULTS[leaf];
      if (leaf === 'gate_policy') {
        expect(entry.default).toEqual(runtimeDefault); // nested object: deep equal
      } else {
        expect(entry.default).toBe(runtimeDefault); // scalar/null: strict equal
      }
    }
  });
});

// ── shared-config exports: validateSet / shadowingTiers (t2) ────────────────
//
// Direct unit tests (no CLI subprocess) against the exported helpers, so t4/t5
// can rely on the { code, severity, message } contract and the shadowingTiers
// signature without re-deriving them from CLI stdout scraping.

describe('validateSet (t2 structured findings)', () => {
  test('unregistered key: severity warn, code unregistered, no throw', () => {
    const findings = validateSet('totally.unknown.key', 'anything');
    expect(findings.length).toBe(1);
    expect(findings[0].code).toBe('unregistered');
    expect(findings[0].severity).toBe('warn');
    expect(typeof findings[0].message).toBe('string');
  });

  test('type violation (agent_max_count as string): severity error, code type', () => {
    const findings = validateSet('agent_max_count', 'not-a-number');
    const typeFinding = findings.find(f => f.code === 'type');
    expect(typeFinding).toBeDefined();
    expect(typeFinding.severity).toBe('error');
  });

  test('enum violation (mode out of range): severity error, code enum', () => {
    const findings = validateSet('mode', 'bogus-mode');
    expect(findings.length).toBe(1);
    expect(findings[0].code).toBe('enum');
    expect(findings[0].severity).toBe('error');
  });

  test('min violation (agent_max_count below range): severity error, code min', () => {
    const findings = validateSet('agent_max_count', 0);
    const minFinding = findings.find(f => f.code === 'min');
    expect(minFinding).toBeDefined();
    expect(minFinding.severity).toBe('error');
  });

  test('max violation (agent_max_count above range): severity error, code max', () => {
    const findings = validateSet('agent_max_count', 999);
    const maxFinding = findings.find(f => f.code === 'max');
    expect(maxFinding).toBeDefined();
    expect(maxFinding.severity).toBe('error');
  });

  test('null value against a non-nullable schema entry: severity error, no throw', () => {
    expect(() => validateSet('mode', null)).not.toThrow();
    const findings = validateSet('mode', null);
    const typeFinding = findings.find(f => f.code === 'type');
    expect(typeFinding).toBeDefined();
    expect(typeFinding.severity).toBe('error');
  });

  test('huge string value against a numeric schema entry: severity error, no throw', () => {
    const huge = 'x'.repeat(100000);
    expect(() => validateSet('agent_max_count', huge)).not.toThrow();
    const findings = validateSet('agent_max_count', huge);
    const typeFinding = findings.find(f => f.code === 'type');
    expect(typeFinding).toBeDefined();
    expect(typeFinding.severity).toBe('error');
  });

  test('vendor tier enum violation: severity error, code enum', () => {
    const findings = validateSet('vendor_models.claude.bogus-tier', 'sonnet');
    expect(findings.length).toBe(1);
    expect(findings[0].code).toBe('enum');
    expect(findings[0].severity).toBe('error');
  });

  test('vendor tier type violation (non-string spec): severity error, code type', () => {
    const findings = validateSet('vendor_models.claude.opus', 123);
    expect(findings.length).toBe(1);
    expect(findings[0].code).toBe('type');
    expect(findings[0].severity).toBe('error');
  });

  test('panel.model_overrides wrong type: severity error, code type', () => {
    const findings = validateSet('panel.model_overrides', 'not-an-object');
    expect(findings.length).toBe(1);
    expect(findings[0].code).toBe('type');
    expect(findings[0].severity).toBe('error');
  });

  test('unmanaged panel.* leaf: severity warn, code unregistered', () => {
    const findings = validateSet('panel.some_unmanaged_leaf', 'x');
    expect(findings.length).toBe(1);
    expect(findings[0].code).toBe('unregistered');
    expect(findings[0].severity).toBe('warn');
  });

  test('clean value against a registered schema entry: empty findings', () => {
    expect(validateSet('mode', 'developer')).toEqual([]);
    expect(validateSet('agent_max_count', 4)).toEqual([]);
  });
});

describe('shadowingTiers (t2 pure judgment)', () => {
  test('empty layers: no shadow regardless of tier', () => {
    expect(shadowingTiers('gate', 'global', {})).toEqual([]);
    expect(shadowingTiers('gate', 'shared', {})).toEqual([]);
  });

  test('unknown tier: safe empty return, no throw', () => {
    expect(() => shadowingTiers('gate', 'bogus-tier', {})).not.toThrow();
    expect(shadowingTiers('gate', 'bogus-tier', { 'build-local': { gate: 'panel' } })).toEqual([]);
  });

  test('build-local is highest priority: never shadowed', () => {
    const layers = {
      'build-local': { gate: 'panel' },
      shared: { gate: 'panel' },
      global: { gate: 'panel' },
    };
    expect(shadowingTiers('gate', 'build-local', layers)).toEqual([]);
  });

  test('global write shadowed by build-local when build-local sets the key', () => {
    const layers = { 'build-local': { gate: 'panel' }, shared: {}, global: {} };
    expect(shadowingTiers('gate', 'global', layers)).toEqual(['build-local']);
  });

  test('global write shadowed by shared when only shared sets the key', () => {
    const layers = { 'build-local': {}, shared: { gate: 'panel' }, global: {} };
    expect(shadowingTiers('gate', 'global', layers)).toEqual(['shared']);
  });

  test('shared write shadowed by build-local, ignores global', () => {
    const layers = { 'build-local': { gate: 'panel' }, shared: {}, global: { gate: 'panel' } };
    expect(shadowingTiers('gate', 'shared', layers)).toEqual(['build-local']);
  });

  test('nested dotted keyPath (gate_policy.allow_low) resolves through layers', () => {
    const layers = { 'build-local': { gate_policy: { allow_low: false } }, shared: {}, global: {} };
    expect(shadowingTiers('gate_policy.allow_low', 'global', layers)).toEqual(['build-local']);
  });

  test('missing/null layer values: safe false, no throw', () => {
    expect(() => shadowingTiers('gate', 'global', { 'build-local': null, shared: undefined })).not.toThrow();
    expect(shadowingTiers('gate', 'global', { 'build-local': null, shared: undefined })).toEqual([]);
  });

  test('layers argument itself null/undefined: safe empty return, no throw', () => {
    expect(() => shadowingTiers('gate', 'global', null)).not.toThrow();
    expect(shadowingTiers('gate', 'global', null)).toEqual([]);
    expect(shadowingTiers('gate', 'global', undefined)).toEqual([]);
  });
});

describe('setNestedKey / getNestedKey (t2 exported)', () => {
  test('round-trips a dotted path', () => {
    const obj = {};
    setNestedKey(obj, 'a.b.c', 42);
    expect(getNestedKey(obj, 'a.b.c')).toBe(42);
  });

  test('rejects __proto__ / constructor / prototype segments', () => {
    const obj = {};
    expect(() => setNestedKey(obj, '__proto__.polluted', true)).toThrow();
    expect(() => setNestedKey(obj, 'constructor.prototype.polluted', true)).toThrow();
  });

  test('getNestedKey on a missing path returns undefined, no throw', () => {
    expect(() => getNestedKey({}, 'a.b.c')).not.toThrow();
    expect(getNestedKey({}, 'a.b.c')).toBeUndefined();
  });
});
