/**
 * @OnlyCurrentDoc
 * 
 * AUTOMAÇÃO DE TRANSFERÊNCIA DE ANEXOS DO PIPEFY
 * 
 * Este script transfere automaticamente anexos de campos específicos quando
 * o campo "o_guincho_est_sendo_solicitado_por_motivo_de_abandono" é marcado como "Sim".
 * 
 * FUNCIONAMENTO:
 * 1. O Pipefy envia um webhook quando o campo é alterado
 * 2. O script verifica se o valor é "Sim"
 * 3. Busca todos os anexos dos campos de origem (fotos)
 * 4. Transfere os anexos para o campo de destino (evidências)
 * 
 * CONFIGURAÇÃO:
 * 1. Execute configurarPropriedades() com seu token e organization ID
 * 2. Implante como Web App
 * 3. Configure o webhook no Pipefy com a URL do Web App
 * 
 * CORREÇÕES APLICADAS:
 * - Melhorada validação de tipos de campos (attachment vs outros)
 * - Adicionado suporte para reutilizar IDs de upload existentes
 * - Corrigido formato de envio de anexos para API do Pipefy
 * - Adicionado melhor tratamento de erros e logging detalhado
 * - Implementado fallback para diferentes métodos de atualização
 * - Adicionadas funções de teste para facilitar depuração
 */

const PIPEFY_API_URL = 'https://api.pipefy.com/graphql';

// =================================================================
// PARTE 0: CONFIGURAÇÃO INICIAL (EXECUTAR UMA VEZ)
// =================================================================
/**
 * Execute esta função UMA VEZ pelo editor do Apps Script para configurar
 * as propriedades necessárias.
 * * **INSTRUÇÕES:**
 * 1. Preencha os valores de PIPEFY_API_TOKEN e PIPEFY_ORGANIZATION_ID abaixo.
 * 2. Salve o script (Ctrl+S).
 * 3. No menu "Selecionar função", escolha "configurarPropriedades".
 * 4. Clique em "Executar".
 * 5. Implante o script como um Web App.
 */
function configurarPropriedades() {
  const properties = PropertiesService.getScriptProperties();
  
  // ** PREENCHA OS VALORES ABAIXO **
  const PIPEFY_API_TOKEN = 'SEU_TOKEN_DA_API_AQUI';
  const PIPEFY_ORGANIZATION_ID = 'SEU_ID_DE_ORGANIZACAO_AQUI';
  // *******************************

  const WEB_APP_URL = ScriptApp.getService().getUrl();
  
  properties.setProperties({
    'PIPEFY_API_TOKEN': PIPEFY_API_TOKEN,
    'PIPEFY_ORGANIZATION_ID': PIPEFY_ORGANIZATION_ID,
    'WEB_APP_URL': WEB_APP_URL
  });
  
  Logger.log('✅ Propriedades do script configuradas com sucesso!');
  Logger.log('URL do Web App: ' + WEB_APP_URL);
  Logger.log('Certifique-se de que o Web App está implantado e que esta URL está configurada no Webhook do Pipefy.');
}


// =================================================================
// PARTE 1: FUNÇÃO PRINCIPAL DO WEBHOOK
// =================================================================
function doPost(e) {
  Logger.log('--- INÍCIO DA EXECUÇÃO doPost ---');
  try {
    const postContents = e.postData.contents;
    Logger.log('1. Payload recebido do Pipefy: ' + postContents);
    
    if (!postContents) {
      throw new Error('Payload (postContents) está vazio ou nulo.');
    }
    
    const postData = JSON.parse(postContents);
    const cardId = postData.data.card.id;
    const fieldId = postData.data.field.id;
    const changedFieldValue = postData.data.new_value;

    Logger.log(`2. Dados extraídos: Card ID=${cardId}, Field ID=${fieldId}, Novo Valor="${changedFieldValue}"`);

    const fieldMatches = fieldId === 'o_guincho_est_sendo_solicitado_por_motivo_de_abandono';
    const valueMatches = changedFieldValue !== null && 
                         changedFieldValue !== undefined && 
                         changedFieldValue.toString().trim() === 'Sim';

    if (fieldMatches && valueMatches) {
      Logger.log('3. ✅ CONDIÇÃO ATENDIDA! Iniciando processamento de anexos...');
      processarAnexos(cardId);
    } else {
      Logger.log(`3. ❌ Condição NÃO atendida.`);
    }
  } catch (error) {
    Logger.log('!!! ERRO FATAL em doPost: ' + error.toString());
    Logger.log('!!! Stack trace: ' + error.stack);
  }
  Logger.log('--- FIM DA EXECUÇÃO doPost ---');
  return ContentService.createTextOutput(JSON.stringify({ 'status': 'success' })).setMimeType(ContentService.MimeType.JSON);
}

