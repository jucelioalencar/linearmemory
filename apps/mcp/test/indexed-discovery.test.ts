import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { pool } from '../src/db.js';
import { similarityQuery } from '../src/similarity-query.js';
import { relationCandidatesSql } from '../src/relation-candidates.js';

test('nearest relation candidates match exhaustive ranking across scopes and limits', async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const domain = (await client.query(`INSERT INTO memory.knowledge_domains(domain_key,name,description) VALUES ($1,'test','test') RETURNING id`, [randomUUID()])).rows[0].id;
    const workspaces = [];
    for (let i=0;i<2;i++) workspaces.push((await client.query(`INSERT INTO memory.workspaces(workspace_key,domain_id) VALUES ($1,$2) RETURNING id`, [randomUUID(),domain])).rows[0].id);
    const source = randomUUID();
    await client.query(`INSERT INTO memory.memory_nodes(id,workspace_id,node_type,title,summary) VALUES ($1,$2,'fact','architecture','architecture')`, [source,workspaces[0]]);
    const texts = [['architecture','database'],['database','architecture'],['archi','tecture'],['architecture','database'],['unrelated','other'],['archtecture','design']];
    for (let i=0;i<texts.length;i++) await client.query(`INSERT INTO memory.memory_nodes(workspace_id,node_type,title,summary,importance,created_at) VALUES ($1,'fact',$2,$3,$4,now()+$5*interval '1 second')`, [workspaces[i%2],...texts[i],i/10,i]);
    const exhaustive = `SELECT n.id,GREATEST(similarity(title,$4),similarity(summary,$4),similarity(title || ' ' || summary,$4)) AS similarity FROM memory.memory_nodes n JOIN memory.workspaces w ON w.id=n.workspace_id WHERE n.status='active' AND n.id<>$1 AND (($2='Workspace' AND w.id=$5) OR ($2='Domain' AND w.domain_id=$6)) AND GREATEST(similarity(title,$4),similarity(summary,$4),similarity(title || ' ' || summary,$4)) >= $3 ORDER BY similarity DESC,n.importance DESC,n.created_at DESC LIMIT $7`;
    for (const scope of ['Workspace','Domain']) for (const threshold of [0,.08,.3,1]) for (const limit of [1,2,5,20]) {
      const args: unknown[]=[source,scope,threshold,'architecture',workspaces[0],domain,limit];
      const actual=(await client.query(relationCandidatesSql,args)).rows.map(({id,similarity})=>({id,similarity}));
      assert.deepEqual(actual,(await client.query(exhaustive,args)).rows,`${scope}/${threshold}/${limit}`);
    }
  } finally { await client.query('ROLLBACK'); client.release(); }
});

test('indexed relation discovery preserves similarity matches at threshold boundaries', async () => {
  const key = `perf-regression-${randomUUID()}`;
  const workspace = (await pool.query(`INSERT INTO memory.workspaces(workspace_key) VALUES ($1) RETURNING id`,[key])).rows[0].id;
  try {
    for(const [title, summary] of [['architecture','database design'],['Arquitetura','Decisão validada'],['archtecture','retry timeout'],['unrelated','different topic']]) {
      await pool.query(`INSERT INTO memory.memory_nodes(workspace_id,node_type,title,summary) VALUES ($1,'fact',$2,$3)`,[workspace,title,summary]);
    }
    for(const threshold of [0,.08,.3,1]) {
      const values=[workspace,'architecture',threshold];
      const original=`SELECT id FROM memory.memory_nodes WHERE workspace_id=$1 AND GREATEST(similarity(title,$2),similarity(summary,$2),similarity(title || ' ' || summary,$2)) >= $3 ORDER BY id`;
      const indexed=original.replace('AND GREATEST','AND ($3::real=0 OR title % $2 OR summary % $2 OR (title || \' \' || summary) % $2) AND GREATEST');
      assert.deepEqual((await similarityQuery(indexed,values,threshold)).rows,(await pool.query(original,values)).rows);
    }
    await assert.rejects(similarityQuery('SELECT nonexistent_column',[],.1));
    assert.equal(Number((await pool.query("SELECT current_setting('pg_trgm.similarity_threshold') AS threshold")).rows[0].threshold),.3);
    assert.equal((await pool.query(`SELECT count(*)::int n FROM pg_indexes WHERE indexname IN ('memory_nodes_relation_title_idx','memory_nodes_relation_summary_idx','memory_nodes_relation_text_idx','reflections_search_text_idx')`)).rows[0].n,4);
  } finally {
    await pool.query('DELETE FROM memory.memory_nodes WHERE workspace_id=$1',[workspace]);
    await pool.query('DELETE FROM memory.workspaces WHERE id=$1',[workspace]);
  }
});

test.after(()=>pool.end());

test('reflection search text stays synchronized on insert and update', async () => {
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    const workspace=(await client.query(`INSERT INTO memory.workspaces(workspace_key) VALUES ($1) RETURNING id`,[randomUUID()])).rows[0].id;
    const agent=(await client.query(`INSERT INTO memory.agents(agent_key) VALUES ($1) RETURNING id`,[randomUUID()])).rows[0].id;
    const session=(await client.query(`INSERT INTO memory.sessions(workspace_id,agent_id,task) VALUES ($1,$2,'test') RETURNING id`,[workspace,agent])).rows[0].id;
    const execution=(await client.query(`INSERT INTO memory.executions(workspace_id,session_id,agent_id,goal,user_request) VALUES ($1,$2,$3,'test','test') RETURNING id`,[workspace,session,agent])).rows[0].id;
    const reflection=(await client.query(`INSERT INTO memory.reflections(execution_id,what_worked,lessons_learned) VALUES ($1,ARRAY['ação validada'],ARRAY['decisão']) RETURNING id,search_text`,[execution])).rows[0];
    assert.equal(reflection.search_text,'decisao ação validada'.normalize('NFD').replace(/[\u0300-\u036f]/g,''));
    const changed=(await client.query(`UPDATE memory.reflections SET what_failed=ARRAY['erro corrigido'] WHERE id=$1 RETURNING search_text`,[reflection.id])).rows[0];
    assert.equal(changed.search_text,'decisao erro corrigido acao validada');
  } finally { await client.query('ROLLBACK'); client.release(); }
});
