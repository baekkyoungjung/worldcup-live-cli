# e2e-monitor

> 전반전부터 후반전까지, 당신의 터미널은 일하고 있었습니다.

월드컵 경기를 **로거(log/warn/error) 형식의 실시간 텍스트 중계**로 바꿔, Claude Code
세션 안에 끊김 없이 흘려보내는 스킬. 멀리서 보면 애플리케이션 로그, 가까이서 읽으면
캐스터의 절규다.

```
14:32:21 [log]      중원에서 양 팀이 볼을 주고받습니다
14:32:31 🟡 [warn]   스코틀랜드가 오른쪽에서 코너킥을 얻어냅니다
14:33:05 🔴 [error]  해이티 페널티 박스 안, 슛이 골문을 위협합니다
14:35:48 🟥 [CRITICAL] 골! John McGinn — HAI 0 : 1 SCO
```

---

## 설치

Claude Code에서 이 저장소를 마켓플레이스로 추가하고 스킬을 설치한다:

```
/plugin marketplace add baekkyoungjung/sajang-molae
/plugin install e2e-monitor@sajang-molae
```

설치되는 것은 단일 번들(`dist/poll.mjs`)과 에셋뿐 — **`npm install` 불필요**, 런타임
의존성 0개. **Node 18+** 만 있으면 된다. 각색에 쓰는 `claude` CLI가 없으면 한국어
템플릿 폴백으로 동작한다.

## 사용

설치 후에는 세션에 자연어로 말하면 된다 — 스킬이 데몬 기동부터 세션 내 실시간 중계,
10분 단위 recap까지 전부 대신한다.

| 이렇게 말하면 | 이렇게 동작한다 |
|---|---|
| "오늘 경기 뭐 있어" | 오늘 경기 목록과 eventId를 보여준다 |
| "중계 시작" / "모니터 돌려줘" | 라이브 경기를 골라 세션에 중계를 흘려보낸다 |
| "이전 경기 리플레이" / "가짜로 보여줘" | 끝난 경기를 가짜 라이브로 압축 재생한다 |
| "경기 어떻게 돼가" | 현재 스코어와 최근 상황을 요약한다 |
| "중계 꺼줘" | 백그라운드 데몬을 멈춘다 |

## 중계 형식 — severity 로거

ESPN 이벤트를 위험도로 분류해 prefix를 박는다. 필드 위치 좌표가 없어, 이벤트 타입과
ESPN 텍스트 키워드(“box”, “corner”, “one-on-one” 등)로 위험도를 근사한다.

| prefix | 색 / 세션 | 기준 |
|---|---|---|
| `[log]` | 기본 | 중원 경합, 일반 파울, 오프사이드, 교체 등 |
| `[warn]` | 노랑 / 🟡 | 코너·프리킥·세트피스, 위험지역 패스/크로스 |
| `[error]` | 빨강 / 🔴 | 박스 안 위기, 슛, 페널티킥 |
| `[CRITICAL]` | 빨강 / 🟥 | 골 |
| `[BREAK]` | 청록 | 하프타임·수분 휴식 (recap 트리거) |

세션(Claude Code)은 코드블록 안 ANSI 색을 렌더하지 못하므로 **이모지로 severity를 표시**하고,
터미널 `tail -f`에서는 **ANSI 색**으로 보인다.

**정적 없는 중계.** 이벤트가 없는 구간에도 ~10초마다 일반 흐름 멘트(`[log] 중원 경합…`)를
흘려 "멈춘 것처럼" 느껴지지 않게 한다. 단, **사실은 지어내지 않는다** — 스코어·시간·
선수명은 언제나 원데이터이고, 앰비언트 멘트는 흐름만 묘사한다.

**10분 recap.** 중계 루프는 실시간 10분마다, 그리고 하프타임·수분 휴식(`[BREAK]`)에는
반드시 직전 구간을 2~4줄로 요약해 노출한다 — 잠깐 자리를 비워도 따라잡을 수 있게.

