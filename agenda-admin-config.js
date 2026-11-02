/* =========================================================
   PAINEL: FECHAR AGENDA EM DATAS ESPECIFICAS - Larissa Barbosa
   ---------------------------------------------------------
   Controla a secao "Fechar agenda em datas especificas" do
   controle-agenda.html. Grava em config/diasFechados via
   AgendaDB (Firebase) ou localStorage como fallback.

   Nao toca no no "agendamentos".

   Feedbacks distinguem claramente:
   - online   : gravado no Firebase (vale para todos os aparelhos)
   - pendente : enviado, aguardando confirmacao / sem conexao
   - erro     : falhou no banco (ex.: permissao) — so vale localmente
   ========================================================= */
(function () {
    'use strict';

    var DIAS = ['Domingo', 'Segunda-feira', 'Terça-feira', 'Quarta-feira', 'Quinta-feira', 'Sexta-feira', 'Sábado'];
    var DIAS_CURTOS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
    var MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho',
        'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

    var ROTULO_FECHAR = '<i class="fas fa-lock"></i> Fechar este dia';
    var ROTULO_PERIODO = '<i class="fas fa-calendar-xmark"></i> Fechar período';
    var ROTULO_SYNC = '<i class="fas fa-cloud-arrow-up"></i> Enviar ao banco as datas salvas só neste aparelho';

    var iniciado = false;
    var cancelarObservacao = null;
    var cancelarConexao = null;
    var conectado = null; // null = desconhecido ainda

    function $(id) { return document.getElementById(id); }

    function escapar(valor) {
        return String(valor == null ? '' : valor)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function isoHoje() {
        var d = new Date();
        return d.getFullYear() + '-' +
            String(d.getMonth() + 1).padStart(2, '0') + '-' +
            String(d.getDate()).padStart(2, '0');
    }

    function isoValido(iso) {
        if (typeof iso !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
        var p = iso.split('-');
        var d = new Date(parseInt(p[0], 10), parseInt(p[1], 10) - 1, parseInt(p[2], 10));
        return d.getFullYear() === parseInt(p[0], 10) &&
            d.getMonth() === parseInt(p[1], 10) - 1 &&
            d.getDate() === parseInt(p[2], 10);
    }

    function partes(iso) {
        var p = iso.split('-');
        return { ano: parseInt(p[0], 10), mes: parseInt(p[1], 10) - 1, dia: parseInt(p[2], 10) };
    }

    function dataCurta(iso) {
        var p = partes(iso);
        return String(p.dia).padStart(2, '0') + '/' + String(p.mes + 1).padStart(2, '0');
    }

    function dataLonga(iso) {
        var p = partes(iso);
        var d = new Date(p.ano, p.mes, p.dia);
        return String(p.dia).padStart(2, '0') + '/' + String(p.mes + 1).padStart(2, '0') +
            '/' + p.ano + ' — ' + DIAS[d.getDay()];
    }

    function feedback(mensagem, tipo) {
        var el = $('df-feedback');
        if (!el) return;
        el.textContent = mensagem || '';
        el.className = 'ctrl-feedback' + (tipo === 'erro' ? ' df-erro' : (tipo === 'ok' ? ' df-ok' : ''));
    }

    function pintarConexao(ok) {
        conectado = ok;
        var el = $('df-conexao');
        if (!el) return;
        if (ok === true) {
            el.className = 'df-conexao df-conexao-ok';
            el.innerHTML = '<i class="fas fa-cloud-arrow-up"></i> Sincronizado com o banco — vale para todas as clientes.';
        } else {
            el.className = 'df-conexao df-conexao-off';
            el.innerHTML = '<i class="fas fa-wifi"></i> Sem acesso ao banco (sem conexão ou regras bloqueando) — alterações valem apenas neste aparelho até sincronizar.';
        }
    }

    function observarConexao() {
        if (!window.AgendaDB || typeof window.AgendaDB.observarConexao !== 'function') return;
        cancelarConexao = window.AgendaDB.observarConexao(pintarConexao);
    }

    // Mostra o botao de sincronizacao apenas quando existem datas salvas
    // neste aparelho que o banco ainda nao confirmou.
    function atualizarBotaoSync() {
        var botao = $('df-btn-sinc-local');
        if (!botao) return;
        if (!window.AgendaDB || typeof window.AgendaDB.listarDiasPendentes !== 'function') {
            botao.hidden = true;
            return;
        }
        var pendentes;
        try {
            pendentes = window.AgendaDB.listarDiasPendentes() || [];
        } catch (e) {
            pendentes = [];
        }
        if (!pendentes.length) {
            botao.hidden = true;
            return;
        }
        botao.hidden = false;
        botao.innerHTML = ROTULO_SYNC + ' (' + pendentes.length + ')';
    }

    function ocupado(botao, sim, rotuloOriginal) {
        if (!botao) return;
        botao.disabled = !!sim;
        if (sim) {
            botao.dataset.rotulo = rotuloOriginal || botao.textContent;
            botao.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Salvando...';
        } else {
            botao.innerHTML = rotuloOriginal || botao.dataset.rotulo || 'Salvar';
        }
    }

    function renderizarLista(lista) {
        var alvo = $('df-lista');
        if (!alvo) return;

        atualizarBotaoSync();

        var datas = (lista || []).filter(isoValido).sort();

        if (!datas.length) {
            alvo.innerHTML = '<p class="df-vazio"><i class="fas fa-calendar-check"></i> ' +
                'Nenhuma data fechada. A agenda está aberta em todos os dias permitidos.</p>';
            return;
        }

        var grupos = {};
        datas.forEach(function (iso) {
            var chave = iso.slice(0, 7);
            if (!grupos[chave]) grupos[chave] = [];
            grupos[chave].push(iso);
        });

        var html = '';
        Object.keys(grupos).sort().forEach(function (chave) {
            var p = partes(chave + '-01');
            html += '<div class="df-grupo">' +
                '<div class="df-grupo-titulo">' + MESES[p.mes] + ' de ' + p.ano + '</div>' +
                '<div class="df-badges">';

            grupos[chave].forEach(function (iso) {
                var d = partes(iso);
                var diaSemana = DIAS_CURTOS[new Date(d.ano, d.mes, d.dia).getDay()];
                html += '<span class="df-badge" title="' + escapar(dataLonga(iso)) + '">' +
                    '<span class="df-badge-data">' + dataCurta(iso) + ' · ' + diaSemana + '</span>' +
                    '<button type="button" class="df-reabrir" data-iso="' + escapar(iso) + '" ' +
                    'aria-label="Reabrir ' + escapar(dataCurta(iso)) + '" title="Reabrir este dia">' +
                    '<i class="fas fa-xmark"></i></button>' +
                    '</span>';
            });

            html += '</div></div>';
        });

        html += '<p class="df-total"><i class="fas fa-circle-info"></i> ' +
            datas.length + (datas.length === 1 ? ' dia fechado' : ' dias fechados') + '.</p>';

        alvo.innerHTML = html;

        alvo.querySelectorAll('.df-reabrir').forEach(function (btn) {
            btn.addEventListener('click', function () { reabrir(btn.dataset.iso, btn); });
        });
    }

    function recarregar() {
        if (!window.AgendaDB || typeof window.AgendaDB.listarDiasFechados !== 'function') {
            renderizarLista([]);
            return;
        }
        window.AgendaDB.listarDiasFechados().then(renderizarLista).catch(function (err) {
            console.warn('[AgendaConfig] Falha ao listar dias fechados.', err);
            feedback('Não foi possível carregar as datas fechadas.', 'erro');
        });
    }

    function observar() {
        if (!window.AgendaDB || typeof window.AgendaDB.observarDiasFechados !== 'function') return;
        cancelarObservacao = window.AgendaDB.observarDiasFechados(renderizarLista);
    }

    function exigirSelecao(iso, campo) {
        if (!iso || !isoValido(iso)) {
            feedback('Escolha uma data válida.', 'erro');
            if (campo) campo.focus();
            return false;
        }
        if (iso < isoHoje()) {
            feedback('Só é possível fechar hoje ou datas futuras.', 'erro');
            if (campo) campo.focus();
            return false;
        }
        return true;
    }

    /* ---------- Mensagens de resultado ---------- */

    function msgSucessoDia(iso, r) {
        if (r && r.pendente) {
            return 'Dia ' + dataCurta(iso) + ' fechado. Sem confirmação do banco por enquanto ' +
                '(sem conexão?) — a gravação segue tentando e o dia já vale neste aparelho.';
        }
        if (r && r.erro) {
            return 'O banco recusou: ' + r.erro + ' O dia consta fechado apenas neste aparelho.';
        }
        if (r && r.online) {
            return 'Dia ' + dataCurta(iso) + ' fechado e sincronizado para todos os aparelhos.';
        }
        return 'Dia ' + dataCurta(iso) + ' fechado (somente neste aparelho — sem conexão).';
    }

    function msgSucessoPeriodo(r) {
        var total = r && r.total ? r.total : '';
        if (r && r.pendente) {
            return 'Período fechado (' + total + ' dia(s)) — aguardando confirmação do banco. ' +
                'Já vale neste aparelho e continua tentando sincronizar.';
        }
        if (r && r.erro) {
            var parcial = (typeof r.gravados === 'number' && r.gravados > 0 && r.gravados < r.total)
                ? ' (' + r.gravados + ' de ' + r.total + ' dias gravados — tente fechar o período de novo para concluir o resto.)'
                : '';
            return 'Falha ao gravar o período: ' + r.erro + parcial;
        }
        if (r && r.online) {
            return 'Período fechado: ' + total + ' dia(s), sincronizado para todos os aparelhos.';
        }
        return 'Período fechado: ' + total + ' dia(s) (somente neste aparelho — sem conexão).';
    }

    function msgSucessoReabrir(iso, r) {
        if (r && r.pendente) {
            return 'Dia ' + dataCurta(iso) + ' reaberto. Sem confirmação do banco por enquanto ' +
                '(sem conexão?) — a remoção segue tentando.';
        }
        if (r && r.erro) {
            return 'O banco recusou: ' + r.erro + ' A reabertura vale apenas neste aparelho.';
        }
        if (r && r.online) {
            return 'Dia ' + dataCurta(iso) + ' reaberto para todos os aparelhos.';
        }
        return 'Dia ' + dataCurta(iso) + ' reaberto (somente neste aparelho — sem conexão com o banco).';
    }

    /* ---------- Ações ---------- */

    function fecharUmDia() {
        var campo = $('df-data');
        var motivoCampo = $('df-motivo');
        var botao = $('df-btn-fechar');
        var iso = campo ? campo.value : '';

        if (!exigirSelecao(iso, campo)) return;

        if (!window.AgendaDB || typeof window.AgendaDB.fecharDia !== 'function') {
            feedback('Camada de dados indisponível. Recarregue a página.', 'erro');
            return;
        }

        feedback('Fechando ' + dataCurta(iso) + '...');
        ocupado(botao, true);

        window.AgendaDB.fecharDia(iso, motivoCampo ? motivoCampo.value.trim() : '').then(function (r) {
            ocupado(botao, false, ROTULO_FECHAR);
            // Timeout vem com erro+pendente: estiliza como pendente (nao erro).
            var tipoVisual = (r && r.erro && !r.pendente) ? 'erro' : 'ok';
            feedback(msgSucessoDia(iso, r), tipoVisual);
            if (campo) campo.value = '';
            if (motivoCampo) motivoCampo.value = '';
            recarregar();
        }).catch(function (err) {
            ocupado(botao, false, ROTULO_FECHAR);
            console.warn('[AgendaConfig] Falha ao fechar dia.', err);
            feedback('Não foi possível fechar este dia. Verifique a conexão e as regras do Firebase.', 'erro');
        });
    }

    function fecharPeriodo() {
        var campoInicio = $('df-inicio');
        var campoFim = $('df-fim');
        var motivoCampo = $('df-motivo-intervalo');
        var botao = $('df-btn-intervalo');
        var inicio = campoInicio ? campoInicio.value : '';
        var fim = campoFim ? campoFim.value : '';

        if (!exigirSelecao(inicio, campoInicio)) return;
        if (!exigirSelecao(fim, campoFim)) return;

        if (fim < inicio) {
            feedback('A data final precisa ser depois da data inicial.', 'erro');
            if (campoFim) campoFim.focus();
            return;
        }

        if (inicio !== fim) {
            var p1 = partes(inicio), p2 = partes(fim);
            var dias = Math.round((new Date(p2.ano, p2.mes, p2.dia) - new Date(p1.ano, p1.mes, p1.dia)) / 86400000) + 1;
            if (dias > 60 && !window.confirm('Você vai fechar ' + dias + ' dias seguidos. Confirmar?')) {
                return;
            }
        }

        if (!window.AgendaDB || typeof window.AgendaDB.fecharIntervalo !== 'function') {
            feedback('Camada de dados indisponível. Recarregue a página.', 'erro');
            return;
        }

        feedback('Fechando o período...');
        ocupado(botao, true);

        window.AgendaDB.fecharIntervalo(inicio, fim, motivoCampo ? motivoCampo.value.trim() : '').then(function (r) {
            ocupado(botao, false, ROTULO_PERIODO);
            var parcial = r && !r.online && typeof r.gravados === 'number' &&
                r.gravados > 0 && r.gravados < r.total;
            var tipoVisual = (parcial || (r && r.erro && !r.pendente)) ? 'erro' : 'ok';
            feedback(msgSucessoPeriodo(r), tipoVisual);
            if (!(r && r.erro && parcial)) {
                if (campoInicio) campoInicio.value = '';
                if (campoFim) campoFim.value = '';
                if (motivoCampo) motivoCampo.value = '';
            }
            recarregar();
        }).catch(function (err) {
            ocupado(botao, false, ROTULO_PERIODO);
            console.warn('[AgendaConfig] Falha ao fechar período.', err);
            feedback((err && err.message) || 'Não foi possível fechar o período.', 'erro');
        });
    }

    function reabrir(iso, botao) {
        if (!window.AgendaDB || typeof window.AgendaDB.reabrirDia !== 'function') return;
        if (!iso || !isoValido(iso)) return;

        if (botao) botao.disabled = true;
        feedback('Reabrindo ' + dataCurta(iso) + '...');

        window.AgendaDB.reabrirDia(iso).then(function (r) {
            var tipoVisual = (r && r.erro && !r.pendente) ? 'erro' : 'ok';
            feedback(msgSucessoReabrir(iso, r), tipoVisual);
            recarregar();
        }).catch(function (err) {
            console.warn('[AgendaConfig] Falha ao reabrir dia.', err);
            if (botao) botao.disabled = false;
            feedback('Não foi possível reabrir este dia. Tente novamente.', 'erro');
        });
    }

    // Envia ao banco as datas que existem apenas neste aparelho.
    // Nao apaga nada no banco: so acrescenta as datas que faltam.
    function sincronizarPendentes() {
        var botao = $('df-btn-sinc-local');

        if (!window.AgendaDB || typeof window.AgendaDB.sincronizarDiasPendentes !== 'function') {
            feedback('Camada de dados indisponível. Recarregue a página.', 'erro');
            return;
        }

        if (botao) {
            botao.disabled = true;
            botao.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Enviando...';
        }
        feedback('Enviando as datas salvas só neste aparelho para o banco...');

        window.AgendaDB.sincronizarDiasPendentes().then(function (r) {
            if (botao) botao.disabled = false;

            if (!r || !r.online) {
                var motivo = (r && r.erros && r.erros[0]) || 'sem conexão com o banco';
                feedback('Não consegui falar com o banco (' + motivo + '). As datas continuam salvas neste aparelho.', 'erro');
            } else if (r.falhas > 0) {
                feedback('Enviadas ' + r.enviados + ' de ' + (r.enviados + r.falhas + r.jaExistiam) +
                    ' datas. ' + r.falhas + ' não entraram — clique de novo para tentar o resto.', 'erro');
            } else {
                feedback('Datas sincronizadas: ' + (r.enviados + r.jaExistiam) +
                    ' no banco. Agora valem para todos os aparelhos.', 'ok');
            }

            atualizarBotaoSync();
            recarregar();
        }).catch(function (err) {
            if (botao) botao.disabled = false;
            console.warn('[AgendaConfig] Falha ao sincronizar datas locais.', err);
            feedback('Não foi possível sincronizar agora. As datas continuam salvas neste aparelho.', 'erro');
            atualizarBotaoSync();
        });
    }

    function iniciar() {
        if (iniciado) return;
        var box = $('box-dias-fechados');
        if (!box) return;
        iniciado = true;

        var hoje = isoHoje();
        ['df-data', 'df-inicio', 'df-fim'].forEach(function (id) {
            var el = $(id);
            if (el) el.min = hoje;
        });

        var b1 = $('df-btn-fechar');
        var b2 = $('df-btn-intervalo');
        var b3 = $('df-btn-sinc-local');
        if (b1) b1.addEventListener('click', fecharUmDia);
        if (b2) b2.addEventListener('click', fecharPeriodo);
        if (b3) b3.addEventListener('click', sincronizarPendentes);

        pintarConexao(null);
        observarConexao();
        atualizarBotaoSync();

        if (!window.AgendaDB || typeof window.AgendaDB.observarDiasFechados !== 'function') {
            feedback('Modo local: o Firebase não está disponível nesta página.', 'erro');
            renderizarLista([]);
            return;
        }

        recarregar();
        observar();
    }

    window.AgendaAdminConfig = { iniciar: iniciar };
})();
