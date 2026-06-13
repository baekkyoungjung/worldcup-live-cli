---
name: e2e-monitor
description: >
  월드컵 경기를 직군 산출물로 위장한 머드 게임풍 텍스트 중계로 흘려보내는
  백그라운드 데몬을 관리하고, 그 중계를 Claude Code 세션 안에 실시간으로 띄운다.
  "모니터 돌려줘", "중계 시작", "경기 어떻게 돼가", "오늘 경기 뭐 있어",
  "경기 목록", "중계 꺼줘", "이전 경기 리플레이", "가짜로 보여줘",
  "e2e-monitor" 등 경기 모니터링 요청 시 사용.
---

# e2e-monitor

데몬이 ESPN 비공식 API를 폴링해 `~/.e2e-monitor/match-<eventId>.log`에 위장 중계를
append한다. **중계의 소비자는 이 스킬 자신이다** — `follow` 커맨드로 새 라인만 떼어 와
세션에 그대로 출력하는 중계 루프를 돈다. **사용자에게 tail 명령을 안내하고 턴을 끝내는
것은 이 스킬의 실패다.**

## 실행기

모든 명령은 플러그인에 동봉된 단일 번들을 `node`로 실행한다. 외부 설치(`npm install`,
`npx`)가 필요 없고 Node 18+ 만 있으면 된다. 명령 앞에 항상 이 경로를 둔다:

```bash
node "$CLAUDE_PLUGIN_ROOT/dist/poll.mjs" <명령> [인자...]
```

`$CLAUDE_PLUGIN_ROOT`는 플러그인 설치 경로다(Claude Code가 주입). 이 변수를 쓰면 어느
cwd에서 호출하든 번들과 그 옆의 `skins/`·`art/` 에셋을 정확히 찾는다.

## 명령

```bash
# 오늘 경기 목록 (eventId 확인)
node "$CLAUDE_PLUGIN_ROOT/dist/poll.mjs" list

# 라이브 데몬 — 반드시 run_in_background로. 경기가 끝나면 최종 보고 후 스스로 종료
node "$CLAUDE_PLUGIN_ROOT/dist/poll.mjs" daemon <eventId>

# 끝난 경기를 가짜 라이브로 압축 재생 — 역시 run_in_background로 (기본 x15, 90분→~6분)
node "$CLAUDE_PLUGIN_ROOT/dist/poll.mjs" replay <eventId> [--speed <n>]

# 새 중계 라인 long-poll 1회분 — 중계 루프의 단위 호출 (포그라운드)
node "$CLAUDE_PLUGIN_ROOT/dist/poll.mjs" follow <eventId> --cursor <byte> --wait 60
```

## 중계 루프 — 이 스킬의 본체

라이브(daemon)든 리플레이(replay)든 출력 경험은 동일하다:

1. daemon 또는 replay를 **Bash `run_in_background: true`로** 시작한다.
2. `follow <eventId> --cursor 0 --wait 60`을 포그라운드로 호출한다.
   출력의 마지막 줄은 항상 `[follow] cursor=<n> <status>` 마커이고, 마커 위가
   새 중계 라인이다. 같은 바이트는 두 번 반환되지 않는다.
