/**
 * AI Personality definitions.
 * Each personality affects decision weights and risk thresholds.
 */

export const PersonalityTypes = {
    RUSHER:   { name: 'Rusher',   attack: 0.9, defend: 0.1, riskThreshold: 0.75, spatialCaution: 0.8,  aimSkill: 0.7, reactionTime: 150, nearReaction: 0.3, farReaction: 1.4, suppressDuration: 2, tacticalReloadThreshold: 0.25 },
    DEFENDER: { name: 'Defender', attack: 0.3, defend: 0.9, riskThreshold: 0.45, spatialCaution: 0.25, aimSkill: 0.8, reactionTime: 180, nearReaction: 0.6, farReaction: 0.9, suppressDuration: 4, tacticalReloadThreshold: 0.50 },
    FLANKER:  { name: 'Flanker',  attack: 0.7, defend: 0.2, riskThreshold: 0.65, spatialCaution: 0.6,  aimSkill: 0.75, reactionTime: 160, nearReaction: 0.4, farReaction: 1.2, suppressDuration: 1, tacticalReloadThreshold: 0.30 },
    SUPPORT:  { name: 'Support',  attack: 0.5, defend: 0.5, riskThreshold: 0.55, spatialCaution: 0.4,  aimSkill: 0.7, reactionTime: 190, nearReaction: 0.7, farReaction: 1.1, suppressDuration: 5, tacticalReloadThreshold: 0.40 },
    SNIPER:   { name: 'Sniper',   attack: 0.4, defend: 0.6, riskThreshold: 0.50, spatialCaution: 0.3,  aimSkill: 0.9, reactionTime: 150, nearReaction: 1.4, farReaction: 0.5, suppressDuration: 3, tacticalReloadThreshold: 0.50 },
    CAPTAIN:  { name: 'Captain',  attack: 0.6, defend: 0.4, riskThreshold: 0.60, spatialCaution: 0.5,  aimSkill: 0.8, reactionTime: 170, nearReaction: 0.5, farReaction: 1.0, suppressDuration: 3, tacticalReloadThreshold: 0.40 },
};

/** Squad templates: 5 squads × 3 members per team.
 *  strategy: 'push' = prefer distant enemy flags, 'secure' = prefer nearest uncaptured flags,
 *            'raid' = hunt undefended flags, fallback to push. */
export const SquadTemplates = [
    { name: 'Alpha',   roles: ['CAPTAIN', 'SUPPORT', 'RUSHER'],  strategy: 'push' },
    { name: 'Bravo',   roles: ['CAPTAIN', 'FLANKER', 'SUPPORT'], strategy: 'secure' },
    { name: 'Charlie', roles: ['CAPTAIN', 'DEFENDER', 'SNIPER'], strategy: 'secure' },
    { name: 'Delta',   roles: ['CAPTAIN', 'RUSHER', 'FLANKER'],  strategy: 'push' },
    { name: 'Echo',    roles: ['RUSHER', 'FLANKER', 'RUSHER'],   strategy: 'raid' },
];
