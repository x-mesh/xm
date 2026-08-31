export function scanJSONObjects(text) {
  const out = []; const source = String(text || '');
  for (let start = 0; start < source.length; start += 1) {
    if (source[start] !== '{') continue;
    let depth = 0, quoted = false, escaped = false;
    for (let i = start; i < source.length; i += 1) {
      const ch = source[i];
      if (quoted) { if (escaped) escaped = false; else if (ch === '\\') escaped = true; else if (ch === '"') quoted = false; continue; }
      if (ch === '"') { quoted = true; continue; }
      if (ch === '{') depth += 1;
      else if (ch === '}' && --depth === 0) { try { out.push(JSON.parse(source.slice(start, i + 1))); } catch { } break; }
    }
  }
  return out;
}
export function extractPlanJSON(text) {
  const objects = scanJSONObjects(text);
  return [...objects].reverse().find((value) => value?.schema_version === 1 && Array.isArray(value?.requirements) && Array.isArray(value?.tasks)) || null;
}
