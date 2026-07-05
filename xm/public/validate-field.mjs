/*
 * validate-field.mjs — pure validateField(entry, value) and cfgFieldSupportsUnset(entry)
 * for the config schema editor (t6, config-gap-close), kept as a standalone module so it's
 * unit-testable without loading app.js (a 6.8k-line classic <script> with
 * top-level DOM side effects — same problem render-helpers.js solves for the
 * render layer; see that file's header comment).
 *
 * app.js does NOT load this file via a <script> tag — it inlines an identical
 * copy of both functions directly (index.html is out of scope for this pass).
 * The two copies must be kept byte-for-byte in sync; this file exists purely
 * so x-dashboard/test/validate-field.test.mjs can exercise the logic.
 *
 *   - browser: app.js's own top-level `function validateField(entry, value)`
 *     and `function cfgFieldSupportsUnset(entry)`.
 *   - tests:   `import '../public/validate-field.mjs'` runs the IIFE,
 *     then reads globalThis.XMValidate.validateField / .cfgFieldSupportsUnset.
 */
(function (g) {
  'use strict';

  function validateField(entry, value) {
    if (!entry) return null;
    if (value === undefined) return null; // "unset" always clears any override cleanly
    if (value === null) {
      return entry.nullable ? null : `${entry.key}는 null을 허용하지 않습니다`;
    }
    switch (entry.type) {
      case 'string': {
        if (typeof value !== 'string') return '문자열이어야 합니다';
        if (Array.isArray(entry.enum) && !entry.enum.includes(value)) {
          return `다음 중 하나여야 합니다: ${entry.enum.join(', ')}`;
        }
        return null;
      }
      case 'boolean':
        return typeof value === 'boolean' ? null : 'true/false 값이어야 합니다';
      case 'integer': {
        if (typeof value !== 'number' || !Number.isInteger(value)) return '정수여야 합니다';
        if (entry.min != null && value < entry.min) return `${entry.min} 이상이어야 합니다`;
        if (entry.max != null && value > entry.max) return `${entry.max} 이하여야 합니다`;
        return null;
      }
      case 'number': {
        if (typeof value !== 'number' || !Number.isFinite(value)) return '숫자여야 합니다';
        if (entry.min != null && value < entry.min) return `${entry.min} 이상이어야 합니다`;
        if (entry.max != null && value > entry.max) return `${entry.max} 이하여야 합니다`;
        return null;
      }
      case 'array':
        return Array.isArray(value) ? null : '배열이어야 합니다';
      case 'object':
        return (typeof value === 'object' && !Array.isArray(value)) ? null : 'JSON 객체여야 합니다';
      default:
        return null;
    }
  }

  // True when this schema entry's widget can represent "unset" through the
  // reset button (renderSchemaField/configSaveSchemaFields in app.js, F1):
  // non-nullable booleans always resolve to a concrete true/false and have
  // no way to clear an override back to "not set at this tier".
  function cfgFieldSupportsUnset(entry) {
    return !(entry && entry.type === 'boolean' && !entry.nullable);
  }

  g.XMValidate = { validateField, cfgFieldSupportsUnset };
})(typeof globalThis !== 'undefined' ? globalThis : this);
