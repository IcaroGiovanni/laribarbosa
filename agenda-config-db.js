/* =========================================================
   CONFIGURACAO DA AGENDA - Larissa Barbosa
   ---------------------------------------------------------
   Camada de dados para as configuracoes da agenda. Sempre
   carregada DEPOIS de agenda-db.js.

   REGRAS DE PROTECAO DO BANCO (obrigatorias):
   1. Este arquivo NUNCA toca no no "agendamentos".
   2. NUNCA usa .set()/.remove() nos nos pais "config" ou
      "config/diasFechados" (isso apagaria dados vizinhos).
   3. Escritas sempre cirurgicas:
        - um dia   -> update() apenas em config/diasFechados/<iso>
        - periodo  -> update() parcial com todas as datas
        - reabrir  -> remove() apenas em config/diasFechados/<iso>
   4. update() no no do dia preserva qualquer campo extra
      existente no registro (escritas aditivas, nunca destrutivas).
   5. Registros antigos {fechado, motivo, criadoEm} continuam
      sendo lidos normalmente (compatibilidade garantida).

   Estrutura no Firebase Realtime Database:
     config/
       agendaAberta: true | false
       aviso: "texto exibido no site"
       diasFechados/
         2026-11-20: { fechado: true, motivo: "Viagem", criadoEm: "ISO" }

   API em window.AgendaDB (todas retornam Promise):
     listarDiasFechados()              -> ['2026-11-20', ...]
     fecharDia(iso, motivo)            -> { iso, online, pendente?, erro? }
     fecharIntervalo(inicio, fim, m)   -> { total, online, gravados?, erro? }
     reabrirDia(iso)                   -> { iso, online, erro? }
     observarDiasFechados(cb)          -> cancela a inscricao
     lerConfigAgenda()                 -> { aberta, aviso, online? }
     salvarConfigAgenda({aberta,aviso})-> { aberta, aviso, online, erro? }
     observarConfigAgenda(cb)          -> cancela a inscricao
     observarConexao(cb)               -> cancela a inscricao (aditivo)
     estaOnline()                      -> boolean
     listarDiasPendentes()             -> [iso] (aditivo)
     sincronizarDiasPendentes()        -> {online,enviados,jaExistiam,falhas} (aditivo)

   Sem Firebase configurado tudo continua funcionando via
   localStorage (somente no aparelho), com a MESMA chave
   "agendaDiasFechados" de sempre.
   ========================================================= */