3. status별 처리:
   - **live** — 마커를 제외한 중계 라인을 ```` ```text ```` 코드블록으로 **그대로**
     출력한다. 요약·번역·재배치·생략·해설 덧붙이기 전부 금지 — 위장 포맷 자체가
     콘텐츠다. 출력 후 마커의 cursor 값으로 즉시 다음 follow를 호출한다.
   - **idle** — **아무것도 출력하지 않고** 같은 cursor로 즉시 다음 follow.
     단 idle이 5회 이상 이어지면(하프타임 등) "휴식 구간, 계속 지켜보는 중" 한 줄을
     **한 번만** 남기고 루프를 계속한다.
   - **done** — 남은 라인을 출력했으면 최종 스코어 한 줄 요약으로 턴을 마친다.
   - **stalled** — 중계 프로세스가 죽었다. `pgrep -f "poll.mjs (daemon|replay)"`로
     확인해 상황을 보고하고, 재시작할지 사용자에게 묻는다.
4. 루프 중에는 follow 호출과 중계 라인 출력 외의 다른 작업을 하지 않는다.
5. `--wait`는 60을 쓰고 75를 넘기지 않는다 — follow는 내부 수집(최대 ~20초)을
   포함해 Bash 기본 timeout(120s) 안에 끝나도록 설계되어 있다.

연속 코드블록은 한 중계 흐름이다 — 골 애니메이션이 두 배치로 나뉘어 와도 그대로
이어서 출력하면 된다.

## 요청별 처리

- **"오늘 경기 뭐 있어" / "경기 목록"**: `list` 실행 → 결과를 한국어로 정리해 보여준다.
- **"모니터 돌려줘" / "중계 시작"**: `list`에서 라이브(`[in]`) 경기를 찾는다.
  하나뿐이면 바로, 여럿이면 사용자에게 고르게 한 뒤 daemon을 백그라운드로 시작하고
  **즉시 중계 루프에 진입한다**. 라이브가 없으면 예정/종료 경기를 보여주고
  리플레이를 제안한다.
- **"이전 경기 리플레이" / "가짜로/다시 보여줘"**: 끝난 경기(`[post]`)를 골라 replay를
  백그라운드로 시작하고 같은 중계 루프에 진입한다. 빠르게 보려면 `--speed 60`
  (90분→1.5분), 점심시간 페이스면 `--speed 3`(90분→30분). replay는 라이브 경기엔
  동작하지 않는다(daemon으로 안내).
- **"경기 어떻게 돼가"** (중계 루프가 돌고 있지 않을 때): 로그 마지막 20줄을 읽고
  스코어·최근 상황을 한두 문장으로 요약한 뒤, 원하면 중계 루프로 합류한다.
  합류 cursor는 0이 아니라 **현재 파일 크기**(`wc -c < ~/.e2e-monitor/match-<id>.log`)
  부터 — 지나간 중계를 재방송하지 않는다.
- **"중계 꺼줘"**: `pkill -f "poll.mjs daemon <eventId>"` 후 로그 파일 경로를 알려준다.
- **"골 애니메이션 꺼줘/켜줘"**: `~/.e2e-monitor/config.json`의 `"goalAnimation"`을
  false/true로 바꾼다 (기본 on). 다음에 시작하는 daemon/replay부터 적용된다.

## 주의

- 폴링 간격 하한(10s / tier-2 3s)은 코드에 고정 — 설정으로 더 줄일 수 없고, 줄이려
  하지 마라. 비공식 엔드포인트 보호가 모두의 이익이다.
- 사용자가 ESC로 중계 루프를 끊어도 daemon/replay는 백그라운드에서 계속 돈다.
  이후 "어떻게 돼가"가 오면 마지막으로 알고 있는 cursor(모르면 현재 파일 크기)부터
  follow를 이어가면 된다.
- follow 출력은 ANSI 색이 제거된 상태로 온다 — 골 애니메이션 아트도 모양은 유지된다.
- API 장애 시 데몬은 죽지 않고 `match-<eventId>.raw.jsonl` 사이드카에 raw를 남긴다.
  디버깅 요청이 오면 그 파일을 본다. 위장 로그에는 ESPN raw가 실리지 않는다.
- `claude` CLI가 없는 환경에서도 템플릿 폴백으로 동작한다 — narrator 에러는 치명이 아니다.
- 골 순간에는 약 10초간 위장을 해제하는 ASCII 애니메이션이 로그에 흐른다(기본 on).
  골에서만 발동하며, 스코어·시간 fact 라인은 애니메이션과 무관하게 항상 먼저 출력된다.
  아트는 `$CLAUDE_PLUGIN_ROOT/art/goal/*.txt` 플러그인 — 작성법은 레포의 `skins/README.md` 참조.
