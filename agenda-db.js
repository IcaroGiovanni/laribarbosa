/* =========================================================
   BANCO DE DADOS DA AGENDA - Larissa Barbosa
   ---------------------------------------------------------
   Usa o Firebase Realtime Database quando configurado em
   agenda-firebase.js. Caso contrario, usa o localStorage
   (funciona apenas no mesmo navegador/aparelho).

   API (todas as funcoes retornam Promise):
     AgendaDB.configurado        -> true/false
     AgendaDB.listar()           -> [agendamento, ...]
     AgendaDB.salvar(obj)        -> agendamento salvo (cria ou atualiza)
     AgendaDB.atualizar(id,obj)  -> agendamento atualizado
     AgendaDB.remover(id)        -> true
     AgendaDB.observar(cb)       -> cancela a inscricao
   ========================================================= */
(function () {
    'use strict';

    var KEY = 'agendaAtendimentos';

    /* =========================================================
       MAPEAMENTO DE DURACOES DOS SERVICOS (em minutos)
       ---------------------------------------------------------
       Servicos mapeados na tabela "Tempo de Atendimento" do index.html.
       Servicos nao mapeados (decorações 3D, pedrarias, etc.) retornam
       null -> tratados como "sob consulta" (nao bloqueiam automaticamente).
       ========================================================= */
    var DURACOES = {
        // Alongamento (qualquer variante)
        'Alongamento': 180,          // 3h00
        // Manutencao
        'Manutenção Natural': 100,   // 1h40
        'Manutenção Decorada': 150,  // 2h30
        // Manicure
        'Manicure Tradicional': 60,  // 1h00
        'Manicure & Pedicure': 120,  // 2h00
        // Pedicure
        'Pedicure Tradicional': 60,  // 1h00
        'Pedicure Premium': 60,      // 1h00
    };

    function normalizarServico(servico) {
        if (typeof servico !== 'string') return '';
        return servico.trim();
    }

    function obterDuracao(servico) {
        var nome = normalizarServico(servico);
        if (!nome) return null;

        // Correspondencia exata primeiro
        if (Object.prototype.hasOwnProperty.call(DURACOES, nome)) {
            return DURACOES[nome];
        }

        // Correspondencia por prefixo (cobre variantes como
        // "Alongamento Natural + Cutícula", "Manutenção Decorada + Cutícula")
        var chaves = Object.keys(DURACOES);
        for (var i = 0; i < chaves.length; i++) {
            var chave = chaves[i];
            if (nome.indexOf(chave) === 0) {
                return DURACOES[chave];
            }
        }

        // Nao mapeado: "sob consulta" -> nao bloqueia por duracao
        return null;
    }

    /* ---------- Utilidades de hora (HH:MM <-> minutos) ---------- */

    function horaParaMinutos(hhmm) {
        if (typeof hhmm !== 'string') return null;
        var m = hhmm.match(/^(\d{1,2}):(\d{2})$/);
        if (!m) return null;
        var h = parseInt(m[1], 10);
        var min = parseInt(m[2], 10);
        if (h < 0 || h > 23 || min < 0 || min > 59) return null;
        return h * 60 + min;
    }

    function minutosParaHora(totalMinutos) {
        var h = Math.floor(totalMinutos / 60);
        var m = totalMinutos % 60;
        return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
    }

    function somarHora(hhmm, minutosAcrescimo) {
        var base = horaParaMinutos(hhmm);
        if (base === null) return null;
        var total = base + minutosAcrescimo;
        if (total < 0 || total > 24 * 60) return null;
        return minutosParaHora(total);
    }

    /* ---------- Detecao de sobreposicao de intervalos ---------- */

    // Dois intervalos [inicioA, fimA) e [inicioB, fimB) se sobrepoem
    // se inicioA < fimB E inicioB < fimA.
    function intervalosSobrepoem(inicioA, duracaoA, inicioB, duracaoB) {
        var aInicio = horaParaMinutos(inicioA);
        var bInicio = horaParaMinutos(inicioB);
        if (aInicio === null || bInicio === null) return false;
        var aFim = aInicio + (duracaoA || 0);
        var bFim = bInicio + (duracaoB || 0);
        return aInicio < bFim && bInicio < aFim;
    }

    // Verifica se um candidato (data, hora, servico) conflita com
    // qualquer agendamento existente na mesma data.
    // Retorna { conflito: true, com: <agendamentoExistente> } ou
    // { conflito: false }.
    function detectarConflitoDuracao(candidato, existentes) {
        var dataC = candidato.data;
        var horaC = candidato.hora;
        var servicoC = candidato.servico;
        var duracaoC = obterDuracao(servicoC);

        // Se o servico nao tem duracao mapeada, nao bloqueia por duracao.
        if (duracaoC === null) {
            return { conflito: false };
        }

        var idExcluir = candidato.id || null; // nao conflita consigo mesmo

        for (var i = 0; i < (existentes || []).length; i++) {
            var item = existentes[i];
            if (!item || !item.data || !item.hora) continue;
            if (item.data !== dataC) continue; // so mesmo dia
            if (idExcluir && item.id === idExcluir) continue; // ignorar o proprio registro
            if (item.status === 'cancelado') continue;

            var duracaoE = obterDuracao(item.servico);
            if (duracaoE === null) continue; // existente sem duracao mapeada nao bloqueia

            if (intervalosSobrepoem(horaC, duracaoC, item.hora, duracaoE)) {
                return { conflito: true, com: item };
            }
        }

        return { conflito: false };
    }

    var SDK = 'https://www.gstatic.com/firebasejs/10.12.2/';
    var cfg = window.AGENDA_FIREBASE || {};
    var configurado = !!(cfg && cfg.databaseURL);
    var pronto = null;
    var db = null;
    var ouvintesLocais = [];

    function gerarId() {
        return 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    }

    function carregarScript(src) {
        return new Promise(function (resolve, reject) {
            var s = document.createElement('script');
            s.src = src;
            s.onload = resolve;
            s.onerror = function () { reject(new Error('Falha ao carregar ' + src)); };
            document.head.appendChild(s);
        });
    }

    function iniciarFirebase() {
        if (!configurado) return Promise.resolve(false);
        if (pronto) return pronto;

        pronto = carregarScript(SDK + 'firebase-app-compat.js')
            .then(function () { return carregarScript(SDK + 'firebase-database-compat.js'); })
            .then(function () {
                if (!window.firebase) throw new Error('SDK do Firebase indisponivel');
                if (!firebase.apps.length) firebase.initializeApp(cfg);
                db = firebase.database();
                return true;
            })
            .catch(function (err) {
                console.warn('[AgendaDB] Firebase indisponivel. Usando armazenamento local.', err);
                configurado = false;
                return false;
            });

        return pronto;
    }

    /* ---------- Armazenamento local ---------- */

    function lerLocal() {
        try {
            var bruto = localStorage.getItem(KEY);
            var lista = bruto ? JSON.parse(bruto) : [];
            return Array.isArray(lista) ? lista : [];
        } catch (e) {
            return [];
        }
    }

    function gravarLocal(lista) {
        try {
            localStorage.setItem(KEY, JSON.stringify(lista));
        } catch (e) {
            console.warn('[AgendaDB] Nao foi possivel salvar localmente.', e);
        }
        ouvintesLocais.forEach(function (cb) {
            try { cb(lerLocal()); } catch (e) { }
        });
    }

    function paraArray(valor) {
        if (!valor) return [];
        if (Array.isArray(valor)) return valor.filter(Boolean);
        return Object.keys(valor).map(function (id) {
            var item = valor[id] || {};
            item.id = id;
            return item;
        });
    }

    /* ---------- API publica ---------- */

    function listar() {
        return iniciarFirebase().then(function (online) {
            if (!online) return lerLocal();
            return db.ref('agendamentos').once('value').then(function (snap) {
                return paraArray(snap.val());
            });
        });
    }

    function salvar(obj) {
        var dados = Object.assign({}, obj || {});
        if (!dados.id) dados.id = gerarId();
        dados.atualizadoEm = new Date().toISOString();
        if (!dados.criadoEm) dados.criadoEm = dados.atualizadoEm;
        Object.keys(dados).forEach(function (k) {
            if (dados[k] === undefined) delete dados[k];
        });

        return listar().then(function (existentes) {
            var conflito = detectarConflitoDuracao(dados, existentes);
            if (conflito.conflito) {
                var existente = conflito.com;
                var msg = 'Conflito de horário: o serviço "' + (dados.servico || '') +
                    '" (' + (obterDuracao(dados.servico) || 0) + ' min) às ' + dados.hora +
                    ' se sobrepõe ao "' + (existente.servico || '') +
                    '" já agendado às ' + existente.hora + ' em ' + existente.data + '.';
                return Promise.reject(new Error(msg));
            }

            return iniciarFirebase().then(function (online) {
                if (!online) {
                    var lista = lerLocal();
                    var indice = lista.findIndex(function (i) { return i.id === dados.id; });
                    if (indice >= 0) lista[indice] = dados;
                    else lista.push(dados);
                    gravarLocal(lista);
                    return dados;
                }
                return db.ref('agendamentos/' + dados.id).set(dados).then(function () {
                    return dados;
                });
            });
        });
    }

    function atualizar(id, patch) {
        if (!id) return Promise.reject(new Error('id obrigatorio'));
        return listar().then(function (lista) {
            var atual = lista.find(function (i) { return i.id === id; }) || { id: id };
            return salvar(Object.assign({}, atual, patch, { id: id }));
        });
    }

    function remover(id) {
        if (!id) return Promise.reject(new Error('id obrigatorio'));
        return iniciarFirebase().then(function (online) {
            if (online) return db.ref('agendamentos/' + id).remove();
            gravarLocal(lerLocal().filter(function (i) { return i.id !== id; }));
        });
    }

    function observar(cb) {
        var ativo = true;

        iniciarFirebase().then(function (online) {
            if (!ativo) return;
            if (online) {
                db.ref('agendamentos').on('value', function (snap) {
                    if (ativo) cb(paraArray(snap.val()));
                });
            } else {
                ouvintesLocais.push(cb);
                cb(lerLocal());
            }
        });

        function aoMudarStorage(e) {
            if (e && e.key && e.key !== KEY) return;
            cb(lerLocal());
        }
        window.addEventListener('storage', aoMudarStorage);

        return function cancelar() {
            ativo = false;
            try { window.removeEventListener('storage', aoMudarStorage); } catch (e) { }
            var i = ouvintesLocais.indexOf(cb);
            if (i >= 0) ouvintesLocais.splice(i, 1);
            if (db && configurado) {
                try { db.ref('agendamentos').off('value'); } catch (e) { }
            }
        };
    }

    window.AgendaDB = {
        get configurado() { return configurado; },
        gerarId: gerarId,
        listar: listar,
        salvar: salvar,
        atualizar: atualizar,
        remover: remover,
        observar: observar,
        // Novas funcoes de duracao
        obterDuracao: obterDuracao,
        detectarConflitoDuracao: detectarConflitoDuracao,
        horaParaMinutos: horaParaMinutos,
        minutosParaHora: minutosParaHora,
        somarHora: somarHora,
        intervalosSobrepoem: intervalosSobrepoem
    };
})();
