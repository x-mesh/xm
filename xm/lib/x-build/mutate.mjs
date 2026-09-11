import { lstatSync, realpathSync, readFileSync, existsSync, mkdirSync, readdirSync, renameSync, openSync, closeSync, fstatSync, readSync, writeSync, unlinkSync, ftruncateSync, fchmodSync, fsyncSync, constants as FS } from 'node:fs';
import { join, resolve, relative, sep, dirname, isAbsolute } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { acquireAttentionLock, appendAttentionRows } from './attention-collect.mjs';
import { buildEscapeRow } from './escape-ledger.mjs';
import { resolveMainRepoRoot, validateIdSegment } from './worktree-shared.mjs';
import { getExplicitProject } from './core.mjs';
function fail(message) { const e = new Error(message); e.exitCode = 2; throw e; }
function checkedTarget(workspace, target) {
  const path = resolve(workspace, target), rel = relative(workspace, path);
  if (rel.startsWith('..' + sep) || rel === '..') fail('mutate target escapes workspace');
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) fail('mutate target must be a regular non-symlink file');
  const realRel = relative(realpathSync(workspace), realpathSync(path));
  if (realRel.startsWith('..' + sep) || realRel === '..') fail('mutate target resolves outside workspace');
  return { path, stat };
}
function identity(stat){return {dev:BigInt(stat.dev),ino:BigInt(stat.ino)};}
function sameIdentity(left,right){return left.dev===right.dev&&left.ino===right.ino;}
function assertTargetIdentity(path,expected){const stat=lstatSync(path,{bigint:true});if(stat.isSymbolicLink()||!stat.isFile()||!sameIdentity(identity(stat),expected))fail('mutate target pathname changed during test; bound file was restored but the path requires inspection');}
function readAll(fd){const stat=fstatSync(fd);const out=Buffer.alloc(stat.size);let offset=0;while(offset<out.length){let count;try{count=readSync(fd,out,offset,out.length-offset,offset);}catch(error){if(error?.code==='EINTR')continue;throw error;}if(count<=0)fail('mutate target read made no progress');offset+=count;}return out;}
function replaceBytes(fd,bytes){ftruncateSync(fd,0);let offset=0;while(offset<bytes.length){let count;try{count=writeSync(fd,bytes,offset,bytes.length-offset,offset);}catch(error){if(error?.code==='EINTR')continue;throw error;}if(count<=0)fail('mutate target write made no progress');offset+=count;}}
function openBoundTarget(workspace,target,{expectedIdentity=null,expectedBytes=null,expectedMode=null}={}){const base=resolve(workspace),{path,stat:before}=checkedTarget(base,target),noFollow=Number.isInteger(FS.O_NOFOLLOW)?FS.O_NOFOLLOW:0,fd=openSync(path,FS.O_RDWR|noFollow);try{const opened=fstatSync(fd,{bigint:true});if(!opened.isFile())fail('mutate target must be a regular file');const openedIdentity=identity(opened);if(!sameIdentity(openedIdentity,identity(before)))fail('mutate target changed while opening');assertTargetIdentity(path,openedIdentity);const bytes=readAll(fd),mode=Number(opened.mode&0o777n);if(expectedIdentity&&!sameIdentity(openedIdentity,expectedIdentity))fail('mutate target identity changed before execution');if(expectedBytes&&!bytes.equals(expectedBytes))fail('mutate target bytes changed before execution');if(expectedMode!=null&&mode!==expectedMode)fail('mutate target mode changed before execution');return {fd,path,identity:openedIdentity,bytes,mode};}catch(error){closeSync(fd);throw error;}}
async function runBoundMutate({target,command,timeoutMs=30_000,cwd=process.cwd(),signal=null,replacementBytes=null,expectedIdentity=null,expectedBytes=null,expectedMode=null}) {
  const bound=openBoundTarget(cwd,target,{expectedIdentity,expectedBytes,expectedMode});
  const {fd,path}=bound;let child;let timedOut=false;
  try {
    if(replacementBytes){replaceBytes(fd,replacementBytes);fchmodSync(fd,bound.mode);assertTargetIdentity(path,bound.identity);}
    const code=await new Promise((resolveCode,reject)=>{
      child=spawn(command,{cwd,shell:true,detached:true,stdio:'ignore'});
      let aborted=false;
      const killGroup=()=>{ try{process.kill(-child.pid,'SIGKILL');}catch{} };
      const onAbort=()=>{aborted=true;killGroup();};
      if(signal?.aborted) onAbort(); else signal?.addEventListener?.('abort',onAbort,{once:true});
      const timer=setTimeout(()=>{timedOut=true;killGroup();},timeoutMs);
      child.once('error',error=>{clearTimeout(timer);signal?.removeEventListener?.('abort',onAbort);reject(error);});
      child.once('close',exitCode=>{clearTimeout(timer);signal?.removeEventListener?.('abort',onAbort);resolveCode(aborted?'aborted':exitCode);});
    });
    return { outcome:code==='aborted'?'skipped':timedOut?'timeout':code===0?'survived':'killed', exit_code:typeof code==='number'?code:null };
  } finally {
    if(child?.pid)try{process.kill(-child.pid,'SIGKILL');}catch{}
    let restoreError=null;
    try{replaceBytes(fd,bound.bytes);fchmodSync(fd,bound.mode);const after=readAll(fd),mode=Number(fstatSync(fd,{bigint:true}).mode&0o777n);if(!after.equals(bound.bytes)||mode!==bound.mode)fail('mutate restore failed; recover target from snapshot');assertTargetIdentity(path,bound.identity);}catch(error){restoreError=error;}
    try{closeSync(fd);}catch(error){restoreError??=error;}
    if(restoreError)throw restoreError;
  }
}
export async function runMutate(options){return runBoundMutate(options);}
export function simpleMutations(source, { changedLines = null, maxMutants = 12 } = {}) {
  const lines = String(source).split('\n');
  const allowed = changedLines == null ? null : new Set(changedLines.filter(line => Number.isInteger(line) && line > 0));
  const groups = { boolean: [], comparison: [], relational: [], logical: [], numeric: [] }, seen = new Set();
  const add = (lineIndex, start, length, replacement, operator) => {
    const next = [...lines];
    next[lineIndex] = next[lineIndex].slice(0, start) + replacement + next[lineIndex].slice(start + length);
    const mutated = next.join('\n');
    if (!seen.has(mutated)) { seen.add(mutated); groups[operator].push({ operator, line: lineIndex + 1, source: mutated }); }
  };
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    if (allowed && !allowed.has(lineIndex + 1)) continue;
    const line = lines[lineIndex];
    for (const match of line.matchAll(/\b(true|false)\b/g)) add(lineIndex, match.index, match[0].length, match[1] === 'true' ? 'false' : 'true', 'boolean');
    for (const match of line.matchAll(/(!==|===)/g)) add(lineIndex, match.index, match[0].length, match[1] === '===' ? '!==' : '===', 'comparison');
    for (const match of line.matchAll(/(?<![<>=!])(?:<=|>=|<|>)(?![=>])/g)) add(lineIndex, match.index, match[0].length, ({ '<': '<=', '<=': '<', '>': '>=', '>=': '>' })[match[0]], 'relational');
    for (const match of line.matchAll(/&&|\|\|/g)) add(lineIndex, match.index, match[0].length, match[0] === '&&' ? '||' : '&&', 'logical');
    for (const numeric of line.matchAll(/\b\d+\b/g)) add(lineIndex, numeric.index, numeric[0].length, String(Number(numeric[0]) + 1), 'numeric');
  }
  const result=[]; while(result.length < maxMutants && Object.values(groups).some(group => group.length)) for(const group of Object.values(groups)) if(group.length && result.length < maxMutants) result.push(group.shift());
  return result;
}
function git(workspace, args) { return spawnSync('git', args, { cwd: workspace, encoding: 'utf8' }); }
function isDirty(workspace, target) { const result=git(workspace,['status','--porcelain=v1','--untracked-files=all','--',target]); return result.status!==0 || Boolean(result.stdout.trim()); }
function patchPath(value){let path=String(value||'').trim();if(path.startsWith('\"'))try{path=JSON.parse(path);}catch{return null;}path=path.split('\t')[0].replace(/\\/g,'/');return path==='/dev/null'?null:path.replace(/^[ab]\//,'').replace(/^\.\//,'');}
function parseChangedLines(diff,target=null){const rows=String(diff||'').split('\n'),lines=new Set(),normalized=String(target||'').replace(/\\/g,'/').replace(/^\.\//,'');let file=null,newLine=null,sawFile=false;for(const row of rows){if(row.startsWith('+++ ')){file=patchPath(row.slice(4));sawFile=true;newLine=null;continue;}const hunk=/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(row);if(hunk){newLine=Number(hunk[1]);continue;}if(newLine==null||row.startsWith('\\'))continue;const selected=!sawFile||file===normalized;if(row.startsWith('+')){if(selected)lines.add(newLine);newLine+=1;}else if(!row.startsWith('-'))newLine+=1;}return [...lines].sort((a,b)=>a-b);}
function changedLinesFor(workspace, target, data) {
  if (Array.isArray(data.changed_lines)) return [...new Set(data.changed_lines.filter(Number.isInteger))].sort((a,b)=>a-b);
  if (typeof data.diff === 'string') return parseChangedLines(data.diff,target);
  if (typeof data.base === 'string' && data.base) {
    const result=git(workspace,['diff','--unified=0',`${data.base}...HEAD`,'--',target]);
    if(result.status===0) return parseChangedLines(result.stdout,target);
  }
  return [];
}

function loadTaskArtifact(root, task, projectName = null) {
  const projects = join(root, '.xm', 'build', 'projects');
  if (!existsSync(projects)) return null;
  const matches=[];
  for (const project of readdirSync(projects)) {
    if(projectName&&project!==projectName)continue;
    const dir = join(projects, project, 'worktrees', task);
    for (const file of ['run.json', 'task.json', 'mutate.json']) {
      const path = join(dir, file);
      if (!existsSync(path)) continue;
      try {
        const data=JSON.parse(readFileSync(path,'utf8'));
        const tasksPath=join(projects,project,'phases','02-plan','tasks.json');
        if(existsSync(tasksPath)){try{const row=JSON.parse(readFileSync(tasksPath,'utf8')).tasks?.find(candidate=>candidate.id===task);if(row)data.task=row;}catch{}}
        matches.push({dir,data,project,artifact_file:file});
        break;
      } catch {}
    }
  }
  if(matches.length>1)fail('mutate task id is ambiguous; pass --project <name>');
  return matches[0]||null;
}
function detectedTestCommand(workspace,data){
  const explicit=data.test_command||data.testCommand||data.task?.test_command;
  if(typeof explicit==='string'&&explicit.trim())return { command: explicit, source: 'explicit' };
  const packagePath=join(workspace,'package.json');
  if(existsSync(packagePath)){try{const pkg=JSON.parse(readFileSync(packagePath,'utf8'));if(pkg.scripts?.test){if(existsSync(join(workspace,'bun.lock'))||existsSync(join(workspace,'bun.lockb')))return {command:'bun run test',source:'package:bun'};if(existsSync(join(workspace,'pnpm-lock.yaml')))return {command:'pnpm test',source:'package:pnpm'};if(existsSync(join(workspace,'yarn.lock')))return {command:'yarn test',source:'package:yarn'};return {command:'npm test',source:'package:npm'};}}catch{}}
  return null;
}
function taskTargets(data){
  const explicit=data.target||data.file;
  const candidates=explicit?[explicit]:(data.task?.expected_files||[]);
  return [...new Set(candidates.filter(file=>typeof file==='string'&&/\.(?:[cm]?[jt]sx?)$/i.test(file)))];
}
function repositoryRoot(path){const result=spawnSync('git',['rev-parse','--git-common-dir'],{cwd:path,encoding:'utf8'});if(result.status!==0)fail('mutate task worktree is not a git repository');return realpathSync(resolve(path,result.stdout.trim(),'..'));}
function worktreeRecords(root){const result=spawnSync('git',['worktree','list','--porcelain','-z'],{cwd:root,encoding:'utf8'});if(result.status!==0)fail('mutate could not enumerate registered worktrees');return String(result.stdout||'').split('\0\0').filter(Boolean).map(block=>{const record={path:null,branch:null,detached:false,bare:false,prunable:false};for(const token of block.split('\0').filter(Boolean)){const space=token.indexOf(' '),key=space<0?token:token.slice(0,space),value=space<0?'':token.slice(space+1);if(key==='worktree')record.path=value;else if(key==='branch')record.branch=value;else if(key==='detached')record.detached=true;else if(key==='bare')record.bare=true;else if(key==='prunable')record.prunable=true;}return record;});}
function workspaceClaims(stateRoot,workspace){const projects=join(stateRoot,'.xm','build','projects'),claims=[];if(!existsSync(projects))return claims;for(const projectEntry of readdirSync(projects,{withFileTypes:true})){if(!projectEntry.isDirectory()||projectEntry.isSymbolicLink())continue;const worktrees=join(projects,projectEntry.name,'worktrees');if(!existsSync(worktrees))continue;for(const taskEntry of readdirSync(worktrees,{withFileTypes:true})){if(!taskEntry.isDirectory()||taskEntry.isSymbolicLink())continue;const run=join(worktrees,taskEntry.name,'run.json');if(!existsSync(run))continue;try{const data=JSON.parse(readFileSync(run,'utf8')),candidate=typeof data.worktree==='string'&&data.worktree.trim()?(isAbsolute(data.worktree)?resolve(data.worktree):resolve(stateRoot,data.worktree)):null;if(candidate&&existsSync(candidate)&&realpathSync(candidate)===workspace)claims.push({project:projectEntry.name,task:taskEntry.name});}catch{}}}return claims;}
function mutationWorkspace(artifact,stateRoot,task){const data=artifact?.data;if(artifact?.artifact_file!=='run.json')fail('mutate task requires an authoritative run.json artifact');if(data?.task_id!==task)fail('mutate task artifact identity does not match the selected task');if(typeof data?.branch!=='string'||!data.branch.trim())fail('mutate task artifact is missing its branch');if(typeof data?.worktree!=='string'||!data.worktree.trim())fail('mutate task artifact is missing its worktree path');const path=isAbsolute(data.worktree)?resolve(data.worktree):resolve(stateRoot,data.worktree);if(!existsSync(path))fail('mutate task worktree is missing');const stat=lstatSync(path);if(!stat.isDirectory()||stat.isSymbolicLink())fail('mutate task worktree must be a regular directory');const workspace=realpathSync(path),stateRepo=repositoryRoot(resolve(stateRoot)),worktreeRepo=repositoryRoot(workspace);if(stateRepo!==worktreeRepo)fail('mutate task worktree belongs to a different repository');if(workspace===stateRepo)fail('mutate refuses the primary checkout; task requires its linked worktree');const matches=worktreeRecords(stateRepo).filter(record=>{if(!record.path||!existsSync(record.path))return false;try{return realpathSync(record.path)===workspace;}catch{return false;}});if(matches.length!==1)fail('mutate task worktree is not uniquely registered');const record=matches[0],expectedBranch='refs/heads/'+data.branch;if(record.detached||record.bare||record.prunable||record.branch!==expectedBranch)fail('mutate task worktree registration does not match its recorded branch');const claims=workspaceClaims(stateRoot,workspace);if(claims.length!==1||claims[0].project!==artifact.project||claims[0].task!==task)fail('mutate task worktree is claimed by another task');return workspace;}
function canonicalStateRoot(cwd){if(process.env.X_BUILD_ROOT)return resolve(process.env.X_BUILD_ROOT,'..','..');if(process.env.XM_ROOT)return resolve(process.env.XM_ROOT,'..');return resolveMainRepoRoot(cwd)||resolve(cwd);}
function reportArtifact(project,task){return '.xm/review/mutate/'+project+'/'+task+'.json';}
function ensureReportDirectory(dir){try{mkdirSync(dir,{mode:0o700});}catch(error){if(error?.code!=='EEXIST')throw error;}const stat=lstatSync(dir);if(!stat.isDirectory()||stat.isSymbolicLink())fail('mutate report directory is unsafe');}
function writeAll(fd,buffer){let offset=0;while(offset<buffer.length){let written;try{written=writeSync(fd,buffer,offset,buffer.length-offset,null);}catch(error){if(error?.code==='EINTR')continue;throw error;}if(written<=0){const error=new Error('mutate report write made no progress');error.code='EIO';throw error;}offset+=written;}}
function sameFileIdentity(path,identity){try{const stat=lstatSync(path,{bigint:true});return !stat.isSymbolicLink()&&stat.dev===identity.dev&&stat.ino===identity.ino;}catch{return false;}}
function syncDirectory(path){const fd=openSync(path,FS.O_RDONLY);try{fsyncSync(fd);}catch(error){if(!['EINVAL','ENOTSUP','EOPNOTSUPP'].includes(error?.code))throw error;}finally{closeSync(fd);}}
function persistReport(state,project,task,report){const review=join(state,'.xm','review','mutate'),projectDir=join(review,project),reportPath=join(projectDir,task+'.json');for(const dir of [join(state,'.xm'),join(state,'.xm','review'),review,projectDir])ensureReportDirectory(dir);if(existsSync(reportPath)){const stat=lstatSync(reportPath);if(!stat.isFile()||stat.isSymbolicLink())fail('mutate report path is unsafe');}const payload=Buffer.from(JSON.stringify(report)+'\n'),noFollow=Number.isInteger(FS.O_NOFOLLOW)?FS.O_NOFOLLOW:0,flags=FS.O_WRONLY|FS.O_CREAT|FS.O_EXCL|noFollow;let fd=null,tmp=null,identity=null,published=false;try{for(let attempt=0;attempt<16;attempt+=1){tmp=join(projectDir,'.'+task+'.'+randomBytes(16).toString('hex')+'.tmp');try{fd=openSync(tmp,flags,0o600);break;}catch(error){if(error?.code!=='EEXIST')throw error;}}if(fd==null)fail('mutate could not allocate a unique report temporary file');const stat=fstatSync(fd,{bigint:true});identity={dev:stat.dev,ino:stat.ino};if(!stat.isFile())fail('mutate report temporary path is unsafe');writeAll(fd,payload);fsyncSync(fd);closeSync(fd);fd=null;renameSync(tmp,reportPath);syncDirectory(projectDir);published=true;return reportPath;}finally{if(fd!=null)try{closeSync(fd);}catch{}if(!published&&tmp&&identity&&sameFileIdentity(tmp,identity))try{unlinkSync(tmp);}catch{}}}
function acquireMutationLock(state,workspace,project,task){const dir=join(state,'.xm','review','mutate'),key=createHash('sha256').update(realpathSync(workspace)).digest('hex').slice(0,24);for(const path of [join(state,'.xm'),join(state,'.xm','review'),dir])ensureReportDirectory(path);let releaseFile;try{releaseFile=acquireAttentionLock(join(dir,'.workspace-'+key),{waitMs:100,staleMs:10000});}catch{fail('mutation already running for task worktree');}const repo=repositoryRoot(state),locked=git(repo,['worktree','lock','--reason',`xm mutate ${project}/${task}`,workspace]);if(locked.status!==0){releaseFile();fail('mutate could not lock the registered task worktree');}return ()=>{try{git(repo,['worktree','unlock',workspace]);}finally{releaseFile();}};}
function mutationPlan(workspace,data,{maxMutants=12}={}){const test=detectedTestCommand(workspace,data),targets=taskTargets(data);if(!test)return {reason:'no test command',test:null,targets,candidates:[]};if(!targets.length)return {reason:'no supported expected_files',test,targets,candidates:[]};const candidates=[];let existing=0;try{for(const target of targets){if(!existsSync(resolve(workspace,target)))continue;existing+=1;const {path}=checkedTarget(workspace,target);if(isDirty(workspace,target))return {reason:'target file has pre-existing changes',test,targets,candidates:[]};const bound=openBoundTarget(workspace,path);try{const changedLines=changedLinesFor(workspace,target,data),mutations=simpleMutations(bound.bytes.toString('utf8'),{changedLines,maxMutants:maxMutants-candidates.length});for(const mutation of mutations)candidates.push({target,path,originalBytes:bound.bytes,originalMode:bound.mode,originalIdentity:bound.identity,mutation});}finally{closeSync(bound.fd);}if(candidates.length>=maxMutants)break;}}catch(error){return {reason:error.message,test,targets,candidates:[]};}if(!existing)return {reason:'target files are absent in this worktree',test,targets,candidates:[]};if(!candidates.length)return {reason:'no supported mutation on changed lines',test,targets,candidates:[]};return {reason:null,test,targets,candidates};}
export function listMutationTasks(stateRoot,workspaceRoot=stateRoot){
  const state=resolve(stateRoot),workspace=resolve(workspaceRoot),projects=join(state,'.xm','build','projects'),rows=[];
  if(!existsSync(projects))return rows;
  for(const entry of readdirSync(projects,{withFileTypes:true})){
    if(!entry.isDirectory()||entry.isSymbolicLink())continue;
    const project=entry.name,tasksPath=join(projects,project,'phases','02-plan','tasks.json');let tasks=[];
    if(existsSync(tasksPath))try{tasks=JSON.parse(readFileSync(tasksPath,'utf8')).tasks||[];}catch{}
    const ids=new Set(tasks.map(task=>task.id).filter(Boolean)),worktrees=join(projects,project,'worktrees');
    if(existsSync(worktrees))for(const dirent of readdirSync(worktrees,{withFileTypes:true}))if(dirent.isDirectory()&&dirent.name!=='__integration__')ids.add(dirent.name);
    for(const id of [...ids].sort()){const artifact=loadTaskArtifact(state,id,project),task=tasks.find(candidate=>candidate.id===id)||artifact?.data?.task||{},data=artifact?.data||{task},targets=taskTargets(data);let reason=null;if(!artifact)reason='missing worktree artifact';else try{const taskWorkspace=mutationWorkspace(artifact,state,id),plan=mutationPlan(taskWorkspace,data,{maxMutants:1});reason=plan.reason;}catch(error){reason=error.message;}rows.push({project,id,name:task.name||id,status:task.status||null,files:targets,runnable:reason===null,reason});}
  }
  return rows.sort((a,b)=>Number(b.runnable)-Number(a.runnable)||String(a.project).localeCompare(String(b.project))||String(a.id).localeCompare(String(b.id)));
}

export async function runTaskMutate(root, task, { maxMutants = 12, timeoutMs = 90_000, maxDurationMs = 600_000, signal = null, workspaceRoot = root, stateRoot = root, project = null } = {}) {
  const taskError=validateIdSegment(task,'--task');if(taskError)fail(taskError);
  if(project!=null){const projectError=validateIdSegment(project,'--project');if(projectError)fail(projectError);}
  const initial=loadTaskArtifact(stateRoot,task,project);
  if(!initial)fail('mutate task artifact not found');
  const projectId=initial.project,state=resolve(stateRoot),workspace=mutationWorkspace(initial,state,task),release=acquireMutationLock(state,workspace,projectId,task);
  const refresh=()=>{const current=loadTaskArtifact(state,task,projectId);if(!current)fail('mutate task artifact disappeared while locked');const currentWorkspace=mutationWorkspace(current,state,task);if(currentWorkspace!==workspace)fail('mutate task worktree changed while locked');return current;};
  try{
    const artifact=refresh(),plan=mutationPlan(workspace,artifact.data,{maxMutants});
    if(plan.reason)fail(plan.reason);
    const {test,candidates}=plan,baselineStarted=Date.now(),representative=candidates[0];
    refresh();
    const baseline=await runBoundMutate({target:representative.path,command:test.command,cwd:workspace,timeoutMs,signal,expectedIdentity:representative.originalIdentity,expectedBytes:representative.originalBytes,expectedMode:representative.originalMode});
    if(baseline.outcome!=='survived'){const report={schema_v:1,project:projectId,task_id:task,representative:null,mutants:[],counts:{survived:0,timeout:0},duration_ms:Date.now()-baselineStarted,baseline_exit_code:baseline.exit_code,baseline_outcome:baseline.outcome,test_command:test.command,test_command_source:test.source,ts:new Date().toISOString()};refresh();persistReport(state,projectId,task,report);const error=new Error('mutate baseline is not green; fix the test command first');error.exitCode=2;error.report=report;throw error;}
    const outcomes=[],started=Date.now();
    for(const candidate of candidates){if(signal?.aborted||Date.now()-started>=maxDurationMs){outcomes.push({file:candidate.target,operator:candidate.mutation.operator,line:candidate.mutation.line,outcome:'skipped',exit_code:null});continue;}refresh();const outcome=await runBoundMutate({target:candidate.path,command:test.command,cwd:workspace,timeoutMs,signal,replacementBytes:Buffer.from(candidate.mutation.source),expectedIdentity:candidate.originalIdentity,expectedBytes:candidate.originalBytes,expectedMode:candidate.originalMode});outcomes.push({file:candidate.target,operator:candidate.mutation.operator,line:candidate.mutation.line,...outcome});}
    const result=outcomes.find(row=>row.outcome==='survived')||outcomes[0],report={schema_v:1,project:projectId,task_id:task,representative:result,mutants:outcomes,counts:{survived:outcomes.filter(row=>row.outcome==='survived').length,timeout:outcomes.filter(row=>row.outcome==='timeout').length},duration_ms:Date.now()-started,baseline_exit_code:baseline.exit_code,test_command:test.command,test_command_source:test.source,ts:new Date().toISOString()};
    refresh();persistReport(state,projectId,task,report);
    const artifactPath=reportArtifact(projectId,task),surviving=outcomes.filter(row=>row.outcome==='survived').map(row=>buildEscapeRow({mutant:true,ts:report.ts,task_id:task,file:row.file,artifact:artifactPath,source:'mutate',operator:row.operator,line:row.line}));
    if(surviving.length)appendAttentionRows(state,surviving);
    return report;
  }finally{release();}
}
export async function cmdMutate(args) {
  let task=null,project=getExplicitProject(),maxMutants=12,timeoutMs=90_000,json=false,list=args.length===0;
  for(let i=0;i<args.length;i+=1){const arg=args[i];if(arg==='--list')list=true;else if(arg==='--task'&&args[i+1])task=args[++i];else if((arg==='--project'||arg==='-p')&&args[i+1])project=args[++i];else if(arg.startsWith('--project='))project=arg.slice('--project='.length);else if(arg==='--max-mutants'&&args[i+1])maxMutants=Number(args[++i]);else if(arg==='--timeout-ms'&&args[i+1])timeoutMs=Number(args[++i]);else if(arg==='--json')json=true;else{console.error('Usage: xm build mutate [--list] [--json] | --project <name> --task <id> [--max-mutants N] [--timeout-ms M] [--json]');process.exitCode=2;return;}}
  const workspace=resolve(process.cwd()),state=canonicalStateRoot(workspace);
  if(list){if(task){console.error('mutate --list cannot be combined with --task');process.exitCode=2;return;}const tasks=listMutationTasks(state,workspace),runnable=tasks.filter(row=>row.runnable),out={schema_v:1,tasks,runnable_count:runnable.length};if(json)console.log(JSON.stringify(out));else if(runnable.length){console.log('Mutation testing candidates (existing tests are checked; no tests are generated):');for(const row of runnable)console.log(`  ✓ ${row.project}/${row.id} — ${row.name}${row.status?' ['+row.status+']':''} — ${row.files.join(', ')}`);console.log('Choose one with /xm:mutate or run: xm build mutate --project <project> --task <id>');}else if(!tasks.length)console.log('No x-build tasks found. Create or import a plan before running mutation testing.');else{const reasons=new Map();for(const row of tasks)reasons.set(row.reason,(reasons.get(row.reason)||0)+1);console.log('No tasks are ready for mutation testing.');console.log('This command checks existing tests; it does not generate tests.');console.log('Why: '+[...reasons].map(([reason,count])=>`${count} ${reason}`).join('; '));console.log('Next: prepare an x-build task with a worktree artifact, supported source files, and a test command.');}return;}
  if(!task||!/^[a-zA-Z0-9._-]+$/.test(task)||(project!=null&&!/^[a-zA-Z0-9._-]+$/.test(project))||!Number.isInteger(maxMutants)||maxMutants<1||maxMutants>100||!Number.isInteger(timeoutMs)||timeoutMs<1){console.error('mutate requires valid --project, --task, --max-mutants, and --timeout-ms values; run `xm build mutate --list` to choose a task');process.exitCode=2;return;}
  const controller=new AbortController();let interrupted=null;const stop=signalName=>()=>{interrupted=signalName;controller.abort();};const onInt=stop('SIGINT'),onTerm=stop('SIGTERM');process.once('SIGINT',onInt);process.once('SIGTERM',onTerm);
  try{const report=await runTaskMutate(state,task,{maxMutants,timeoutMs,signal:controller.signal,workspaceRoot:workspace,stateRoot:state,project});if(json)console.log(JSON.stringify(report));else console.log(`Mutate ${project?project+'/':''}${task}: ${report.counts.survived} survived, ${report.counts.timeout} timed out (${report.mutants.length} mutants)`);if(interrupted)process.exitCode=130;}catch(error){if(json&&error.report)console.log(JSON.stringify(error.report));else console.error(error.message);process.exitCode=interrupted?130:(error.exitCode||2);}finally{process.removeListener('SIGINT',onInt);process.removeListener('SIGTERM',onTerm);}
}
