import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HARD_MIN_POLL_SEC, HARD_MIN_TIER2_POLL_SEC, type Config } from './types.js';

export const CONFIG_DIR = path.join(os.homedir(), '.worldcup-live-cli');

const DEFAULTS: Config = {
  league: 'fifa.world',
  logDir: CONFIG_DIR,
  pollIntervalSec: 10,
  tier2PollIntervalSec: 3,
  ambientIntervalSec: 10,
  tier2: {
    typeIds: [],
    lateGameMinute: 80,
    closeScoreDiff: 1,
    cooldownSec: 120,
  },
  narrator: {
    mode: 'auto',
    model: 'haiku',
    timeoutSec: 25,
  },
};

export function loadConfig(configPath?: string): Config {
  const file = configPath ?? path.join(CONFIG_DIR, 'config.json');
  let user: Partial<Config> = {};
  if (fs.existsSync(file)) {
    try {
      user = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      process.stderr.write(`[worldcup-live-cli] config 파싱 실패(${e}) — 기본값 사용\n`);
    }
  }
  const merged: Config = {
    ...DEFAULTS,
    ...user,
    tier2: { ...DEFAULTS.tier2, ...(user.tier2 ?? {}) },
    narrator: { ...DEFAULTS.narrator, ...(user.narrator ?? {}) },
  };
  // 폴링 하한은 코드 고정 — 설정으로 더 줄일 수 없다 (비공식 API 보호. README "점잖게 쓰자")
  merged.pollIntervalSec = Math.max(HARD_MIN_POLL_SEC, Number(merged.pollIntervalSec) || HARD_MIN_POLL_SEC);
  merged.tier2PollIntervalSec = Math.max(
    HARD_MIN_TIER2_POLL_SEC,
    Number(merged.tier2PollIntervalSec) || HARD_MIN_TIER2_POLL_SEC,
  );
  // 앰비언트 간격: 3초 하한(고속 폴링 중에도 멘트가 도배되지 않게)
  merged.ambientIntervalSec = Math.max(3, finiteOr(merged.ambientIntervalSec, DEFAULTS.ambientIntervalSec));
  // 나머지 사용자 입력도 모양을 보장한다 — 잘못된 config로 경기 중에 죽지 않는다
  merged.tier2.typeIds = Array.isArray(merged.tier2.typeIds) ? merged.tier2.typeIds.map(String) : [];
  merged.tier2.lateGameMinute = finiteOr(merged.tier2.lateGameMinute, DEFAULTS.tier2.lateGameMinute);
  merged.tier2.closeScoreDiff = finiteOr(merged.tier2.closeScoreDiff, DEFAULTS.tier2.closeScoreDiff);
  merged.tier2.cooldownSec = finiteOr(merged.tier2.cooldownSec, DEFAULTS.tier2.cooldownSec);
  merged.narrator.timeoutSec = Math.max(5, finiteOr(merged.narrator.timeoutSec, DEFAULTS.narrator.timeoutSec));
  if (!['auto', 'claude', 'template'].includes(merged.narrator.mode)) merged.narrator.mode = 'auto';
  merged.narrator.model = typeof merged.narrator.model === 'string' ? merged.narrator.model : DEFAULTS.narrator.model;
  merged.league = typeof merged.league === 'string' && merged.league ? merged.league : DEFAULTS.league;
  merged.logDir = expandHome(typeof merged.logDir === 'string' && merged.logDir ? merged.logDir : DEFAULTS.logDir);
  return merged;
}

function finiteOr(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function expandHome(p: string): string {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}