(function () {
    'use strict';

    var SDK = 'https://www.gstatic.com/firebasejs/10.12.2/';
    var cfg = window.AGENDA_FIREBASE || {};
    var configurado = !!(cfg && cfg.databaseURL);
    var pronto = null;
    var db = null;

    var K_DIAS = 'agendaDiasFechados';
    var K_ESTADO = 'agendaEstado';
    var K_PEND = 'agendaDiasPendentes';   // fila de dias nao confirmados pelo banco
    var AVISO_PADRAO = 'Agenda fechada no momento. Os botões de agendamento estão desativados.';
    var MAX_DIAS_INTERVALO = 366;   // limite de dias por periodo fechado
    var TAM_CHUNK = 200;            // dias por update() quando o pacote for grande
    var TIMEOUT_WRITE = 15000;      // ms aguardando confirmacao do banco

    var CAMINHO = 'config/diasFechados';

    var ouvintesDias = [];    // inscricoes em modo local (offline)
    var inscricoesRemotas = []; // inscricoes em modo Firebase
    var ouvintesConfig = [];  // inscricoes da configuracao global (modo local)
    var handlerRemoto = null;   // handler unico do on('value')
    var refRemoto = null;       // db.ref(CAMINHO) quando ligado
    var ultimoBruto = null;     // ultimo snapshot bruto recebido do Firebase
    var storageLigado = false;

    // Escritas otimistas em andamento (por aba). Enquanto existem,
    // eventos do Firebase que ainda nao as contemplam NAO apagam
    // o estado otimista do cache — evita "piscadas" na lista.
    var pendFechar = {};   // iso -> { dados, ts }
    var pendReabrir = {};  // iso -> ts

    var conectado = false;         // socket (.info/connected)
    var caminhoOk = false;         // o no config/diasFechados esta legivel?
    var conexaoLigada = false;
    var ouvintesConexao = [];

    /* ---------- Utilidades de data (ISO local, nunca UTC) ---------- */

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
                ligarMonitorConexao();
                return true;
            })
            .catch(function (err) {
                console.warn('[AgendaConfig] Firebase indisponivel. Usando armazenamento local.', err);
                configurado = false;
                return false;
            });

        return pronto;
    }

    function isoValido(iso) {
        if (typeof iso !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
        var p = iso.split('-');
        var ano = parseInt(p[0], 10);
        var mes = parseInt(p[1], 10) - 1;
        var dia = parseInt(p[2], 10);
        var d = new Date(ano, mes, dia);
        return d.getFullYear() === ano && d.getMonth() === mes && d.getDate() === dia;
    }

    function exigirIso(iso) {
        if (!isoValido(iso)) throw new Error('Data invalida (use YYYY-MM-DD).');
        return iso;
    }

    // Caminho cirurgico de um dia. isoValido() garante que a string
    // so tem digitos e hifens (sem ".", "/", "$", "#", "[", "]"),
    // portanto o caminho nunca escapa de config/diasFechados/.
    function caminhoDia(iso) {
        return CAMINHO + '/' + exigirIso(iso);
    }

    function partes(iso) {
        var p = iso.split('-');
        return { ano: parseInt(p[0], 10), mes: parseInt(p[1], 10) - 1, dia: parseInt(p[2], 10) };
    }

    function somarDias(iso, quantidade) {
        var p = partes(iso);
        var d = new Date(p.ano, p.mes, p.dia + quantidade);
        return d.getFullYear() + '-' +
            String(d.getMonth() + 1).padStart(2, '0') + '-' +
            String(d.getDate()).padStart(2, '0');
    }

    // Quantidade de dias de um intervalo fechado [inicio, fim],
    // calculada por diferenca em ms (correta atraves de trocas de mes/ano/DST).
    function contarDias(inicio, fim) {
        var a = partes(inicio), b = partes(fim);
        var t1 = new Date(a.ano, a.mes, a.dia).getTime();
        var t2 = new Date(b.ano, b.mes, b.dia).getTime();
        return Math.round((t2 - t1) / 86400000) + 1;
    }

    function isoHoje() {
        var d = new Date();
        return d.getFullYear() + '-' +
            String(d.getMonth() + 1).padStart(2, '0') + '-' +
            String(d.getDate()).padStart(2, '0');
    }

    function limparMotivo(motivo) {
        return String(motivo == null ? '' : motivo).trim().slice(0, 140);
    }

    function mensagemErro(err) {
        var e = (err && err.erro) || err;
        if (!e) return 'Falha de comunicação com o banco.';
        if (e.code === 'PERMISSION_DENIED' || /permission/i.test(e.message || '')) {
            return 'Permissão negada pelas regras do banco.';
        }
        return (e.message || 'Falha de comunicação com o banco.');
    }

    /* ---------- Cache local (localStorage) ---------- */

    function lerLocalDias() {
        try {
            var bruto = localStorage.getItem(K_DIAS);
            var mapa = bruto ? JSON.parse(bruto) : {};
            return mapa && typeof mapa === 'object' && !Array.isArray(mapa) ? mapa : {};
        } catch (e) {
            return {};
        }
    }

    function gravarCacheDias(mapa) {
        try { localStorage.setItem(K_DIAS, JSON.stringify(mapa || {})); } catch (e) { }
    }

    /* ---------- Fila persistida de dias nao confirmados ---------- */

    // Dias fechados salvos NESTE aparelho que o banco ainda nao confirmou.
    // Sobrevivem a reload e a leitura remota: a leitura do banco atualiza o
    // cache, mas NUNCA apaga esta fila (se apagasse, o dia que nunca chegou
    // ao banco sumiria do aparelho sem deixar rastro).
    function lerPendentes() {
        try {
            var bruto = localStorage.getItem(K_PEND);
            var mapa = bruto ? JSON.parse(bruto) : {};
            return mapa && typeof mapa === 'object' && !Array.isArray(mapa) ? mapa : {};
        } catch (e) {
            return {};
        }
    }

    function gravarPendentes(mapa) {
        try { localStorage.setItem(K_PEND, JSON.stringify(mapa || {})); } catch (e) { }
    }

    function marcarPendente(iso, dados) {
        var mapa = lerPendentes();
        mapa[iso] = dados;
        gravarPendentes(mapa);
    }

    function limparPendente(iso) {
        var mapa = lerPendentes();
        if (!Object.prototype.hasOwnProperty.call(mapa, iso)) return;
        delete mapa[iso];
        gravarPendentes(mapa);
    }

    function limparPendentes(isos) {
        (isos || []).forEach(limparPendente);
    }

    function mapaParaLista(mapa) {
        if (!mapa || typeof mapa !== 'object') return [];
        return Object.keys(mapa).filter(function (iso) {
            var item = mapa[iso];
            // Estrito: so conta como fechado o dia com fechado === true.
            // Registro quebrado/sem "fechado" NUNCA fecha a agenda.
            return isoValido(iso) && item && item.fechado === true;
        }).sort();
    }

    /* ---------- Normalizacao (nunca altera o banco) ---------- */

    // Descarta em MEMORIA apenas: nunca deleta nada no Firebase.
    // Registros antigos {fechado, motivo, criadoEm} sao mantidos.
    // Estrito: so um registro com fechado === true bloqueia o dia.
    function normalizarDias(valor) {
        var mapa = {};
        if (!valor || typeof valor !== 'object') return mapa;
        Object.keys(valor).forEach(function (iso) {
            var item = valor[iso];
            if (!isoValido(iso)) return;
            if (!item || item.fechado !== true) return;
            mapa[iso] = item;
        });
        return mapa;
    }

    /* ---------- Pendencias otimistas (anti-flicker / anti-race) ---------- */

    function marcarPendFechar(iso, dados) {
        pendFechar[iso] = { dados: dados, ts: Date.now() };
    }

    function marcarPendReabrir(iso) {
        pendReabrir[iso] = Date.now();
    }

    function limparPendFechar(iso) { delete pendFechar[iso]; }
    function limparPendReabrir(iso) { delete pendReabrir[iso]; }

    function limparTodasPendencias(isos) {
        (isos || []).forEach(function (iso) {
            limparPendFechar(iso);
            limparPendReabrir(iso);
        });
    }

    function temPendencias() {
        return Object.keys(pendFechar).length > 0 || Object.keys(pendReabrir).length > 0;
    }

    // Aplica as pendencias ainda nao confirmadas sobre o snapshot remoto.
    // Isso impede que um evento "value" gerado ANTES do commit do write
    // faca um dia recem-fechado sumir da lista (flicker) ou um dia
    // recem-reaberto voltar a aparecer.
    function mesclarPendencias(bruto) {
        var mapa = normalizarDias(bruto);

        // Fila persistida: dias fechados NESTE aparelho que o banco ainda
        // nao confirmou. Entram na lista e nunca somem sozinhos — a leitura
        // remota atualiza o cache, mas nao pode apagar o que o banco ainda
        // nao gravou.
        var fila = lerPendentes();
        Object.keys(fila).forEach(function (iso) {
            var item = fila[iso];
            if (!isoValido(iso) || !item || item.fechado !== true) return;
            if (!mapa[iso]) mapa[iso] = item;
        });

        if (!temPendencias()) return mapa;

        Object.keys(pendFechar).forEach(function (iso) {
            if (!mapa[iso]) mapa[iso] = pendFechar[iso].dados;
        });
        Object.keys(pendReabrir).forEach(function (iso) {
            if (mapa[iso]) delete mapa[iso];
        });
        return mapa;
    }

    // Re-sincroniza o cache a partir do ULTIMO snapshot bruto real.
    // Usado quando um write falha de vez: o estado otimista errado
    // precisa ceder lugar ao estado real do banco.
    // Se nenhum snapshot remoto chegou ainda (ultimoBruto === null),
    // o cache local e preservado — o observador reconciliara quando
    // o primeiro evento value chegar.
    function reaplicarBruto() {
        if (ultimoBruto === null) return;
        receberRemoto(ultimoBruto, true);
    }

    /* ---------- Despacho com deduplicacao ---------- */

    // Chama cb apenas quando a lista realmente mudou. Sem isso, cada
    // evento do Firebase re-renderizava a lista inteira sem motivo
    // (redundancia e risco de piscada).
    function despachar(cb, ultimaRef, lista) {
        var chave = lista.join('|');
        if (ultimaRef.u === chave) return;
        ultimaRef.u = chave;
        try { cb(lista); } catch (e) { }
    }

    function listaRemotaAtual() {
        return mapaParaLista(mesclarPendencias(ultimoBruto));
    }

    function listaLocalAtual() {
        return mapaParaLista(mesclarPendencias(lerLocalDias()));
    }

    function despacharRemotas() {
        var lista = listaRemotaAtual();
        inscricoesRemotas.forEach(function (insc) {
            despachar(insc.cb, insc, lista);
        });
    }

    function despacharLocais() {
        var lista = listaLocalAtual();
        ouvintesDias.forEach(function (insc) {
            despachar(insc.cb, insc, lista);
        });
    }

    function notificarTodos() {
        despacharRemotas();
        despacharLocais();
    }

    /* ---------- Observacao remota (handler unico) ---------- */

    function receberRemoto(bruto, forcar) {
        ultimoBruto = bruto;
        marcarCaminho(true);
        var mapa = mesclarPendencias(bruto);
        gravarCacheDias(mapa);
        var lista = mapaParaLista(mapa);
        inscricoesRemotas.forEach(function (insc) {
            if (forcar) insc.u = null; // reemissao apos falha: ignora dedupe
            despachar(insc.cb, insc, lista);
        });
    }

    function ligarObservacaoRemota() {
        if (handlerRemoto || !db) return;
        refRemoto = db.ref(CAMINHO);
        handlerRemoto = refRemoto.on('value', function (snap) {
            receberRemoto(snap.val());
        }, function (err) {
            // Erro de rede/permissao na observacao: cai para modo local
            // (a lista continua funcionando com o cache do aparelho).
            console.warn('[AgendaConfig] Observacao dos dias fechados falhou. Usando cache local.', err);
            marcarCaminho(false);
            desligarObservacaoRemota();
            inscricoesRemotas.forEach(function (insc) { migrarParaLocal(insc); });
            inscricoesRemotas = [];
            despacharLocais();
        });
    }

    function desligarObservacaoRemota() {
        if (refRemoto && handlerRemoto) {
            try { refRemoto.off('value', handlerRemoto); } catch (e) { }
        }
        handlerRemoto = null;
        refRemoto = null;
    }

    function migrarParaLocal(insc) {
        insc.u = null;
        ouvintesDias.push(insc);
    }

    /* ---------- Evento storage (sync entre abas) ---------- */

    function aoMudarStorage(e) {
        if (e && e.key && e.key !== K_DIAS && e.key !== K_PEND) return;
        notificarTodos();
    }

    function ligarStorage() {
        if (storageLigado) return;
        storageLigado = true;
        window.addEventListener('storage', aoMudarStorage);
    }

    function desligarStorage() {
        if (!storageLigado) return;
        if (ouvintesDias.length || inscricoesRemotas.length) return;
        storageLigado = false;
        window.removeEventListener('storage', aoMudarStorage);
    }

    /* ---------- Monitor de conexao (.info/connected) ---------- */

    function ligarMonitorConexao() {
        if (conexaoLigada || !db) return;
        conexaoLigada = true;
        // .info/connected e uma leitura especial do SDK — nao toca em dados.
        db.ref('.info/connected').on('value', function (snap) {
            ligarConexao(snap.val() === true);
        }, function () { /* silencioso: estado permanece desconhecido */ });
    }

    function ligarConexao(valor) {
        if (conectado === valor) return;
        conectado = valor;
        notificarConexao();
    }

    // O socket pode estar ligado e ainda assim o banco recusar o acesso ao
    // no config (regras). O painel so pode dizer "sincronizado" quando os
    // dois lados estao ok.
    function marcarCaminho(ok) {
        if (caminhoOk === ok) return;
        caminhoOk = ok;
        notificarConexao();
    }

    function estadoConexao() {
        return !!(conectado && caminhoOk);
    }

    function notificarConexao() {
        var estado = estadoConexao();
        var lista = ouvintesConexao.slice();
        lista.forEach(function (cb) {
            try { cb(estado); } catch (e) { }
        });
    }

    /* ---------- API: dias fechados ---------- */

    function listarDiasFechados() {
        return iniciarFirebase().then(function (online) {
            if (!online) return listaLocalAtual();
            return db.ref(CAMINHO).once('value').then(function (snap) {
                marcarCaminho(true);
                var mapa = mesclarPendencias(snap.val());
                gravarCacheDias(mapa);
                return mapaParaLista(mapa);
            }).catch(function (err) {
                console.warn('[AgendaConfig] Nao foi possivel listar os dias fechados no banco.', err);
                marcarCaminho(false);
                return listaLocalAtual();
            });
        });
    }

    function fecharDia(iso, motivo) {
        return Promise.resolve().then(function () {
            exigirIso(iso);
            var dados = {
                fechado: true,
                motivo: limparMotivo(motivo),
                criadoEm: new Date().toISOString()
            };

            // Escrita otimista: o cache local e a lista atualizam na hora;
            // o Firebase confirma em seguida (o observador reconcilia).
            marcarPendFechar(iso, dados);
            // Fila persistida: se o banco recusar ou demorar, o dia fica na
            // fila para ser enviado depois (nao se perde no reload).
            marcarPendente(iso, dados);
            var mapa = lerLocalDias();
            mapa[iso] = dados;
            gravarCacheDias(mapa);
            notificarTodos();

            return iniciarFirebase().then(function (online) {
                if (!online) {
                    return { iso: iso, online: false, pendente: true };
                }

                // update() (e nao set()) grava apenas os campos informados
                // em config/diasFechados/<iso>, preservando qualquer campo
                // extra que exista no registro. Nenhum outro no e tocado.
                return comTimeout(
                    db.ref(caminhoDia(iso)).update(dados),
                    'fechar dia ' + iso
                ).then(function () {
                    limparPendFechar(iso);
                    limparPendente(iso);   // banco confirmou: sai da fila
                    return { iso: iso, online: true };
                }).catch(function (err) {
                    // Timeout: o write segue em tentativa no SDK — mantemos a
                    // pendencia para o observador reconciliar quando confirmar.
                    // Falha real (ex.: permissao): o estado otimista cede ao
                    // estado real do banco.
                    if (!err || !err.timeout) {
                        limparPendFechar(iso);
                        reaplicarBruto();
                    }
                    console.warn('[AgendaConfig] Falha ao gravar o dia fechado no banco.', err);
                    return { iso: iso, online: false, pendente: !!(err && err.timeout), erro: mensagemErro(err) };
                });
            });
        });
    }

    function fecharIntervalo(inicio, fim, motivo) {
        return Promise.resolve().then(function () {
            exigirIso(inicio);
            exigirIso(fim);
            if (fim < inicio) throw new Error('A data final precisa ser depois da inicial.');

            var total = contarDias(inicio, fim);
            if (total > MAX_DIAS_INTERVALO) {
                throw new Error('Intervalo muito grande (' + total + ' dias). Feche no máximo ' + MAX_DIAS_INTERVALO + ' dias por vez.');
            }

            var motivoLimpo = limparMotivo(motivo);
            var criadoEm = new Date().toISOString();

            // Pacote gerado dia a dia (O(n), n <= 366 — instantaneo).
            var pacote = {};
            var isos = [];
            var cursor = inicio;
            for (var i = 0; i < total; i++) {
                pacote[cursor] = { fechado: true, motivo: motivoLimpo, criadoEm: criadoEm };
                isos.push(cursor);
                cursor = somarDias(cursor, 1);
            }

            // Escrita otimista do pacote inteiro no cache local.
            var mapaLocal = lerLocalDias();
            isos.forEach(function (d) {
                marcarPendFechar(d, pacote[d]);
                marcarPendente(d, pacote[d]);   // fila persistente ate o banco confirmar
                mapaLocal[d] = pacote[d];
            });
            gravarCacheDias(mapaLocal);
            notificarTodos();

            return iniciarFirebase().then(function (online) {
                if (!online) {
                    return { total: total, online: false, pendente: true };
                }

                // update() parcial: grava SOMENTE as chaves do pacote dentro
                // de config/diasFechados — nenhum outro no e afetado.
                // Pacotes pequenos vao em um update (atomico). Pacotes muito
                // grandes vao em chunks sequenciais (retries sao idempotentes:
                // reenviar o mesmo pacote apenas regrava os mesmos valores).
                return enviarPacote(pacote, isos).then(function (gravados) {
                    return { total: total, gravados: gravados, online: true };
                }).catch(function (err) {
                    var timeout = !!(err && err.timeout);
                    var gravados = err && typeof err.gravados === 'number' ? err.gravados : 0;
                    if (!timeout) {
                        limparTodasPendencias(isos);
                        reaplicarBruto();
                    }
                    console.warn('[AgendaConfig] Falha ao gravar o periodo no banco.', err);
                    return {
                        total: total,
                        gravados: gravados,
                        online: false,
                        pendente: timeout,
                        erro: mensagemErro(err) +
                            (gravados > 0 && gravados < total
                                ? ' (' + gravados + ' de ' + total + ' dias gravados — tente novamente para concluir.)'
                                : '')
                    };
                });
            });
        });
    }

    function enviarPacote(pacote, isos) {
        var ref = db.ref(CAMINHO);

        function escreverChunk(sub) {
            var parte = {};
            sub.forEach(function (d) { parte[d] = pacote[d]; });
            return comTimeout(ref.update(parte), 'fechar ' + sub.length + ' dias').then(function () {
                // Chunk gravado: esses dias saem da fila persistente. Dias de
                // chunks que falharam continuam na fila (retry idempotente).
                sub.forEach(function (d) {
                    limparPendFechar(d);
                    limparPendente(d);
                });
                return sub.length;
            });
        }

        if (isos.length <= TAM_CHUNK) {
            return escreverChunk(isos);
        }

        var gravados = 0;
        var corrente = Promise.resolve();
        for (var i = 0; i < isos.length; i += TAM_CHUNK) {
            (function (sub) {
                corrente = corrente.then(function () {
                    return escreverChunk(sub).then(function (n) {
                        gravados += n;
                    });
                }).catch(function (e) {
                    e.gravados = gravados; // quantos chunks ja haviam ido bem
                    throw e;
                });
            })(isos.slice(i, i + TAM_CHUNK));
        }
        return corrente.then(function () { return gravados; });
    }

    function reabrirDia(iso) {
        return Promise.resolve().then(function () {
            exigirIso(iso);

            // Escrita otimista da reabertura (remove apenas este dia do cache).
            marcarPendReabrir(iso);
            // Dia reaberto nunca pode ser re-enviado depois: sai da fila.
            limparPendente(iso);
            var mapa = lerLocalDias();
            delete mapa[iso];
            gravarCacheDias(mapa);
            notificarTodos();

            return iniciarFirebase().then(function (online) {
                if (!online) {
                    return { iso: iso, online: false, pendente: true };
                }

                // remove() em config/diasFechados/<iso> apaga SOMENTE este dia:
                // reabrir um dia dentro de um periodo fechado nao afeta os
                // outros dias. Se o dia nao existir, o remove e um no-op e
                // nao cria lixo no banco. Nao usa once() antes para nao
                // apagar por engano um fechamento feito por outro aparelho
                // no meio tempo: "reabrir" sempre garante o dia aberto.
                return comTimeout(
                    db.ref(caminhoDia(iso)).remove(),
                    'reabrir dia ' + iso
                ).then(function () {
                    limparPendReabrir(iso);
                    return { iso: iso, online: true };
                }).catch(function (err) {
                    if (!err || !err.timeout) {
                        limparPendReabrir(iso);
                        reaplicarBruto();
                    }
                    console.warn('[AgendaConfig] Falha ao reabrir o dia no banco.', err);
                    return { iso: iso, online: false, pendente: !!(err && err.timeout), erro: mensagemErro(err) };
                });
            });
        });
    }

    /* ---------- Fila persistida: listar e sincronizar ---------- */

    // Dias fechados salvos apenas neste aparelho (ainda nao confirmados
    // pelo banco). Leitura sincrona, sem promessa.
    function listarDiasPendentes() {
        var fila = lerPendentes();
        return Object.keys(fila).filter(function (iso) {
            var item = fila[iso];
            return isoValido(iso) && item && item.fechado === true;
        }).sort();
    }

    // Envia ao banco as datas salvas apenas neste aparelho.
    // Regra de ouro: NUNCA apaga nada no banco.
    // - dia que ja existe no remoto: apenas sai da fila (nao reescreve);
    // - dia ausente: update() cirugico no caminho config/diasFechados/<iso>.
    function sincronizarDiasPendentes() {
        return Promise.resolve().then(function () {
            var isos = listarDiasPendentes();
            if (!isos.length) {
                return { online: false, enviados: 0, jaExistiam: 0, falhas: 0, nada: true, erros: [] };
            }

            return iniciarFirebase().then(function (online) {
                if (!online) {
                    return {
                        online: false, enviados: 0, jaExistiam: 0, falhas: isos.length,
                        erros: ['Sem conexao com o banco.']
                    };
                }

                return db.ref(CAMINHO).once('value').then(function (snap) {
                    var remoto = normalizarDias(snap.val());
                    return enviarFila(isos, remoto);
                }).catch(function (err) {
                    console.warn('[AgendaConfig] Falha ao ler os dias do banco.', err);
                    return {
                        online: false, enviados: 0, jaExistiam: 0,
                        falhas: isos.length, erros: [mensagemErro(err)]
                    };
                });
            });
        });
    }

    function enviarFila(isos, remoto) {
        var fila = lerPendentes();
        var enviados = 0, jaExistiam = 0, falhas = 0;
        var erros = [];

        var corrente = Promise.resolve();
        isos.forEach(function (iso) {
            corrente = corrente.then(function () {
                if (remoto[iso]) {
                    // Ja esta no banco: nao reescreve, so sai da fila.
                    limparPendente(iso);
                    jaExistiam++;
                    return null;
                }
                var item = fila[iso] || {};
                return comTimeout(
                    db.ref(caminhoDia(iso)).update({
                        fechado: true,
                        motivo: item.motivo || '',
                        criadoEm: item.criadoEm || new Date().toISOString()
                    }),
                    'sincronizar ' + iso
                ).then(function () {
                    limparPendente(iso);
                    enviados++;
                }).catch(function (err) {
                    falhas++;
                    erros.push(iso + ': ' + mensagemErro(err));
                });
            });
        });

        return corrente.then(function () {
            return {
                online: true, enviados: enviados, jaExistiam: jaExistiam,
                falhas: falhas, erros: erros
            };
        });
    }

    function comTimeout(promise, rotulo) {
        return new Promise(function (resolve, reject) {
            var terminou = false;
            var t = setTimeout(function () {
                if (terminou) return;
                terminou = true;
                reject({ rotulo: rotulo, timeout: true, erro: new Error('O banco demorou para confirmar (sem conexão?).') });
            }, TIMEOUT_WRITE);

            Promise.resolve(promise).then(function (v) {
                if (terminou) return;
                terminou = true;
                clearTimeout(t);
                resolve(v);
            }, function (e) {
                if (terminou) return;
                terminou = true;
                clearTimeout(t);
                reject(e);
            });
        });
    }

    function observarDiasFechados(cb) {
        if (typeof cb !== 'function') return function () { };

        var insc = { cb: cb, u: null };
        var emCancelamento = false;

        ligarStorage();

        iniciarFirebase().then(function (online) {
            if (emCancelamento || insc.cancelada) return;
            if (online) {
                inscricoesRemotas.push(insc);
                ligarObservacaoRemota();
                // Primeira resposta: enquanto o Firebase nao responde,
                // mostra o cache local (evita lista vazia momentanea).
                despachar(cb, insc, listaLocalAtual());
            } else {
                ouvintesDias.push(insc);
                despachar(cb, insc, listaLocalAtual());
            }
        }).catch(function () {
            if (emCancelamento || insc.cancelada) return;
            ouvintesDias.push(insc);
            despachar(cb, insc, listaLocalAtual());
        });

        return function cancelar() {
            emCancelamento = true;
            insc.cancelada = true;
            var i = ouvintesDias.indexOf(insc);
            if (i >= 0) ouvintesDias.splice(i, 1);
            var j = inscricoesRemotas.indexOf(insc);
            if (j >= 0) inscricoesRemotas.splice(j, 1);
            if (!inscricoesRemotas.length) desligarObservacaoRemota();
            desligarStorage();
        };
    }

    /* ---------- API: configuracao global ---------- */

    function lerConfigLocal() {
        try {
            var s = localStorage.getItem(K_ESTADO);
            if (s) {
                var o = JSON.parse(s);
                if (o && typeof o === 'object') {
                    return {
                        aberta: typeof o.aberta === 'boolean' ? o.aberta : true,
                        aviso: typeof o.aviso === 'string' && o.aviso ? o.aviso : AVISO_PADRAO
                    };
                }
            }
        } catch (e) { }
        return { aberta: true, aviso: AVISO_PADRAO };
    }

    function gravarConfigLocal(estado) {
        try {
            var atual = {};
            try {
                var bruto = localStorage.getItem(K_ESTADO);
                atual = bruto ? (JSON.parse(bruto) || {}) : {};
            } catch (e) { atual = {}; }
            if (!atual || typeof atual !== 'object') atual = {};
            atual.aberta = estado.aberta !== false;
            atual.aviso = estado.aviso || AVISO_PADRAO;
            localStorage.setItem(K_ESTADO, JSON.stringify(atual));
        } catch (e) {
            console.warn('[AgendaConfig] Nao foi possivel salvar a configuracao local.', e);
        }
    }

    function notificarConfig(estado) {
        ouvintesConfig.forEach(function (cb) {
            try { cb(estado); } catch (e) { }
        });
    }

    /* ---------- API: configuracao global (remota, update parcial) ---------- */

    function lerConfigAgenda() {
        var local = lerConfigLocal();

        return iniciarFirebase().then(function (online) {
            if (!online) return local;

            return db.ref('config').once('value').then(function (snap) {
                var valor = snap.val() || {};
                var temRemoto = typeof valor.agendaAberta === 'boolean';
                var estado = {
                    aberta: temRemoto ? valor.agendaAberta : local.aberta,
                    aviso: typeof valor.aviso === 'string' && valor.aviso ? valor.aviso : local.aviso
                };
                if (temRemoto) gravarConfigLocal(estado);
                return estado;
            }).catch(function (err) {
                console.warn('[AgendaConfig] Nao foi possivel ler a configuracao remota.', err);
                return local;
            });
        });
    }

    function salvarConfigAgenda(patch) {
        patch = patch || {};
        var local = lerConfigLocal();
        var estado = {
            aberta: typeof patch.aberta === 'boolean' ? patch.aberta : local.aberta,
            aviso: patch.aviso !== undefined ? String(patch.aviso).slice(0, 200) : local.aviso
        };
        if (!estado.aviso) estado.aviso = AVISO_PADRAO;

        gravarConfigLocal(estado);

        return iniciarFirebase().then(function (online) {
            if (!online) {
                return { aberta: estado.aberta, aviso: estado.aviso, online: false, erro: 'Firebase nao configurado.' };
            }

            // update() parcial: altera apenas agendaAberta e aviso,
            // preservando diasFechados e qualquer outra chave.
            return comTimeout(db.ref('config').update({
                agendaAberta: estado.aberta,
                aviso: estado.aviso
            }), 'salvar configuracao').then(function () {
                return { aberta: estado.aberta, aviso: estado.aviso, online: true };
            }).catch(function (err) {
                console.warn('[AgendaConfig] Nao foi possivel salvar a configuracao na nuvem.', err);
                return {
                    aberta: estado.aberta,
                    aviso: estado.aviso,
                    online: false,
                    erro: (err && (err.erro || err.message)) || 'Falha ao salvar na nuvem.'
                };
            });
        });
    }

    function observarConfigAgenda(cb) {
        if (typeof cb !== 'function') return function () { };
        var ativo = true;
        var handler = null;

        iniciarFirebase().then(function (online) {
            if (!ativo) return;
            if (online) {
                handler = db.ref('config').on('value', function (snap) {
                    if (!ativo) return;
                    var valor = snap.val() || {};
                    if (typeof valor.agendaAberta !== 'boolean') return;
                    var local = lerConfigLocal();
                    var estado = {
                        aberta: valor.agendaAberta,
                        aviso: typeof valor.aviso === 'string' && valor.aviso ? valor.aviso : local.aviso
                    };
                    gravarConfigLocal(estado);
                    cb(estado);
                }, function (err) {
                    console.warn('[AgendaConfig] Observacao da configuracao falhou.', err);
                });
            } else {
                ouvintesConfig.push(cb);
                cb(lerConfigLocal());
            }
        });

        function aoMudarStorage(e) {
            if (e && e.key && e.key !== K_ESTADO) return;
            cb(lerConfigLocal());
        }
        window.addEventListener('storage', aoMudarStorage);

        return function cancelar() {
            ativo = false;
            try { window.removeEventListener('storage', aoMudarStorage); } catch (e) { }
            var i = ouvintesConfig.indexOf(cb);
            if (i >= 0) ouvintesConfig.splice(i, 1);
            if (db && configurado && handler) {
                try { db.ref('config').off('value', handler); } catch (e) { }
            }
        };
    }

    /* ---------- API: status de conexao (aditivo) ---------- */

    function observarConexao(cb) {
        if (typeof cb !== 'function') return function () { };
        ouvintesConexao.push(cb);

        iniciarFirebase().then(function (online) {
            var i = ouvintesConexao.indexOf(cb);
            if (i < 0) return; // ja cancelado
            if (!online) {
                try { cb(false); } catch (e) { }
                ouvintesConexao.splice(i, 1);
            } else if (estadoConexao()) {
                try { cb(true); } catch (e) { }
            }
        });

        return function cancelar() {
            var i = ouvintesConexao.indexOf(cb);
            if (i >= 0) ouvintesConexao.splice(i, 1);
        };
    }

    function estaOnline() {
        return !!(configurado && estadoConexao());
    }

    /* ---------- Exporta no objeto existente ---------- */

    var api = window.AgendaDB = window.AgendaDB || {};

    api.listarDiasFechados = listarDiasFechados;
    api.fecharDia = fecharDia;
    api.fecharIntervalo = fecharIntervalo;
    api.reabrirDia = reabrirDia;
    api.observarDiasFechados = observarDiasFechados;
    api.lerConfigAgenda = lerConfigAgenda;
    api.salvarConfigAgenda = salvarConfigAgenda;
    api.observarConfigAgenda = observarConfigAgenda;

    // Exposicao utilitaria (usada pelo painel para formatar datas).
    api.isoHoje = isoHoje;
    api.isoValido = isoValido;

    // Novidades aditivas (nada existente e alterado).
    api.observarConexao = observarConexao;
    api.estaOnline = estaOnline;
    api.listarDiasPendentes = listarDiasPendentes;
    api.sincronizarDiasPendentes = sincronizarDiasPendentes;
})();