// =================================================================
// PARTE 2: ORQUESTRADOR DO PROCESSO DE ANEXOS
// =================================================================
function processarAnexos(cardId) {
  Logger.log(`--- Iniciando processarAnexos para o Card ID: ${cardId} ---`);
  try {
    // Buscar informações completas do card incluindo a fase atual
    const cardInfo = buscarInformacoesCompletasCard(cardId);
    if (!cardInfo) {
      throw new Error('Não foi possível buscar informações completas do card.');
    }

    const dadosCard = cardInfo.fields;
    const phaseId = cardInfo.current_phase?.id;
    
    Logger.log(`Card está na fase: ${cardInfo.current_phase?.name || 'Desconhecida'} (ID: ${phaseId})`);

    const resultado = agruparUrlsOrigem(dadosCard);
    let todosIdsUpload = [];
    
    // Se já existem IDs de upload, adicionar à lista
    if (resultado.uploadIds && resultado.uploadIds.length > 0) {
      todosIdsUpload = todosIdsUpload.concat(resultado.uploadIds);
      Logger.log(`Reutilizando ${resultado.uploadIds.length} anexos já existentes.`);
    }
    
    // Se existem URLs para baixar, fazer o download e upload
    if (resultado.urls && resultado.urls.length > 0) {
      Logger.log(`Encontradas ${resultado.urls.length} URLs para transferir.`);
      const novosIdsUpload = transferirAnexos(resultado.urls);
      
      if (novosIdsUpload && novosIdsUpload.length > 0) {
        todosIdsUpload = todosIdsUpload.concat(novosIdsUpload);
        Logger.log(`Transferidos ${novosIdsUpload.length} novos anexos.`);
      }
    }
    
    // Atualizar o campo de destino com todos os IDs de upload
    if (todosIdsUpload.length > 0) {
      Logger.log(`Total de ${todosIdsUpload.length} anexos para atualizar no campo de destino.`);
      Logger.log(`IDs de upload: ${todosIdsUpload.join(', ')}`);
      atualizarCampoDestino(cardId, todosIdsUpload);
    } else {
      Logger.log('Nenhum anexo encontrado para processar.');
    }
  } catch (error) {
    Logger.log(`!!! ERRO em processarAnexos: ${error.toString()}`);
    Logger.log(`!!! Stack trace: ${error.stack}`);
  }
  Logger.log(`--- Finalizando processarAnexos para o Card ID: ${cardId} ---`);
}


// =================================================================
// PARTE 3: FUNÇÕES AUXILIARES - LÓGICA DE NEGÓCIO
// =================================================================

/**
 * Transfere os arquivos de uma URL de origem para uma nova URL de anexo do Pipefy.
 * @param {string[]} urlsOrigem - Array de URLs dos arquivos a serem transferidos.
 * @returns {string[]} Array com os IDs de upload (formato: uploads/UUID/nome_arquivo)
 */
function transferirAnexos(urlsOrigem) {
  const idsUpload = [];
  for (let i = 0; i < urlsOrigem.length; i++) {
    const url = urlsOrigem[i];
    try {
      Logger.log(`--- Processando anexo ${i + 1}/${urlsOrigem.length}: ${url}`);
      
      // 1. Baixar o conteúdo do arquivo
      const arquivoBlob = UrlFetchApp.fetch(url).getBlob();
      const nomeArquivo = `anexo_${Date.now()}_${i}.${arquivoBlob.getName().split('.').pop() || 'jpg'}`;
      const tipoConteudo = arquivoBlob.getContentType();
      
      // 2. Obter a URL de upload do Pipefy
      const presignedData = obterUrlPresignada(nomeArquivo, tipoConteudo);
      if (!presignedData || !presignedData.url || !presignedData.downloadUrl) {
        throw new Error('Falha ao obter URL presignada do Pipefy.');
      }
      
      // 3. Fazer o upload do arquivo para a URL temporária
      const sucessoUpload = fazerUploadArquivo(presignedData.url, arquivoBlob);
      if (!sucessoUpload) {
        throw new Error('Falha ao fazer upload do arquivo para a URL do Pipefy.');
      }
      
      // 4. Extrair o ID de upload da URL de download (formato: uploads/...)
      const uploadId = extrairIdUpload(presignedData.downloadUrl);
      if (uploadId) {
        Logger.log(`✅ Anexo transferido com sucesso. ID de upload: ${uploadId}`);
        idsUpload.push(uploadId);
      } else {
        Logger.log(`❌ Não foi possível extrair ID de upload da URL: ${presignedData.downloadUrl}`);
      }

    } catch (error) {
      Logger.log(`❌ ERRO ao transferir o anexo da URL: ${url}. Erro: ${error.toString()}`);
      // Continua para o próximo arquivo
    }
  }
  return idsUpload;
}

/**
 * Extrai o ID de upload de uma URL do Pipefy
 * @param {string} url - URL completa do Pipefy
 * @returns {string|null} ID de upload (formato: uploads/UUID/nome_arquivo) ou null se não encontrado
 */
