# worldcup-live-cli

> **Assista futebol como você programa.**

[English](README.md) · [한국어](README.ko.md) · [Español](README.es.md) · **Português** · [日本語](README.ja.md)

Um plugin do Claude Code que transforma uma partida da Copa do Mundo ao vivo em **texto em tempo real no formato de logger** (`log` / `warn` / `error` / `CRITICAL`) e o transmite direto para a sua sessão — sem segunda tela, sem troca de contexto. De longe parecem logs de uma aplicação; de perto, é um locutor gritando.

```
14:32:21 [log]      Os dois times trocam passes no meio-campo
14:32:31 🟡 [warn]   A Escócia conquista um escanteio pela direita
14:33:05 🔴 [error]  Dentro da área do Haiti — o chute ameaça o gol
14:35:48 🟥 [CRITICAL] GOL! John McGinn — HAI 0 : 1 SCO
```

---

## Por que ele roda *dentro* do Claude Code

É esse o ponto. A partida não vive numa aba do navegador nem num app à parte: ela é transmitida para a mesma sessão em que você já está programando.

- **Sem troca de contexto.** Você não sai do seu terminal/IDE. A narração aparece como texto na sua sessão, igual a um log de build ou a um test runner. Você olha de relance, como olha os logs.
- **A skill consome o próprio stream.** Um daemon em segundo plano consulta o placar; a skill faz `follow` do log e imprime apenas as linhas novas na sessão. Você não roda `tail` nem fica vigiando um processo — é só dizer *"comece a transmissão"* e assistir.
- **Recap para você não perder o fio.** Saiu para corrigir um bug? A cada **10 minutos** (e em cada intervalo / parada técnica) a skill publica um resumo de 2 a 4 linhas do que você perdeu. Você volta, se atualiza num relance e segue programando.
- **Sem estática.** Mesmo nos trechos calmos ele emite uma linha ambiente `[log]` a cada **10 segundos**, para a transmissão nunca parecer congelada. Mas **placar, tempos e nomes dos jogadores são sempre dados reais**; as linhas ambiente apenas descrevem o ritmo do jogo, nunca inventam fatos.
- **Camuflagem de brinde.** Como é saída de logger, para quem passa parece exatamente uma ferramenta de desenvolvimento acompanhando logs. (Este projeto nasceu como *사장 몰래* — "pelas costas do chefe". Essa herança agora é um recurso, não a manchete.)

## Instalação

No Claude Code, adicione este repositório como marketplace e instale o plugin:

```
/plugin marketplace add baekkyoungjung/worldcup-live-cli
/plugin install worldcup-live-cli@worldcup-live-cli
```

O que é instalado é um único bundle (`dist/poll.mjs`) mais os recursos — **sem `npm install`, zero dependências em runtime.** Você só precisa do **Node 18+**. Se a CLI `claude` não estiver disponível para a narração, ele recorre a templates embutidos.

## Uso

Depois de instalar, basta falar com a sua sessão em linguagem natural — a skill cuida de tudo, desde subir o daemon até transmitir ao vivo dentro da sessão e publicar os resumos.

| Se você disser | O que acontece |
|---|---|
| "Quais jogos têm hoje?" | Lista as partidas de hoje com seus eventIds |
| "Comece a transmissão" / "Assista o jogo" | Escolhe uma partida ao vivo e a transmite para a sua sessão |
| "Repita o último jogo" / "Mostra um falso" | Reproduz uma partida encerrada como falso-ao-vivo comprimido |
| "Como está o placar?" | Resume o placar atual e os lances recentes |
| "Pare a transmissão" | Encerra o daemon em segundo plano |

## Formato do stream — um logger por severidade

Os eventos da ESPN são classificados por nível de perigo e marcados com um prefixo. Não há coordenadas de posição no campo, então o perigo é aproximado pelo tipo de evento e por palavras-chave do texto da ESPN ("box", "corner", "one-on-one" etc.).

