# 스킨 작성 가이드

스킨 하나 = 마크다운 파일 하나 (`skins/<이름>.md`). PR로 보내달라.
구조는 세 부분: frontmatter, `# 각색 가이드`, `# 라인 템플릿`.

## frontmatter

```yaml
---
name: my-skin            # 스킨 이름 (config.json의 "skin" 값)
description: 한 줄 설명
detect: ["figma.config.js"]   # cwd에 이 파일이 보이면 자동 선택 (한 줄 JSON 배열)
wrapIndent: 11           # 긴 줄 줄바꿈 시 연속행 들여쓰기 칸수 (0~60으로 clamp됨)
---
```

`detect`는 **직군 고유 파일만** 넣어라. `package.json`, `*.json` 같은 범용 패턴은
다른 스킨 사용자의 자동 감지를 가로챈다 — PR 리뷰에서 반려된다. 평가 순서는
파일명 알파벳 순, 첫 매치 승. 확신이 없으면 `detect: []`로 두면 된다 (config 지정 전용).

## `# 각색 가이드` 섹션

`claude -p` 각색 프롬프트에 그대로 주입되는 페르소나 지시문. 톤, 길이 제한,
허용/금지 어휘를 산문으로 쓴다. 이 섹션이 비면 각색이 페르소나 없이 돌아간다
(데몬이 stderr로 경고한다).

## `# 라인 템플릿` 섹션

` ```ini ` 코드블록 안에 `key = 템플릿` 한 줄씩. 블록을 여러 개로 나눠도 전부 병합된다.

### 키 목록

| 키 | 필수 | 없을 때 동작 |
|----|------|-------------|
| `kickoff.fact` `halftime.fact` `resume.fact` `fulltime.fact` | 권장 | `generic.flavor`로 폴백 |
| `goal.flavor` `goal.fact` | 권장 | flavor는 `generic.flavor` 폴백, fact는 그 줄 생략 |
| `goal.desc` 등 `<카테고리>.desc` | **권장** | 각색(claude) 실패 시 쓰는 고정 묘사. **한국어로 쓸 것.** 없으면 시스템 내장 한국어 폴백(일부 type만) → 그것도 없으면 그 이벤트는 침묵 |
| `penalty/var/red/yellow/sub/chance/setpiece.flavor` | 선택 | `generic.flavor` 폴백 |
| `generic.flavor` | **필수** | 없으면 다수 이벤트가 통째로 생략된다 |
| `generic.desc` | 비권장 | 정의하면 미분류 이벤트마다 같은 고정 문구가 반복된다. **`{rawText}` 사용 금지** — ESPN 영문 원문이 위장 로그에 그대로 샌다. 비워 두면 각색 실패한 미분류 이벤트는 침묵 처리(의도된 동작) |
| `replay.flavor` | 권장 | 없으면 tier-2 사후 각색 보강 라인이 출력되지 않는다 |
| `report.header` `report.line` `report.footer` | 권장 | 없으면 경기 종료 최종 보고가 생략된다 |

카테고리: `kickoff` `halftime` `resume` `fulltime`은 **fact 전용**(flavor 없음),
나머지는 flavor(+goal만 fact 추가) 구조다.

### placeholder 전체 어휘

`{time}`(HH:MM:SS) `{matchId}` `{venue}` `{homeTeam}` `{awayTeam}` `{homeAbbr}`
`{awayAbbr}` `{homeScore}` `{awayScore}` `{minute}`("67'") `{minuteNum}`(67)
`{player}` `{teamAbbr}` `{scoringAbbr}` `{concedingAbbr}` `{scoringTeam}`
`{rawText}`(ESPN 영문 원문 — **desc/flavor에 쓰지 말 것**, 중계는 한국어가 원칙)
`{desc}`(각색 묘사 — flavor에 필수) `{item}`(report.line 전용)

오타 placeholder는 **빈 문자열로 무음 치환**된다. PR 전에 종료된 경기로
`npx tsx scripts/poll.ts daemon <끝난 경기 id> --config <테스트 config>` 한 번 돌려
로그를 눈으로 확인하라.

### 지켜야 할 것

- 묘사는 `{desc}` 한 칸에만. 스코어·시간·선수명 등 사실은 placeholder로만 출력한다.
- `goal.flavor`에 `{concedingAbbr}`/`{scoringTeam}`을 쓰면, 득점 팀 판별이 불가능한
  이벤트에서는 시스템이 자동으로 `generic.flavor`로 강등한다 — 틀린 팀을 찍지 않기 위함.
- 한 줄 110자 안쪽을 권장. 길면 `wrapIndent`로 줄바꿈된다.

---

# 골 애니메이션 아트팩 작성 가이드

골이 터지면 약 10초간 위장을 해제하고 `art/goal/*.txt`의 아트팩 하나를 골라
(여러 개면 골마다 랜덤) 프레임 단위로 로그에 append한다. 새 아트팩도 PR로 보내달라.

## 형식

파일 하나 = 애니메이션 하나. 프레임 구분은 단독 `---` 줄.

```
# `# `(해시+공백)로 시작하는 줄은 주석 — `####` 같은 해시 아트는 보존된다
#delay 450
{dim}        ●{reset}
---
#delay 400
{bold}{yellow}  ██████╗ ...{reset}
```

- `#delay <ms>`: 이 프레임 출력 후 다음 프레임까지의 간격. 50~2000ms로 clamp,
  생략 시 600ms. 전체 합이 15초를 넘으면 비례 축소된다.
- 프레임 하나에 여러 줄을 넣을 수 있다 (한 번에 append됨).
- 색 토큰: `{yellow}` `{cyan}` `{green}` `{red}` `{white}` `{dim}` `{bold}` `{reset}` —
  ANSI 코드로 치환되며, 색을 쓴 줄은 시스템이 자동으로 reset을 닫는다.
  그 외 `{...}`는 아트의 일부로 그대로 출력된다.
- 프레임 최대 40개, 한 줄 가시 폭 110자 초과분은 잘린다.

## 제약 (append-only + tail -f)

커서 제어·화면 지우기는 **불가능**하다 — 로그 파일에 append된 텍스트가 그대로
쌓이는 구조라서, '움직임'은 프레임이 순차로 나타나는 리듬과 점진 공개로만 만든다.
끝난 뒤 화면에 남는 전체 모습(누적 결과물)이 한 장의 포스터로 성립하는지도 확인하라.

- 스코어·시간 등 **사실은 넣지 않는다** — fact 라인은 시스템이 애니메이션과
  무관하게 별도로 출력한다. 아트는 순수 연출만.
- 검증: 끝난 경기로 `npx tsx scripts/poll.ts replay <id> --speed 600 --config <테스트 config>`
  한 번 돌려 `tail -f`로 눈으로 확인하라.
- 끄기: config.json에 `"goalAnimation": false`.