function extrairIdUpload(url) {
  try {
    // Padrão: https://app.pipefy.com/storage/v1/signed/orgs/.../uploads/UUID/arquivo?signature=...
    const match = url.match(/\/uploads\/([^\/]+)\/([^\/\?]+)/);
    if (match && match[1] && match[2]) {
      // Retornar o ID do upload com nome do arquivo (formato: uploads/UUID/nome_arquivo)
      return `uploads/${match[1]}/${match[2]}`;
    }
    
    // Padrão alternativo: se já for apenas uploads/UUID/nome_arquivo
    if (url.startsWith('uploads/')) {
      return url;
    }
    
    Logger.log(`   Não foi possível extrair ID de upload da URL: ${url}`);
    return null;
  } catch (error) {
    Logger.log(`   Erro ao extrair ID de upload: ${error.toString()}`);
    return null;
  }
}


/**
 * Busca todos os campos de um card específico no Pipefy.
 */
function buscarDadosCard(cardId) {
  Logger.log(`4. BUSCANDO DADOS DO CARD: ${cardId}`);
  const PIPEFY_API_TOKEN = PropertiesService.getScriptProperties().getProperty('PIPEFY_API_TOKEN');
  if (!PIPEFY_API_TOKEN) throw new Error('PIPEFY_API_TOKEN não encontrado.');
  
  const query = `query { 
    card(id: ${cardId}) { 
      fields { 
        field { 
          id 
          label 
          type 
        } 
        value 
      } 
    } 
  }`;
  const response = fazerRequisicaoPipefy(query, PIPEFY_API_TOKEN);
  
  if (!response.data || !response.data.card || !response.data.card.fields) {
    throw new Error('Estrutura de resposta inválida da API do Pipefy ao buscar dados do card.');
  }
  Logger.log(`5. DADOS DO CARD RECEBIDOS.`);
  return response.data.card.fields;
}

/**
 * Busca informações completas do card incluindo fase atual
 */
function buscarInformacoesCompletasCard(cardId) {
  Logger.log(`BUSCANDO INFORMAÇÕES COMPLETAS DO CARD: ${cardId}`);
  const PIPEFY_API_TOKEN = PropertiesService.getScriptProperties().getProperty('PIPEFY_API_TOKEN');
  if (!PIPEFY_API_TOKEN) throw new Error('PIPEFY_API_TOKEN não encontrado.');
  
  const query = `query { 
    card(id: ${cardId}) { 
      id
      title
      current_phase {
        id
        name
      }
      fields { 
        field { 
          id 
          label 
          type 
        } 
        value 
      } 
    } 
  }`;
  const response = fazerRequisicaoPipefy(query, PIPEFY_API_TOKEN);
  
  if (!response.data || !response.data.card) {
    throw new Error('Estrutura de resposta inválida da API do Pipefy ao buscar informações completas do card.');
  }
  Logger.log(`INFORMAÇÕES COMPLETAS DO CARD RECEBIDAS.`);
  return response.data.card;
}

/**
 * Extrai as URLs dos campos de anexo de origem.
 */
function agruparUrlsOrigem(campos) {
  Logger.log('6. AGRUPANDO URLs DE ORIGEM...');
  const idsCamposOrigem = [
    'foto_do_ve_culo_e_ou_local_da_recolha_1', 'foto_do_ve_culo_e_ou_local_da_recolha_2',
    'foto_do_ve_culo_e_ou_local_da_recolha_3', 'foto_da_lateral_direita_passageiro',
    'foto_do_ve_culo_e_ou_local_da_recolha_1_1', 'foto_do_ve_culo_e_ou_local_da_recolha_2_1',
    'foto_do_ve_culo_e_ou_local_da_recolha_3_1', 'foto_da_lateral_direita_passageiro_1',
    'foto_do_ve_culo_e_ou_local_da_recolha_1_2', 'foto_do_ve_culo_e_ou_local_da_recolha_2_2',
    'foto_do_ve_culo_e_ou_local_da_recolha_3_2', 'foto_da_lateral_direita_passageiro_2',
    'foto_do_ve_culo_e_ou_local_da_recolha_1_3', 'foto_do_ve_culo_e_ou_local_da_recolha_2_3',
    'foto_do_ve_culo_e_ou_local_da_recolha_3_3', 'foto_da_lateral_direita_passageiro_3'
  ];
  let urlsAnexos = [];
  let idsUploadExistentes = [];
  
  Logger.log(`   Analisando ${campos.length} campos...`);
  
  for (const campo of campos) {
    // Verificar se o campo está na lista de origem e tem valor
    if (idsCamposOrigem.includes(campo.field.id) && campo.value) {
      try {
        const valores = JSON.parse(campo.value);
        if (Array.isArray(valores)) {
          Logger.log(`   Campo ${campo.field.id}: ${valores.length} valores encontrados`);
          
          // Separar URLs de download de IDs de upload
          valores.forEach(valor => {
            if (typeof valor === 'string') {
              if (valor.startsWith('http')) {
                urlsAnexos.push(valor);
              } else if (valor.startsWith('uploads/')) {
                idsUploadExistentes.push(valor);
              }
            }
          });
        }
      } catch (e) { 
        // Se não for JSON, pode ser uma string única
        if (campo.value && typeof campo.value === 'string') {
          if (campo.value.startsWith('http')) {
            Logger.log(`   Campo ${campo.field.id}: 1 anexo encontrado (URL)`);
            urlsAnexos.push(campo.value);
          } else if (campo.value.startsWith('uploads/')) {
            Logger.log(`   Campo ${campo.field.id}: 1 anexo encontrado (ID upload)`);
            idsUploadExistentes.push(campo.value);
          }
        }
      }
    }
  }
  
  Logger.log(`7. URLs DE ORIGEM AGRUPADAS:`);
  Logger.log(`   - URLs para download: ${urlsAnexos.length}`);
  Logger.log(`   - IDs de upload existentes: ${idsUploadExistentes.length}`);
  
  // Se já temos IDs de upload, não precisamos baixar e re-fazer upload
  if (idsUploadExistentes.length > 0 && urlsAnexos.length === 0) {
    Logger.log(`   Usando IDs de upload existentes diretamente.`);
    return { urls: [], uploadIds: idsUploadExistentes };
  }
  
  return { urls: urlsAnexos, uploadIds: idsUploadExistentes };
}


