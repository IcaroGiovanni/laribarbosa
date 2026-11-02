/* =========================================================
   CONTROLE DA AGENDA - Larissa Barbosa
   ---------------------------------------------------------
   Abre/fecha o site conforme window.AGENDA (agenda-config.js)
   e conforme a configuracao do painel (controle-agenda.html).

   Prioridade:
     1. Firebase (config/agendaAberta e config/aviso), quando
        disponivel — vale em todos os aparelhos.
     2. localStorage (agendaEstado), usado como cache/fallback
        quando o Firebase nao esta configurado ou esta offline.
     3. agenda-config.js (window.AGENDA), padrao do site.

   O estado e atualizado em tempo real quando o painel altera
   a configuracao, sem precisar recarregar a pagina.
   ========================================================= */
(function () {
    'use strict';

    var bannerAtual = null;
    var cancelarObservacao = null;

    function lerEstadoLocal() {
        try {
            var s = localStorage.getItem('agendaEstado');
            if (!s) return null;
            var o = JSON.parse(s);
            if (o && typeof o.aberta === 'boolean') {
                return {
                    aberta: o.aberta,
                    aviso: typeof o.aviso === 'string' && o.aviso ? o.aviso : ''
                };
            }
        } catch (e) { }
        return null;
    }

    function removerBanner() {
        if (bannerAtual && bannerAtual.parentNode) {
            bannerAtual.parentNode.removeChild(bannerAtual);
        }
        bannerAtual = null;
    }

    function criarBanner(aviso) {
        var banner = document.createElement('div');
        banner.className = 'agenda-closed-banner';
        banner.setAttribute('role', 'status');
        banner.innerHTML = '<i class="fas fa-lock"></i><span></span>';
        banner.querySelector('span').textContent = aviso;

        var wrapper = document.querySelector('.bio-wrapper');
        if (wrapper) {
            wrapper.insertBefore(banner, wrapper.firstChild);
        } else {
            document.body.insertBefore(banner, document.body.firstChild);
        }
        return banner;
    }

    function bloquearLinks() {
        var links = document.querySelectorAll('a[href*="politica-pagamento.html"], a[href*="agendamento.html"]');
        Array.prototype.forEach.call(links, function (a) {
            if (a.classList.contains('policy-link') || a.classList.contains('policy-back-link')) return;
            if (a.__agendaOffHandler) return;

            var handler = function (e) { e.preventDefault(); };
            a.__agendaOffHandler = handler;
            a.classList.add('btn-agenda-off');
            a.setAttribute('aria-disabled', 'true');
            a.setAttribute('title', 'Agenda fechada no momento');
            a.addEventListener('click', handler);
        });
    }

    function liberarLinks() {
        var links = document.querySelectorAll('a[href*="politica-pagamento.html"], a[href*="agendamento.html"]');
        Array.prototype.forEach.call(links, function (a) {
            if (!a.__agendaOffHandler) return;
            a.removeEventListener('click', a.__agendaOffHandler);
            delete a.__agendaOffHandler;
            a.classList.remove('btn-agenda-off');
            a.removeAttribute('aria-disabled');
            a.removeAttribute('title');
        });
    }

    function aplicarEstado(estado) {
        var cfg = window.AGENDA || {};
        var aberta = !estado || estado.aberta !== false;
        var aviso = (estado && estado.aviso) || cfg.aviso || 'Agenda fechada no momento.';

        cfg.aberta = aberta;
        cfg.aviso = aviso;
        window.AGENDA = cfg;

        if (aberta) {
            document.body.classList.remove('agenda-fechada');
            removerBanner();
            liberarLinks();
            return;
        }

        document.body.classList.add('agenda-fechada');

        if (!bannerAtual || !bannerAtual.parentNode) {
            bannerAtual = criarBanner(aviso);
        } else {
            var span = bannerAtual.querySelector('span');
            if (span) span.textContent = aviso;
        }

        bloquearLinks();
    }

    document.addEventListener('DOMContentLoaded', function () {
        var cfg = window.AGENDA || {};
        var local = lerEstadoLocal();

        // 1) Aplica imediatamente o que temos localmente (sem esperar rede).
        if (local) {
            aplicarEstado(local);
        } else {
            aplicarEstado({ aberta: cfg.aberta !== false, aviso: cfg.aviso });
        }

        // 2) Se a camada de dados estiver presente, prioriza o Firebase
        //    e mantem o estado sincronizado em tempo real.
        if (window.AgendaDB && typeof window.AgendaDB.lerConfigAgenda === 'function') {
            window.AgendaDB.lerConfigAgenda().then(function (remoto) {
                if (remoto) aplicarEstado(remoto);
            }).catch(function () { });

            if (typeof window.AgendaDB.observarConfigAgenda === 'function') {
                cancelarObservacao = window.AgendaDB.observarConfigAgenda(aplicarEstado);
            }
        }
    });

    window.addEventListener('pagehide', function () {
        if (typeof cancelarObservacao === 'function') cancelarObservacao();
    });
})();
