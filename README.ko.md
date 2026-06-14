# worldcup-live-cli

> **코딩하는 것처럼 축구를 보세요.**

[English](README.md) · **한국어** · [Español](README.es.md) · [Português](README.pt.md) · [日本語](README.ja.md)

라이브 월드컵 경기를 **로거 형식의 실시간 텍스트**(`log` / `warn` / `error` / `CRITICAL`)로 바꿔, 작업 중인 Claude Code 세션 안에 그대로 흘려보내는 플러그인. 별도 화면도, 컨텍스트 전환도 없습니다. 멀리서 보면 애플리케이션 로그, 가까이서 읽으면 캐스터의 절규입니다.

```
14:32:21 [log]      중원에서 양 팀이 볼을 주고받습니다
14:32:31 🟡 [warn]   스코틀랜드가 오른쪽에서 코너킥을 얻어냅니다
14:33:05 🔴 [error]  해이티 페널티 박스 안, 슛이 골문을 위협합니다
14:35:48 🟥 [CRITICAL] 골! John McGinn — HAI 0 : 1 SCO
```

---

## 왜 Claude Code *안*에서 도는가

이게 핵심입니다. 경기가 브라우저 탭이나 별도 앱이 아니라, 지금 코딩하고 있는 바로 그 세션 안으로 흘러들어옵니다.

- **컨텍스트 전환이 없다.** 터미널/IDE를 떠나지 않습니다. 빌드 로그나 테스트 러너처럼, 중계가 세션 안에 텍스트로 뜹니다. 로그 보듯 흘끗 보면 됩니다.
- **스킬이 자기 스트림을 직접 소비한다.** 백그라운드 데몬이 스코어를 폴링하고, 스킬은 로그를 `follow`해 새 라인만 세션에 출력합니다. `tail`을 직접 돌릴 필요도, 프로세스를 지켜볼 필요도 없습니다 — *"중계 시작"* 한마디면 됩니다.
- **흐름을 놓치지 않게 하는 recap.** 버그 잡으러 잠깐 자리를 비웠나요? **10분마다**(그리고 하프타임·수분 휴식마다) 스킬이 놓친 구간을 2~4줄로 요약해 띄웁니다. 돌아와서 한눈에 따라잡고 다시 코딩하면 됩니다.
- **정적 없는 중계.** 조용한 구간에도 약 **10초마다** 앰비언트 `[log]` 라인을 흘려, 중계가 멈춘 것처럼 보이지 않습니다 — 단, **스코어·시간·선수명은 언제나 원데이터**이고, 앰비언트 라인은 흐름만 묘사할 뿐 사실을 지어내지 않습니다.
- **덤으로 위장.** 로거 출력이라, 지나가는 사람 눈엔 로그를 tail하는 개발 도구로 보입니다. (이 프로젝트는 원래 *사장 몰래* 라는 이름으로 시작했습니다. 그 유산은 이제 헤드라인이 아니라 하나의 기능입니다.)

## 설치

Claude Code에서 이 저장소를 마켓플레이스로 추가하고 플러그인을 설치합니다:

```
/plugin marketplace add baekkyoungjung/worldcup-live-cli
/plugin install worldcup-live-cli@worldcup-live-cli
```

설치되는 것은 단일 번들(`dist/poll.mjs`)과 에셋뿐 — **`npm install` 불필요, 런타임 의존성 0개.** **Node 18+** 만 있으면 됩니다. 각색에 쓰는 `claude` CLI가 없으면 내장 템플릿 폴백으로 동작합니다.

## 사용

설치 후에는 세션에 자연어로 말하면 됩니다 — 데몬 기동부터 세션 내 실시간 중계, recap까지 스킬이 전부 대신합니다.

| 이렇게 말하면 | 이렇게 동작한다 |
|---|---|
| "오늘 경기 뭐 있어" | 오늘 경기 목록과 eventId를 보여준다 |
| "중계 시작" / "모니터 돌려줘" | 라이브 경기를 골라 세션에 중계를 흘려보낸다 |
| "이전 경기 리플레이" / "가짜로 보여줘" | 끝난 경기를 가짜 라이브로 압축 재생한다 |
| "경기 어떻게 돼가" | 현재 스코어와 최근 상황을 요약한다 |
| "중계 꺼줘" | 백그라운드 데몬을 멈춘다 |

## 중계 형식 — severity 로거

ESPN 이벤트를 위험도로 분류해 prefix를 박습니다. 필드 위치 좌표가 없어, 이벤트 타입과 ESPN 텍스트 키워드("box", "corner", "one-on-one" 등)로 위험도를 근사합니다.