| prefixo | cor / sessão | critério |
|---|---|---|
| `[log]` | padrão | disputas no meio-campo, faltas comuns, impedimentos, substituições |
| `[warn]` | amarelo / 🟡 | escanteios, faltas, bolas paradas, passes/cruzamentos em zona perigosa |
| `[error]` | vermelho / 🔴 | chances dentro da área, chutes, pênaltis |
| `[CRITICAL]` | vermelho / 🟥 | gols |
| `[BREAK]` | ciano | intervalo / parada técnica (dispara o recap) |

A sessão do Claude Code não consegue renderizar cores ANSI dentro de um bloco de código, então **a severidade é mostrada com emoji**; num `tail -f` no terminal você vê **cores ANSI**.

## Como funciona

```
┌─ daemon (segundo plano) ──────────────────────────────┐
│  Consulta a API não oficial da ESPN (padrão 10s)      │
│    → classifica eventos: tier (velocidade) + severidade│
│    → narra eventos de ritmo via claude -p (headless)  │
│    → anexa em ~/.worldcup-live-cli/match-{id}.log     │
│  Em perigo (chute/pênalti/gol): cai para 3s + na hora │
│  Em trechos calmos: linha ambiente ~10s, sem estática │
└───────────────────────────────────────────────────────┘
        │
        ├─ sessão do Claude Code (a skill, automaticamente):
        │    follow faz long-poll só das linhas novas e as imprime
        │    + publica recap a cada 10min / [BREAK] (um byte-cursor
        │      bloqueia saída repetida)
        │
        └─ terminal: tail -f ~/.worldcup-live-cli/match-{id}.log
```

Quem narra é o daemon, não a sua sessão — então a sua sessão não precisa ficar aberta e você pode continuar trabalhando. Os momentos de perigo são impressos na hora a partir de templates de latência zero; só os eventos de ritmo são narrados em lotes de `claude -p` (na prática uma chamada `claude -p` leva ~11s, que não acompanha a cadência de 3s). Todo o texto da narração sai no idioma do leitor; os nomes próprios (jogadores/times) são mantidos como estão.

## Configuração

`~/.worldcup-live-cli/config.json` (veja `config.example.json`):

- `ambientIntervalSec` — intervalo mínimo entre linhas ambiente (padrão 10s, piso 3s)
- `pollIntervalSec` / `tier2PollIntervalSec` — cadência de polling (pisos 10s / 3s, fixos no código)
- `tier2.lateGameMinute` / `closeScoreDiff` / `cooldownSec` — limiares para promover ao polling rápido
- `narrator.mode` (`auto` / `claude` / `template`), `model`, `timeoutSec`

## Desenvolvimento

O código-fonte é TypeScript (`src/`, `scripts/`); o artefato publicado é um único `dist/poll.mjs` empacotado com esbuild (zero dependências em runtime).

```bash
npm install            # tsx / esbuild / typescript (só dev)
npm run build          # scripts/poll.ts → dist/poll.mjs
npm run typecheck

node dist/poll.mjs list
node dist/poll.mjs daemon <eventId> &
node dist/poll.mjs replay <eventId> [--speed <n>] &
tail -f ~/.worldcup-live-cli/match-<eventId>.log
```

Depois de mudar a skill, rode `npm run build` para atualizar e commitar o `dist/poll.mjs` — quem instala recebe apenas o bundle.

## Fonte de dados e limites

Usa a API não oficial (sem documentação) da ESPN. Não exige autenticação, mas não há suporte oficial nem SLA. O esquema pode mudar ou ser bloqueado a qualquer momento; quando isso acontece o daemon não morre: ele guarda o JSON cru num sidecar (`match-{id}.raw.jsonl`) e aguenta.

Pelo mesmo motivo os pisos do intervalo de polling (10s / 3s) são fixos no código e não podem ser reduzidos por configuração. Se esta ferramenta ficar popular e o endpoint for bloqueado, todos perdem. Use com moderação.

Partidas menores podem trazer apenas `keyEvents` sem comentário minuto a minuto. Nesse caso a transmissão fica mais rarefeita, mas os grandes eventos e o ritmo ambiente são preservados.

## Aviso

Este projeto não é afiliado à ESPN e não garante a disponibilidade dos endpoints não oficiais. O que acontecer por usá-lo em horário de trabalho é por sua conta.

## Licença

MIT