## 동작 구조

```
┌─ daemon (백그라운드) ────────────────────────────────┐
│  ESPN unofficial API 폴링 (기본 10s)                  │
│    → 이벤트 분류: tier(폴링속도) + severity(위험도)    │
│    → claude -p (headless)로 흐름 이벤트 각색           │
│    → ~/.e2e-monitor/match-{id}.log 에 append          │
│  위험 상황(슛·PK·골)에선 폴링 3s 단축 + 즉시 출력       │
│  조용한 구간엔 ~10s 앰비언트 멘트로 정적 제거           │
└──────────────────────────────────────────────────────┘
        │
        ├─ Claude Code 세션 (스킬이 알아서):
        │    follow가 새 라인만 long-poll로 떼어 와 세션에 그대로 출력
        │    + 10분/[BREAK]마다 recap 노출 (중복 출력 byte-cursor로 차단)
        │
        └─ 터미널: tail -f ~/.e2e-monitor/match-{id}.log
```

각색 주체는 daemon이다. 세션이 떠 있을 필요가 없고, 본업에 쓰면 된다. 위험 상황은
지연 0의 템플릿으로 즉시 출력하고, 흐름 이벤트만 `claude -p` 배치로 각색한다(실측상
`claude -p` 1회 ~11s라 3s 주기를 못 따라오기 때문). 중계 텍스트는 전부 한국어다
(선수명·팀명 등 고유명사 제외).

## 설정

`~/.e2e-monitor/config.json` (예시는 `config.example.json`):

- `ambientIntervalSec` — 앰비언트 멘트 최소 간격(기본 10초, 하한 3초)
- `pollIntervalSec` / `tier2PollIntervalSec` — 폴링 주기(하한 10s / 3s, 코드 고정)
- `tier2.lateGameMinute` / `closeScoreDiff` / `cooldownSec` — 고속 폴링 승격 기준
- `narrator.mode` (`auto`/`claude`/`template`), `model`, `timeoutSec`

## 개발

소스는 TypeScript(`src/`, `scripts/`)이고, 배포물은 esbuild로 묶은 단일 `dist/poll.mjs`다
(런타임 의존성 0개).

```bash
npm install            # tsx / esbuild / typescript (dev only)
npm run build          # scripts/poll.ts → dist/poll.mjs
npm run typecheck

node dist/poll.mjs list
node dist/poll.mjs daemon <eventId> &
node dist/poll.mjs replay <eventId> [--speed <n>] &
tail -f ~/.e2e-monitor/match-<eventId>.log
```

스킬을 바꾼 뒤에는 `npm run build`로 `dist/poll.mjs`를 갱신해 커밋해야 한다 — 설치
사용자는 번들만 받는다.

## 데이터 소스와 한계

ESPN의 비공식(undocumented) API를 사용한다. 인증은 필요 없지만 공식 지원도, SLA도 없다.
언제든 스키마가 바뀌거나 막힐 수 있으며, 그 경우 daemon은 죽지 않고 raw JSON을
사이드카(`match-{id}.raw.jsonl`)에 남기며 버틴다.

같은 이유로 폴링 간격 하한(10s/3s)은 코드에 고정되어 있고 설정으로 더 줄일 수 없다.
이 도구가 인기를 얻어 엔드포인트가 막히면 모두가 잃는다. 점잖게 쓰자.

마이너 매치는 분 단위 commentary 없이 keyEvents만 제공될 수 있다. 이 경우 중계 밀도는
낮아지지만 빅 이벤트와 앰비언트 흐름은 유지된다.

## Disclaimer

이 프로젝트는 ESPN과 무관하며, 비공식 엔드포인트의 가용성을 보장하지 않는다.
업무 시간의 사용으로 발생하는 모든 결과는 사용자의 책임이다.

## License

MIT
