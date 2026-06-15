---
name: worldcup-live-cli
description: >
  월드컵 경기를 로거(log/warn/error/CRITICAL) 형식의 실시간 텍스트 중계로 흘려보내는
  백그라운드 데몬을 관리하고, 그 중계를 Claude Code 세션 안에 끊김 없이 띄운다.
  "코딩하는 것처럼 축구를 본다" — 별도 화면·컨텍스트 전환 없이 세션 안에서 본다.
  "모니터 돌려줘", "중계 시작", "경기 어떻게 돼가", "오늘 경기 뭐 있어",
  "경기 목록", "중계 꺼줘", "이전 경기 리플레이", "가짜로 보여줘",
  "watch the match", "start the live feed", "what's the score",
  "today's matches", "replay last game", "stop the feed",
  "worldcup-live-cli" 등 경기 모니터링 요청 시 사용.
---

# worldcup-live-cli

데몬이 ESPN 비공식 API를 폴링해 `~/.worldcup-live-cli/match-<eventId>.log`에 로거형 중계를
append한다. **중계의 소비자는 이 스킬 자신이다** — `follow`로 새 라인만 떼어 와 세션에
그대로 출력하고, 10분마다 직전 구간을 recap한다. **사용자에게 tail 명령을 안내하고 턴을
끝내는 것은 이 스킬의 실패다.**

## 실행기

모든 명령은 플러그인에 동봉된 단일 번들을 `node`로 실행한다. 외부 설치 불필요, Node 18+만.

```bash
node "$CLAUDE_PLUGIN_ROOT/dist/poll.mjs" <명령> [인자...]
```

`$CLAUDE_PLUGIN_ROOT`는 플러그인 설치 경로(Claude Code가 주입). 어느 cwd에서 호출하든
번들과 에셋을 정확히 찾는다.

## 명령

```bash
node "$CLAUDE_PLUGIN_ROOT/dist/poll.mjs" list                       # 오늘 경기 목록
node "$CLAUDE_PLUGIN_ROOT/dist/poll.mjs" daemon <eventId> --lang <ko|en>            # 라이브 데몬 (run_in_background)
node "$CLAUDE_PLUGIN_ROOT/dist/poll.mjs" replay <eventId> --lang <ko|en> [--speed <n>]  # 끝난 경기 압축 재생 (run_in_background)
node "$CLAUDE_PLUGIN_ROOT/dist/poll.mjs" follow <eventId> --cursor <byte> --wait 60  # 새 라인 long-poll 1회분
```

## 중계 언어 — 사용자 언어로 자동

데몬은 백그라운드라 사용자 언어를 모른다. **중계를 시작할 때 `--lang`으로 넘겨주는 것은 이 스킬의 몫이다.**

- daemon/replay를 띄울 때 **사용자의 대화 언어를 감지해 `--lang`을 붙인다**: 한국어면 `--lang ko`, 그 외 모든 언어는 `--lang en`. (지원: `ko`, `en` 둘뿐. 미지원 언어는 `en`으로.)
- 데몬은 그 언어로 로깅 중계를 흘린다 — 직역이 아니라 로깅 스타일 재작성. `follow`는 바이트 중계라 언어 무관.
- **recap은 당신(세션)이 작성한다 — 반드시 사용자의 대화 언어로 쓴다.** 중계 라인(데몬 생성)은 `--lang`, recap(세션 생성)은 대화 언어, 둘을 일치시킨다.

## 중계 라인 형식

데몬은 위험도(severity)를 prefix로 박은 로거형 라인을 흘린다. 그대로 출력하면 된다:

- `HH:MM:SS [log] …` — 일반 흐름 (중원 경합 등). 이벤트가 없어도 ~10초마다 흐르므로 정적이 없다.
- `HH:MM:SS 🟡 [warn] …` — 세트피스·위험지역 전개
- `HH:MM:SS 🔴 [error] …` — 박스 안 위기·슛·PK
- `HH:MM:SS 🟥 [CRITICAL] …` — 골
- `HH:MM:SS [BREAK] …` — 하프타임·수분 휴식. **이 라인을 보면 recap을 반드시 만든다.**

(이모지가 세션의 색 표시다. 터미널 `tail -f`에서는 ANSI 색으로도 보인다.)

## 중계 루프 — 이 스킬의 본체

라이브(daemon)든 리플레이(replay)든 동일하다:

1. daemon 또는 replay를 **Bash `run_in_background: true`로** 시작한다 — 사용자 대화 언어에 맞춰 **`--lang ko|en`을 반드시 붙인다.** 시작 시각을 기억해 둔다.
2. `follow <eventId> --cursor 0 --wait 60`을 포그라운드로 호출한다. 출력의 마지막 줄은
   항상 `[follow] cursor=<n> <status>` 마커이고, 마커 위가 새 중계 라인이다.