/**
 * Atualiza o campo de destino no Pipefy com as novas URLs.
 */
function atualizarCampoDestino(cardId, anexos) {
  Logger.log(`8. ATUALIZANDO CAMPO DE DESTINO para o Card ID: ${cardId}`);
  const PIPEFY_API_TOKEN = PropertiesService.getScriptProperties().getProperty('PIPEFY_API_TOKEN');
  if (!PIPEFY_API_TOKEN) throw new Error('PIPEFY_API_TOKEN não encontrado.');

  // Validar se anexos é um array válido
  if (!Array.isArray(anexos) || anexos.length === 0) {
    Logger.log(`❌ ERRO: anexos deve ser um array não vazio. Recebido: ${typeof anexos}`);
    return;
  }

  // PRIMEIRO: Verificar se o campo existe e listar todos os campos
  Logger.log(`9. VERIFICANDO CAMPOS DISPONÍVEIS NO CARD...`);
  const camposDisponiveis = listarCamposCard(cardId, PIPEFY_API_TOKEN);
  
  // Procurar campos que sejam especificamente de tipo attachment
  const camposAnexo = camposDisponiveis.filter(campo => {
    const fieldType = campo.field.type;
    const fieldId = campo.field.id.toLowerCase();
    // Filtrar apenas campos do tipo attachment
    return fieldType === 'attachment' && (
           fieldId.includes('anexo') || 
           fieldId.includes('evidencia') || 
           fieldId.includes('evidência') ||
           fieldId.includes('evid') ||
           fieldId.includes('banimento') ||
           fieldId.includes('imagem') ||
           fieldId.includes('arquivo') ||
           fieldId.includes('file') ||
           fieldId.includes('upload')
    );
  });
  
  // Se não encontrar campos de attachment, procurar por todos os campos de attachment
  if (camposAnexo.length === 0) {
    Logger.log(`   Nenhum campo de anexo encontrado com os filtros. Buscando todos os campos de attachment...`);
    const todosAttachments = camposDisponiveis.filter(campo => campo.field.type === 'attachment');
    Logger.log(`   Total de campos attachment no card: ${todosAttachments.length}`);
    todosAttachments.forEach((campo, index) => {
      Logger.log(`   Campo attachment ${index + 1}: ID="${campo.field.id}", Label="${campo.field.label}"`);
    });
    // Usar todos os campos de attachment se não houver filtros específicos
    camposAnexo.push(...todosAttachments);
  }
  
  Logger.log(`10. CAMPOS DE ANEXO ENCONTRADOS: ${camposAnexo.length}`);
  camposAnexo.forEach((campo, index) => {
    Logger.log(`   Campo ${index + 1}: ID="${campo.field.id}", Tipo="${campo.field.type}", Valor atual: ${JSON.stringify(campo.value)}`);
  });
  
  // Tentar atualizar o campo original primeiro
  const campoOriginal = 'evid_ncias_para_banimento';
  Logger.log(`11. TENTANDO CAMPO ORIGINAL: ${campoOriginal}`);
  let success = tentarAtualizarCampo(cardId, campoOriginal, anexos, PIPEFY_API_TOKEN);
  
  // Se não funcionou, tentar outros campos de anexo encontrados
  if (!success && camposAnexo.length > 0) {
    for (let i = 0; i < camposAnexo.length; i++) {
      const campo = camposAnexo[i];
      Logger.log(`12. TENTANDO CAMPO ALTERNATIVO ${i + 1}: ${campo.field.id}`);
      success = tentarAtualizarCampo(cardId, campo.field.id, anexos, PIPEFY_API_TOKEN);
      if (success) {
        Logger.log(`✅ SUCESSO com o campo: ${campo.field.id}`);
        break;
      }
    }
  }
  
  if (!success) {
    Logger.log(`❌ TODAS AS TENTATIVAS FALHARAM. Campos testados:`);
    Logger.log(`   - Campo original: ${campoOriginal}`);
    camposAnexo.forEach((campo, index) => {
      Logger.log(`   - Campo alternativo ${index + 1}: ${campo.field.id}`);
    });
  }
}

