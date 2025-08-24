/**
 * @OnlyCurrentDoc
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
    const dadosCard = buscarDadosCard(cardId);
    if (!dadosCard) {
      throw new Error('buscarDadosCard retornou nulo ou vazio.');
    }

    const urlsOrigem = agruparUrlsOrigem(dadosCard);
    if (urlsOrigem && urlsOrigem.length > 0) {
      Logger.log(`Encontradas ${urlsOrigem.length} URLs de origem. Iniciando transferência.`);
      const idsUpload = transferirAnexos(urlsOrigem);
      
      if (idsUpload && idsUpload.length > 0) {
        Logger.log(`Transferidos ${idsUpload.length} anexos com sucesso. IDs de upload: ${idsUpload.join(', ')}`);
        Logger.log(`Atualizando card com IDs de upload (formato: uploads/UUID/nome_arquivo)...`);
        atualizarCampoDestino(cardId, idsUpload);
      } else {
        Logger.log('Nenhum anexo foi transferido com sucesso. Nenhuma atualização será feita.');
      }
    } else {
      Logger.log('Nenhum anexo encontrado nos campos de origem.');
    }
  } catch (error) {
    Logger.log(`!!! ERRO em processarAnexos: ${error.toString()}`);
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
  
  const query = `query { card(id: ${cardId}) { fields { field { id } value } } }`;
  const response = fazerRequisicaoPipefy(query, PIPEFY_API_TOKEN);
  
  if (!response.data || !response.data.card || !response.data.card.fields) {
    throw new Error('Estrutura de resposta inválida da API do Pipefy ao buscar dados do card.');
  }
  Logger.log(`5. DADOS DO CARD RECEBIDOS.`);
  return response.data.card.fields;
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
  
  for (const campo of campos) {
    if (idsCamposOrigem.includes(campo.field.id) && campo.value) {
      try {
        const urls = JSON.parse(campo.value);
        if (Array.isArray(urls)) {
          urlsAnexos = urlsAnexos.concat(urls);
        }
      } catch (e) { /* Ignora valores que não são JSON array */ }
    }
  }
  Logger.log(`7. URLs DE ORIGEM AGRUPADAS (${urlsAnexos.length} anexos).`);
  return urlsAnexos;
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
  
  // Procurar campos que possam ser de anexo
  const camposAnexo = camposDisponiveis.filter(campo => {
    const fieldId = campo.field.id.toLowerCase();
    return fieldId.includes('anexo') || 
           fieldId.includes('evidencia') || 
           fieldId.includes('evidência') ||
           fieldId.includes('evid') ||
           fieldId.includes('banimento') ||
           fieldId.includes('foto') ||
           fieldId.includes('imagem');
  });
  
  Logger.log(`10. CAMPOS DE ANEXO ENCONTRADOS: ${camposAnexo.length}`);
  camposAnexo.forEach((campo, index) => {
    Logger.log(`   Campo ${index + 1}: ID="${campo.field.id}", Valor atual: ${JSON.stringify(campo.value)}`);
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
  
  // MÉTODO 1: String JSON
  let success = atualizarCampoEspecifico(cardId, fieldId, JSON.stringify(anexos), token, 'STRING_JSON');
  if (success) return true;
  
  // MÉTODO 2: Array direto
  success = atualizarCampoComArray(cardId, fieldId, anexos, token);
  if (success) return true;
  
  // MÉTODO 3: Anexo único
  success = atualizarCampoEspecifico(cardId, fieldId, anexos[0], token, 'ANEXO_UNICO');
  if (success) return true;
  
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
    
    Logger.log(`     Método ${metodo}: ${mutation.substring(0, 200)}...`);
    
    const response = fazerRequisicaoPipefy(mutation, token);
    
    if (response.data && response.data.updateCardField && response.data.updateCardField.card) {
      Logger.log(`     ✅ SUCESSO com método ${metodo} no campo ${fieldId}`);
      return true;
    } else {
      Logger.log(`     ❌ Falha método ${metodo}: ${JSON.stringify(response.errors?.[0]?.message || 'Erro desconhecido')}`);
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
    
    Logger.log(`     Método ARRAY: ${mutation.substring(0, 200)}...`);
    
    const response = fazerRequisicaoPipefy(mutation, token);
    
    if (response.data && response.data.updateCardField && response.data.updateCardField.card) {
      Logger.log(`     ✅ SUCESSO com método ARRAY no campo ${fieldId}`);
      return true;
    } else {
      Logger.log(`     ❌ Falha método ARRAY: ${JSON.stringify(response.errors?.[0]?.message || 'Erro desconhecido')}`);
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
function atualizarCampoDestinoComVariaveis(cardId, anexos, token) {
  try {
    const mutation = `mutation($cardId: ID!, $newValue: [String!]!) { 
      updateCardField(input: { 
        card_id: $cardId, 
        field_id: "evid_ncias_para_banimento", 
        new_value: $newValue
      }) { 
        card { id } 
      } 
    }`;
    
    const variables = {
      cardId: cardId.toString(),
      newValue: anexos
    };
    
    Logger.log(`   Mutation com variáveis: ${mutation}`);
    Logger.log(`   Variáveis: ${JSON.stringify(variables)}`);
    
    const response = fazerRequisicaoPipefy(mutation, token, variables);

    if (response.data && response.data.updateCardField && response.data.updateCardField.card) {
      Logger.log(`11. ✅ CAMPO ATUALIZADO COM SUCESSO (método com variáveis).`);
      return true;
    } else {
      Logger.log(`❌ Falha no método com variáveis. Resposta: ${JSON.stringify(response)}`);
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
