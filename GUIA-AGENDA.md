# Guia da Agenda Online — Larissa Barbosa

A agenda da profissional agora fica dentro da **Área da profissional**
(`controle-agenda.html`) e recebe automaticamente os agendamentos iniciados
pelas clientes no site.

Para que os agendamentos apareçam em **qualquer celular/computador**, é preciso
ligar o banco de dados gratuito do Firebase. Leva cerca de 10 minutos e é feito
uma única vez.

---

## 1. Criar o projeto no Firebase

1. Acesse <https://console.firebase.google.com> com uma conta Google.
2. Clique em **Criar projeto**, dê um nome (ex.: `larissa-agenda`) e continue.
   Pode desativar o Google Analytics.
3. Espere o projeto ser criado e clique em **Continuar**.

## 2. Criar o aplicativo Web

1. Na tela inicial do projeto, clique no ícone **`</>`** (Web).
2. Dê um apelido (ex.: `site-larissa`) e clique em **Registrar app**.
3. O Firebase vai mostrar um bloco parecido com este:

   ```js
   const firebaseConfig = {
     apiKey: "AIza...",
     authDomain: "larissa-agenda.firebaseapp.com",
     databaseURL: "https://larissa-agenda-default-rtdb.firebaseio.com",
     projectId: "larissa-agenda",
     storageBucket: "larissa-agenda.appspot.com",
     messagingSenderId: "123456789",
     appId: "1:123456789:web:abc123"
   };
   ```

   **Copie esses valores.**

> Se o `databaseURL` não aparecer, ele será mostrado no passo 3 (Realtime
> Database) — copie o endereço que aparece lá.

## 3. Ativar o Realtime Database

1. No menu da esquerda, em **Criação**, clique em **Realtime Database**.
2. Clique em **Criar banco de dados**.
3. Escolha o local (ex.: `Estados Unidos (us-central1)`) e clique em **Avançar**.
4. Marque **Iniciar no modo de teste** e clique em **Ativar**.

## 4. Publicar as regras de acesso

1. Ainda no **Realtime Database**, abra a aba **Regras**.
2. Substitua todo o conteúdo por:

   ```json
   {
     "rules": {
       "agendamentos": {
         ".read": true,
         ".write": true,
         "$id": {
           ".validate": "newData.hasChildren(['nome','servico','data','hora','status'])"
         }
       },
       "config": {
         ".read": true,
         ".write": true,
         "agendaAberta": {
           ".validate": "newData.isBoolean()"
         },
         "aviso": {
           ".validate": "newData.isString() && newData.val().length <= 200"
         },
         "diasFechados": {
           "$data": {
             ".validate": "$data.matches(/^\\d{4}-\\d{2}-\\d{2}$/) && newData.hasChild('fechado') && newData.child('fechado').val() === true && (!newData.hasChild('motivo') || (newData.child('motivo').isString() && newData.child('motivo').val().length <= 140)) && (!newData.hasChild('criadoEm') || newData.child('criadoEm').isString())"
           }
         }
       }
     }
   }
   ```

   > O arquivo pronto para copiar está em [`database.rules.json`](database.rules.json).
   > O nó `config` é separado de `agendamentos`. As regras acima não alteram
   > nem apagam nenhum agendamento já existente. O site só grava em
   > `config/agendaAberta`, `config/aviso` e `config/diasFechados/<data>`.

3. Clique em **Publicar**.

> **Importante:** o site é público, então essas regras permitem que qualquer
> pessoa que conheça o endereço do banco leia/grave agendamentos. Para um
> salão pequeno isso costuma ser aceitável, mas não coloque dados sensíveis
> (documentos, endereço completo, etc.) na agenda. Se quiser mais segurança,
> podemos adicionar login real depois.

### 4.1 Se aparecer "O banco recusou: Permissão negada pelas regras do banco"

Este aviso significa que **as regras publicadas no Firebase não cobrem o nó
`config`**. O sintoma é characteristicamente:

- a lista "Datas fechadas" aparece vazia (ou só com o que está salvo no
  aparelho), mesmo com datas fechadas no painel;
- o painel informa que o dia "consta fechado apenas neste aparelho";
- o interruptor de abrir/fechar a agenda também não sincroniza entre aparelhos.

**Como conferir:** abra no navegador

```
https://larisabarbosa-f2c39-default-rtdb.firebaseio.com/config.json?shallow=true&auth=AIzaSyBSOeQAeEarc0Twq2SyazNBxRdGTgPSLrM
```

