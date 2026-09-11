import { existsSync, lstatSync, mkdirSync, openSync, closeSync, readFileSync, writeSync, fstatSync, chmodSync, unlinkSync, renameSync, rmSync, readdirSync, constants as FS } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { ESCAPE_LEDGER_FILE, parseEscapeLedger, sanitizeEscapeRow, escapeRowKey, buildEscapeRow } from './escape-ledger.mjs';
const MAX_BYTES=50*1024*1024, MAX_WAIT=2000, STALE=10000;
function processLive(pid){const value=Number(pid);if(!Number.isInteger(value)||value<=0)return false;try{process.kill(value,0);return true;}catch(error){return error?.code!=='ESRCH';}}
function recoveryLock(path,staleMs){
  const token=`${process.pid}-${Date.now()}`,metadata=JSON.stringify({pid:process.pid,token,created_at:Date.now()});
  for(let attempt=0;attempt<2;attempt+=1){
    try{const fd=openSync(path,FS.O_WRONLY|FS.O_CREAT|FS.O_EXCL|(FS.O_NOFOLLOW||0),0o600);try{writeSync(fd,metadata);}finally{closeSync(fd);}return ()=>{try{const owner=JSON.parse(readFileSync(path,'utf8'));if(owner.token===token)unlinkSync(path);}catch{}};}
    catch(error){if(error?.code!=='EEXIST')throw error;try{const observed=JSON.parse(readFileSync(path,'utf8'));if(Date.now()-Number(observed.created_at||0)>staleMs&&!processLive(observed.pid)){const current=JSON.parse(readFileSync(path,'utf8'));if(current.token===observed.token&&Date.now()-Number(current.created_at||0)>staleMs&&!processLive(current.pid)){const quarantine=path+'.stale-'+process.pid+'-'+Date.now();renameSync(path,quarantine);rmSync(quarantine,{force:true});continue;}}}catch{}return null;}
  }
  return null;
}
function inside(root, path) { const rel=relative(root,path); return rel === '' || (!rel.startsWith('..'+sep) && rel !== '..'); }
function safe(root, path, { createParents = false } = {}) {
  root=resolve(root); path=resolve(path); if (!inside(root,path)) throw new Error('attention ledger escapes workspace');
  let cur=root; if (!lstatSync(cur).isDirectory() || lstatSync(cur).isSymbolicLink()) throw new Error('unsafe workspace');
  for (const bit of relative(root,dirname(path)).split(sep).filter(Boolean)) {
    cur=join(cur,bit);
    if (!existsSync(cur)) { if (!createParents) return path; mkdirSync(cur,{mode:0o700}); }
    const st=lstatSync(cur); if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('unsafe ledger parent');
  }
  if (existsSync(path)) { const st=lstatSync(path); if (!st.isFile() || st.isSymbolicLink()) throw new Error('unsafe ledger file'); } return path;
}
export function acquireAttentionLock(path,{waitMs=MAX_WAIT,staleMs=STALE}={}) {
  const lp=path+'.lock',reap=lp+'.reap',token=`${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,end=Date.now()+waitMs;
  const metadata=JSON.stringify({pid:process.pid,token,created_at:Date.now()});
  while(true) {
    try {
      if(existsSync(reap)){const recovered=recoveryLock(reap,staleMs);if(recovered){recovered();continue;}const busy=new Error('attention ledger recovery in progress');busy.code='EEXIST';throw busy;}
      const fd=openSync(lp,FS.O_WRONLY|FS.O_CREAT|FS.O_EXCL|(FS.O_NOFOLLOW||0),0o600);
      try{writeSync(fd,metadata);}finally{closeSync(fd);}
      return ()=>{try{const owner=JSON.parse(readFileSync(lp,'utf8'));if(owner.token===token)unlinkSync(lp);}catch{}};
    } catch(error) {
      if(error?.code!=='EEXIST')throw error;
      try {
        const observed=JSON.parse(readFileSync(lp,'utf8')),stale=Date.now()-Number(observed.created_at||0)>staleMs;
        if(stale&&!processLive(observed.pid)){
          const releaseRecovery=recoveryLock(reap,staleMs);
          if(releaseRecovery)try{
            const current=JSON.parse(readFileSync(lp,'utf8'));
            if(current.token===observed.token&&Date.now()-Number(current.created_at||0)>staleMs&&!processLive(current.pid)){const quarantine=lp+'.stale-'+process.pid+'-'+Date.now();renameSync(lp,quarantine);rmSync(quarantine,{force:true});}
          }catch{}finally{releaseRecovery();}
          continue;
        }
      } catch {}
      if(Date.now()>end) throw new Error('attention ledger lock timeout');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20);
    }
  }
}
export function attentionLedgerPath(root) { return join(resolve(root), '.xm','review',ESCAPE_LEDGER_FILE); }
function ledgerPaths(root) {
  const base=attentionLedgerPath(root),dir=dirname(base);
  if(!existsSync(dir))return [];
  return readdirSync(dir,{withFileTypes:true}).filter(entry=>entry.isFile()&&/^escape-ledger(?:\.\d{4}Q[1-4])?\.jsonl$/.test(entry.name)).map(entry=>join(dir,entry.name)).sort();
}
function quarterPath(base,now=new Date()){return base.replace(/\.jsonl$/,`.`+now.getUTCFullYear()+`Q`+(Math.floor(now.getUTCMonth()/3)+1)+`.jsonl`);}
export function readAttentionLedger(root) {
  const resolved=resolve(root),paths=ledgerPaths(resolved);
  if(!paths.length){safe(resolved,attentionLedgerPath(resolved));return {rows:[],skipped:0,parse_errors:0,exists:false};}
  const rows=[];let skipped=0;
  for(const candidate of paths){const path=safe(resolved,candidate),st=lstatSync(path);if(st.size>MAX_BYTES)throw new Error('attention ledger fragment exceeds size limit');const parsed=parseEscapeLedger(readFileSync(path,'utf8'));rows.push(...parsed.rows);skipped+=parsed.parse_errors;}
  return {rows,skipped,parse_errors:skipped,exists:true};
}
export function appendAttentionRows(root, values) {
  const resolved=resolve(root),base=safe(resolved,attentionLedgerPath(resolved),{createParents:true}),release=acquireAttentionLock(base);try{const prior=readAttentionLedger(resolved).rows,seen=new Set(prior.map(escapeRowKey)),fresh=[];for(const value of values){const row=sanitizeEscapeRow({...value,schema_v:value?.schema_v??1});if(row&&!seen.has(escapeRowKey(row))){seen.add(escapeRowKey(row));fresh.push(row);}}if(!fresh.length)return 0;const text=fresh.map(JSON.stringify).join('\n')+'\n',bytes=Buffer.byteLength(text);let path=base;if(existsSync(base)&&lstatSync(base).size+bytes>MAX_BYTES)path=safe(resolved,quarterPath(base),{createParents:true});const fd=openSync(path,FS.O_WRONLY|FS.O_CREAT|FS.O_APPEND|(FS.O_NOFOLLOW||0),0o600);try{const st=fstatSync(fd);if(st.size+bytes>MAX_BYTES)throw new Error('attention ledger fragment exceeds size limit');chmodSync(path,0o600);const written=writeSync(fd,text);if(written!==bytes)throw new Error('attention ledger short write');}finally{closeSync(fd);}return fresh.length;}finally{release();}
}
function walk(dir, out=[]) { if(!existsSync(dir))return out; for(const ent of readdirSync(dir,{withFileTypes:true})){const p=join(dir,ent.name); if(ent.isSymbolicLink())continue; if(ent.isDirectory())walk(p,out); else if(ent.isFile()&&/^panel-[^.]+(?:\.attempt-\d+)?\.json$/.test(ent.name))out.push(p);} return out; }
function joinPath(value){if(typeof value!=='string')return null;const path=value.trim().replace(/\\/g,'/').replace(/^\.\//,'').replace(/^[ab]\//,'').replace(/\/{2,}/g,'/');return path||null;}
export function collectAttention(root) {
  const resolved=resolve(root), base=join(resolved,'.xm','build','projects'), rows=[], errors=[], triageResult=readTriage(resolved), triage=triageResult.rows;
  errors.push(...triageResult.errors);
  const panels=[];
  for(const path of walk(base)){ let panel; try{panel=JSON.parse(readFileSync(path,'utf8'));}catch{errors.push(relative(resolved,path));continue;}
    const name=/panel-(before|after|release)(?:\.attempt-\d+)?\.json$/.exec(path)?.[1]; const phase=panel.phase==null?name:(['before','after','release'].includes(panel.phase)?panel.phase:null); if(!phase){errors.push(relative(resolved,path));continue;} panels.push({path,panel,phase,project:projectFromPath(path)}); }
  const scopes=panels.filter(({phase})=>phase==='before'||phase==='after').map(({path,panel,project})=>({project,task:normalizeTask(panel.task_id)||taskFromPath(path),files:(Array.isArray(panel.reviewed_files_all)?panel.reviewed_files_all:(Array.isArray(panel.reviewed_files)?panel.reviewed_files:[])).map(joinPath).filter(Boolean)}));
  for(const {path,panel,phase,project} of panels){
    const release=phase==='release' || path.includes('__integration__');
    const task=release?null:(normalizeTask(panel.task_id) || taskFromPath(path)); const common={ts:panel.created_at||panel.ts||new Date(0).toISOString(),task_id:task,phase,panel_run:panel.panel_run||null,artifact:relative(resolved,path),attribution:release?'integration':'task'};
    for(const bucket of ['blocking_findings','advisory_findings']) for(const finding of Array.isArray(panel[bucket])?panel[bucket]:[]) {
      if(!finding || !['confirmed','contested'].includes(finding.kind))continue;
      const findingPath=joinPath(finding.file),candidates=release&&findingPath?[...new Set(scopes.filter(scope=>scope.project===project&&scope.files.includes(findingPath)).map(scope=>scope.task).filter(Boolean))].sort():[];
      const reviewedByCandidates=candidates.length>0&&findingPath?[findingPath]:[];
      const normalizedFinding=findingPath?{...finding,file:findingPath}:finding;
      const input={...common,finding:normalizedFinding,kind:finding.kind,gateRecord:release?{reviewed_files_all:reviewedByCandidates}:panel,ledgerRows:triage,escaped_from_task_ids:candidates};
      if(finding.kind==='confirmed' && release) rows.push(buildEscapeRow(input));
      if(finding.kind==='contested') rows.push(buildEscapeRow(input));
    }
  }
  for(const row of triage){ if(row.type==='triage_outcome' && row.outcome==='regression' && triage.some(d=>d.type==='triage_decision'&&d.decision==='false_positive'&&d.reviewed_commit===row.reviewed_commit&&d.finding_id===row.finding_id&&String(d.file||'')===String(row.file||''))){ rows.push(buildEscapeRow({revived:true,ts:row.ts,reviewed_commit:row.reviewed_commit,task_id:null,attribution:'integration',artifact:'.xm/review/triage-ledger.jsonl',finding:row})); } }
  const unique=new Map(); for(const row of rows){if(row)unique.set(escapeRowKey(row),row);} return { rows:[...unique.values()], parse_errors:errors.length, errors };
}
function normalizeTask(value){return typeof value==='string'&&value!=='__integration__'?value:null;}
function taskFromPath(path){const m=path.match(/[\/]worktrees[\/]([^\/]+)/);return m&&m[1]!=='__integration__'?m[1]:null;}
function projectFromPath(path){return path.match(/[\/]projects[\/]([^\/]+)[\/]worktrees[\/]/)?.[1]||null;}
function readTriage(root){const path=join(root,'.xm','review','triage-ledger.jsonl');if(!existsSync(path))return {rows:[],errors:[]};try{const rows=[],errors=[];readFileSync(path,'utf8').split('\n').forEach((line,index)=>{if(!line.trim())return;try{rows.push(JSON.parse(line));}catch{errors.push(`${relative(root,path)}:${index+1}`);}});return {rows,errors};}catch{return {rows:[],errors:[relative(root,path)]};}}
