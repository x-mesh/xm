import { lstatSync, realpathSync, readFileSync, writeFileSync, chmodSync, existsSync, mkdirSync, readdirSync, renameSync, openSync, closeSync, fstatSync, writeSync, unlinkSync, constants as FS } from 'node:fs';
import { join, resolve, relative, sep, dirname } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendAttentionRows } from './attention-collect.mjs';
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
export async function runMutate({ target, command, timeoutMs=30_000, cwd=process.cwd(), signal=null }) {
  const base = resolve(cwd);
  const { path, stat } = checkedTarget(base, target); target = path;
  const bytes=readFileSync(target), mode=stat.mode & 0o777; let child; let timedOut=false;
  const restore=()=>{ writeFileSync(target,bytes,{mode}); chmodSync(target,mode); const after=readFileSync(target); if(!after.equals(bytes) || (lstatSync(target).mode&0o777)!==mode) fail('mutate restore failed; recover target from snapshot'); };
  try {
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
  } finally { if(child?.pid) try{process.kill(-child.pid,'SIGKILL');}catch{} restore(); }
}
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
function parseChangedLines(diff) {
  const lines = new Set();
  for (const line of String(diff || '').split('\n')) {
    const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!match) continue;
    const start=Number(match[1]), count=match[2]==null?1:Number(match[2]);
    for(let offset=0;offset<count;offset+=1) lines.add(start+offset);
  }
  return [...lines].sort((a,b)=>a-b);
}
function changedLinesFor(workspace, target, data) {
  if (Array.isArray(data.changed_lines)) return [...new Set(data.changed_lines.filter(Number.isInteger))].sort((a,b)=>a-b);
  if (typeof data.diff === 'string') return parseChangedLines(data.diff);
  if (typeof data.base === 'string' && data.base) {
    const result=git(workspace,['diff','--unified=0',`${data.base}...HEAD`,'--',target]);
    if(result.status===0) return parseChangedLines(result.stdout);
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
        matches.push({dir,data,project});
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
function mutationWorkspace(artifact,stateRoot){const candidate=artifact?.data?.worktree;if(typeof candidate!=='string'||!candidate.trim())fail('mutate task artifact is missing its worktree path');const path=resolve(candidate);if(!existsSync(path))fail('mutate task worktree is missing');const stat=lstatSync(path);if(!stat.isDirectory()||stat.isSymbolicLink())fail('mutate task worktree must be a regular directory');const workspace=realpathSync(path),stateRepo=repositoryRoot(resolve(stateRoot)),worktreeRepo=repositoryRoot(workspace);if(stateRepo!==worktreeRepo)fail('mutate task worktree belongs to a different repository');return workspace;}
function canonicalStateRoot(cwd){if(process.env.X_BUILD_ROOT)return resolve(process.env.X_BUILD_ROOT,'..','..');if(process.env.XM_ROOT)return resolve(process.env.XM_ROOT,'..');return resolveMainRepoRoot(cwd)||resolve(cwd);}
function reportArtifact(project,task){return '.xm/review/mutate/'+project+'/'+task+'.json';}
function ensureReportDirectory(dir){try{mkdirSync(dir,{mode:0o700});}catch(error){if(error?.code!=='EEXIST')throw error;}const stat=lstatSync(dir);if(!stat.isDirectory()||stat.isSymbolicLink())fail('mutate report directory is unsafe');}
function writeAll(fd,buffer){let offset=0;while(offset<buffer.length){let written;try{written=writeSync(fd,buffer,offset,buffer.length-offset,null);}catch(error){if(error?.code==='EINTR')continue;throw error;}if(written<=0){const error=new Error('mutate report write made no progress');error.code='EIO';throw error;}offset+=written;}}
function sameFileIdentity(path,identity){try{const stat=lstatSync(path,{bigint:true});return !stat.isSymbolicLink()&&stat.dev===identity.dev&&stat.ino===identity.ino;}catch{return false;}}
function persistReport(state,project,task,report){const review=join(state,'.xm','review','mutate'),projectDir=join(review,project),reportPath=join(projectDir,task+'.json');for(const dir of [join(state,'.xm'),join(state,'.xm','review'),review,projectDir])ensureReportDirectory(dir);if(existsSync(reportPath)){const stat=lstatSync(reportPath);if(!stat.isFile()||stat.isSymbolicLink())fail('mutate report path is unsafe');}const payload=Buffer.from(JSON.stringify(report)+'\n'),noFollow=Number.isInteger(FS.O_NOFOLLOW)?FS.O_NOFOLLOW:0,flags=FS.O_WRONLY|FS.O_CREAT|FS.O_EXCL|noFollow;let fd=null,tmp=null,identity=null,published=false;try{for(let attempt=0;attempt<16;attempt+=1){tmp=join(projectDir,'.'+task+'.'+randomBytes(16).toString('hex')+'.tmp');try{fd=openSync(tmp,flags,0o600);break;}catch(error){if(error?.code!=='EEXIST')throw error;}}if(fd==null)fail('mutate could not allocate a unique report temporary file');const stat=fstatSync(fd,{bigint:true});identity={dev:stat.dev,ino:stat.ino};if(!stat.isFile())fail('mutate report temporary path is unsafe');writeAll(fd,payload);closeSync(fd);fd=null;renameSync(tmp,reportPath);published=true;return reportPath;}finally{if(fd!=null)try{closeSync(fd);}catch{}if(!published&&tmp&&identity&&sameFileIdentity(tmp,identity))try{unlinkSync(tmp);}catch{}}}
export function listMutationTasks(stateRoot,workspaceRoot=stateRoot){
  const state=resolve(stateRoot),workspace=resolve(workspaceRoot),projects=join(state,'.xm','build','projects'),rows=[];
  if(!existsSync(projects))return rows;
  for(const entry of readdirSync(projects,{withFileTypes:true})){
    if(!entry.isDirectory()||entry.isSymbolicLink())continue;
    const project=entry.name,tasksPath=join(projects,project,'phases','02-plan','tasks.json');let tasks=[];
    if(existsSync(tasksPath))try{tasks=JSON.parse(readFileSync(tasksPath,'utf8')).tasks||[];}catch{}
    const ids=new Set(tasks.map(task=>task.id).filter(Boolean)),worktrees=join(projects,project,'worktrees');
    if(existsSync(worktrees))for(const dirent of readdirSync(worktrees,{withFileTypes:true}))if(dirent.isDirectory()&&dirent.name!=='__integration__')ids.add(dirent.name);
    for(const id of [...ids].sort()){const artifact=loadTaskArtifact(state,id,project),task=tasks.find(candidate=>candidate.id===id)||artifact?.data?.task||{},data=artifact?.data||{task},targets=taskTargets(data);let taskWorkspace=workspace,reason=null;if(artifact)try{taskWorkspace=mutationWorkspace(artifact,state);}catch(error){reason=error.message;}const test=artifact&&!reason?detectedTestCommand(taskWorkspace,data):null,existingTargets=targets.filter(file=>existsSync(resolve(taskWorkspace,file)));if(!artifact)reason='missing worktree artifact';else if(!reason&&!targets.length)reason='no supported expected_files';else if(!reason&&!existingTargets.length)reason='target files are absent in this worktree';else if(!reason&&!test)reason='no test command';rows.push({project,id,name:task.name||id,status:task.status||null,files:targets,runnable:reason===null,reason});}
  }
  return rows.sort((a,b)=>Number(b.runnable)-Number(a.runnable)||String(a.project).localeCompare(String(b.project))||String(a.id).localeCompare(String(b.id)));
}

export async function runTaskMutate(root, task, { maxMutants = 12, timeoutMs = 90_000, maxDurationMs = 600_000, signal = null, workspaceRoot = root, stateRoot = root, project = null } = {}) {
  const taskError=validateIdSegment(task,'--task');if(taskError)fail(taskError);
  if(project!=null){const projectError=validateIdSegment(project,'--project');if(projectError)fail(projectError);}
  const artifact = loadTaskArtifact(stateRoot, task, project);
  if (!artifact) fail('mutate task artifact not found');
  const projectId=artifact.project,state=resolve(stateRoot),workspace=mutationWorkspace(artifact,state);
  const test=detectedTestCommand(workspace,artifact.data),targets=taskTargets(artifact.data);
  if(!test||!targets.length) fail('mutate task requires a test command and supported expected_files');
  const candidates=[];
  for(const target of targets){if(!existsSync(resolve(workspace,target)))continue;const {path,stat}=checkedTarget(workspace,target);if(isDirty(workspace,target))fail('mutate refuses pre-existing dirty target');const originalBytes=readFileSync(path),original=originalBytes.toString('utf8'),originalMode=stat.mode&0o777,changedLines=changedLinesFor(workspace,target,artifact.data);for(const mutation of simpleMutations(original,{changedLines,maxMutants:maxMutants-candidates.length}))candidates.push({target,path,originalBytes,originalMode,mutation});if(candidates.length>=maxMutants)break;}
  if(!candidates.length) fail('mutate found no supported mutation on changed lines');
  const baselineStarted=Date.now();
  const baseline=await runMutate({target:candidates[0].path,command:test.command,cwd:workspace,timeoutMs,signal});
  if(baseline.outcome!=='survived'){const report={schema_v:1,project:projectId,task_id:task,representative:null,mutants:[],counts:{survived:0,timeout:0},duration_ms:Date.now()-baselineStarted,baseline_exit_code:baseline.exit_code,baseline_outcome:baseline.outcome,test_command:test.command,test_command_source:test.source,ts:new Date().toISOString()};persistReport(state,projectId,task,report);const error=new Error('mutate baseline is not green; fix the test command first');error.exitCode=2;error.report=report;throw error;}
  const outcomes=[];
  const started=Date.now();
  for(const candidate of candidates){const {target,path,originalBytes,originalMode,mutation}=candidate;try{if(signal?.aborted||Date.now()-started>=maxDurationMs){outcomes.push({file:target,operator:mutation.operator,line:mutation.line,outcome:'skipped',exit_code:null});continue;}writeFileSync(path,mutation.source,{mode:originalMode});outcomes.push({file:target,operator:mutation.operator,line:mutation.line,...(await runMutate({target:path,command:test.command,cwd:workspace,timeoutMs,signal}))});}finally{writeFileSync(path,originalBytes,{mode:originalMode});chmodSync(path,originalMode);if(!readFileSync(path).equals(originalBytes)||(lstatSync(path).mode&0o777)!==originalMode)fail('mutate restore failed; recover target from git');}}
  const result = outcomes.find(row => row.outcome === 'survived') || outcomes[0];
  const report = { schema_v:1,project:projectId,task_id:task,representative:result,mutants:outcomes,counts:{survived:outcomes.filter(row=>row.outcome==='survived').length,timeout:outcomes.filter(row=>row.outcome==='timeout').length},duration_ms:Date.now()-started,baseline_exit_code:baseline.exit_code,test_command:test.command,test_command_source:test.source,ts:new Date().toISOString() };
  persistReport(state,projectId,task,report);
  const artifactPath=reportArtifact(projectId,task),surviving=outcomes.filter(row=>row.outcome==='survived').map(row=>buildEscapeRow({mutant:true,ts:report.ts,task_id:task,file:row.file,artifact:artifactPath,source:'mutate',operator:row.operator,line:row.line}));
  if(surviving.length)appendAttentionRows(state,surviving);
  return report;
}
export async function cmdMutate(args) {
  let task=null,maxMutants=12,timeoutMs=90_000,json=false,list=args.length===0;
  for(let i=0;i<args.length;i+=1){const arg=args[i];if(arg==='--list')list=true;else if(arg==='--task'&&args[i+1])task=args[++i];else if(arg==='--max-mutants'&&args[i+1])maxMutants=Number(args[++i]);else if(arg==='--timeout-ms'&&args[i+1])timeoutMs=Number(args[++i]);else if(arg==='--json')json=true;else{console.error('Usage: xm build mutate [--list] [--json] | --project <name> --task <id> [--max-mutants N] [--timeout-ms M] [--json]');process.exitCode=2;return;}}
  const workspace=resolve(process.cwd()),state=canonicalStateRoot(workspace),project=getExplicitProject();
  if(list){if(task){console.error('mutate --list cannot be combined with --task');process.exitCode=2;return;}const tasks=listMutationTasks(state,workspace),runnable=tasks.filter(row=>row.runnable),out={schema_v:1,tasks,runnable_count:runnable.length};if(json)console.log(JSON.stringify(out));else if(runnable.length){console.log('Mutation testing candidates (existing tests are checked; no tests are generated):');for(const row of runnable)console.log(`  ✓ ${row.project}/${row.id} — ${row.name}${row.status?' ['+row.status+']':''} — ${row.files.join(', ')}`);console.log('Choose one with /xm:mutate or run: xm build mutate --project <project> --task <id>');}else if(!tasks.length)console.log('No x-build tasks found. Create or import a plan before running mutation testing.');else{const reasons=new Map();for(const row of tasks)reasons.set(row.reason,(reasons.get(row.reason)||0)+1);console.log('No tasks are ready for mutation testing.');console.log('This command checks existing tests; it does not generate tests.');console.log('Why: '+[...reasons].map(([reason,count])=>`${count} ${reason}`).join('; '));console.log('Next: prepare an x-build task with a worktree artifact, supported source files, and a test command.');}return;}
  if(!task||!/^[a-zA-Z0-9._-]+$/.test(task)||!Number.isInteger(maxMutants)||maxMutants<1||maxMutants>100||!Number.isInteger(timeoutMs)||timeoutMs<1){console.error('mutate requires valid --task, --max-mutants, and --timeout-ms values; run `xm build mutate --list` to choose a task');process.exitCode=2;return;}
  const controller=new AbortController();let interrupted=null;const stop=signalName=>()=>{interrupted=signalName;controller.abort();};const onInt=stop('SIGINT'),onTerm=stop('SIGTERM');process.once('SIGINT',onInt);process.once('SIGTERM',onTerm);
  try{const report=await runTaskMutate(state,task,{maxMutants,timeoutMs,signal:controller.signal,workspaceRoot:workspace,stateRoot:state,project});if(json)console.log(JSON.stringify(report));else console.log(`Mutate ${project?project+'/':''}${task}: ${report.counts.survived} survived, ${report.counts.timeout} timed out (${report.mutants.length} mutants)`);if(interrupted)process.exitCode=130;}catch(error){if(json&&error.report)console.log(JSON.stringify(error.report));else console.error(error.message);process.exitCode=error.exitCode||2;}finally{process.removeListener('SIGINT',onInt);process.removeListener('SIGTERM',onTerm);}
}