- `200` = as regras estão certas.
- `401` = falta o bloco `"config"` nas regras — repita o passo 4 acima e
  publique o arquivo `database.rules.json` inteiro.

> Nada é apagado ao publicar as regras: regras são apenas permissões de
> leitura/escrita, elas nunca removem dados do banco.

> **Atenção:** depois de publicar, as datas que estavam salvas **só no
> aparelho** (cache local) continuam salvas aqui, mas ainda não estão no
> banco. Para levá-las ao banco, reabra a área da profissional com o painel
> sincronizado e use a opção de sincronizar dias locais.

## 5. Colar as chaves no site

Abra o arquivo **`agenda-firebase.js`** e preencha com os valores copiados no
passo 2:

```js
window.AGENDA_FIREBASE = {
    apiKey: "AIza...",
    authDomain: "larissa-agenda.firebaseapp.com",
    databaseURL: "https://larissa-agenda-default-rtdb.firebaseio.com",
    projectId: "larissa-agenda",
    storageBucket: "larissa-agenda.appspot.com",
    messagingSenderId: "123456789",
    appId: "1:123456789:web:abc123"
};
```

Salve e envie esse arquivo para a hospedagem junto com os demais.

## 6. Testar

1. Abra o site em uma aba anônima (simulando uma cliente).
2. Faça um agendamento: serviço → dia → horário → nome/WhatsApp.
3. Clique em **Continuar para pagamento**.
4. Abra `controle-agenda.html`, entre com a senha e veja o atendimento na
   lista, com o selo **Site**.
5. Clique em **WhatsApp** no atendimento para confirmar com a cliente.
6. Use **Editar** para mudar data, horário, serviço, valor, status ou
   observações. Use a lixeira para remover.

---

## Como funciona a agenda

- **Fechar dias específicos:** na área da profissional, use **Fechar agenda
  em datas específicas** para bloquear um dia isolado ou um período inteiro
  (inclusive datas distantes). As datas ficam salvas em
  `config/diasFechados/<AAAA-MM-DD>` e o calendário da cliente desabilita
  esses dias automaticamente, em tempo real.
- **Agenda aberta/fechada geral:** o interruptor do painel vale para todos os
  aparelhos, pois agora é salvo no Firebase em `config/agendaAberta` e
  `config/aviso` (com o `localStorage` como reserva quando não há conexão).
- **Dados protegidos:** a configuração usa somente o nó `config`. Nenhuma
  rotina lê, sobrescreve ou apaga o nó `agendamentos`; as escritas são
  parciais (`update`) ou em caminhos exatos (`config/diasFechados/<data>`).
- **Status:** Aguardando confirmação → Sinal enviado (quando a cliente clica em
  "já paguei") → Confirmado → Concluído / Cancelado.
- **Novo atendimento:** cadastro manual (origem "Manual").
- **Filtros:** próximos, hoje, próximos 7 dias, este mês, anteriores, todos;
  busca por nome/serviço/telefone; filtro por status.
- **Horários ocupados:** o site bloqueia automaticamente horários já
  agendados (exceto cancelados).
- **WhatsApp:** o botão abre a conversa com a cliente já com a mensagem de
  confirmação preenchida (serviço, data, horário e sinal).

## Sem Firebase (modo local)

Se as chaves não forem preenchidas, tudo continua funcionando, mas os
agendamentos ficam salvos **somente no navegador do aparelho** onde foram
feitos. A agenda avisa isso no topo com uma faixa vermelha.

## Arquivos envolvidos

| Arquivo | Função |
|---|---|
| `agenda-firebase.js` | Chaves do Firebase (você preenche) |
| `agenda-db.js` | Leitura/gravação dos agendamentos |
| `agenda-config-db.js` | Configuração da agenda (agenda aberta/fechada, aviso e dias fechados) |
| `agenda.js` | Aplica o estado da agenda no site inteiro |
| `agenda-admin.js` | Agenda da profissional (lista, edição, WhatsApp) |
| `agenda-admin-config.js` | Painel de fechar dias específicos |
| `agenda-admin.css` | Estilos da agenda |
| `controle-agenda.html` | Área da profissional com a agenda |
| `agendamento.html` | Coleta nome/WhatsApp e cria o agendamento |
| `pagamento.html` / `pix.html` | Marcam "sinal enviado" ao chamar no WhatsApp |
