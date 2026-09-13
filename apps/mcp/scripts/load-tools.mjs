import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';

const pool = new pg.Pool();
const concurrency = Number(process.env.PERF_CONCURRENCY ?? 5);
const iterations = Number(process.env.PERF_ITERATIONS ?? 10);
const port = Number(process.env.PERF_PORT ?? 3349);
const mode = process.env.PERF_MODE ?? 'lexical';
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 64 || !Number.isInteger(iterations) || iterations < 1 || iterations > 10000) throw new Error('Invalid load size. Use concurrency 1..64 and iterations 1..10000.');
if (!['lexical','semantic'].includes(mode)) throw new Error('PERF_MODE must be lexical or semantic');
const endpoint = `http://127.0.0.1:${port}/mcp`;
const samples = {};
let api, provider;
async function rpc(method, params) {
  const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }), signal: AbortSignal.timeout(60_000) });
  const text = await response.text();
  const payload = JSON.parse(text.split('\n').find(l => l.startsWith('data: '))?.slice(6) ?? text);
  // Never echo response contents: errors can contain private source records.
  if (!response.ok || payload.error || payload.result?.isError) throw new Error(`${method} failed (HTTP ${response.status})`);
  return payload.result;
}
async function call(name, args) {
  const start = performance.now();
  let error = false;
  try { return (await rpc('tools/call', { name, arguments: args })).structuredContent; }
  catch (e) { error = true; console.error(`Tool failed: ${name}; response details omitted for privacy.`); throw e; }
  finally { (samples[name] ??= []).push({ ms: performance.now()-start, error }); }
}
try {
  const db = (await pool.query('SELECT current_database() name')).rows[0].name;
  if (!db.endsWith('_perf') || process.env.PERF_ISOLATED !== 'yes') throw new Error('Requires isolated *_perf database.');
  const fixture = (await pool.query('SELECT * FROM memory.performance_fixture_marker')).rows[0];
  const source = (await pool.query(`SELECT n.id,n.title,n.workspace_id,w.domain_id,embedding::text FROM memory.memory_nodes n JOIN memory.workspaces w ON w.id=n.workspace_id WHERE n.status='active' AND embedding IS NOT NULL AND COALESCE(n.content_hash,'') NOT LIKE '%:perf:%' ORDER BY n.created_at,n.id LIMIT 1`)).rows[0];
  // Deterministic local provider isolates vector SQL cost from model latency.
  provider = createServer((req,res) => { req.resume(); res.setHeader('content-type','application/json'); res.end(JSON.stringify({ data: [{ embedding: JSON.parse(source.embedding) }] })); });
  await new Promise(resolve => provider.listen(0,'127.0.0.1',resolve));
  await pool.query(`INSERT INTO memory.system_settings(key,value) VALUES ('embeddings',$1) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`, [JSON.stringify({ enabled: mode === 'semantic', provider: 'openai-compatible', model: 'isolated-performance-fixture', endpoint: `http://127.0.0.1:${provider.address().port}/embed` })]);
  api = spawn(process.execPath,['--import','tsx',process.env.PERF_API_ENTRY ?? 'src/index.ts'],{ env: { ...process.env, PORT: String(port), EMBEDDING_CACHE_SIZE:'0' }, stdio: ['ignore','ignore','ignore'] });
  for (let attempt=0; attempt<100; attempt++) {
    if (api.exitCode !== null) throw new Error(`API exited: ${api.exitCode}`);
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch {}
    await new Promise(r=>setTimeout(r,100));
  }
  const advertised = (await rpc('tools/list',{})).tools.map(t=>t.name);
  // Warm up transport and database pool, without recording measurements.
  await rpc('tools/call',{name:'find_domain',arguments:{searchText:'performance'}});
  const beginArgs = { domainId: source.domain_id, workspaceId: source.workspace_id, goal:'Isolated performance measurement',userRequest:'Synthetic load test',environment:'performance-test' };
  const started = performance.now();
  let cursor=0, failedWorkflows=0;
  await Promise.all(Array.from({length:concurrency},async(_,worker)=>{
    while (cursor<iterations) {
      cursor++;
      const key=`perf-${randomUUID()}`;
      try {
        const domain=await call('create_domain',{domainKey:key,name:'Performance domain',description:'Isolated synthetic load test domain.'});
        await call('update_domain',{domainId:domain.id,name:'Updated performance domain',reason:'Measure catalog update under load.'});
        const workspace=await call('create_workspace',{domainId:domain.id,workspaceKey:key,name:'Performance workspace',description:'Isolated synthetic load test workspace.',creationReason:'Dedicated isolated load test scope.'});
        await call('update_workspace',{workspaceId:workspace.id,name:'Updated performance workspace',reason:'Measure catalog update under load.'});
        await call('find_domain',{searchText:'performance'});
        await call('find_workspace',{domainId:source.domain_id,searchText:'memory'});
        await call('suggest_workspace',{domainId:source.domain_id,subject:'memory',purpose:'Measure workspace discovery performance.'});
        const created=await call('begin_context',{...beginArgs,agentId:`perf-worker-${worker}`});
        const executionId=created.execution.id;
        await call('add_execution_event',{executionId,eventType:'ProgressUpdated',title:'Load test progress',description:'Synthetic event for ingestion measurement.'});
        await call('search_memory',{executionId,query:source.title.split(/\s+/).slice(0,5).join(' '),scope:'Domain'});
        await call('find_memory_relations',{executionId,memoryId:source.id,searchText:'architecture',scope:'Domain'});
        await call('record_reflection',{executionId,whatWorked:['Measured ingestion and lookup'],lessonsLearned:['Benchmark before and after changes']});
        await call('search_reflections',{executionId,query:'erro',scope:'Domain'});
        const complete=await call('complete_execution',{executionId,status:'completed',durationMs:1,finalResponse:'Load test finished',confidence:1,memoryChanges:[0,1].map(n=>({changeType:'Created',memoryType:'fact',title:`Performance fixture ${key}-${n}`,summary:'Synthetic durable memory for ingestion testing',contentHash:`${key}-${n}`}))});
        const next=await call('begin_context',{...beginArgs,agentId:`perf-worker-${worker}`});
        const relation=await call('link_memories',{executionId:next.execution.id,sourceMemoryId:complete.memoryChanges[0].id,targetMemoryId:complete.memoryChanges[1].id,relationType:'contradicts',explanation:'Synthetic contradiction for isolated load testing',evidence:['Synthetic fixture only']});
        const conflict=(await pool.query(`SELECT id FROM memory.memory_conflicts WHERE memory_a_id=LEAST($1::uuid,$2::uuid) AND memory_b_id=GREATEST($1::uuid,$2::uuid) AND status='open'`,complete.memoryChanges.map(n=>n.id))).rows[0];
        await call('resolve_memory_conflict',{executionId:next.execution.id,conflictId:conflict.id,outcome:'dismissed',explanation:'Synthetic contradiction resolved in load test',evidence:['Both records are test fixtures']});
        await call('unlink_memories',{executionId:next.execution.id,relationId:relation.relation.id,reason:'Remove isolated synthetic test relationship'});
        await call('complete_execution',{executionId:next.execution.id,status:'completed',durationMs:1,finalResponse:'Load test finished',confidence:1});
      } catch { failedWorkflows++; }
    }
  }));
  const durationMs=performance.now()-started;
  const metrics=Object.fromEntries(Object.entries(samples).map(([name,rows])=>{
    const times=rows.map(r=>r.ms).sort((a,b)=>a-b);
    const p=f=>+times[Math.max(0,Math.ceil(times.length*f)-1)].toFixed(2);
    return [name,{samples:rows.length,errors:rows.filter(r=>r.error).length,p50Ms:p(.5),p95Ms:p(.95),p99Ms:p(.99),maxMs:p(1)}];
  }));
  const report={timestamp:new Date().toISOString(),factor:fixture.factor,mode,provider:'local deterministic vector fixture; model inference excluded',concurrency,iterations,failedWorkflows,durationMs,requestsPerSecond:Object.values(samples).reduce((n,r)=>n+r.length,0)/(durationMs/1000),uncoveredTools:advertised.filter(n=>!samples[n]),metrics};
  if(process.env.PERF_REPORT) await writeFile(process.env.PERF_REPORT,JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
  if(failedWorkflows || report.uncoveredTools.length) process.exitCode=1;
} finally {
  if(api && api.exitCode === null){ const stopped=new Promise(r=>api.once('exit',r)); api.kill(); await stopped; }
  if(provider) await new Promise(r=>provider.close(r));
  await pool.end();
}