/**
 * Lista todos os campos disponíveis em um card
 */
function listarCamposCard(cardId, token) {
  try {
    Logger.log(`   Buscando todos os campos do card ${cardId}...`);
    const query = `query { 
      card(id: ${cardId}) { 
        fields { 
          field { 
            id 
            label 
            type 
          } 
          value 
        } 
      } 
    }`;
    
    const response = fazerRequisicaoPipefy(query, token);
    
    if (response.data && response.data.card && response.data.card.fields) {
      Logger.log(`   Encontrados ${response.data.card.fields.length} campos no card.`);
      return response.data.card.fields;
    } else {
      Logger.log(`   Erro ao buscar campos do card: ${JSON.stringify(response)}`);
      return [];
    }
  } catch (error) {
    Logger.log(`   Erro ao listar campos: ${error.toString()}`);
    return [];
  }
}

/**
 * Tenta atualizar um campo específico com diferentes métodos
 */
function tentarAtualizarCampo(cardId, fieldId, anexos, token) {
  Logger.log(`   Testando campo: ${fieldId}`);
  
  // Para campos de attachment, usar o método especial de anexar arquivos
  const campoInfo = obterInformacaoCampo(cardId, fieldId, token);
  if (campoInfo && campoInfo.type === 'attachment') {
    Logger.log(`   Campo ${fieldId} é do tipo attachment. Usando método de anexar arquivos.`);
    return anexarArquivosAoCampo(cardId, fieldId, anexos, token);
  }
  
  // MÉTODO 1: Usando variáveis GraphQL (mais seguro)
  let success = atualizarCampoDestinoComVariaveis(cardId, fieldId, anexos, token);
  if (success) return true;
  
  // MÉTODO 2: Array direto
  success = atualizarCampoComArray(cardId, fieldId, anexos, token);
  if (success) return true;
  
  // MÉTODO 3: String JSON (caso o campo espere uma string)
  success = atualizarCampoEspecifico(cardId, fieldId, JSON.stringify(anexos), token, 'STRING_JSON');
  if (success) return true;
  
  // MÉTODO 4: Anexo único (caso o campo aceite apenas um anexo)
  if (anexos.length > 0) {
    success = atualizarCampoEspecifico(cardId, fieldId, anexos[0], token, 'ANEXO_UNICO');
    if (success) return true;
  }
  
  return false;
}

/**
 * Atualiza um campo específico com um valor específico
 */
function atualizarCampoEspecifico(cardId, fieldId, valor, token, metodo) {
  try {
    let mutation;
    let valorFormatado;
    
    if (metodo === 'STRING_JSON') {
      // Para string JSON, precisamos escapar corretamente
      valorFormatado = JSON.stringify(valor);
      mutation = `mutation { 
        updateCardField(input: { 
          card_id: ${cardId}, 
          field_id: "${fieldId}", 
          new_value: ${valorFormatado}
        }) { 
          card { id } 
        } 
      }`;
    } else if (metodo === 'ANEXO_UNICO') {
      // Para anexo único, enviar apenas a string sem array
      valorFormatado = `"${valor.replace(/"/g, '\\"')}"`;
      mutation = `mutation { 
        updateCardField(input: { 
          card_id: ${cardId}, 
          field_id: "${fieldId}", 
          new_value: ${valorFormatado}
        }) { 
          card { id } 
        } 
      }`;
    }
    
    Logger.log(`     Método ${metodo}: Tentando atualizar campo ${fieldId}`);
    Logger.log(`     Mutation: ${mutation}`);
    
    const response = fazerRequisicaoPipefy(mutation, token);
    
    if (response.data && response.data.updateCardField && response.data.updateCardField.card) {
      Logger.log(`     ✅ SUCESSO com método ${metodo} no campo ${fieldId}`);
      return true;
    } else {
      const errorMsg = response.errors?.[0]?.message || 'Erro desconhecido';
      Logger.log(`     ❌ Falha método ${metodo}: ${errorMsg}`);
      if (response.errors) {
        response.errors.forEach((error, idx) => {
          Logger.log(`        Erro ${idx + 1}: ${error.message}`);
          if (error.extensions?.code) {
            Logger.log(`        Código: ${error.extensions.code}`);
          }
        });
      }
      return false;
    }
  } catch (error) {
    Logger.log(`     ❌ Erro método ${metodo}: ${error.toString()}`);
    return false;
  }
}

