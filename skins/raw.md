---
name: raw
description: 위장 없는 풀 머드. 회의가 없는 날을 위해.
detect: []
wrapIndent: 8
---

# 각색 가이드

당신은 텍스트 머드 게임의 던전 마스터이자 축구 캐스터다.

- 한국어, 현재형, 최대 140자. 감각 묘사(소리, 속도, 군중)를 아끼지 않는다.
- 위장이 필요 없으니 마음껏 외쳐라. 단 이모지는 ⚽🟨🟥 등 경기 기호만.
- 스코어·시간·선수명은 입력 그대로. 입력에 없는 사실을 지어내지 않는다.

# 라인 템플릿

```ini
kickoff.fact = [{minute}] ⚽ 킥오프 — {homeTeam} vs {awayTeam} @ {venue}
halftime.fact = [{minute}] ⏸ 하프타임 — {homeAbbr} {homeScore} : {awayScore} {awayAbbr}
resume.fact = [{minute}] ⚽ 후반전 시작 — {homeAbbr} {homeScore} : {awayScore} {awayAbbr}
fulltime.fact = [{minute}] 🏁 경기 종료 — {homeAbbr} {homeScore} : {awayScore} {awayAbbr}

replay.flavor = [{minute}] 🔁 다시보기 — {desc}

goal.flavor = [{minute}] ⚽ 고오오오올! {desc}
goal.desc = {player}의 슛이 골망을 가른다
goal.fact = [{minute}] 스코어 {homeAbbr} {homeScore} : {awayScore} {awayAbbr}

penalty.flavor = [{minute}] 🎯 페널티킥! {desc}
penalty.desc = 주심의 손끝이 스팟을 가리킨다

var.flavor = [{minute}] 📺 VAR 리뷰 — {desc}
var.desc = 경기장 전체가 숨을 죽인다

red.flavor = [{minute}] 🟥 퇴장! {teamAbbr} {player} — {desc}
red.desc = 그라운드를 떠나는 발걸음이 무겁다

yellow.flavor = [{minute}] 🟨 경고 — {teamAbbr} {player}. {desc}
yellow.desc = 다음은 없다

sub.flavor = [{minute}] ↔ 교체 — {teamAbbr}. {desc}
sub.desc = 벤치가 움직인다

chance.flavor = [{minute}] ⚡ {desc}
chance.desc = 위협적인 장면, 골문이 잠시 열렸다 닫힌다

setpiece.flavor = [{minute}] ○ {desc}
setpiece.desc = 세트피스. 키커가 공을 내려놓는다

generic.flavor = [{minute}] · {desc}

report.header = ━━ 최종 전적 (match {matchId}) ━━
report.line =   {item}
report.footer = 오늘의 중계는 여기까지. 다음 경기에서 만나요. ⚽
```
