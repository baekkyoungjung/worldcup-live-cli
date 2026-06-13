# e2e-monitor

> 전반전부터 후반전까지, 당신의 터미널은 일하고 있었습니다.

월드컵 경기를 **직군 산출물로 위장한** 머드 게임풍 텍스트 중계로 바꿔, Claude Code
세션 안에 실시간으로 흘려보내는 스킬. 멀리서 보면 vitest 로그, 가까이서 읽으면
캐스터의 절규다.

```
12:37:03 ✗ FAIL  RSA.goalkeeper.save() — 67' 히메네스, 박스 우측에서 한 번 접고
                 왼발 감아차기. 골키퍼 손끝을 스치고 골망이 출렁인다. 아스테카 폭발
12:37:03 ● deploy success → MEX 1 : 0 RSA (build #67, Estadio Banorte)
```

---

## 설치

Claude Code에서 이 저장소를 마켓플레이스로 추가하고 스킬을 설치한다:

```
/plugin marketplace add baekkyoungjung/sajang-molae
/plugin install e2e-monitor@sajang-molae
```

설치되는 것은 단일 번들(`dist/poll.mjs`)과 에셋뿐 — **`npm install` 불필요**,
런타임 의존성 0개. **Node 18+** 만 있으면 된다. 각색에 쓰는 `claude` CLI가 없으면
템플릿 폴백으로 동작한다.

## 사용

설치 후에는 세션에 자연어로 말하면 된다 — 스킬이 데몬 기동부터 세션 내 실시간
중계까지 전부 대신한다.

| 이렇게 말하면 | 이렇게 동작한다 |
|---|---|
| "오늘 경기 뭐 있어" | 오늘 경기 목록과 eventId를 보여준다 |
| "중계 시작" / "모니터 돌려줘" | 라이브 경기를 골라 세션에 중계를 흘려보낸다 |
| "이전 경기 리플레이" / "가짜로 보여줘" | 끝난 경기를 가짜 라이브로 압축 재생한다 |
| "경기 어떻게 돼가" | 현재 스코어와 최근 상황을 요약한다 |
| "중계 꺼줘" | 백그라운드 데몬을 멈춘다 |

중계는 `follow` long-poll로 새 라인만 떼어 와 세션에 그대로 출력된다 — 사용자가
직접 로그 명령어를 칠 필요가 없고, 같은 내용이 두 번 나오지 않는다.

## 설계 원칙

**3미터 / 30센티 원칙.** 3미터 거리에서 보면 업무 화면, 30센티에서 읽으면 머드 게임
중계. 형식(포맷, 타임스탬프, 용어)은 직군의 실제 산출물을 따르고, 내용(서사, 감정,
현장감)은 중계를 유지한다. 둘이 충돌하면 형식이 이긴다 — 위장이 우선이다.

**서사는 양념, 사실은 원본.** 스코어, 시간, 선수명은 원데이터 그대로. 각색은 묘사를
입히는 것이지 없는 어시스트를 지어내는 게 아니다.

**침묵도 위장이다.** 새 이벤트가 없으면 아무것도 출력하지 않는다.

## 동작 구조

```
┌─ daemon (백그라운드) ────────────────────────────────┐
│  ESPN unofficial API 폴링 (기본 10s)                  │
│    → 이벤트 tier 판정                                 │
│    → claude -p (headless)로 페르소나 스킨 각색         │
│    → ~/.e2e-monitor/match-{id}.log 에 append          │
│  tier-2 상황에선 폴링 3s 단축 + 라인 단위 즉시 flush    │
└──────────────────────────────────────────────────────┘
        │
        ├─ Claude Code 세션 (스킬이 알아서):
        │    follow가 새 라인만 long-poll로 떼어 와 세션에 그대로 출력
        │    (중복 출력 byte-cursor로 구조적 차단)
        │
        └─ 터미널: tail -f ~/.e2e-monitor/match-{id}.log
```

각색 주체는 daemon이다. Claude Code 세션이 떠 있을 필요가 없고, 세션은 본업에 쓰면
된다. 각색에는 `claude -p`(headless CLI)를 사용하며, CLI가 없는 환경을 위한 템플릿
기반 폴백을 제공한다. 중계 텍스트는 전부 한국어다(선수명·팀명 등 고유명사 제외).

