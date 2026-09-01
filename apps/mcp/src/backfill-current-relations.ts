import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({ max: 2 });

type RelationSeed = {
  sourceTitle: string;
  targetTitle: string;
  relationType: 'supports' | 'depends_on' | 'caused' | 'contradicts' | 'refines' | 'implements' | 'validates' | 'supersedes' | 'related_to';
  explanation: string;
  evidence: string[];
  confidence: number;
  weight: number;
};

const seeds: RelationSeed[] = [
  {
    sourceTitle: 'MCP Pilot requer extensão Chrome ativa - fallback webfetch funciona',
    targetTitle: 'Cadastro Integrador Sol Agora - fluxo completo e URLs',
    relationType: 'caused',
    explanation: 'A indisponibilidade da extensão levou ao uso do fallback webfetch que produziu o primeiro fluxo documentado da Sol Agora.',
    evidence: ['Extensão registrada como desconectada', 'Fallback webfetch registrado como fonte do fluxo inicial'],
    confidence: 0.97,
    weight: 2
  },
  {
    sourceTitle: 'Cadastro Integrador Sol Agora - Execução MCP Pilot 2026-08-31 validada',
    targetTitle: 'Cadastro Integrador Sol Agora - fluxo completo e URLs',
    relationType: 'validates',
    explanation: 'A execução real confirmou URLs, campos obrigatórios e partes operacionais descritas no fluxo inicialmente obtido por pesquisa.',
    evidence: ['Navegação real por quatro URLs', 'Seis campos obrigatórios preenchidos', 'Validação por JSON e captura de tela'],
    confidence: 0.9,
    weight: 2
  },
  {
    sourceTitle: 'Cadastro Integrador Sol Agora - Fluxo MCP Pilot validado 2026-08-31 com nativeSetter',
    targetTitle: 'Cadastro Integrador Sol Agora - Execução MCP Pilot 2026-08-31 validada',
    relationType: 'refines',
    explanation: 'O fluxo com nativeSetter aprofunda a execução anterior ao confirmar o modal, o redirecionamento e os campos da etapa de dados básicos.',
    evidence: ['Modal Confirmação validado', 'Redirecionamento registration/basic-data observado', 'Campos masked preenchidos com nativeSetter'],
    confidence: 0.96,
    weight: 3
  },
  {
    sourceTitle: 'Cadastro Integrador Sol Agora - Etapas Endereço e Bank com upload S3 e token expiry',
    targetTitle: 'Cadastro Integrador Sol Agora - Fluxo MCP Pilot validado 2026-08-31 com nativeSetter',
    relationType: 'depends_on',
    explanation: 'As etapas de endereço e dados bancários somente são alcançadas depois da etapa cadastral e do redirecionamento documentados no fluxo com nativeSetter.',
    evidence: ['Etapas 2 e 3 sucedem registration/basic-data', 'Continuação usa o identificador criado pela etapa cadastral'],
    confidence: 0.95,
    weight: 3
  },
  {
    sourceTitle: 'Envio validado para veveje2197@mediseat.com',
    targetTitle: 'Fluxo envio email Outlook Web via MCP Pilot',
    relationType: 'validates',
    explanation: 'O recebimento confirmado no Temp Mail valida que o procedimento do Outlook Web consegue concluir um envio real.',
    evidence: ['Mensagem enviada pelo Outlook Web', 'Entrega confirmada no Temp Mail'],
    confidence: 0.95,
    weight: 2
  },
  {
    sourceTitle: 'Envio V2 validado para veveje2197@mediseat.com em 01/09/2026 00:13',
    targetTitle: 'Fluxo envio email Outlook Web via MCP Pilot',
    relationType: 'validates',
    explanation: 'O segundo envio reproduz o procedimento de cinco passos e confirma novamente a entrega, o fechamento da composição e a ausência de rascunho.',
    evidence: ['Pill de destinatário validada', 'Entrega V2 confirmada no Temp Mail', 'Composição fechada sem rascunho'],
    confidence: 0.97,
    weight: 3
  },
  {
    sourceTitle: 'Envio V2 validado para veveje2197@mediseat.com em 01/09/2026 00:13',
    targetTitle: 'Envio validado para veveje2197@mediseat.com',
    relationType: 'supports',
    explanation: 'O segundo envio bem-sucedido fornece uma repetição independente que reforça a evidência do primeiro envio.',
    evidence: ['Dois envios distintos recebidos pelo mesmo destino temporário', 'V2 observada junto às mensagens anteriores no inbox'],
    confidence: 0.94,
    weight: 2
  },
  {
    sourceTitle: 'Fluxo envio email Outlook Web via MCP Pilot',
    targetTitle: 'Procedimento automação Outlook Web - Truques React',
    relationType: 'validates',
    explanation: 'A execução observada valida as técnicas React descritas no procedimento, incluindo native setter, contenteditable e envio via fiber.',
    evidence: ['Contador de Itens Enviados aumentou de 458 para 459', 'ComposeSendButton.onSend foi usado via React fiber'],
    confidence: 0.95,
    weight: 3
  }
];

async function main() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inserted = [];
    for (const seed of seeds) {
      const memories = await client.query<{
        source_id: string; target_id: string; source_workspace_id: string;
        source_domain_id: string; target_domain_id: string;
      }>(
        `SELECT source.id AS source_id,target.id AS target_id,
                source.workspace_id AS source_workspace_id,
                source_workspace.domain_id AS source_domain_id,
                target_workspace.domain_id AS target_domain_id
           FROM memory.memory_nodes source
           JOIN memory.workspaces source_workspace ON source_workspace.id=source.workspace_id
           CROSS JOIN memory.memory_nodes target
           JOIN memory.workspaces target_workspace ON target_workspace.id=target.workspace_id
          WHERE source.title=$1 AND target.title=$2
            AND source.status='active' AND target.status='active'
            AND target_workspace.domain_id=source_workspace.domain_id`,
        [seed.sourceTitle, seed.targetTitle]
      );
      if (memories.rowCount !== 1) {
        throw new Error(`Expected one memory pair for ${seed.sourceTitle} -> ${seed.targetTitle}, found ${memories.rowCount}.`);
      }
      const pair = memories.rows[0];
      if (pair.source_domain_id !== pair.target_domain_id) {
        throw new Error(`Refusing cross-domain relation: ${seed.sourceTitle} -> ${seed.targetTitle}.`);
      }
      const relation = await client.query(
        `INSERT INTO memory.memory_relations
           (workspace_id,source_id,target_id,relation_type,weight,confidence,metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
         ON CONFLICT (workspace_id,source_id,target_id,relation_type) DO UPDATE SET
           weight=EXCLUDED.weight,confidence=EXCLUDED.confidence,
           metadata=memory.memory_relations.metadata || EXCLUDED.metadata
         RETURNING id,source_id,target_id,relation_type,confidence`,
        [pair.source_workspace_id, pair.source_id, pair.target_id, seed.relationType, seed.weight, seed.confidence,
         JSON.stringify({ explanation: seed.explanation, evidence: seed.evidence, provenance: 'reviewed-current-history-backfill-2026-09-01' })]
      );
      inserted.push(relation.rows[0]);
    }
    await client.query('COMMIT');
    console.log(JSON.stringify({ reviewedMemories: 10, relationsApplied: inserted.length, relations: inserted }, null, 2));
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

await main();
