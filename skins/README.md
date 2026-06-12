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
| `goal.desc` 등 `<카테고리>.desc` | 선택 | `generic.desc` 폴백 — 각색 실패 시 쓰는 고정 묘사 |
| `penalty/var/red/yellow/sub/chance/setpiece.flavor` | 선택 | `generic.flavor` 폴백 |
| `generic.flavor` `generic.desc` | **필수** | 없으면 다수 이벤트가 통째로 생략된다 |
| `replay.flavor` | 권장 | 없으면 tier-2 사후 각색 보강 라인이 출력되지 않는다 |
| `report.header` `report.line` `report.footer` | 권장 | 없으면 경기 종료 최종 보고가 생략된다 |

카테고리: `kickoff` `halftime` `resume` `fulltime`은 **fact 전용**(flavor 없음),
나머지는 flavor(+goal만 fact 추가) 구조다.

### placeholder 전체 어휘

`{time}`(HH:MM:SS) `{matchId}` `{venue}` `{homeTeam}` `{awayTeam}` `{homeAbbr}`
`{awayAbbr}` `{homeScore}` `{awayScore}` `{minute}`("67'") `{minuteNum}`(67)
`{player}` `{teamAbbr}` `{scoringAbbr}` `{concedingAbbr}` `{scoringTeam}`
`{rawText}`(ESPN 원문) `{desc}`(각색 묘사 — flavor에 필수) `{item}`(report.line 전용)

오타 placeholder는 **빈 문자열로 무음 치환**된다. PR 전에 종료된 경기로
`npx tsx scripts/poll.ts daemon <끝난 경기 id> --config <테스트 config>` 한 번 돌려
로그를 눈으로 확인하라.

### 지켜야 할 것

- 묘사는 `{desc}` 한 칸에만. 스코어·시간·선수명 등 사실은 placeholder로만 출력한다.
- `goal.flavor`에 `{concedingAbbr}`/`{scoringTeam}`을 쓰면, 득점 팀 판별이 불가능한
  이벤트에서는 시스템이 자동으로 `generic.flavor`로 강등한다 — 틀린 팀을 찍지 않기 위함.
- 한 줄 110자 안쪽을 권장. 길면 `wrapIndent`로 줄바꿈된다.
