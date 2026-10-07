import { describe, test, expect } from 'bun:test';
import { scanDiff, addedLineKeys, newFileDiff } from '../x-solver/lib/workaround-signals.mjs';

const diff = (file, body) => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n${body}`;
const kinds = (text, opts) => scanDiff(text, opts).map((s) => s.kind);

describe('scanDiff', () => {
  test('flags an added empty catch in JS and an except-pass in Python', () => {
    expect(kinds(diff('a.js', '@@ -1,0 +2,1 @@\n+try { run(); } catch {}\n'))).toEqual(['empty-catch']);
    expect(kinds(diff('a.js', '@@ -1,0 +2,1 @@\n+} catch (err) { }\n'))).toEqual(['empty-catch']);
    expect(kinds(diff('a.py', '@@ -1,0 +2,1 @@\n+    except ValueError: pass\n'))).toEqual(['empty-catch']);
  });

  test('a catch that does something is not flagged', () => {
    expect(kinds(diff('a.js', '@@ -1,0 +2,1 @@\n+} catch (err) { log(err); throw err; }\n'))).toEqual([]);
  });

  test('a raised timeout in CI config is a tunable increase', () => {
    const ci = diff('.github/workflows/ci.yml', '@@ -7 +7 @@\n-    timeout-minutes: 10\n+    timeout-minutes: 30\n');
    const [signal] = scanDiff(ci);
    expect(signal).toEqual({ kind: 'tunable-increase', file: '.github/workflows/ci.yml', line: 7, text: 'timeout-minutes: 30' });
  });

  test('a raised retry count is a tunable increase; a lowered one or a reshaped line is not', () => {
    expect(kinds(diff('a.js', '@@ -3 +3 @@\n-const RETRIES = 2;\n+const RETRIES = 5;\n'))).toEqual(['tunable-increase']);
    expect(kinds(diff('a.js', '@@ -3 +3 @@\n-const RETRIES = 5;\n+const RETRIES = 2;\n'))).toEqual([]);
    expect(kinds(diff('a.js', '@@ -3 +3 @@\n-await sleep(100);\n+await sleep(100, signal);\n'))).toEqual([]);
    expect(kinds(diff('a.js', '@@ -3 +3 @@\n-const width = 10;\n+const width = 30;\n'))).toEqual([]);
  });

  test('flags a new skip, a new mock, and an assert that only checks for a value', () => {
    expect(kinds(diff('a.test.js', '@@ -1,0 +2,1 @@\n+test.skip(\'flaky\', () => {});\n'))).toEqual(['skip-or-mock']);
    expect(kinds(diff('a.test.js', '@@ -1,0 +2,1 @@\n+vi.mock(\'./net.js\');\n'))).toEqual(['skip-or-mock']);
    expect(kinds(diff('t.py', '@@ -1,0 +2,1 @@\n+    assert result is not None\n'))).toEqual(['not-none-assert']);
  });

  test('optional chaining and default fallbacks are not flagged', () => {
    expect(kinds(diff('a.js', '@@ -1,0 +2,2 @@\n+const n = value?.number;\n+const list = input || [];\n'))).toEqual([]);
  });

  test('removed lines are not flagged and line numbers follow the new file', () => {
    const text = diff('a.js', '@@ -10,2 +10,3 @@\n-try { a(); } catch {}\n context\n+x();\n+try { b(); } catch {}\n');
    expect(scanDiff(text)).toEqual([{ kind: 'empty-catch', file: 'a.js', line: 12, text: 'try { b(); } catch {}' }]);
  });

  test('ignore drops lines the baseline patch already added; include limits the files', () => {
    const baseline = diff('a.js', '@@ -1,0 +2,1 @@\n+try { run(); } catch {}\n');
    const fix = diff('a.js', '@@ -1,0 +2,2 @@\n+try { run(); } catch {}\n+try { other(); } catch {}\n');
    expect(scanDiff(fix, { ignore: addedLineKeys(baseline) }).map((s) => s.text)).toEqual(['try { other(); } catch {}']);
    expect(scanDiff(fix, { include: (f) => f !== 'a.js' })).toEqual([]);
  });

  test('newFileDiff makes every line of a new file an added line', () => {
    expect(scanDiff(newFileDiff('n.js', 'ok();\ntry { x(); } catch {}\n'))).toEqual([
      { kind: 'empty-catch', file: 'n.js', line: 2, text: 'try { x(); } catch {}' },
    ]);
  });
});
