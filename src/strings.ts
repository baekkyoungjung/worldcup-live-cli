import type { Category, Language } from './types.js';

/**
 * 언어별 정적 문자열 테이블. 각색(claude) 경로 밖의 모든 텍스트 —
 * 앰비언트 멘트·경기 경계 라벨·골/최종보고 템플릿·각색 폴백·요약 라벨 — 이 여기 모인다.
 *
 * 사실 불변: 스코어·시간·선수명 같은 raw 값은 호출부(render.ts)가 끼워 넣고,
 * 이 테이블은 그 주변 '말'만 담는다. 런타임 LLM 의존 없음 → claude가 없어도 양 언어가 산다.
 */
export interface Strings {
  /** 이벤트 없는 구간의 흐름 멘트 — 사실(스코어·시간)은 절대 담지 않는다 */
  ambientPool: string[];

  // 경기 경계
  kickoff: (home: string, away: string, venueSuffix: string) => string;
  resume: string;
  fulltime: string;
  halftime: string; // [BREAK] 큐
  breakCue: string; // 수분 휴식 [BREAK] 큐

  // 골 — who는 호출부가 "득점자 — " 또는 "" 로 조립해 넘긴다
  goal: (who: string, homeAbbr: string, home: number, away: number, awayAbbr: string) => string;

  /** 각색(claude)이 없을 때의 카테고리별 폴백. team(t)/상대(opp)는 호출부가 채운다 */
  attackingDefault: string; // team 미상일 때의 주어
  fallback: {
    penalty: (t: string) => string;
    var: string;
    red: (t: string) => string;
    yellow: (t: string) => string;
    sub: (t: string) => string;
    chance: (t: string, opp: string) => string;
    setpiece: (t: string) => string;
    generic: string;
  };
  /** generic 카테고리 최후 폴백 — ESPN typeId 기준 */
  descByType: Record<string, string>;

  // 최종 보고
  finalHeader: (homeTeam: string, home: number, away: number, awayTeam: string) => string;
  finalFooter: string;
  /** 최종 보고 하이라이트 라벨 (labelOf) */
  labels: Partial<Record<Category, string>>;
  labelDefault: string;
}

const KO: Strings = {
  ambientPool: [
    '중원에서 양 팀이 볼을 주고받습니다',
    '후방에서 천천히 빌드업을 가져갑니다',
    '측면을 활용한 전개를 시도합니다',
    '중앙 경합 — 소유권이 오갑니다',
    '템포를 늦추며 기회를 엿봅니다',
    '미드필드 싸움이 팽팽합니다',
    '롱볼로 전선을 끌어올립니다',
    '점유율 싸움이 이어집니다',
    '수비 라인을 정비하며 간격을 좁힙니다',
    '볼이 좌우로 분배됩니다',
    '전방 압박 수위를 끌어올립니다',
    '느린 호흡으로 경기를 운영합니다',
    '전방 압박에 패스가 끊깁니다',
    '백패스로 다시 빌드업을 시작합니다',
    '중원에서 인터셉트를 노립니다',
    '사이드라인을 따라 공이 흐릅니다',
  ],
  kickoff: (home, away, venueSuffix) => `킥오프 — ${home} vs ${away}${venueSuffix}`,
  resume: '후반전 시작',
  fulltime: '경기 종료 — 풀타임 휘슬',
  halftime: '전반 종료 — 잠시 후 후반전',
  breakCue: '수분 휴식 — 잠시 숨을 고릅니다',
  goal: (who, homeAbbr, home, away, awayAbbr) => `골! ${who}${homeAbbr} ${home} : ${away} ${awayAbbr}`,
  attackingDefault: '공격 팀',
  fallback: {
    penalty: (t) => `페널티킥 상황! ${t} 키커가 준비합니다`,
    var: 'VAR 판독이 진행됩니다',
    red: (t) => `${t} 레드카드 — 수적 변화가 생깁니다`,
    yellow: (t) => `${t} 옐로카드`,
    sub: (t) => `${t} 선수 교체`,
    chance: (t, opp) => (opp ? `${t}의 슛! ${opp} 골문을 위협합니다` : `슛 — 골문을 위협합니다`),
    setpiece: (t) => `${t} 세트피스 기회`,
    generic: '경기가 이어집니다',
  },
  descByType: {
    '66': '파울 — 흐름이 잠시 끊깁니다',
    '68': '오프사이드 — 공격이 멈춥니다',
    '122': '핸드볼 선언',
    '129': '경기가 잠시 멈춥니다',
    '130': '경기가 잠시 멈춥니다',
  },
  finalHeader: (homeTeam, home, away, awayTeam) => `── 최종 보고 ── ${homeTeam} ${home} : ${away} ${awayTeam}`,
  finalFooter: '경기 종료. 수고하셨습니다.',
  labels: {
    goal: '득점',
    red: '퇴장',
    penalty: 'PK',
    yellow: '경고',
    var: 'VAR',
    sub: '교체',
    chance: '기회',
    setpiece: '세트피스',
  },
  labelDefault: '기록',
};

const EN: Strings = {
  ambientPool: [
    'Both sides trade passes in midfield',
    'Patient build-up from the back',
    'They work it down the flank',
    'A midfield battle — possession swings',
    'The tempo drops as they probe for an opening',
    'A tight contest in the middle of the park',
    'A long ball pushes the line higher',
    'The possession battle goes on',
    'The back line tightens its shape',
    'The ball is switched from side to side',
    'They ramp up the press',
    'A slow, measured spell of control',
    'The press cuts out the pass',
    'Back to the keeper to restart the build-up',
    'Looking to intercept in midfield',
    'The ball rolls along the sideline',
  ],
  kickoff: (home, away, venueSuffix) => `Kick-off — ${home} vs ${away}${venueSuffix}`,
  resume: 'Second half under way',
  fulltime: 'Full time — the final whistle',
  halftime: 'Half-time — second half to follow shortly',
  breakCue: 'Water break — a moment to catch breath',
  goal: (who, homeAbbr, home, away, awayAbbr) => `GOAL! ${who}${homeAbbr} ${home} : ${away} ${awayAbbr}`,
  attackingDefault: 'the attacking side',
  fallback: {
    penalty: (t) => `Penalty! ${t} ready to take it`,
    var: 'VAR check under way',
    red: (t) => `${t} red card — down a player`,
    yellow: (t) => `${t} booked`,
    sub: (t) => `${t} substitution`,
    chance: (t, opp) => (opp ? `${t} shoot! Threatening the ${opp} goal` : 'A shot — threatening the goal'),
    setpiece: (t) => `${t} set-piece chance`,
    generic: 'Play continues',
  },
  descByType: {
    '66': 'Foul — the flow is broken',
    '68': 'Offside — the attack is halted',
    '122': 'Handball given',
    '129': 'A brief stoppage',
    '130': 'A brief stoppage',
  },
  finalHeader: (homeTeam, home, away, awayTeam) => `── Full-time report ── ${homeTeam} ${home} : ${away} ${awayTeam}`,
  finalFooter: 'Match over. Thanks for watching.',
  labels: {
    goal: 'Goal',
    red: 'Red',
    penalty: 'PK',
    yellow: 'Booking',
    var: 'VAR',
    sub: 'Sub',
    chance: 'Chance',
    setpiece: 'Set-piece',
  },
  labelDefault: 'Note',
};

const TABLE: Record<Language, Strings> = { ko: KO, en: EN };

export function stringsFor(lang: Language): Strings {
  return TABLE[lang] ?? EN;
}
