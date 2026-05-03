import { describe, test, expect } from 'bun:test';
import fc from 'fast-check';
import { renderKiroFrontmatter, renderKiroWithDiagnostics } from '../xm/lib/install/transform/kiro.mjs';

// Feature: kiro-xm-compatibility, Property 3: Steering 프론트매터 정합성
// **Validates: Requirements 4.1, 4.2, 4.3**

const arbInclusion = fc.constantFrom('always', 'fileMatch', 'manual', 'auto');
const arbDescription = fc.string({ minLength: 0, maxLength: 100 }).map(s => s.replace(/\n/g, ' '));
const arbFileMatchPattern = fc.oneof(
  fc.constant(undefined),
  fc.string({ minLength: 1, maxLength: 30 }).map(s => s.replace(/\n/g, '')),
);

describe('Property 3: Steering 프론트매터 정합성', () => {
  test('renderKiroFrontmatter() output has no name: line, has inclusion: line, auto has description:', () => {
    fc.assert(
      fc.property(arbInclusion, arbDescription, arbFileMatchPattern, (inclusion, description, fileMatchPattern) => {
        const fm = { inclusion, description: description || undefined, fileMatchPattern };
        const output = renderKiroFrontmatter(fm);

        // No name: line
        expect(output).not.toMatch(/^name:/m);
        // Has inclusion: line
        expect(output).toMatch(/^inclusion:/m);
        // If auto and description provided, must have description: line
        if (inclusion === 'auto' && description) {
          expect(output).toMatch(/^description:/m);
        }
      }),
      { numRuns: 200 }
    );
  });

  test('renderKiroWithDiagnostics() outputs have no name: in frontmatter', () => {
    // pluginName/skillName must match /^[a-z][a-z0-9-]{0,30}$/
    const arbPluginName = fc.constantFrom('build', 'op', 'agent', 'eval', 'humble');
    const arbSkillName = fc.constant('default');
    const arbSkillDescription = fc.string({ minLength: 30, maxLength: 100 }).map(s => s.replace(/\n/g, ' '));

    const arbSkillIR = fc.record({
      pluginName: arbPluginName,
      skillName: arbSkillName,
      description: arbSkillDescription,
      body: fc.constant('# Test body\n\nSome content here.\n'),
      references: fc.constant([]),
    });

    fc.assert(
      fc.property(fc.array(arbSkillIR, { minLength: 1, maxLength: 5 }), (skills) => {
        const ctx = { scope: 'local', target: 'kiro' };
        const { outputs } = renderKiroWithDiagnostics(skills, ctx);
        for (const output of outputs) {
          // Extract frontmatter (between --- markers)
          const fmMatch = output.content.match(/^---\n([\s\S]*?)\n---/);
          if (fmMatch) {
            expect(fmMatch[1]).not.toMatch(/^name:/m);
            expect(fmMatch[1]).toMatch(/^inclusion:/m);
          }
        }
      }),
      { numRuns: 100 }
    );
  });
});

// Feature: kiro-xm-compatibility, Property 4: 짧은 Description 경고
// **Validates: Requirements 5.1, 5.2**

describe('Property 4: 짧은 Description 경고', () => {
  test('short descriptions (< 30 chars) produce warnings with skill name and char count', () => {
    const arbShortDesc = fc.string({ minLength: 1, maxLength: 29 }).map(s => s.replace(/\n/g, ' ').trim()).filter(s => s.length > 0 && s.length < 30);
    const arbPluginName = fc.constantFrom('build', 'op', 'agent', 'eval', 'humble');

    fc.assert(
      fc.property(arbPluginName, arbShortDesc, (pluginName, description) => {
        const skills = [{
          pluginName,
          skillName: 'default',
          description,
          body: '# Test\n',
          references: [],
        }];
        const ctx = { scope: 'local', target: 'kiro' };
        const { warnings } = renderKiroWithDiagnostics(skills, ctx);
        
        const ruleBase = `xm-${pluginName}`;
        // Must have at least one warning about this skill
        const relevant = warnings.filter(w => w.includes(ruleBase));
        expect(relevant.length).toBeGreaterThan(0);
        // Warning must mention the character count
        const charCount = description.trim().length;
        expect(relevant.some(w => w.includes(String(charCount)))).toBe(true);
      }),
      { numRuns: 100 }
    );
  });
});
