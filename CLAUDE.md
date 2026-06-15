# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 개요

월드컵 경기를 로거형 텍스트(`[log]`/`[warn]`/`[error]`/`[CRITICAL]`)로 세션에 흘려보내는 Claude Code **플러그인**이다. 백그라운드 데몬이 ESPN 비공식 API를 폴링해 로그 파일에 중계를 append하고, 스킬이 그 파일을 `follow`하며 새 라인만 세션에 출력한다. 애플리케이션 로그처럼 보이는 위장("코딩하듯 축구를 본다")이 이 제품의 원래 전제다 — *사장 몰래*에서 출발했다.

제품 맥락은 다국어 `README.md`(+ `.ko/.es/.pt/.ja`), 세션이 루프를 구동하는 방식은 `skills/worldcup-live-cli/SKILL.md`를 참고한다.

## 명령

```bash
npm run build       # esbuild scripts/poll.ts → dist/poll.mjs (배포되는 유일한 산출물)
npm run typecheck   # tsc --noEmit (테스트 스위트 없음)
npm run list        # tsx scripts/poll.ts list — 오늘 경기
npm run daemon      # tsx scripts/poll.ts daemon <eventId>

# 번들 직접 실행 (설치 사용자가 받는 형태):
node dist/poll.mjs list
node dist/poll.mjs daemon <eventId> [--once]          # --once = 1 tick만, 검증용
node dist/poll.mjs replay <eventId> [--speed <n>]     # 끝난 경기 → 압축 가짜 라이브
node dist/poll.mjs follow <eventId> --cursor <byte> --wait 60
tail -f ~/.worldcup-live-cli/match-<eventId>.log
```

**`src/`나 `scripts/`를 고쳤으면 반드시 `npm run build` 후 `dist/poll.mjs`를 커밋한다.** 설치자는 번들만 받으므로, 리빌드되지 않은 소스 변경은 아무것도 배포되지 않는다. 런타임 의존성은 0(Node 18+만 필요)이고, dev 의존성은 tsx/esbuild/typescript뿐이다.

`scripts/poll.ts`가 유일한 CLI 진입점으로 네 서브커맨드(`list`/`daemon`/`replay`/`follow`)를 라우팅한다. 모든 로직은 `src/`에 있다.

## 아키텍처

두 프로세스가 **오직 파일로만** (`~/.worldcup-live-cli/` 내부) 통신한다 — IPC는 없다. 이 "파일이 곧 채널" 설계 덕에 경기가 백그라운드에서 도는 동안에도 세션은 계속 작업할 수 있다.

**Writer 측 (`daemon.ts` / `replay.ts`)** — 백그라운드로 돌며 ESPN을 폴링해 `match-<id>.log`에 append:
- `espn.ts` — `summary`(1콜 = 1 tick: 상태 + clock + 스코어 + commentary + keyEvents)와 `scoreboard`를 가져온다. 모든 필드를 불신하며, 스키마가 깨지면 throw하지 않고 에러를 반환한다. 항목 소스는 둘: `commentary`(풍부, `seq:` id) 또는 commentary가 비면 `keyEvents`(희소, `ke:` id).
- `tier.ts` — `classify()`가 각 raw 항목을 **tier**(0 스킵 / 1 기본 / 2 고속폴링 승격), **severity**(log/warn/error/critical — 필드 좌표가 없어 이벤트 타입 + 텍스트 키워드로 골 위험도를 근사하며 **절대 강등 안 함**), **category**로 정규화한다. `NOISE_TYPE_IDS`가 템플릿 노이즈 약 63%를 버린다.
- `narrate.ts` — `Narrator.narrateBatch()`가 흐름 이벤트 각색을 위해 `claude -p`(기본 `haiku`)를 호출한다. 중앙값 지연 ~11s는 3s 고속 케이던스를 못 따라가므로, **위험 이벤트(error/critical)는 템플릿으로 즉시 출력하고, 흐름 이벤트만 tick당 1회 배치로 각색한다.** `STYLE_GUIDE`는 언어별(ko/en)로 출력 언어를 정한다 — 직역이 아닌 로깅 스타일 재작성. `claude`가 없거나 timeout이면 해당 언어 템플릿으로 폴백 — 치명적이지 않다.
- `render.ts` — 최종 `HH:MM:SS <이모지> [LEVEL] 멘트` 라인을 조립한다. **스코어·시간·선수명은 raw 데이터에서 직접 렌더하며 `claude`를 절대 거치지 않는다**(사실 불변). 이모지는 ANSI 제거 후에도 살아남는 severity 표시이고, ANSI 색은 터미널 `tail -f`용이다. 언어 의존 문구는 `Strings` 테이블로 주입받는다(`formatLine`/`formatCue`는 언어 중립).
- `strings.ts` — 언어별 정적 문자열 테이블(`STRINGS_KO`/`STRINGS_EN`, `stringsFor(lang)`): 앰비언트 풀·경기 경계 라벨·골/최종보고 템플릿·각색 폴백·요약 라벨. **런타임 LLM 의존 0** — claude 없어도 양 언어가 산다. 미지원 언어는 `en` 폴백. 출력 언어는 `--lang ko|en`(스킬이 사용자 대화 언어 감지 후 주입) 또는 config `language`(기본 `en`)로 결정.
- `state.ts` — `MatchStateStore`가 dedupe/스코어 상태를 `state-<id>.json`에 영속화(원자적 temp-write+rename)해, 재시작한 데몬이 경기 전체를 재방송하지 않게 한다. `takeNew()`는 미방송 항목만 반환하고 `seq`↔`ke` 소스 플립을 처리한다(전체 재방송을 막으려 그 배치는 통째로 흡수). `acquireLock()`은 한 경기에 데몬 둘이 붙는 걸 막는 pid-file 뮤텍스다(죽은 pid의 stale lock은 회수).