/**
 * Atualiza campo com array direto
 */
function atualizarCampoComArray(cardId, fieldId, anexos, token) {
  try {
    // Para campos de anexo, enviar array de strings
    const anexosEscapados = anexos.map(url => `"${url.replace(/"/g, '\\"')}"`).join(', ');
    const mutation = `mutation { 
      updateCardField(input: { 
        card_id: ${cardId}, 
        field_id: "${fieldId}", 
        new_value: [${anexosEscapados}]
      }) { 
        card { id } 
      } 
    }`;
    
    Logger.log(`     Método ARRAY: Tentando atualizar campo ${fieldId} com ${anexos.length} anexos`);
    Logger.log(`     Mutation: ${mutation}`);
    
    const response = fazerRequisicaoPipefy(mutation, token);
    
    if (response.data && response.data.updateCardField && response.data.updateCardField.card) {
      Logger.log(`     ✅ SUCESSO com método ARRAY no campo ${fieldId}`);
      return true;
    } else {
      const errorMsg = response.errors?.[0]?.message || 'Erro desconhecido';
      Logger.log(`     ❌ Falha método ARRAY: ${errorMsg}`);
      if (response.errors) {
        response.errors.forEach((error, idx) => {
          Logger.log(`        Erro ${idx + 1}: ${error.message}`);
          if (error.extensions?.code) {
            Logger.log(`        Código: ${error.extensions.code}`);
          }
        });
      }
      return false;
    }
  } catch (error) {
    Logger.log(`     ❌ Erro método ARRAY: ${error.toString()}`);
    return false;
  }
}

/**
 * Tenta atualizar usando variáveis GraphQL (método preferido)
 */
function atualizarCampoDestinoComVariaveis(cardId, fieldId, anexos, token) {
  try {
    const mutation = `mutation($cardId: ID!, $fieldId: ID!, $newValue: [String!]!) { 
      updateCardField(input: { 
        card_id: $cardId, 
        field_id: $fieldId, 
        new_value: $newValue
      }) { 
        card { id } 
      } 
    }`;
    
    const variables = {
      cardId: cardId.toString(),
      fieldId: fieldId,
      newValue: anexos
    };
    
    Logger.log(`   Mutation com variáveis para campo ${fieldId}`);
    Logger.log(`   Variáveis: ${JSON.stringify(variables)}`);
    
    const response = fazerRequisicaoPipefy(mutation, token, variables);

    if (response.data && response.data.updateCardField && response.data.updateCardField.card) {
      Logger.log(`✅ CAMPO ${fieldId} ATUALIZADO COM SUCESSO (método com variáveis).`);
      return true;
    } else {
      const errorMsg = response.errors?.[0]?.message || 'Erro desconhecido';
      Logger.log(`❌ Falha no método com variáveis para campo ${fieldId}: ${errorMsg}`);
      return false;
    }
  } catch (error) {
    Logger.log(`❌ Erro no método com variáveis: ${error.toString()}`);
    return false;
  }
}

/**
 * TENTATIVA 1: Envia anexos como string JSON (método original)
 */
function atualizarCampoComoStringJson(cardId, anexos, token) {
  try {
    const anexosJsonString = JSON.stringify(JSON.stringify(anexos));
    
    const mutation = `mutation { 
      updateCardField(input: { 
        card_id: ${cardId}, 
        field_id: "evid_ncias_para_banimento", 
        new_value: ${anexosJsonString}
      }) { 
        card { id } 
      } 
    }`;
    
    Logger.log(`   Mutation como string JSON: ${mutation}`);
    
    const response = fazerRequisicaoPipefy(mutation, token);

    if (response.data && response.data.updateCardField && response.data.updateCardField.card) {
      Logger.log(`✅ SUCESSO: Campo atualizado como string JSON.`);
      return true;
    } else {
      Logger.log(`❌ Falha no método string JSON. Resposta: ${JSON.stringify(response)}`);
      return false;
    }
  } catch (error) {
    Logger.log(`❌ Erro no método string JSON: ${error.toString()}`);
    return false;
  }
}

/**
 * TENTATIVA 2: Método alternativo sem variáveis GraphQL (array direto)
 */
