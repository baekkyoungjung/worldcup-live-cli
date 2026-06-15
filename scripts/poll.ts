#!/usr/bin/env tsx
import { loadConfig } from '../src/config.js';
import { runDaemon } from '../src/daemon.js';
import { fetchScoreboard } from '../src/espn.js';
import { runFollow } from '../src/follow.js';
import { runReplay } from '../src/replay.js';
import type { Language } from '../src/types.js';

/** --lang 값 정규화: ko만 ko, 그 외(미지정 포함)는 undefined → config 기본값(en) 사용 */
function parseLang(v: string | undefined): Language | undefined {
  if (v === 'ko' || v === 'en') return v;
  return undefined;
}

const USAGE = `worldcup-live-cli — watch football like you code.

사용법:
  npx tsx scripts/poll.ts list [--league <code>]          오늘 경기 목록
  npx tsx scripts/poll.ts daemon <eventId> [옵션] &        데몬 시작 (경기 종료 시 자진 종료)
  npx tsx scripts/poll.ts replay <eventId> [옵션] &        끝난 경기를 가짜 라이브로 압축 재생
  npx tsx scripts/poll.ts follow <eventId> [옵션]          새 중계 라인 long-poll 1회분
                                                          (마지막 줄 마커: [follow] cursor=<n> <status>)

옵션:
  --league <code>   리그 코드 (기본 fifa.world)
  --lang <ko|en>    중계 출력 언어 (기본 en, daemon/replay 전용)
  --config <path>   config.json 경로 (기본 ~/.worldcup-live-cli/config.json)
  --once            1 tick만 실행 (검증용, daemon 전용)
  --speed <n>       replay 압축 배율 (기본 15 — 90분 경기를 ~6분에)
  --cursor <byte>   follow 시작 위치 (직전 마커의 cursor 값, 기본 0)
  --wait <sec>      follow 새 데이터 대기 한도 (기본 60, 상한 75)

터미널에서 직접 보려면:
  tail -f ~/.worldcup-live-cli/match-<eventId>.log
`;

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };

  if (cmd === 'list') {
    const config = loadConfig(flag('config'));
    const league = flag('league') ?? config.league;
    const res = await fetchScoreboard(league);
    if (!res.ok) {
      process.stderr.write(`scoreboard 실패: ${res.error}\n`);
      return 1;
    }
    if (res.data.length === 0) {
      process.stdout.write(`오늘(${league}) 경기 없음\n`);
      return 0;
    }
    for (const e of res.data) {
      const score = e.state === 'pre' ? 'vs' : `${e.homeScore} : ${e.awayScore}`;
      process.stdout.write(
        `${e.id}  ${e.home.padEnd(4)} ${score.padStart(5)}  ${e.away.padEnd(4)} [${e.state}] ${e.detail}\n`,
      );
    }
    return 0;
  }

  if (cmd === 'follow') {
    const eventId = argv[1];
    if (!eventId || eventId.startsWith('--')) {
      process.stderr.write(USAGE);
      return 1;
    }
    await runFollow(eventId, {
      configPath: flag('config'),
      cursor: Number(flag('cursor')) || 0,
      waitSec: Number(flag('wait')) || undefined,
    });
    return 0;
  }

  if (cmd === 'daemon' || cmd === 'replay') {
    const eventId = argv[1];
    if (!eventId || eventId.startsWith('--')) {
      process.stderr.write(USAGE);
      return 1;
    }
    if (cmd === 'replay') {
      await runReplay(eventId, {
        league: flag('league'),
        language: parseLang(flag('lang')),
        configPath: flag('config'),
        speed: Number(flag('speed')) || undefined,
      });
      return Number(process.exitCode ?? 0);
    }
    await runDaemon(eventId, {
      league: flag('league'),
      language: parseLang(flag('lang')),
      configPath: flag('config'),
      once: argv.includes('--once'),
    });
    return 0;
  }

  process.stderr.write(USAGE);
  return cmd === undefined || cmd === 'help' || cmd === '--help' ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    // 마지막 안전망 — 그래도 죽어야 한다면 이유는 남긴다
    process.stderr.write(`[worldcup-live-cli] fatal: ${e?.stack ?? e}\n`);
    process.exit(1);
  });
