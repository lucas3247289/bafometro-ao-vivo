# Servidor de lembretes (push)

Cloudflare Worker que envia as notificações do Bafômetro ao Vivo, inclusive com o app fechado.

- Produção: `https://bafometro-push.lucas2000-199862.workers.dev`
- Banco: D1 `bafometro-push`, ligado como `DB`
- Gatilho: a cada minuto (`* * * * *`), envia os lembretes vencidos
- As chaves VAPID são geradas pelo próprio Worker na primeira chamada e ficam no D1 (tabela `settings`). Não há segredo neste repositório.

## Rotas

| Rota | Método | O que faz |
| --- | --- | --- |
| `/vapid` | GET | Chave pública VAPID para o navegador se inscrever |
| `/schedule` | POST | Agenda o lembrete do aparelho (`kind`: `next` = próxima bebida, `water` = copo d’água) |
| `/cancel` | POST | Cancela um tipo de lembrete, ou todos se `kind` não for enviado |
| `/test` | POST | Envia 2 notificações de teste (criptografada e vazia) depois de `delay` segundos |
| `/last` | GET | Última resposta do serviço de push (Apple, Google, Mozilla), para diagnóstico |

## Publicar uma nova versão

Com o [Wrangler](https://developers.cloudflare.com/workers/wrangler/) instalado e logado na conta:

```bash
npx wrangler deploy
```

Ou cole o conteúdo de `worker.js` no editor do Worker no painel da Cloudflare e clique em Deploy.