| prefix | 색 / 세션 | 기준 |
|---|---|---|
| `[log]` | 기본 | 중원 경합, 일반 파울, 오프사이드, 교체 등 |
| `[warn]` | 노랑 / 🟡 | 코너·프리킥·세트피스, 위험지역 패스/크로스 |
| `[error]` | 빨강 / 🔴 | 박스 안 위기, 슛, 페널티킥 |
| `[CRITICAL]` | 빨강 / 🟥 | 골 |
| `[BREAK]` | 청록 | 하프타임·수분 휴식 (recap 트리거) |

세션(Claude Code)은 코드블록 안 ANSI 색을 렌더하지 못하므로 **이모지로 severity를 표시**하고, 터미널 `tail -f`에서는 **ANSI 색**으로 보입니다.

## 동작 구조

```
┌─ daemon (백그라운드) ────────────────────────────────────┐
│  ESPN 비공식 API 폴링 (기본 10s)                          │
│    → 이벤트 분류: tier(폴링속도) + severity(위험도)       │
│    → claude -p (headless)로 흐름 이벤트 각색              │
│    → ~/.worldcup-live-cli/match-{id}.log 에 append        │
│  위험 상황(슛·PK·골)에선 폴링 3s 단축 + 즉시 출력          │
│  조용한 구간엔 ~10s 앰비언트 멘트로 정적 제거              │
└───────────────────────────────────────────────────────────┘
        │
        ├─ Claude Code 세션 (스킬이 알아서):
        │    follow가 새 라인만 long-poll로 떼어 와 세션에 출력
        │    + 10분/[BREAK]마다 recap 노출 (중복 출력 byte-cursor로 차단)
        │
        └─ 터미널: tail -f ~/.worldcup-live-cli/match-{id}.log
```

각색 주체는 데몬입니다. 세션이 떠 있을 필요가 없고, 본업에 쓰면 됩니다. 위험 상황은 지연 0의 템플릿으로 즉시 출력하고, 흐름 이벤트만 `claude -p` 배치로 각색합니다(실측상 `claude -p` 1회 ~11s라 3s 주기를 못 따라오기 때문). 중계 텍스트는 읽는 사람의 언어로 나오고, 고유명사(선수명·팀명)는 원형 그대로 둡니다.

## 설정

`~/.worldcup-live-cli/config.json` (예시는 `config.example.json`):

- `ambientIntervalSec` — 앰비언트 멘트 최소 간격(기본 10초, 하한 3초)
- `pollIntervalSec` / `tier2PollIntervalSec` — 폴링 주기(하한 10s / 3s, 코드 고정)
- `tier2.lateGameMinute` / `closeScoreDiff` / `cooldownSec` — 고속 폴링 승격 기준
- `narrator.mode` (`auto` / `claude` / `template`), `model`, `timeoutSec`

## 개발

소스는 TypeScript(`src/`, `scripts/`)이고, 배포물은 esbuild로 묶은 단일 `dist/poll.mjs`입니다(런타임 의존성 0개).

```bash
npm install            # tsx / esbuild / typescript (dev only)
npm run build          # scripts/poll.ts → dist/poll.mjs
npm run typecheck

node dist/poll.mjs list
node dist/poll.mjs daemon <eventId> &
node dist/poll.mjs replay <eventId> [--speed <n>] &
tail -f ~/.worldcup-live-cli/match-<eventId>.log
```

스킬을 바꾼 뒤에는 `npm run build`로 `dist/poll.mjs`를 갱신해 커밋해야 합니다 — 설치 사용자는 번들만 받습니다.

## 데이터 소스와 한계

ESPN의 비공식(undocumented) API를 사용합니다. 인증은 필요 없지만 공식 지원도, SLA도 없습니다. 언제든 스키마가 바뀌거나 막힐 수 있으며, 그 경우 데몬은 죽지 않고 raw JSON을 사이드카(`match-{id}.raw.jsonl`)에 남기며 버팁니다.

같은 이유로 폴링 간격 하한(10s / 3s)은 코드에 고정되어 있고 설정으로 더 줄일 수 없습니다. 이 도구가 인기를 얻어 엔드포인트가 막히면 모두가 잃습니다. 점잖게 쓰세요.

마이너 매치는 분 단위 commentary 없이 keyEvents만 제공될 수 있습니다. 이 경우 중계 밀도는 낮아지지만 빅 이벤트와 앰비언트 흐름은 유지됩니다.

## Disclaimer

이 프로젝트는 ESPN과 무관하며, 비공식 엔드포인트의 가용성을 보장하지 않습니다. 업무 시간의 사용으로 발생하는 모든 결과는 사용자의 책임입니다.

## License

MIT
