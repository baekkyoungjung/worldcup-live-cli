import type { Category, Config, MatchEvent, MatchSnapshot, RawItem, Tier } from './types.js';

/**
 * tier-2 승격 휴리스틱 — 2026 조별리그 MEX-RSA(760415, plays 1,313건) 실데이터로 확정.
 * 근거는 README [내부] 메모 ① 참조.
 *
 * - 골은 변형 type(70 Goal, 137 Goal - Header, ...)으로 쪼개지므로 type.text의
 *   "Goal"/"Own Goal" prefix + 텍스트 "Goal!" 패턴으로 잡는다.
 * - VAR은 별도 id 패밀리(172 등) — "VAR" prefix 매칭.
 * - PK는 type.text의 "Penalty" 매칭 (penaltyKick 플래그는 commentary에선 null).
 */

/** "이름 (팀) 액션 at N'" 템플릿 노이즈 — 출력 스킵 (실측 63%가 Pass) */
const NOISE_TYPE_IDS = new Set([
  '118', // Pass
  '177', // Ball touch
  '176', // Out
  '63', // Clear
  '178', // Take On
  '181', // Aerial
  '148', // Tackle
  '182', // Attempted tackle
  '65', // Cross
  '196', // Dispossessed
  '179', // Interception
  '141', // Assists Shot
  '110', // Goal Kick
  '162', // Blocked Pass
  '77', // Save (템플릿 텍스트 — 유의미한 선방은 106 Shot On Target 텍스트에 실림)
  '185', // Drop of Ball
  '180', // Claim
  '78', // Assist
  '202', // Keeper Sweeper
  '195', // Punch
  '200', // Shield ball opp
  '96', // Free Kick (실행 노이즈 — 선언은 66 Foul 텍스트가 커버)
  '124', // Throw In
]);

const CHANCE_TYPE_IDS = new Set(['106', '117', '135', '136']); // 슛 온/오프/블록/골대

interface Rule {
  category: Category;
  tier: Tier;
}

function ruleFor(item: RawItem): Rule {
  const t = item.typeText;
  const text = item.text;

  // 경기 경계 — 저볼륨·고신호
  if (item.typeId === '80' || /^Kickoff$/i.test(t)) return { category: 'kickoff', tier: 2 };
  if (item.typeId === '81' || /^First Half ends/i.test(text)) return { category: 'halftime', tier: 2 };
  if (item.typeId === '82' || /^Second Half begins/i.test(text)) return { category: 'resume', tier: 2 };
  // FT 텍스트는 경기에 따라 "Match ends" 또는 "Second Half ends"로 온다 (KOR-CZE 실측)
  if (item.typeId === '83' || /^Match ends/i.test(text) || /^Second Half ends/i.test(text)) {
    return { category: 'fulltime', tier: 2 };
  }

  // 노이즈는 골 판정보다 먼저 — 110 "Goal Kick"이 /^Goal/에 잡히는 오분류 방지
  if (NOISE_TYPE_IDS.has(item.typeId)) return { category: 'generic', tier: 0 };

  // tier-2: 경기를 멈춰 세우는 사건
  if (/^Goal kick/i.test(t)) return { category: 'generic', tier: 0 }; // typeId 누락 대비 이중 방어
  if (/^Goal\b/i.test(t) || /^Own Goal/i.test(t) || /^Goal!/i.test(text) || item.scoringPlay) {
    return { category: 'goal', tier: 2 };
  }
  if (/penalty/i.test(t) || /penalty/i.test(text)) {
    // "Penalty - Scored"류는 위 Goal 매칭이 먼저 잡는다 — 여기는 선언/실축
    return { category: 'penalty', tier: 2 };
  }
  if (/^VAR/i.test(t) || /^VAR/i.test(text)) return { category: 'var', tier: 2 };
  if (item.typeId === '93' || /red card/i.test(text)) return { category: 'red', tier: 2 };

  // tier-1: 기본 흐름
  if (item.typeId === '94' || /yellow card/i.test(text)) return { category: 'yellow', tier: 1 };
  if (item.typeId === '76' || /^Substitution/i.test(text)) return { category: 'sub', tier: 1 };
  if (CHANCE_TYPE_IDS.has(item.typeId)) return { category: 'chance', tier: 1 };
  if (item.typeId === '95') return { category: 'setpiece', tier: 1 };
  if (item.typeId === '66' || item.typeId === '68' || item.typeId === '122') return { category: 'generic', tier: 1 };
  if (item.typeId === '129' || item.typeId === '130') return { category: 'generic', tier: 1 };

  // 미지의 type: 템플릿 텍스트("이름 (팀) 액션 at N'")면 노이즈, 자연어 문장이면 tier-1
  if (/\) [A-Za-z ]+ at \d+'$/.test(text)) return { category: 'generic', tier: 0 };
  return { category: 'generic', tier: 1 };
}

export function classify(item: RawItem, config: Config): MatchEvent {
  const base = ruleFor(item);
  let tier = base.tier;
  // config로 type 단위 승격 허용 (강등으로 골을 숨기는 건 의도적으로 미지원)
  if (tier === 1 && config.tier2.typeIds.includes(item.typeId)) tier = 2;
  return {
    id: item.id,
    category: base.category,
    tier,
    minuteNum: item.minuteNum,
    minute: item.minute || `${item.minuteNum}'`,
    rawText: item.text,
    typeId: item.typeId,
    typeText: item.typeText,
    player: item.player,
    teamAbbr: item.teamAbbr,
  };
}

/** 80'+ 박빙 — 상황 전체가 tier-2 (판정식은 실측 검증: clock 80'=4800s, 90'+는 5400 고정) */
export function isEndgameClose(snap: MatchSnapshot, config: Config): boolean {
  return (
    snap.state === 'in' &&
    snap.minuteNum >= config.tier2.lateGameMinute &&
    Math.abs(snap.homeScore - snap.awayScore) <= config.tier2.closeScoreDiff
  );
}
