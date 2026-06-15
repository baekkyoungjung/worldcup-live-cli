export type Category =
  | 'kickoff'
  | 'halftime'
  | 'resume'
  | 'fulltime'
  | 'break' // 수분 휴식 / 쿨링 브레이크
  | 'goal'
  | 'penalty'
  | 'var'
  | 'red'
  | 'yellow'
  | 'sub'
  | 'chance'
  | 'setpiece'
  | 'generic';

/** 0 = 출력 스킵(노이즈), 1 = 기본 흐름, 2 = 고속 폴링 승격(위험 상황) */
export type Tier = 0 | 1 | 2;

/**
 * 중계 라인의 위험도. 로거 prefix와 색/이모지를 결정한다.
 *  log      일반 흐름(중원 경합 등)
 *  warn     세트피스·위험지역 전개 (노란색 / 🟡)
 *  error    박스 안 위험·슛·PK (빨간색 / 🔴)
 *  critical 골 (빨간색 / 🟥)
 */
export type Severity = 'log' | 'warn' | 'error' | 'critical';

export interface MatchEvent {
  id: string;
  category: Category;
  tier: Tier;
  severity: Severity;
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

/** 중계 출력 언어. 지원 외 언어는 'en'으로 폴백한다 */
export type Language = 'ko' | 'en';

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

/** ESPN 응답에서 최소한으로 정규화한 원본 항목. 분류(tier/severity/category)는 tier.ts 담당 */
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

export interface Config {
  league: string;
  logDir: string;
  /** 중계 출력 언어. 스킬이 --lang으로 주입, 미지정 시 기본 'en' */
  language: Language;
  pollIntervalSec: number; // 하한 10s — 코드에서 clamp
  tier2PollIntervalSec: number; // 하한 3s — 코드에서 clamp
  /** 이벤트 없는 구간에서 앰비언트 멘트를 흘리는 최소 간격(초). 정적을 없앤다 */
  ambientIntervalSec: number;
  tier2: {
    /** 고속 폴링(tier-2)로 승격할 ESPN type id 목록 (기본값은 tier.ts) */
    typeIds: string[];
    /** 이 분 이후 + 박빙이면 상황 전체를 고속 폴링으로 */
    lateGameMinute: number;
    /** 박빙 판정 점수차 */
    closeScoreDiff: number;
    /** 위험 이벤트 후 고속 폴링을 유지할 시간(초) */
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
