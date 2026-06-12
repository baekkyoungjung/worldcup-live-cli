#!/usr/bin/env tsx
import { loadConfig } from '../src/config.js';
import { runDaemon } from '../src/daemon.js';
import { fetchScoreboard } from '../src/espn.js';

const USAGE = `e2e-monitor — 전반전부터 후반전까지, 당신의 터미널은 일하고 있었습니다.

사용법:
  npx tsx scripts/poll.ts list [--league <code>]          오늘 경기 목록
  npx tsx scripts/poll.ts daemon <eventId> [옵션] &        데몬 시작 (경기 종료 시 자진 종료)

옵션:
  --league <code>   리그 코드 (기본 fifa.world)
  --config <path>   config.json 경로 (기본 ~/.e2e-monitor/config.json)
  --once            1 tick만 실행 (검증용)

중계 켜기:
  tail -f ~/.e2e-monitor/match-<eventId>.log
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

  if (cmd === 'daemon') {
    const eventId = argv[1];
    if (!eventId || eventId.startsWith('--')) {
      process.stderr.write(USAGE);
      return 1;
    }
    await runDaemon(eventId, {
      league: flag('league'),
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
    process.stderr.write(`[e2e-monitor] fatal: ${e?.stack ?? e}\n`);
    process.exit(1);
  });
