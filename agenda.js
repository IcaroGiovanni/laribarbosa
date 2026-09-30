/* =========================================================
   CONTROLE DA AGENDA - Larissa Barbosa
   ---------------------------------------------------------
   Abre/fecha o site conforme window.AGENDA (agenda-config.js)
   e conforme a configuracao local da pagina de controle
   (controle-agenda.html), que vale no aparelho onde foi feita.
   ========================================================= */
(function () {
    function lerEstadoLocal() {
        try {
            var s = localStorage.getItem('agendaEstado');
            if (!s) return null;
            var o = JSON.parse(s);
            if (o && typeof o.aberta === 'boolean') return o;
        } catch (e) { }
        return null;
    }

    document.addEventListener('DOMContentLoaded', function () {
        var cfg = window.AGENDA || {};
        var local = lerEstadoLocal();

        if (local) {
            cfg.aberta = local.aberta;
            if (local.aviso) cfg.aviso = local.aviso;
            window.AGENDA = cfg;
        }

        if (cfg.aberta !== false) return;

        document.body.classList.add('agenda-fechada');

        var aviso = cfg.aviso || 'Agenda fechada no momento.';

        var banner = document.createElement('div');
        banner.className = 'agenda-closed-banner';
        banner.setAttribute('role', 'status');
        banner.innerHTML = '<i class="fas fa-lock"></i><span>' + aviso + '</span>';

        var wrapper = document.querySelector('.bio-wrapper');
        if (wrapper) {
            wrapper.insertBefore(banner, wrapper.firstChild);
        } else {
            document.body.insertBefore(banner, document.body.firstChild);
        }

        var links = document.querySelectorAll('a[href*="politica-pagamento.html"], a[href*="agendamento.html"]');
        Array.prototype.forEach.call(links, function (a) {
            if (a.classList.contains('policy-link') || a.classList.contains('policy-back-link')) return;
            a.classList.add('btn-agenda-off');
            a.setAttribute('aria-disabled', 'true');
            a.setAttribute('title', 'Agenda fechada no momento');
            a.addEventListener('click', function (e) {
                e.preventDefault();
            });
        });
    });
})();
