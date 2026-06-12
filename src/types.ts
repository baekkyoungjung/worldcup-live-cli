export type Category =
  | 'kickoff'
  | 'halftime'
  | 'resume'
  | 'fulltime'
  | 'goal'
  | 'penalty'
  | 'var'
  | 'red'
  | 'yellow'
  | 'sub'
  | 'chance'
  | 'setpiece'
  | 'generic';

/** 0 = 출력 스킵(노이즈), 1 = 기본 흐름, 2 = 스트리밍 승격 */
export type Tier = 0 | 1 | 2;

export interface MatchEvent {
  id: string;
  category: Category;
  tier: Tier;
  minuteNum: number;
  minute: string; // "67'"
  rawText: string;
  typeId?: string;
  typeText?: string;
  player?: string;
  teamAbbr?: string;
  scoringAbbr?: string;
  concedingAbbr?: string;
}

export type MatchState = 'pre' | 'in' | 'post' | 'unknown';

export interface MatchSnapshot {
  matchId: string;
  state: MatchState;
  statusDetail: string; // "HT", "FT", "62'" 등
  homeTeam: string;
  awayTeam: string;
  homeAbbr: string;
  awayAbbr: string;
  homeScore: number;
  awayScore: number;
  venue: string;
  minuteNum: number;
  /** commentary(분 단위) 또는 keyEvents(빅 이벤트만) — 시간순, 분류 전 */
  items: RawItem[];
  /** commentary 없이 keyEvents만 제공되는 마이너 매치 여부 */
  keyEventsOnly: boolean;
}

/** ESPN 응답에서 최소한으로 정규화한 원본 항목. 분류(tier/category)는 tier.ts 담당 */
export interface RawItem {
  id: string;
  typeId: string;
  typeText: string;
  text: string;
  minuteNum: number;
  minute: string;
  player?: string;
  teamAbbr?: string;
  scoreValue?: number; // keyEvents의 scoringPlay 여부 판단용
  scoringPlay?: boolean;
}

export interface SkinTemplates {
  [key: string]: string; // "goal.flavor" → 템플릿 문자열
}

export interface Skin {
  name: string;
  description: string;
  detect: string[];
  wrapIndent: number;
  /** claude -p 프롬프트에 주입되는 각색 가이드 원문 */
  guide: string;
  templates: SkinTemplates;
}

export interface Config {
  skin?: string;
  league: string;
  logDir: string;
  /** 골 순간 10초 위장 해제 애니메이션 (art/goal/*.txt). false면 기존 출력과 완전 동일 */
  goalAnimation: boolean;
  pollIntervalSec: number; // 하한 10s — 코드에서 clamp
  tier2PollIntervalSec: number; // 하한 3s — 코드에서 clamp
  tier2: {
    /** tier-2로 승격할 ESPN type id 목록 (기본값은 tier.ts) */
    typeIds: string[];
    /** 이 분 이후 + 박빙이면 상황 전체를 tier-2로 */
    lateGameMinute: number;
    /** 박빙 판정 점수차 */
    closeScoreDiff: number;
    /** tier-2 이벤트 후 고속 폴링을 유지할 시간(초) — 골 전후 시퀀스 */
    cooldownSec: number;
  };
  narrator: {
    mode: 'auto' | 'claude' | 'template';
    model: string;
    /** 각색 1회 대기 한도(초). 초과 시 템플릿으로 폴백 */
    timeoutSec: number;
  };
}

export const HARD_MIN_POLL_SEC = 10;
export const HARD_MIN_TIER2_POLL_SEC = 3;
