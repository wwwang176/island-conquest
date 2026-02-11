/**
 * AI Personality definitions.
 * Each personality affects decision weights and risk thresholds.
 */

export const PersonalityTypes = {
    RUSHER:   { name: 'Rusher',   attack: 0.9, defend: 0.1, riskThreshold: 0.75, aimSkill: 0.7, reactionTime: 150, suppressDuration: 2 },
    DEFENDER: { name: 'Defender', attack: 0.2, defend: 0.9, riskThreshold: 0.45, aimSkill: 0.8, reactionTime: 200, suppressDuration: 4 },
    FLANKER:  { name: 'Flanker',  attack: 0.7, defend: 0.2, riskThreshold: 0.65, aimSkill: 0.75, reactionTime: 180, suppressDuration: 1 },
    SUPPORT:  { name: 'Support',  attack: 0.5, defend: 0.5, riskThreshold: 0.55, aimSkill: 0.7, reactionTime: 200, suppressDuration: 5 },
    SNIPER:   { name: 'Sniper',   attack: 0.4, defend: 0.6, riskThreshold: 0.50, aimSkill: 0.9, reactionTime: 250, suppressDuration: 3 },
    CAPTAIN:  { name: 'Captain',  attack: 0.6, defend: 0.4, riskThreshold: 0.60, aimSkill: 0.8, reactionTime: 180, suppressDuration: 3 },
};

/** Squad templates: 4 squads × 3 members per team. */
export const SquadTemplates = [
    { name: 'Alpha',   roles: ['CAPTAIN', 'SUPPORT', 'RUSHER'] },
    { name: 'Bravo',   roles: ['CAPTAIN', 'FLANKER', 'SUPPORT'] },
    { name: 'Charlie', roles: ['CAPTAIN', 'DEFENDER', 'SNIPER'] },
    { name: 'Delta',   roles: ['CAPTAIN', 'RUSHER', 'FLANKER'] },
];
