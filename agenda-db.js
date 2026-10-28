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
        observar: observar
    };
})();