function atualizarCampoDestinoSemVariaveis(cardId, anexos, token) {
  try {
    // Construir array de strings escapadas para GraphQL
    const anexosEscapados = anexos.map(url => `"${url.replace(/"/g, '\\"')}"`).join(', ');
    
    const mutation = `mutation { 
      updateCardField(input: { 
        card_id: ${cardId}, 
        field_id: "evid_ncias_para_banimento", 
        new_value: [${anexosEscapados}]
      }) { 
        card { id } 
      } 
    }`;
    
    Logger.log(`   Mutation como array direto: ${mutation}`);
    
    const response = fazerRequisicaoPipefy(mutation, token);

    if (response.data && response.data.updateCardField && response.data.updateCardField.card) {
      Logger.log(`✅ SUCESSO: Campo atualizado como array direto.`);
      return true;
    } else {
      Logger.log(`❌ Falha no método array direto. Resposta: ${JSON.stringify(response)}`);
      return false;
    }
  } catch (error) {
    Logger.log(`❌ Erro no método array direto: ${error.toString()}`);
    return false;
  }
}

/**
 * TENTATIVA 3: Envia apenas um anexo (para testar se o campo aceita múltiplos)
 */
function atualizarCampoAnexoUnico(cardId, anexoUrl, token) {
  try {
    const anexoEscapado = anexoUrl.replace(/"/g, '\\"');
    
    const mutation = `mutation { 
      updateCardField(input: { 
        card_id: ${cardId}, 
        field_id: "evid_ncias_para_banimento", 
        new_value: "${anexoEscapado}"
      }) { 
        card { id } 
      } 
    }`;
    
    Logger.log(`   Mutation anexo único: ${mutation}`);
    
    const response = fazerRequisicaoPipefy(mutation, token);

    if (response.data && response.data.updateCardField && response.data.updateCardField.card) {
      Logger.log(`✅ SUCESSO: Campo atualizado com anexo único.`);
      return true;
    } else {
      Logger.log(`❌ Falha no método anexo único. Resposta: ${JSON.stringify(response)}`);
      if (response.errors && response.errors.length > 0) {
        Logger.log(`❌ DETALHES DOS ERROS (anexo único):`);
        response.errors.forEach((error, index) => {
          Logger.log(`   Erro ${index + 1}: ${error.message}`);
          if (error.locations) {
            Logger.log(`   Localização: ${JSON.stringify(error.locations)}`);
          }
          if (error.path) {
            Logger.log(`   Caminho: ${JSON.stringify(error.path)}`);
          }
          if (error.extensions) {
            Logger.log(`   Extensões: ${JSON.stringify(error.extensions)}`);
          }
        });
      }
      return false;
    }
  } catch (error) {
    Logger.log(`❌ Erro no método anexo único: ${error.toString()}`);
    return false;
  }
}

/**
 * Obtém informações sobre um campo específico
 */
function obterInformacaoCampo(cardId, fieldId, token) {
  try {
    const campos = listarCamposCard(cardId, token);
    const campo = campos.find(c => c.field.id === fieldId);
    return campo ? campo.field : null;
  } catch (error) {
    Logger.log(`   Erro ao obter informações do campo: ${error.toString()}`);
    return null;
  }
}

/**
 * Anexa arquivos a um campo do tipo attachment
 */
function anexarArquivosAoCampo(cardId, fieldId, anexos, token) {
  try {
    // Para campos de attachment, o Pipefy espera apenas as strings de upload
    // sem array, uma por vez
    if (anexos.length === 1) {
      // Se houver apenas um anexo, enviar diretamente
      return atualizarCampoEspecifico(cardId, fieldId, anexos[0], token, 'ANEXO_UNICO');
    } else {
      // Se houver múltiplos anexos, tentar enviar como array
      // Mas primeiro verificar se o campo aceita múltiplos valores
      Logger.log(`   Tentando anexar ${anexos.length} arquivos ao campo ${fieldId}`);
      
      // Tentar primeiro como array
      let success = atualizarCampoComArray(cardId, fieldId, anexos, token);
      if (success) return true;
      
      // Se falhar, tentar enviar apenas o primeiro
      Logger.log(`   Array falhou. Tentando enviar apenas o primeiro anexo.`);
      return atualizarCampoEspecifico(cardId, fieldId, anexos[0], token, 'ANEXO_UNICO');
    }
  } catch (error) {
    Logger.log(`   Erro ao anexar arquivos: ${error.toString()}`);
    return false;
  }
}


// =================================================================
// FUNÇÕES DE TESTE E DEBUG
// =================================================================

/**
 * Função de teste para simular o recebimento de um webhook
 * Útil para testar o processamento sem depender do Pipefy
 */
function testarProcessamento() {
  // ID de um card para teste - substitua pelo ID real
  const cardIdTeste = '1200959896'; // Substitua pelo ID do seu card
  
  Logger.log('=== INICIANDO TESTE DE PROCESSAMENTO ===');
  
  try {
    // Simular o processamento de anexos
    processarAnexos(cardIdTeste);
    Logger.log('=== TESTE CONCLUÍDO COM SUCESSO ===');
  } catch (error) {
    Logger.log(`=== ERRO NO TESTE: ${error.toString()} ===`);
    Logger.log(`Stack: ${error.stack}`);
  }
}

/**
 * Função para verificar a configuração
 */
function verificarConfiguracao() {
  const properties = PropertiesService.getScriptProperties();
  const token = properties.getProperty('PIPEFY_API_TOKEN');
  const orgId = properties.getProperty('PIPEFY_ORGANIZATION_ID');
  const webAppUrl = properties.getProperty('WEB_APP_URL');
  
  Logger.log('=== VERIFICAÇÃO DE CONFIGURAÇÃO ===');
  Logger.log(`API Token configurado: ${token ? 'SIM' : 'NÃO'}`);
  Logger.log(`Organization ID configurado: ${orgId ? 'SIM' : 'NÃO'}`);
  Logger.log(`Web App URL: ${webAppUrl || 'NÃO CONFIGURADO'}`);
  
  if (!token || !orgId) {
    Logger.log('❌ ERRO: Execute a função configurarPropriedades() primeiro!');
    return false;
  }
  
  Logger.log('✅ Configuração OK');
  return true;
}

// =================================================================
// PARTE 4: FUNÇÕES DE BAIXO NÍVEL - INTERAÇÃO COM API
// =================================================================

/**
 * Solicita ao Pipefy uma URL para upload de um novo arquivo.
 */
function obterUrlPresignada(nomeArquivo, tipoConteudo) {
  Logger.log(`   - Solicitando URL presignada para: ${nomeArquivo} (Tipo: ${tipoConteudo})`);
  const PIPEFY_API_TOKEN = PropertiesService.getScriptProperties().getProperty('PIPEFY_API_TOKEN');
  const ORGANIZATION_ID = PropertiesService.getScriptProperties().getProperty('PIPEFY_ORGANIZATION_ID');
  if (!PIPEFY_API_TOKEN || !ORGANIZATION_ID) throw new Error('PIPEFY_API_TOKEN ou PIPEFY_ORGANIZATION_ID não encontrados.');

  const mutation = `mutation($organizationId: ID!, $fileName: String!, $contentType: String!) {
    createPresignedUrl(input: {
      organizationId: $organizationId,
      fileName: $fileName,
      contentType: $contentType
    }) {
      url
      downloadUrl
    }
  }`;
  
  const variables = {
    organizationId: ORGANIZATION_ID,
    fileName: nomeArquivo,
    contentType: tipoConteudo
  };

  const response = fazerRequisicaoPipefy(mutation, PIPEFY_API_TOKEN, variables);
  
  if (!response) {
      Logger.log('   - Resposta da API do Pipefy foi nula ou vazia.');
      return null;
  }
  
  if (response.errors) {
      Logger.log(`   - ERRO na API do Pipefy ao criar URL: ${JSON.stringify(response.errors)}`);
      return null;
  }

  if (response.data && response.data.createPresignedUrl) {
    Logger.log('   - URL presignada recebida com sucesso.');
    return response.data.createPresignedUrl;
  }

  Logger.log(`   - Resposta inesperada da API do Pipefy: ${JSON.stringify(response)}`);
  return null;
}

/**
 * Envia o conteúdo de um arquivo para a URL de upload do Pipefy.
 */
function fazerUploadArquivo(uploadUrl, arquivoBlob) {
  Logger.log(`   - Fazendo upload para: ${uploadUrl.substring(0, 60)}...`);
  const options = {
    'method': 'put',
    'contentType': arquivoBlob.getContentType(),
    'payload': arquivoBlob.getBytes(),
    'muteHttpExceptions': true
  };
  const response = UrlFetchApp.fetch(uploadUrl, options);
  return response.getResponseCode() === 200;
}

/**
 * Função genérica para fazer requisições à API GraphQL do Pipefy.
 */
function fazerRequisicaoPipefy(query, token, variables) {
  const payload = {
    query: query
  };
  
  // Adicionar variáveis apenas se foram fornecidas
  if (variables && Object.keys(variables).length > 0) {
    payload.variables = variables;
  }
  
  const options = {
    'method': 'post',
    'contentType': 'application/json',
    'headers': { 'Authorization': 'Bearer ' + token },
    'payload': JSON.stringify(payload),
    'muteHttpExceptions': true
  };
  
  Logger.log(`Enviando requisição para: ${PIPEFY_API_URL}`);
  Logger.log(`Payload: ${JSON.stringify(payload)}`);
  
  const response = UrlFetchApp.fetch(PIPEFY_API_URL, options);
  const responseCode = response.getResponseCode();
  const responseText = response.getContentText();

  Logger.log(`Código de resposta: ${responseCode}`);
  Logger.log(`Resposta da API: ${responseText}`);

  if (responseCode !== 200) {
    throw new Error(`Erro HTTP ${responseCode} na API do Pipefy: ${responseText}`);
  }
  
  try {
    return JSON.parse(responseText);
  } catch (parseError) {
    throw new Error(`Erro ao fazer parse da resposta JSON: ${parseError.toString()}. Resposta: ${responseText}`);
  }
}
