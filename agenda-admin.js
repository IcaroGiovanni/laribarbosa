/* =========================================================
   AGENDA DA PROFISSIONAL - Larissa Barbosa
   ---------------------------------------------------------
   Lista, cria, edita e remove atendimentos. Usa AgendaDB
   (Firebase quando configurado, senao localStorage).
   ========================================================= */
(function () {
    'use strict';

    var HORARIOS = ['09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00', '18:00'];
    var DIAS = ['Domingo', 'Segunda-feira', 'Terça-feira', 'Quarta-feira', 'Quinta-feira', 'Sexta-feira', 'Sábado'];
    var DIAS_CURTOS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

    var STATUS = {
        aguardando: { rotulo: 'Aguardando confirmação', curto: 'Aguardando' },
        sinal_enviado: { rotulo: 'Sinal enviado', curto: 'Sinal enviado' },
        confirmado: { rotulo: 'Confirmado', curto: 'Confirmado' },
        concluido: { rotulo: 'Concluído', curto: 'Concluído' },
        cancelado: { rotulo: 'Cancelado', curto: 'Cancelado' }
    };

    var SERVICOS = [
        'Alongamento Natural', 'Alongamento Natural + Cutícula', 'Alongamento Decorado',
        'Alongamento com Decoração 3D', 'Alongamento Decorado + Cutícula', 'Banho de Gel',
        'Banho de Gel + Cutícula', 'Banho de Gel Decorado + Cutícula', 'Manutenção Natural',
        'Manutenção Decorada', 'Manutenção Decorada + Cutícula', 'Reposição de unha (fora da manutenção)',
        'Manicure Tradicional', 'Manicure & Pedicure', 'Pedicure Tradicional', 'Pedicure Premium',
        'Pedicure Alto Padrão + Esmaltação em Gel', 'Plástica dos Pés + Pedicure Tradicional'
    ];

    var WHATSAPP_LARISSA = '5531991628750';

    var estado = {
        itens: [],
        editando: null,
        busca: '',
        periodo: 'proximos',
        status: 'todos',
        iniciado: false,
        cancelarObservacao: null
    };

    function $(id) { return document.getElementById(id); }

    function escapar(valor) {
        return String(valor == null ? '' : valor)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function dois(n) { return String(n).padStart(2, '0'); }

    function paraISO(data) {
        return data.getFullYear() + '-' + dois(data.getMonth() + 1) + '-' + dois(data.getDate());
    }

    function hojeISO() { return paraISO(new Date()); }

    function somarDias(iso, dias) {
        var p = (iso || '').split('-');
        var d = new Date(parseInt(p[0], 10), parseInt(p[1], 10) - 1, parseInt(p[2], 10));
        d.setDate(d.getDate() + dias);
        return paraISO(d);
    }

    function dataLegivel(iso) {
        var p = (iso || '').split('-');
        if (p.length !== 3) return iso || '—';
        var d = new Date(parseInt(p[0], 10), parseInt(p[1], 10) - 1, parseInt(p[2], 10));
        return DIAS[d.getDay()] + ', ' + dois(d.getDate()) + '/' + dois(d.getMonth() + 1) + '/' + d.getFullYear();
    }

    function dataCurta(iso) {
        var p = (iso || '').split('-');
        if (p.length !== 3) return iso || '';
        var d = new Date(parseInt(p[0], 10), parseInt(p[1], 10) - 1, parseInt(p[2], 10));
        return DIAS_CURTOS[d.getDay()] + ', ' + dois(d.getDate()) + '/' + dois(d.getMonth() + 1);
    }

    function tituloGrupo(iso) {
        var hoje = hojeISO();
        if (iso === hoje) return 'Hoje — ' + dataLegivel(iso);
        if (iso === somarDias(hoje, 1)) return 'Amanhã — ' + dataLegivel(iso);
        return dataLegivel(iso);
    }

    function normalizarTelefone(tel) {
        var d = String(tel || '').replace(/\D/g, '');
        if (!d) return '';
        if (d.length <= 11) d = '55' + d;
        return d;
    }

    function telefoneBonito(tel) {
        var d = String(tel || '').replace(/\D/g, '');
        if (d.length === 11) return '(' + d.slice(0, 2) + ') ' + d.slice(2, 7) + '-' + d.slice(7);
        if (d.length === 10) return '(' + d.slice(0, 2) + ') ' + d.slice(2, 6) + '-' + d.slice(6);
        return tel || 'sem telefone';
    }

    function statusInfo(chave) {
        return STATUS[chave] || STATUS.aguardando;
    }

    function valorNumerico(texto) {
        var limpo = String(texto || '').replace(/[^\d,]/g, '').replace(',', '.');
        var n = parseFloat(limpo);
        return isNaN(n) ? 0 : n;
    }

    function formatarDinheiro(n) {
        return 'R$ ' + n.toFixed(2).replace('.', ',');
    }

    /* ---------------- Filtros ---------------- */

    function passaFiltroPeriodo(item) {
        var hoje = hojeISO();
        var data = item.data || '';
        switch (estado.periodo) {
            case 'hoje': return data === hoje;
            case 'semana': return data >= hoje && data <= somarDias(hoje, 7);
            case 'mes': return data.slice(0, 7) === hoje.slice(0, 7);
            case 'passados': return data < hoje;
            case 'todos': return true;
            default: return data >= hoje;
        }
    }

    function passaFiltroStatus(item) {
        if (estado.status === 'todos') return true;
        if (estado.status === 'pendentes') return item.status === 'aguardando' || item.status === 'sinal_enviado';
        return item.status === estado.status;
    }

    function passaBusca(item) {
        if (!estado.busca) return true;
        var alvo = [item.nome, item.servico, item.telefone, item.obs]
            .join(' ').toLowerCase()
            .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        var termo = estado.busca.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        return alvo.indexOf(termo) >= 0;
    }

    function itensFiltrados() {
        return estado.itens.filter(function (item) {
            return passaFiltroPeriodo(item) && passaFiltroStatus(item) && passaBusca(item);
        }).sort(function (a, b) {
            var chaveA = (a.data || '') + ' ' + (a.hora || '');
            var chaveB = (b.data || '') + ' ' + (b.hora || '');
            return chaveA < chaveB ? -1 : chaveA > chaveB ? 1 : 0;
        });
    }

    /* ---------------- Estatisticas ---------------- */

    function ativos() {
        return estado.itens.filter(function (i) { return i.status !== 'cancelado'; });
    }

    function pintarEstatisticas() {
        var hoje = hojeISO();
        var lista = ativos();
        var doDia = lista.filter(function (i) { return i.data === hoje; });
        var pendentes = lista.filter(function (i) {
            return (i.status === 'aguardando' || i.status === 'sinal_enviado') && i.data >= hoje;
        });
        var semana = lista.filter(function (i) { return i.data >= hoje && i.data <= somarDias(hoje, 7); });

        $('agenda-stats').innerHTML =
            '<div class="agenda-stat"><span>Hoje</span><strong>' + doDia.length + '</strong></div>' +
            '<div class="agenda-stat agenda-stat-alerta"><span>Aguardando confirmação</span><strong>' + pendentes.length + '</strong></div>' +
            '<div class="agenda-stat"><span>Próximos 7 dias</span><strong>' + semana.length + '</strong></div>';
    }

    /* ---------------- Lista ---------------- */

    function acoesItem(item) {
        var temTelefone = !!normalizarTelefone(item.telefone);
        return '<div class="agenda-actions">' +
            (temTelefone
                ? '<button type="button" class="agenda-action agenda-action-wa" data-acao="whats" data-id="' + escapar(item.id) + '" title="Chamar no WhatsApp"><i class="fab fa-whatsapp"></i> WhatsApp</button>'
                : '') +
            '<button type="button" class="agenda-action" data-acao="editar" data-id="' + escapar(item.id) + '" title="Editar atendimento"><i class="fas fa-pen"></i> Editar</button>' +
            '<button type="button" class="agenda-action agenda-action-danger" data-acao="remover" data-id="' + escapar(item.id) + '" title="Remover atendimento"><i class="fas fa-trash"></i></button>' +
            '</div>';
    }

    function cartao(item) {
        var st = statusInfo(item.status);
        var hoje = hojeISO();
        var passado = item.data < hoje;
        var preco = item.preco || item.valor || '';
        var sinal = item.sinal || (valorNumerico(preco) ? formatarDinheiro(valorNumerico(preco) / 2) : '');

        return '<article class="agenda-item agenda-status-' + escapar(item.status || 'aguardando') + (passado ? ' agenda-item-passado' : '') + '">' +
            '<div class="agenda-hora"><strong>' + escapar(item.hora || '--:--') + '</strong><span>' + escapar(dataCurta(item.data)) + '</span></div>' +
            '<div class="agenda-info">' +
                '<div class="agenda-item-top">' +
                    '<strong>' + escapar(item.nome || 'Sem nome') + '</strong>' +
                    '<span class="agenda-pill agenda-pill-' + escapar(item.status || 'aguardando') + '">' + escapar(st.curto) + '</span>' +
                '</div>' +
                '<p class="agenda-servico"><i class="fas fa-spa"></i> ' + escapar(item.servico || 'Serviço não informado') +
                    (preco ? ' <span class="agenda-preco">' + escapar(preco) + '</span>' : '') + '</p>' +
                '<p class="agenda-meta">' +
                    '<span><i class="fab fa-whatsapp"></i> ' + escapar(telefoneBonito(item.telefone)) + '</span>' +
                    (sinal ? '<span><i class="fas fa-coins"></i> Sinal ' + escapar(sinal) + '</span>' : '') +
                    '<span class="agenda-origem agenda-origem-' + escapar(item.origem || 'manual') + '">' +
                        (item.origem === 'site' ? 'Site' : 'Manual') + '</span>' +
                '</p>' +
                (item.obs ? '<p class="agenda-obs"><i class="fas fa-note-sticky"></i> ' + escapar(item.obs) + '</p>' : '') +
            '</div>' +
            acoesItem(item) +
        '</article>';
    }

    function pintarLista() {
        var lista = itensFiltrados();
        var container = $('agenda-lista');

        if (!lista.length) {
            container.innerHTML = '<div class="agenda-vazio">' +
                '<i class="fas fa-calendar-check"></i>' +
                '<strong>Nenhum atendimento por aqui</strong>' +
                '<span>Cadastre um novo atendimento ou ajuste os filtros.</span>' +
                '</div>';
            return;
        }

        var html = '';
        var dataAtual = null;
        lista.forEach(function (item) {
            if (item.data !== dataAtual) {
                dataAtual = item.data;
                html += '<div class="agenda-dia"><span>' + escapar(tituloGrupo(item.data)) + '</span>' +
                    '<small>' + lista.filter(function (i) { return i.data === dataAtual; }).length + ' atendimento(s)</small></div>';
            }
            html += cartao(item);
        });
        container.innerHTML = html;
    }

    function pintarTudo() {
        pintarEstatisticas();
        pintarLista();
    }

    function pintarOrigem() {
        var el = $('agenda-origem');
        if (!el) return;
        if (window.AgendaDB && window.AgendaDB.configurado) {
            el.innerHTML = '<i class="fas fa-cloud"></i> Banco de dados online — os agendamentos do site aparecem aqui automaticamente.';
            el.className = 'agenda-sub agenda-sub-online';
        } else {
            el.innerHTML = '<i class="fas fa-triangle-exclamation"></i> Sem banco online configurado: os agendamentos do site aparecem apenas neste aparelho. Veja o GUIA-AGENDA.md.';
            el.className = 'agenda-sub agenda-sub-offline';
        }
    }

    /* ---------------- Modal ---------------- */

    function abrirModal(item) {
        estado.editando = item || null;
        $('modal-titulo').textContent = item ? 'Editar atendimento' : 'Novo atendimento';
        $('f-id').value = item ? item.id : '';
        $('f-nome').value = item ? (item.nome || '') : '';
        $('f-telefone').value = item ? (item.telefone || '') : '';
        $('f-servico').value = item ? (item.servico || '') : '';
        $('f-valor').value = item ? (item.preco || item.valor || '') : '';
        $('f-data').value = item ? (item.data || hojeISO()) : hojeISO();
        $('f-hora').value = item ? (item.hora || '09:00') : proximoHorario();
        $('f-status').value = item ? (item.status || 'aguardando') : 'confirmado';
        $('f-obs').value = item ? (item.obs || '') : '';
        $('f-aviso').classList.add('hidden');
        $('modal-atendimento').classList.remove('hidden');
        document.body.classList.add('agenda-modal-aberto');
        setTimeout(function () { $('f-nome').focus(); }, 60);
    }

    function proximoHorario() {
        var agora = new Date();
        for (var i = 0; i < HORARIOS.length; i++) {
            if (parseInt(HORARIOS[i], 10) > agora.getHours()) return HORARIOS[i];
        }
        return '09:00';
    }

    function fecharModal() {
        $('modal-atendimento').classList.add('hidden');
        document.body.classList.remove('agenda-modal-aberto');
        estado.editando = null;
    }

    function avisoForm(mensagem) {
        var el = $('f-aviso');
        el.textContent = mensagem;
        el.classList.remove('hidden');
    }

    function conflito(dados) {
        return estado.itens.find(function (item) {
            return item.id !== dados.id &&
                item.data === dados.data &&
                item.hora === dados.hora &&
                item.status !== 'cancelado';
        });
    }

    function salvarFormulario(evento) {
        evento.preventDefault();

        var dados = {
            id: $('f-id').value || null,
            nome: $('f-nome').value.trim(),
            telefone: $('f-telefone').value.trim(),
            servico: $('f-servico').value.trim(),
            preco: $('f-valor').value.trim(),
            data: $('f-data').value,
            hora: $('f-hora').value,
            status: $('f-status').value,
            obs: $('f-obs').value.trim()
        };

        if (!dados.nome) return avisoForm('Informe o nome da cliente.');
        if (!dados.servico) return avisoForm('Informe o serviço.');
        if (!dados.data) return avisoForm('Informe a data.');
        if (!dados.hora) return avisoForm('Informe o horário.');

        var outro = conflito(dados);
        if (outro) {
            return avisoForm('Já existe atendimento em ' + dataCurta(dados.data) + ' às ' + dados.hora +
                ' (' + (outro.nome || 'sem nome') + '). Escolha outro horário.');
        }

        var existente = estado.itens.find(function (i) { return i.id === dados.id; });
        if (existente) {
            dados.origem = existente.origem || 'manual';
            dados.criadoEm = existente.criadoEm;
        } else {
            dados.origem = 'manual';
            dados.criadoEm = new Date().toISOString();
        }

        var botao = $('btn-salvar-atendimento');
        botao.disabled = true;
        botao.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Salvando...';

        window.AgendaDB.salvar(dados).then(function () {
            fecharModal();
            return recarregar();
        }).catch(function (erro) {
            console.error(erro);
            avisoForm('Não foi possível salvar. Verifique a conexão e tente novamente.');
        }).then(function () {
            botao.disabled = false;
            botao.innerHTML = '<i class="fas fa-save"></i> Salvar atendimento';
        });
    }

    /* ---------------- WhatsApp ---------------- */

    function mensagemWhatsApp(item) {
        var preco = item.preco || item.valor || '';
        var sinal = item.sinal || (valorNumerico(preco) ? formatarDinheiro(valorNumerico(preco) / 2) : '');
        var linhas = [
            'Oi, ' + (item.nome || 'tudo bem') + '! Aqui é a Larissa 💅',
            '',
            'Confirmando seu atendimento:',
            'Serviço: ' + (item.servico || '—'),
            'Data: ' + dataLegivel(item.data) + ' às ' + (item.hora || '--:--'),
            preco ? 'Valor: ' + preco : null,
            sinal ? 'Sinal (50%): ' + sinal : null,
            '',
            'Pode confirmar por aqui que o horário fica reservado pra você. 💕'
        ];
        return linhas.filter(function (l) { return l !== null; }).join('\n');
    }

    function abrirWhatsApp(item) {
        var numero = normalizarTelefone(item.telefone) || WHATSAPP_LARISSA;
        var url = 'https://wa.me/' + numero + '?text=' + encodeURIComponent(mensagemWhatsApp(item));
        window.open(url, '_blank');
    }

    /* ---------------- Dados ---------------- */

    function recarregar() {
        return window.AgendaDB.listar().then(function (lista) {
            estado.itens = lista || [];
            pintarTudo();
        }).catch(function (erro) {
            console.error('[Agenda] Erro ao carregar:', erro);
            $('agenda-lista').innerHTML = '<div class="agenda-vazio"><i class="fas fa-plug-circle-xmark"></i>' +
                '<strong>Não foi possível carregar a agenda</strong><span>Verifique a conexão e recarregue a página.</span></div>';
        });
    }

    function acaoLista(evento) {
        var botao = evento.target.closest('[data-acao]');
        if (!botao) return;
        var id = botao.getAttribute('data-id');
        var item = estado.itens.find(function (i) { return i.id === id; });
        if (!item) return;

        var acao = botao.getAttribute('data-acao');
        if (acao === 'whats') return abrirWhatsApp(item);
        if (acao === 'editar') return abrirModal(item);

        if (acao === 'remover') {
            var confirmar = window.confirm('Remover o atendimento de ' + (item.nome || 'sem nome') +
                ' em ' + dataCurta(item.data) + ' às ' + item.hora + '?');
            if (!confirmar) return;

            botao.disabled = true;
            window.AgendaDB.remover(id).then(recarregar).catch(function (erro) {
                console.error(erro);
                window.alert('Não foi possível remover. Tente novamente.');
                botao.disabled = false;
            });
        }
    }

    /* ---------------- Inicializacao ---------------- */

    function preencherDatalist() {
        var dl = $('lista-servicos');
        if (!dl) return;
        dl.innerHTML = SERVICOS.map(function (s) {
            return '<option value="' + escapar(s) + '"></option>';
        }).join('');
    }

    function ligarEventos() {
        $('btn-novo-atendimento').addEventListener('click', function () { abrirModal(null); });
        $('btn-fechar-modal').addEventListener('click', fecharModal);
        $('btn-cancelar-form').addEventListener('click', fecharModal);
        $('form-atendimento').addEventListener('submit', salvarFormulario);
        $('modal-atendimento').addEventListener('click', function (e) {
            if (e.target === $('modal-atendimento')) fecharModal();
        });
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape' && !$('modal-atendimento').classList.contains('hidden')) fecharModal();
        });

        $('agenda-lista').addEventListener('click', acaoLista);

        $('agenda-busca').addEventListener('input', function (e) {
            estado.busca = e.target.value.trim();
            pintarLista();
        });
        $('agenda-periodo').addEventListener('change', function (e) {
            estado.periodo = e.target.value;
            pintarLista();
        });
        $('agenda-status').addEventListener('change', function (e) {
            estado.status = e.target.value;
            pintarLista();
        });

        var busca = $('agenda-busca');
        if (busca) {
            busca.value = '';
            estado.busca = '';
        }
        $('agenda-periodo').value = estado.periodo;
        $('agenda-status').value = estado.status;
    }

    function iniciar() {
        if (estado.iniciado) {
            recarregar();
            return;
        }
        estado.iniciado = true;

        preencherDatalist();
        ligarEventos();
        pintarOrigem();
        pintarTudo();

        if (window.AgendaDB) {
            estado.cancelarObservacao = window.AgendaDB.observar(function (lista) {
                estado.itens = lista || [];
                pintarOrigem();
                pintarTudo();
            });
        }
    }

    window.AgendaAdmin = {
        iniciar: iniciar,
        recarregar: recarregar
    };
})();
