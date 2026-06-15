# 중계 언어 선택 (en/ko) — 설계

날짜: 2026-06-15
상태: 승인 대기

## 문제

중계 텍스트가 한국어로 하드코딩돼 있다. 사용자의 대화 언어에 따라 중계가 그 언어로 나가게 한다. 지원 언어는 **`ko`, `en` 둘**, 미지원 언어는 `en`으로 폴백한다.

## 배경 — 현재 텍스트가 만들어지는 두 경로

중계 텍스트는 **백그라운드 데몬이 생성**하고 세션은 그대로 중계만 한다(세션은 번역하지 않음). 데몬의 텍스트 출처는 둘:

1. **각색(LLM, `narrate.ts`)** — ESPN 영문 raw를 haiku가 **로깅 스타일 한 줄 멘트로 재작성**. `STYLE_GUIDE` 프롬프트가 "한국어로 써라 + severity가 톤을 정한다"를 지시. 직역이 아니라 로깅 중계로 재작성한다.
2. **정적 템플릿(`render.ts`)** — `골!`, `킥오프`, 앰비언트 멘트, 최종 보고, 카테고리 폴백 등 하드코딩 한국어 ~50개. LLM 미경유(즉시·결정적).

따라서 다국어화는 **두 경로를 데몬 레벨에서** 각각 처리한다.

## 결정 사항 (확정)

- 지원: `ko`, `en`. 미지원 → `en`.
- **두 언어 모두 로깅 스타일 각색.** haiku가 영문 raw를 대상 언어 로깅 멘트로 재작성(직역 아님, severity별 톤). 영어도 raw 패스스루가 아니라 영어 로깅 멘트로 재작성.
- 정적 템플릿은 **코드 내장 정적 테이블**(`STRINGS_KO` / `STRINGS_EN`). 런타임 LLM 의존 없음. claude 부재 시 각 언어 템플릿으로 폴백 → 현재(한국어 폴백만)보다 견고.
- 사실 불변 유지: 스코어·시간·선수명은 항상 raw 데이터에서 직접 렌더, claude 미경유.

## 설계

### 1. 언어 결정 및 전달
- **스킬(SKILL.md)**: 대화 언어 감지 → 한국어면 `ko`, 그 외 `en` → `daemon`/`replay` 시작 시 `--lang ko|en` 전달.
- **`follow`**: 바이트 중계라 언어 무관(변경 없음).
- **recap**: 세션 모델이 사용자 언어로 작성. SKILL.md의 한국어 고정 예시를 언어 중립 지시로 교체.
- **config (`types.ts`/`config.ts`)**: `language: 'ko' | 'en'` 필드 추가, shape-guard(미지원 값 → `en`), 기본값 `en`. CLI `--lang`이 config보다 우선.
- **CLI (`scripts/poll.ts`)**: `--lang` 플래그 파싱 → `daemon`/`replay` 옵션으로 전달. USAGE에 추가.

### 2. 각색 경로 (`narrate.ts`)
- `Narrator`가 언어를 안다(config.language 또는 생성자 인자).
- `STYLE_GUIDE`를 언어 파라미터화: 동일 규칙(로깅 스타일, severity 톤, 고유명사 보존, 사실 불변)을 대상 언어로 작성하라는 지시. `ko`는 현행과 동일, `en`은 영어판.
- 출력 언어 = 대상 언어. 실패·timeout 시 null → 호출부가 대상 언어 템플릿 폴백.

### 3. 템플릿 경로 (`render.ts`)
- 하드코딩 한국어를 `Strings` 인터페이스로 추출:
  - `ambientPool: string[]`
  - 경기 경계 라벨: kickoff(home/away/venue), resume, fulltime, halftime, break
  - `goalPrefix` (`골!` / `GOAL!`)
  - 카테고리 폴백(penalty/var/red/yellow/sub/chance/setpiece) + `descByType` + generic 폴백
  - 최종 보고 header/footer + 카테고리 라벨(labelOf)
  - 보조 문구(예: "공격 팀" 기본값)
- `STRINGS_KO`(현행 문자열 이전) + `STRINGS_EN`(신규 작성, 자연스러운 영어 로깅 문체).
- 언어 텍스트를 만드는 함수(`renderEventLines`, `renderAmbient`, `renderFinalReport`)가 `Strings`를 인자로 받는다(또는 `Renderer`가 보유). `formatLine`/`formatCue`/`parseScoreFromGoalText`는 언어 중립이라 변경 없음.

### 4. 배선 (`daemon.ts` / `replay.ts`)
- opts/config에서 `lang` 해석 → `STRINGS_KO|EN` 선택 + `Narrator`에 언어 주입.
- 선택한 `Strings`를 렌더 호출에 전달.

## 영향 범위
- 변경: `types.ts`, `config.ts`, `scripts/poll.ts`, `narrate.ts`, `render.ts`, `daemon.ts`, `replay.ts`, `skills/worldcup-live-cli/SKILL.md`, `config.example.json`.
- 빌드: `npm run build` 후 `dist/poll.mjs` 커밋(설치자는 번들만 받음).

## 검증
- `npm run typecheck` 통과.
- `node dist/poll.mjs replay <eventId> --lang en` / `--lang ko`로 끝난 경기 재생 → 각 언어 로깅 라인 + 템플릿(킥오프/골/최종보고) 확인.
- claude 없는 환경 시뮬레이션(narrator.mode=template)에서 양 언어 템플릿 폴백 출력 확인.

## 비범위 (YAGNI)
- ja/zh 등 추가 언어, 런타임 언어팩 생성, 중국어 변형 — 모두 제외.
