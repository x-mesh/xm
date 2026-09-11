import { test, expect } from 'bun:test'; import { readFileSync } from 'node:fs'; import { resolve } from 'node:path';
// Each pure module is checked in every location it ships to. x-dashboard only
// receives what it imports, so escape-git is absent there by design.
const SHIPPED = { 'escape-ledger': ['x-build/lib/x-build','xm/lib/x-build','x-dashboard/lib/x-build'], 'attention-rank': ['x-build/lib/x-build','xm/lib/x-build','x-dashboard/lib/x-build'], 'escape-git': ['x-build/lib/x-build','xm/lib/x-build'] };
test('source and shipped attention modules preserve the PURE contract',()=>{const repo=resolve(import.meta.dir,'..');for(const [name,roots] of Object.entries(SHIPPED))for(const root of roots){const source=readFileSync(resolve(repo,root,name+'.mjs'),'utf8');expect(source).not.toMatch(/^(import|.*process|.*node:fs)/m);}});