## 중계 밀도 — 2-tier

| tier | 대상 | 동작 |
|------|------|------|
| 1 (기본 흐름) | 슛·위기/기회, 파울, 세트피스, 카드, 교체 | 10s 폴링, 상황당 1~2줄 |
| 2 (스트리밍 승격) | PK 선언, 골 전후 시퀀스, VAR, 80'+ 박빙 스코어 | 3s 폴링, 호흡 끊어 라인 단위 flush |

승격 판정은 ESPN commentary의 이벤트 type 기반 휴리스틱이며, 기준은
`~/.e2e-monitor/config.json`에서 조정할 수 있다(예시는 `config.example.json`).

## 페르소나 스킨

`~/.e2e-monitor/config.json`의 `skin` 필드로 지정한다. 미지정 시 cwd를 보고 추정한다
(tsconfig.json이 보이면 `ts-dev`). 기본 제공:

- `ts-dev` — 테스트 러너/CI 로그체
- `planner` — 요구사항 정의서체 (골은 "승인 완료")
- `raw` — 위장 없는 풀 머드

스킨은 `skins/*.md` 마크다운 파일 하나로 추가된다. 형식 규칙과 예시 톤만 기술하면
각색 프롬프트에 주입되는 구조다. **당신의 직군 스킨을 PR로 보내달라** — 디자이너의
Figma 코멘트체, 데이터 분석가의 쿼리 로그체, 무엇이든. 작성법은 `skins/README.md`.

## 골 애니메이션

위장에는 하나의 예외가 있다: **골**. 골이 터지면 약 10초간 위장을 해제하고 ASCII
연출이 로그를 타고 흐른다 — 공이 날아가고, 골망이 찢어지고, 대형 GOAL이 한 줄씩
차오른다. 끝나면 즉시 위장 포맷으로 복귀하고, 스코어·시간 fact 라인은 연출과 무관하게
항상 출력된다. 끄려면 config에 `"goalAnimation": false` (기본 on).

아트는 `art/goal/*.txt` 플러그인이다. 여러 팩이 있으면 골마다 랜덤으로 하나를 고른다.
**당신의 골 세리머니를 PR로 보내달라** — 작성법은 `skins/README.md`.

## 개발

소스는 TypeScript(`src/`, `scripts/`)이고, 배포물은 esbuild로 묶은 단일
`dist/poll.mjs`다(런타임 의존성 0개라 번들이 단순하다).

```bash
npm install            # tsx / esbuild / typescript (dev only)
npm run build          # scripts/poll.ts → dist/poll.mjs
npm run typecheck      # tsc --noEmit

# 번들 직접 실행 (설치본과 동일하게 동작)
node dist/poll.mjs list
node dist/poll.mjs daemon <eventId> &
node dist/poll.mjs replay <eventId> [--speed <n>] &
tail -f ~/.e2e-monitor/match-<eventId>.log
```

스킬을 바꾼 뒤에는 `npm run build`로 `dist/poll.mjs`를 갱신해 커밋해야 한다 — 설치
사용자는 번들만 받는다.

## 데이터 소스와 한계

ESPN의 비공식(undocumented) API를 사용한다. 인증은 필요 없지만 공식 지원도, SLA도
없다. 언제든 스키마가 바뀌거나 막힐 수 있으며, 그 경우 daemon은 죽지 않고 raw JSON을
사이드카(`match-{id}.raw.jsonl`)에 남기며 버틴다.

같은 이유로 폴링 간격 하한(10s/3s)은 코드에 고정되어 있고 설정으로 더 줄일 수 없다.
이 도구가 인기를 얻어 엔드포인트가 막히면 모두가 잃는다. 점잖게 쓰자.

마이너 매치는 분 단위 commentary 없이 keyEvents만 제공될 수 있다. 이 경우 중계 밀도는
낮아지지만 빅 이벤트 서사는 유지된다.

## Disclaimer

이 프로젝트는 ESPN과 무관하며, 비공식 엔드포인트의 가용성을 보장하지 않는다.
업무 시간의 사용으로 발생하는 모든 결과는 사용자의 책임이다. 우리는 도구를 만들었을
뿐, 당신의 스탠드업 발표 차례에 골이 터지는 것까지는 책임질 수 없다.

## License

MIT
