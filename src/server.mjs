import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync, appendFileSync, writeFileSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CACHE_LIMIT_BYTES, pressureFor, safeCandidates } from './policy.mjs';

const exec = promisify(execFile);
const HOST = process.env.GCC_HOST || '127.0.0.1';
const PORT = Number(process.env.GCC_PORT || 3010);
const ROOT = resolve(new URL('..', import.meta.url).pathname);
const PUBLIC = resolve(ROOT, 'public');
const DATA = resolve(homedir(), '.github-control-center');
const SETTINGS = resolve(DATA, 'settings.json');
const LOG = resolve(DATA, 'cleanup-log.jsonl');
mkdirSync(DATA, { recursive: true });

const defaultSettings = { autoCleanup: false, intervalHours: 6, pressureThreshold: 85, lastAutoRunAt: null };
function loadSettings(){ try { return { ...defaultSettings, ...JSON.parse(readFileSync(SETTINGS,'utf8')) }; } catch { return { ...defaultSettings }; } }
function saveSettings(s){ writeFileSync(SETTINGS, JSON.stringify(s,null,2)); return s; }
let settings = loadSettings();
let cachedSnapshot = null;
let scanPromise = null;

function json(res,status,body){ res.writeHead(status, {'content-type':'application/json; charset=utf-8','cache-control':'no-store'}); res.end(JSON.stringify(body)); }
function text(res,status,body,type='text/plain; charset=utf-8'){ res.writeHead(status, {'content-type':type,'cache-control':'no-store'}); res.end(body); }
async function body(req){ let s=''; for await (const c of req) { s += c; if(s.length>1e6) throw new Error('request too large'); } return s ? JSON.parse(s) : {}; }
function serve(path,res){ const rel=path==='/'?'index.html':path.slice(1); const file=resolve(PUBLIC,rel); if(!file.startsWith(PUBLIC)||!existsSync(file)) return false; const type={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8'}[extname(file)]||'text/plain'; text(res,200,readFileSync(file,'utf8'),type); return true; }

async function gh(args, {allowFailure=false}={}) {
  try {
    const { stdout } = await exec('gh', args, { maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GH_PAGER: 'cat' } });
    return stdout.trim();
  } catch (e) {
    if (allowFailure) return null;
    const msg = String(e.stderr || e.message || e).trim();
    throw new Error(msg || 'gh command failed');
  }
}
async function ghJson(endpoint,{allowFailure=false}={}) { const out = await gh(['api', endpoint],{allowFailure}); return out===null?null:JSON.parse(out||'null'); }
async function ghDelete(endpoint){ await gh(['api','--method','DELETE',endpoint]); }
async function paginate(endpoint, key) {
  const out = await gh(['api','--paginate','--slurp',endpoint],{allowFailure:true});
  if (out===null) return null;
  const pages = JSON.parse(out || '[]');
  const rows=[]; for(const p of pages){ if(Array.isArray(p?.[key])) rows.push(...p[key]); else if(Array.isArray(p)) rows.push(...p); }
  return rows;
}
async function mapLimit(items, limit, fn){ const result=new Array(items.length); let i=0; await Promise.all(Array.from({length:Math.min(limit,items.length)}, async()=>{ while(i<items.length){ const n=i++; result[n]=await fn(items[n],n); } })); return result; }
function bytes(v){ const n=Number(v||0); return Number.isFinite(n)?Math.max(0,n):0; }

async function activeRuns(fullName){ const p=await ghJson(`/repos/${fullName}/actions/runs?status=in_progress&per_page=100`,{allowFailure:true}); const q=await ghJson(`/repos/${fullName}/actions/runs?status=queued&per_page=100`,{allowFailure:true}); return { running:Number(p?.total_count||0), queued:Number(q?.total_count||0) }; }

async function scanRepo(meta){
  const full=meta.full_name;
  const [cacheUsage,caches,artifacts,runs,workflows] = await Promise.all([
    ghJson(`/repos/${full}/actions/cache/usage`,{allowFailure:true}),
    paginate(`/repos/${full}/actions/caches?per_page=100`,'actions_caches'),
    paginate(`/repos/${full}/actions/artifacts?per_page=100`,'artifacts'),
    ghJson(`/repos/${full}/actions/runs?per_page=100`,{allowFailure:true}),
    ghJson(`/repos/${full}/actions/workflows?per_page=100`,{allowFailure:true})
  ]);
  const runRows=Array.isArray(runs?.workflow_runs)?runs.workflow_runs:[];
  const active=runRows.filter(r=>['in_progress','queued','requested','waiting','pending'].includes(r.status));
  const liveArtifacts=(artifacts||[]).filter(a=>!a.expired);
  const repo={
    name:meta.name, fullName:full, private:Boolean(meta.private), defaultBranch:meta.default_branch,
    repoBytes:bytes(meta.size)*1024, cacheBytes:bytes(cacheUsage?.active_caches_size_in_bytes), cacheCount:Number(cacheUsage?.active_caches_count||0), cacheLimitBytes:CACHE_LIMIT_BYTES,
    artifactBytes:liveArtifacts.reduce((s,a)=>s+bytes(a.size_in_bytes),0), artifactCount:liveArtifacts.length,
    running:active.filter(r=>r.status==='in_progress').length, queued:active.filter(r=>r.status!=='in_progress').length,
    totalRuns:Number(runs?.total_count||0), workflowCount:Number(workflows?.total_count||0), recentFailures:runRows.filter(r=>r.status==='completed'&&['failure','cancelled','timed_out','startup_failure'].includes(r.conclusion)).length,
    updatedAt:meta.updated_at, apiErrors:[]
  };
  if(cacheUsage===null) repo.apiErrors.push('cache'); if(caches===null) repo.apiErrors.push('cache-list'); if(artifacts===null) repo.apiErrors.push('artifacts'); if(runs===null) repo.apiErrors.push('runs');
  repo.pressure=pressureFor(repo);
  repo.links={ repo:`https://github.com/${full}`, actions:`https://github.com/${full}/actions`, caches:`https://github.com/${full}/actions/caches`, workflows:`https://github.com/${full}/actions/workflows`, settings:`https://github.com/${full}/settings/actions` };
  return repo;
}

async function accountAllowance(login){
  const endpoints=[`/users/${login}/settings/billing/shared-storage`,`/users/${login}/settings/billing/usage`];
  for(const ep of endpoints){ const v=await ghJson(ep,{allowFailure:true}); if(v) return { available:true, endpoint:ep, raw:v }; }
  return { available:false, reason:'billing scope/API not available to current gh authentication' };
}

async function scan(force=false){
  if(!force && cachedSnapshot && Date.now()-new Date(cachedSnapshot.generatedAt).getTime()<60_000) return cachedSnapshot;
  if(scanPromise) return scanPromise;
  scanPromise=(async()=>{
    const auth=await gh(['auth','status'],{allowFailure:true});
    if(auth===null) throw new Error('GitHub CLI authenticated session not found. Run: gh auth login');
    const profile=await ghJson('/user');
    const repos=await paginate('/user/repos?affiliation=owner&sort=updated&per_page=100','__none__');
    // paginate helper cannot flatten bare arrays when --slurp wraps pages; handle directly.
    const raw=await gh(['api','--paginate','--slurp','/user/repos?affiliation=owner&sort=updated&per_page=100']);
    const pages=JSON.parse(raw||'[]'); const metas=pages.flatMap(p=>Array.isArray(p)?p:[]);
    const rows=await mapLimit(metas,4,scanRepo);
    const totals=rows.reduce((a,r)=>({ repoBytes:a.repoBytes+r.repoBytes, cacheBytes:a.cacheBytes+r.cacheBytes, artifactBytes:a.artifactBytes+r.artifactBytes, running:a.running+r.running, queued:a.queued+r.queued }),{repoBytes:0,cacheBytes:0,artifactBytes:0,running:0,queued:0});
    const allowance=await accountAllowance(profile.login);
    cachedSnapshot={ generatedAt:new Date().toISOString(), login:profile.login, repoCount:rows.length, totals, allowance, settings, repos:rows.sort((a,b)=>b.pressure.score-a.pressure.score) };
    return cachedSnapshot;
  })().finally(()=>{ scanPromise=null; });
  return scanPromise;
}

async function loadCleanupData(full){
  const [caches,artifacts,usage]=await Promise.all([
    paginate(`/repos/${full}/actions/caches?per_page=100`,'actions_caches'),
    paginate(`/repos/${full}/actions/artifacts?per_page=100`,'artifacts'),
    ghJson(`/repos/${full}/actions/cache/usage`,{allowFailure:true})
  ]);
  return { caches:caches||[], artifacts:(artifacts||[]).filter(a=>!a.expired), cacheBytes:bytes(usage?.active_caches_size_in_bytes), cacheLimitBytes:CACHE_LIMIT_BYTES };
}

async function previewCleanup(full,mode='safe'){
  if(!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(full)) throw new Error('Invalid repository');
  const active=await activeRuns(full); if(active.running||active.queued) return { blocked:true, reason:`${active.running} running / ${active.queued} queued`, active };
  const data=await loadCleanupData(full);
  let candidates;
  if(mode==='cache-all') candidates={ cacheCandidates:data.caches, artifactCandidates:[], protectedArtifacts:[], projectedCacheBytes:0 };
  else candidates=safeCandidates(data);
  return { blocked:false, repo:full, mode, before:{cacheBytes:data.cacheBytes,cacheCount:data.caches.length,artifactCount:data.artifacts.length,artifactBytes:data.artifacts.reduce((s,a)=>s+bytes(a.size_in_bytes),0)}, candidates:{ caches:candidates.cacheCandidates.map(c=>({id:c.id,key:c.key,ref:c.ref,size:bytes(c.size_in_bytes),lastAccessed:c.last_accessed_at})), artifacts:candidates.artifactCandidates.map(a=>({id:a.id,name:a.name,size:bytes(a.size_in_bytes),createdAt:a.created_at})), protectedArtifacts:candidates.protectedArtifacts.length, projectedCacheBytes:candidates.projectedCacheBytes } };
}

async function executeCleanup(full,mode,confirmation,automatic=false){
  if(!automatic && confirmation!==`DELETE ${full}`) throw new Error(`Confirmation must be exactly: DELETE ${full}`);
  const preview=await previewCleanup(full,mode); if(preview.blocked) throw new Error(`Cleanup blocked: ${preview.reason}`);
  const deleted={caches:[],artifacts:[],errors:[]};
  for(const c of preview.candidates.caches){ try{ await ghDelete(`/repos/${full}/actions/caches/${c.id}`); deleted.caches.push(c); }catch(e){ deleted.errors.push({type:'cache',id:c.id,error:e.message}); } }
  for(const a of preview.candidates.artifacts){ try{ await ghDelete(`/repos/${full}/actions/artifacts/${a.id}`); deleted.artifacts.push(a); }catch(e){ deleted.errors.push({type:'artifact',id:a.id,error:e.message}); } }
  const after=await loadCleanupData(full); const event={at:new Date().toISOString(),repo:full,mode,automatic,deletedCacheBytes:deleted.caches.reduce((s,c)=>s+c.size,0),deletedArtifactBytes:deleted.artifacts.reduce((s,a)=>s+a.size,0),errors:deleted.errors.length};
  appendFileSync(LOG,JSON.stringify(event)+'\n'); cachedSnapshot=null;
  return { preview, deleted, after:{cacheBytes:after.cacheBytes,cacheCount:after.caches.length,artifactBytes:after.artifacts.reduce((s,a)=>s+bytes(a.size_in_bytes),0),artifactCount:after.artifacts.length}, event };
}

async function autoCleanupTick(){
  settings=loadSettings(); if(!settings.autoCleanup) return;
  const last=settings.lastAutoRunAt?new Date(settings.lastAutoRunAt).getTime():0;
  if(Date.now()-last<settings.intervalHours*3600000) return;
  const snap=await scan(true);
  for(const r of snap.repos){ if(r.pressure.score<settings.pressureThreshold||r.running||r.queued) continue; try{ await executeCleanup(r.fullName,'safe','',true); }catch(e){ appendFileSync(LOG,JSON.stringify({at:new Date().toISOString(),repo:r.fullName,automatic:true,error:e.message})+'\n'); } }
  settings.lastAutoRunAt=new Date().toISOString(); saveSettings(settings); cachedSnapshot=null;
}
setInterval(()=>autoCleanupTick().catch(()=>{}),15*60_000).unref();
setTimeout(()=>autoCleanupTick().catch(()=>{}),15_000).unref();

const server=createServer(async(req,res)=>{
  try{
    const url=new URL(req.url||'/',`http://${req.headers.host||HOST}`); const path=url.pathname; const method=req.method||'GET';
    if(method==='GET'&&path==='/api/health') return json(res,200,{ok:true,host:HOST,port:PORT,settings});
    if(method==='GET'&&path==='/api/snapshot') return json(res,200,await scan(url.searchParams.get('force')==='1'));
    if(method==='GET'&&path==='/api/settings') return json(res,200,settings);
    if(method==='POST'&&path==='/api/settings'){ const b=await body(req); settings=saveSettings({ ...settings, autoCleanup:Boolean(b.autoCleanup), intervalHours:Math.max(1,Math.min(168,Number(b.intervalHours||6))), pressureThreshold:Math.max(50,Math.min(100,Number(b.pressureThreshold||85))) }); cachedSnapshot=null; return json(res,200,settings); }
    if(method==='POST'&&path==='/api/cleanup/preview'){ const b=await body(req); return json(res,200,await previewCleanup(String(b.repo||''),String(b.mode||'safe'))); }
    if(method==='POST'&&path==='/api/cleanup/execute'){ const b=await body(req); return json(res,200,await executeCleanup(String(b.repo||''),String(b.mode||'safe'),String(b.confirmation||''),false)); }
    if(method==='GET'&&!path.startsWith('/api/')&&serve(path,res)) return;
    json(res,404,{error:'Not found'});
  }catch(e){ json(res,400,{error:e instanceof Error?e.message:String(e)}); }
});
server.listen(PORT,HOST,()=>console.log(`GitHub Control Center: http://${HOST}:${PORT}`));