**Reader 측 (`follow.ts`)** — 세션 턴당 1회 호출되는, 상주 tail이 아닌 byte-cursor long-poll이다. `match-<id>.log`가 `cursor`를 넘어 자랄 때까지 대기 → 새 라인 배치를 디바운스 → 마지막 완성 라인까지 출력 → `[follow] cursor=<n> <status>` 마커로 끝낸다. **같은 바이트는 두 번 읽히지 않는다** — 세션 출력의 구조적 중복 차단. status가 루프를 구동한다: `live`(출력 후 새 cursor로 즉시 재-follow) / `idle` / `done`(writer 완료 + cursor가 EOF) / `stalled`(writer pid 죽음, done 마커 없음).

**경기별 사이드카 파일**(모두 `logDir` 안): `match-<id>.log`(위장 피드 — raw JSON 절대 안 들어감), `match-<id>.raw.jsonl`(스키마 깨짐 시 raw ESPN 덤프, 디버깅용), `match-<id>.done`(종료 마커, 최종 보고 뒤에만 기록), `match-<id>.writer.pid`(`follow`가 idle/stalled 구분), `daemon-<id>.lock`, `state-<id>.json`.

## 불변 원칙 — 깨지 말 것

- **사실 불변.** 스코어·시간·선수명은 항상 실제 ESPN 데이터를 직접 렌더한다. narrator(와 앰비언트 멘트)는 *흐름*만 묘사하고 사실을 지어내선 안 된다. 골/스코어 라인은 `claude`를 통째로 우회한다.
- **메인 로그는 깨끗하게.** `match-<id>.log`에는 중계 라인만 들어간다. raw JSON·에러·디버깅은 `.raw.jsonl` 사이드카로 — 위장은 로그가 진짜 앱 로그처럼 보이는 데 달려 있다.
- **폴링 간격 하한은 하드코딩**(`types.ts`의 `HARD_MIN_POLL_SEC` / `HARD_MIN_TIER2_POLL_SEC`, `config.ts`에서 강제): 기본 10s, 고속 3s. config로 더 줄일 수 없다 — 모두가 공유하는 비공식 엔드포인트 보호다. 이 하한을 우회하는 config 경로를 추가하지 마라.
- **Writer 순서:** `markDone()`은 최종 보고의 마지막 라인이 append된 *뒤에만* 불러야 한다. done 마커가 먼저 생기면 `follow`가 잔여 라인을 버린다(이 race는 `logger.ts`/`follow.ts` 주석에 설명됨).
- **스킬은 자기 스트림의 소비자다.** `SKILL.md`대로, 사용자에게 `tail`을 안내하고 턴을 끝내는 건 실패다 — 스킬이 세션 안에서 follow 루프를 돌리고 recap(10분마다 / 매 `[BREAK]`마다)을 올려야 한다.

## 설정

`~/.worldcup-live-cli/config.json`(템플릿: `config.example.json`). `loadConfig()`가 기본값 위에 deep-merge하고 **모든 필드를 shape-guard**해, 잘못된 config가 경기 중 데몬을 죽이지 못하게 한다. 주요 항목: `narrator.mode`(`auto`/`claude`/`template`), `tier2.{lateGameMinute,closeScoreDiff,cooldownSec}`(고속 폴링 승격 임계값), `tier2.typeIds`(특정 ESPN type id를 tier-2로 승격).