3. status별 처리:
   - **live** — 마커를 제외한 중계 라인을 ```` ```text ```` 코드블록으로 **그대로** 출력한다.
     요약·번역·재배치·생략·해설 덧붙이기 전부 금지. 출력 후 마커의 cursor로 즉시 다음 follow.
   - **idle** — 아무것도 출력하지 않고 같은 cursor로 즉시 다음 follow (앰비언트 덕에 드물다).
   - **done** — 남은 라인을 출력한 뒤 **최종 recap**(아래)으로 턴을 마친다.
   - **stalled** — 중계 프로세스가 죽었다. `pgrep -f "poll.mjs (daemon|replay)"`로 확인해
     보고하고 재시작할지 묻는다.
4. **출력 규율**: 루프 중 당신의 출력은 **중계 코드블록 + recap 블록, 이 둘뿐이다.**
   상태 설명·잡담·"계속 지켜보는 중" 류 멘트를 넣지 마라. (중계 외 노이즈 금지.)
5. `--wait`는 60을 쓰고 75를 넘기지 않는다.

## Recap — 10분 단위 + 휴식 필수

직전 구간을 사용자가 한눈에 따라잡도록 요약해 노출한다.

- **트리거**: ① 중계 시작 후 **실시간 10분이 지날 때마다**, ② 스트림에 **`[BREAK]` 라인이
  나타날 때마다**(하프타임·수분 휴식 — **필수**), ③ 경기 종료(done) 시 최종 recap.
- **내용**: 마지막 recap 이후 당신이 흘려보낸 중계 라인을 근거로, 그 구간의 스코어 변화·
  결정적 장면(🔴/🟥)·흐름을 2~4줄로 요약한다. 없던 사실을 지어내지 않는다.
- **언어**: recap은 **사용자의 대화 언어로 쓴다**(중계 라인의 `--lang`과 일치). 아래 예시는 한국어일 뿐, 영어 사용자면 영어로.
- **형식**: 중계 코드블록과 구분되게 아래처럼 노출한다.

  > 📋 **최근 10분 요약 (32'~42')** — SCO가 박스 근처에서 두 차례 위협(🔴), 골은 없음. 스코어 HAI 0:1 SCO 유지.

- 하프타임 recap은 전반 전체를, 최종 recap은 경기 전체를 요약한다.

## 요청별 처리

- **"오늘 경기 뭐 있어" / "경기 목록"**: `list` 실행 → 한국어로 정리해 보여준다.
- **"중계 시작" / "모니터 돌려줘"**: `list`에서 라이브(`[in]`) 경기를 찾는다. 하나뿐이면 바로,
  여럿이면 고르게 한 뒤 daemon을 백그라운드로(`--lang` 포함) 시작하고 **즉시 중계 루프에 진입한다.**
  라이브가 없으면 예정/종료 경기를 보여주고 리플레이를 제안한다.
- **"이전 경기 리플레이" / "가짜로/다시 보여줘"**: 끝난 경기(`[post]`)를 골라 replay를
  백그라운드로(`--lang` 포함) 시작하고 같은 루프에 진입한다. 빠르게 보려면 `--speed 60`. replay는
  라이브엔 동작하지 않는다(daemon으로 안내).
- **"경기 어떻게 돼가"** (루프가 안 돌 때): 로그 마지막 20줄을 읽고 스코어·최근 상황을 한두
  문장으로 요약한 뒤, 원하면 **현재 파일 크기**(`wc -c < ~/.worldcup-live-cli/match-<id>.log`)를
  cursor로 루프에 합류한다 — 지나간 중계를 재방송하지 않는다.
- **"중계 꺼줘"**: `pkill -f "poll.mjs daemon <eventId>"` 후 로그 경로를 알려준다.

## 주의

- 폴링 간격 하한(10s / 위험상황 3s)은 코드 고정 — 설정으로 더 줄일 수 없다. 비공식
  엔드포인트 보호가 모두의 이익이다.
- 사용자가 ESC로 루프를 끊어도 daemon/replay는 백그라운드에서 계속 돈다. 이후 "어떻게
  돼가"가 오면 현재 파일 크기부터 follow를 이어간다.
- follow 출력은 ANSI 색이 제거된 상태로 온다 — 이모지(🟡🔴🟥)가 세션의 severity 표시다.
- API 장애 시 데몬은 죽지 않고 `match-<eventId>.raw.jsonl` 사이드카에 raw를 남긴다.
  디버깅 요청이 오면 그 파일을 본다. 위장 로그에는 ESPN raw가 실리지 않는다.
- `claude` CLI가 없는 환경에서도 선택 언어(ko/en) 템플릿 폴백으로 동작한다 — narrator 에러는 치명이 아니다.
- 사실 불변: 스코어·시간·선수명은 항상 원데이터. 앰비언트 멘트는 흐름만 묘사할 뿐 사실을 담지 않는다.
