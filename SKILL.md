---
name: e2e-monitor
description: >
  월드컵 경기를 직군 산출물로 위장한 머드 게임풍 텍스트 중계로 흘려보내는
  백그라운드 데몬을 관리한다. "모니터 돌려줘", "중계 시작", "경기 어떻게 돼가",
  "오늘 경기 뭐 있어", "중계 꺼줘" 등 경기 모니터링 요청 시 사용.
---

# e2e-monitor

데몬이 ESPN 비공식 API를 폴링해 `~/.e2e-monitor/match-<eventId>.log`에 위장 중계를
append한다. 소비는 `tail -f` 하나로 끝난다. 이 스킬은 그 데몬의 시작/상태/종료만 돕는다.

## 명령

이 스킬 디렉토리(레포 루트) 기준으로 실행한다.

```bash
# 오늘 경기 목록 (eventId 확인)
npx tsx scripts/poll.ts list

# 데몬 시작 — 반드시 백그라운드로. 경기가 끝나면 최종 보고를 남기고 스스로 종료한다
npx tsx scripts/poll.ts daemon <eventId> &

# 중계 화면 = tail (사용자에게 이 명령을 안내)
tail -f ~/.e2e-monitor/match-<eventId>.log
```

## 요청별 처리

- **"오늘 경기 뭐 있어" / "모니터 돌려줘"**: `list` 실행 → 사용자가 경기를 고르면
  daemon을 백그라운드로 시작하고 `tail -f` 명령 한 줄을 안내한다.
- **"경기 어떻게 돼가"**: 로그 파일 마지막 20줄을 읽고 스코어·최근 상황을 한두 문장으로
  요약한다. 데몬 프로세스가 살아있는지(`pgrep -f "poll.ts daemon"`)도 확인.
- **"중계 꺼줘"**: `pkill -f "poll.ts daemon <eventId>"` 후 로그 파일 경로를 알려준다.
- **데몬이 안 떠 있는데 상태를 물으면**: 로그 파일이 있으면 그걸로 답하고, 없으면
  list부터 제안한다.

## 주의

- 폴링 간격 하한(10s / tier-2 3s)은 코드에 고정 — 설정으로 더 줄일 수 없고, 줄이려
  하지 마라. 비공식 엔드포인트 보호가 모두의 이익이다.
- API 장애 시 데몬은 죽지 않고 `match-<eventId>.raw.jsonl` 사이드카에 raw를 남긴다.
  디버깅 요청이 오면 그 파일을 본다.
- `claude` CLI가 없는 환경에서도 템플릿 폴백으로 동작한다 — narrator 에러는 치명이 아니다.
