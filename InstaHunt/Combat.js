const PveEncounter = invoke('GameServer/Bot/Population/ColdPveEncounter');
const ProgressionRates = invoke('GameServer/ProgressionRates');
const BackgroundDropResolver = invoke('GameServer/Bot/Population/BackgroundDropResolver');
const DataCache = invoke('GameServer/DataCache');
const Formulas = invoke('GameServer/Formulas');
const C4SkillRules = invoke('GameServer/Skills/C4SkillRules');
const ColdCombatProfile = invoke('GameServer/Bot/Population/ColdCombatProfile');
const ColdClassPolicy = invoke('GameServer/Bot/Population/ColdClassPolicy');
const BotRoles = invoke('GameServer/Bot/AI/BotRoles');
const ChargeLifecycle = invoke('GameServer/Skills/ChargeLifecycle');
const HealingPotionStock = invoke('GameServer/Bot/AI/HealingPotionStock');
const BotHuntingGroundPolicy = invoke('GameServer/Bot/AI/BotHuntingGroundPolicy');
const TargetMatchup = invoke('GameServer/Bot/AI/BotTargetMatchup');
const EncounterReadiness = invoke('GameServer/Bot/AI/BotEncounterReadiness');
const PartyBuffLoadout = invoke('GameServer/Bot/AI/PartyBuffLoadout');

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function randInt(rng, min, max) {
    return Math.floor(rng() * (max - min + 1)) + min;
}

function midpointBand(levelBand) {
    if (!levelBand) return 1;
    const parts = String(levelBand).split('-').map((value) => Number(value));
    if (parts.length < 2 || !Number.isFinite(parts[0]) || !Number.isFinite(parts[1])) return Number(parts[0]) || 1;
    return Math.round((parts[0] + parts[1]) / 2);
}

function botCombatStats(state, timestamp = Date.now()) {
    return ColdCombatProfile.profileFor(state, timestamp);
}

function combatRoleForState(state) {
    if (BotRoles.isSpoiler(state)) return 'spoiler';
    const persistedRole = state?.party?.role || state?.stats?.role;
    return persistedRole === 'crafter'
        ? BotRoles.combatRoleFor(state)
        : persistedRole || BotRoles.combatRoleFor(state);
}

const ELEMENTAL_DAMAGE_TRAITS = new Set(['fire', 'water', 'wind', 'earth', 'holy', 'dark']);
const PHYSICAL_RACE_STATS = Object.freeze({
    animal: 'pAtk-animals',
    beast: 'pAtk-monsters',
    construct: 'pAtk-mcreatures',
    dragon: 'pAtk-dragons',
    giant: 'pAtk-giants',
    insect: 'pAtk-insects',
    plant: 'pAtk-plants'
});

function mobVulnerability(mob, stat) {
    const value = Number(mob?.vulnerabilities?.[stat]);
    return Number.isFinite(value) ? Math.max(0, value) : 1;
}

function coldWeaponVulnerability(bot, mob, semantic = {}) {
    const kind = String(bot?.equipment?.weaponKind || '');
    if (semantic.trait === 'bow' || kind === 'Weapon.Bow') return mobVulnerability(mob, 'bowWpnVuln');
    if (kind === 'Weapon.Blunt' || kind === 'Weapon.BigBlunt') return mobVulnerability(mob, 'bluntWpnVuln');
    if (semantic.trait === 'dagger' || kind === 'Weapon.Knife') return mobVulnerability(mob, 'daggerWpnVuln');
    return 1;
}

function coldPhysicalTargetModifier(bot, mob, semantic = {}, timestamp = Date.now()) {
    let modifier = coldWeaponVulnerability(bot, mob, semantic);
    if (mob?.undead === true) modifier *= ColdCombatProfile.statMultiplier(bot, 'pAtkUndeadMul', timestamp);
    const raceStat = PHYSICAL_RACE_STATS[String(mob?.race || '').toLowerCase()];
    if (raceStat) modifier *= ColdCombatProfile.statMultiplier(bot, raceStat, timestamp);
    return modifier;
}

function coldMagicTargetModifier(mob, semantic = {}) {
    return ELEMENTAL_DAMAGE_TRAITS.has(semantic.trait)
        ? mobVulnerability(mob, `${semantic.trait}Vuln`)
        : 1;
}

function coldNpcWeaponModifier(mob, target, timestamp = Date.now()) {
    const kind = String(mob?.weaponKind || '');
    if (kind === 'Weapon.Bow') return ColdCombatProfile.statMultiplier(target, 'bowWpnVuln', timestamp);
    if (kind === 'Weapon.Blunt' || kind === 'Weapon.BigBlunt') {
        return ColdCombatProfile.statMultiplier(target, 'bluntWpnVuln', timestamp);
    }
    return 1;
}

function coldChargeState(state, timestamp) {
    const coldCombat = state.stats?.coldCombat || {};
    const expiresAt = Number(coldCombat.chargeExpiresAt) || 0;
    return expiresAt > timestamp
        ? { charges: Math.max(0, Number(coldCombat.charges) || 0), chargeExpiresAt: expiresAt }
        : { charges: 0, chargeExpiresAt: null };
}

function expireCharges(holder, timestamp) {
    if (holder.chargeExpiresAt && holder.chargeExpiresAt <= timestamp) {
        holder.charges = 0;
        holder.chargeExpiresAt = null;
    }
}

function addCharges(holder, amount, maximum, timestamp) {
    const previous = Math.max(0, Number(holder.charges) || 0);
    const maxCharges = Math.max(1, Number(maximum) || 1);
    holder.charges = Math.min(maxCharges, previous + Math.max(0, Number(amount) || 0));
    if (previous === 0 && holder.charges > 0) {
        holder.chargeExpiresAt = timestamp + ChargeLifecycle.EXPIRY_MS;
    }
}

function consumeCharges(holder, amount) {
    holder.charges = Math.max(0, Number(holder.charges) - Math.max(0, Number(amount) || 0));
    if (holder.charges === 0) holder.chargeExpiresAt = null;
}

function coldPassiveRegenAdd(state, skillId, stat) {
    const classId = Number(state.stats?.classId ?? state.classId);
    const skill = (DataCache.skillTree || []).find((tree) => Number(tree.classId) === classId)?.skills
        ?.find((entry) => Number(entry.selfId) === skillId);
    const level = Number(state.level || midpointBand(state.levelBand));
    const skillLevel = (skill?.levels || [])
        .filter((entry) => Number(entry.pLevel) <= level)
        .reduce((highest, entry) => Math.max(highest, Number(entry.level) || 0), 0);
    if (!skillLevel) return 0;

    return Number(C4SkillRules.resolve({ selfId: skillId, level: skillLevel }).stats?.[stat]) || 0;
}

function coldRestRegenPerTick(state, options = {}) {
    const level = Math.max(1, Number(state.level || midpointBand(state.levelBand)) || 1);
    const classId = Number(state.stats?.classId ?? state.classId);
    const profile=botCombatStats(state);
    const con=Math.max(1,(Number(profile.base?.con) || 1)+ColdCombatProfile.statAdd(profile,'CON',Date.now()));
    const men=Math.max(1,(Number(profile.base?.men) || 1)+ColdCombatProfile.statAdd(profile,'MEN',Date.now()));
    const hpBase = Number(DataCache.revitalize?.hp?.[level]) || 0;
    const mpBase = Number(DataCache.revitalize?.mp?.[level]) || 0;
    const hp = ((hpBase * Formulas.calcLevelMod(level) * Formulas.calcBaseMod.CON(con)
        * ColdCombatProfile.statMultiplier(profile,'regHp',Date.now()) * ColdCombatProfile.statMultiplier(profile,'regHpMul',Date.now()))
        + ColdCombatProfile.statAdd(profile,'regHpAdd',Date.now())) * 1.5;
    const mp = ((mpBase * Formulas.calcLevelMod(level) * Formulas.calcBaseMod.MEN(men)
        * ColdCombatProfile.statMultiplier(profile,'regMp',Date.now()) * ColdCombatProfile.statMultiplier(profile,'regMpMul',Date.now()))
        + ColdCombatProfile.statAdd(profile,'regMpAdd',Date.now())) * 1.5;

    return { hp: Math.max(0, hp) * (options.hpMultiplier || 1), mp: Math.max(0, mp) * (options.mpMultiplier || 1) };
}

function requiresManaRecovery(state, options = {}) {
    if (typeof options.requireMana === 'boolean') return options.requireMana;
    return options.party === true
        ? BotRoles.needsPartyManaRecovery(state)
        : BotRoles.shouldRestForMana(state);
}

function needsRest(state, vitals, options = {}) {
    const hpRatio = Number(vitals?.hp ?? 0) / Math.max(1, Number(vitals?.maxHp ?? vitals?.hp ?? 1));
    const mpRatio = Number(vitals?.mp ?? 0) / Math.max(1, Number(vitals?.maxMp ?? vitals?.mp ?? 1));
    return hpRatio < Number(options.hpThreshold ?? 0.35)
        || (requiresManaRecovery(state, options) && mpRatio < Number(options.mpThreshold ?? 0.20));
}

function estimateRestMs(state, vitals, options = {}) {
    const maxHp = Number(vitals.maxHp || vitals.hp || 1);
    const maxMp = Number(vitals.maxMp || vitals.mp || 1);
    const missingHp = Math.max(0, maxHp - Number(vitals.hp || 0));
    const missingMp = Math.max(0, maxMp - Number(vitals.mp || 0));
    const regen = coldRestRegenPerTick(state, options);
    const hpSeconds = missingHp / Math.max(0.01, regen.hp / 3);
    const mpSeconds = requiresManaRecovery(state, options)
        ? missingMp / Math.max(0.01, regen.mp / 3)
        : 0;

    return Math.round(Math.max(hpSeconds, mpSeconds, 8) * 1000);
}

function applyStandingRegen(state, sourceVitals, elapsedMs, timestamp = Date.now()) {
    const combat = botCombatStats(state, timestamp);
    const vitals = {
        hp: Math.max(0, Number(sourceVitals?.hp ?? combat.maxHp)),
        maxHp: combat.maxHp,
        mp: Math.max(0, Number(sourceVitals?.mp ?? combat.maxMp)),
        maxMp: combat.maxMp
    };
    const sitting = coldRestRegenPerTick(state);
    const ticks = Math.max(0, Number(elapsedMs) || 0) / 3000;
    vitals.hp = Math.min(vitals.maxHp, vitals.hp + (sitting.hp / 1.5) * ticks);
    vitals.mp = Math.min(vitals.maxMp, vitals.mp + (sitting.mp / 1.5) * ticks);
    return vitals;
}

function resolveRest(state, elapsedMs, timestamp, options = {}) {
    const combat = botCombatStats(state, timestamp);
    const vitals = {
        hp: Math.max(0, Number(state.vitals?.hp || 0)),
        maxHp: combat.maxHp,
        mp: Math.max(0, Number(state.vitals?.mp || 0)),
        maxMp: combat.maxMp
    };
    const regen = coldRestRegenPerTick(state, options);
    const ticks = Math.max(0, Number(elapsedMs) || 0) / 3000;
    vitals.hp = Math.min(vitals.maxHp, vitals.hp + regen.hp * ticks);
    vitals.mp = Math.min(vitals.maxMp, vitals.mp + regen.mp * ticks);

    const hpReady = vitals.hp / Math.max(1, vitals.maxHp) >= 0.95;
    const requireMana = requiresManaRecovery(state, options);
    const mpReady = !requireMana || vitals.mp / Math.max(1, vitals.maxMp) >= 0.95;
    const recoveryNeeded = !hpReady || !mpReady;
    const scheduledRemainingMs = recoveryNeeded && requireMana
        ? Math.max(0, Number(state.stats?.restUntil || 0) - timestamp)
        : 0;
    const remainingMs = recoveryNeeded
        ? Math.max(estimateRestMs(state, vitals, options), scheduledRemainingMs)
        : 0;
    const resting = recoveryNeeded;
    const restUntil = resting ? timestamp + remainingMs : null;

    return {
        patch: {
            activity: resting ? 'resting' : 'hunting',
            vitals,
            stats: { ...(state.stats || {}), restUntil }
        },
        events: resting ? [] : [{
            type: 'recovered',
            summary: `${state.name || 'Bot'} finished recovering and returned to hunting`,
            weight: 1
        }],
        materialize: { exp: 0, sp: 0, adena: 0, items: [] },
        nextResolveAt: resting ? restUntil : timestamp + 30000,
        debug: { activity: resting ? 'resting' : 'recovered', regen, remainingMs, requireMana }
    };
}

function resolveTravel(state, timestamp = Date.now()) {
    const travel = state.stats?.travel;
    if (!travel?.to || !travel?.arrivalAt) return null;
    const isLegacyGiranMarketTrip = travel.townName === 'Giran'
        && ['market_sale_inventory', 'market_search_for_weapon', 'market_search_for_gear'].includes(travel.reason)
        && travel.method !== 'soe_gatekeeper';
    const nativeTransit = ['soe_gatekeeper', 'gatekeeper_spot'].includes(travel.method)
        || ['component_craft', 'component_craft_return', 'equipment_craft', 'equipment_craft_return', 'dual_sword_combine', 'dual_sword_combine_return', 'return_after_market'].includes(travel.reason);
    const startedAt = Number(travel.startedAt || timestamp);
    const arrivalAt = Number(travel.arrivalAt);
    const progress = isLegacyGiranMarketTrip ? 1 : nativeTransit
        ? (timestamp >= arrivalAt ? 1 : 0)
        : Math.max(0, Math.min(1, (timestamp - startedAt) / Math.max(1, arrivalAt - startedAt)));
    const from = travel.from || state.loc || {};
    const to = travel.to;
    const loc = {
        locX: Math.round(Number(from.locX || 0) + (Number(to.locX || 0) - Number(from.locX || 0)) * progress),
        locY: Math.round(Number(from.locY || 0) + (Number(to.locY || 0) - Number(from.locY || 0)) * progress),
        locZ: Math.round(Number(from.locZ || 0) + (Number(to.locZ || 0) - Number(from.locZ || 0)) * progress)
    };
    const arrived = progress >= 1;
    const arrivalActivity = travel.arrivalActivity || 'shopping';
    const nextStats = { ...(state.stats || {}), travel: arrived ? null : travel };
    if (arrived && travel.clearMarketReturn) nextStats.marketReturn = null;
    return {
        patch: {
            activity: arrived ? arrivalActivity : 'traveling',
            loc,
            currentRegion: arrived ? travel.regionName || travel.townName || state.currentRegion : state.currentRegion,
            spotId: arrived && travel.spotId ? travel.spotId : state.spotId,
            stats: nextStats
        },
        events: arrived ? [{
            type: travel.arrivalEvent || (arrivalActivity === 'crafting' ? 'arrived_craft_station' : 'arrived_town'),
            summary: travel.method === 'walk'
                ? `${state.name || 'Bot'} reached ${travel.regionName || 'the hunting area'} on foot`
                : arrivalActivity === 'shopping'
                ? `${state.name || 'Bot'} used SoE via ${travel.viaTown || 'town'} and reached ${travel.townName || 'town'} to shop`
                : arrivalActivity === 'crafting'
                    ? `${state.name || 'Bot'} arrived at ${travel.stationId || 'a Giran craft station'} via SoE and gatekeeper`
                    : `${state.name || 'Bot'} reached ${travel.regionName || 'the hunting area'} via gatekeeper`,
            weight: 2,
            meta: { townName: travel.townName || null, stationId: travel.stationId || null, reason: travel.reason || null }
        }] : [],
        materialize: { exp: 0, sp: 0, adena: 0, items: [] },
        nextResolveAt: arrived && ['shopping', 'crafting'].includes(arrivalActivity)
            ? timestamp
            : arrived ? timestamp + 30000 : arrivalAt,
        debug: { activity: 'traveling', arrived, progress, townName: travel.townName || null, arrivalActivity }
    };
}

function staleShopping(state) {
    return state?.activity === 'shopping'
        && !state.stats?.marketReturn
        && !state.stats?.supplyErrand
        && state.currentRegion !== 'Giran';
}

function resolveDeathRecovery(state, timestamp = Date.now()) {
    const pvpRecovery = Number(state.stats?.coldPvp?.recoverUntil || 0);
    if (pvpRecovery > timestamp) return { patch: {}, events: [],
        materialize: { exp: 0, sp: 0, adena: 0, items: [] }, nextResolveAt: pvpRecovery,
        debug: { activity: 'dead', reason: 'pvp_recovery' } };
    const combat = botCombatStats(state, timestamp);
    const respawnDelayMs = pvpRecovery ? 1000 : 90000;

    return {
        patch: {
            activity: 'resting',
            clearDeathExperience: 'restart_to_town',
            vitals: {
                hp: combat.maxHp,
                maxHp: combat.maxHp,
                mp: combat.maxMp,
                maxMp: combat.maxMp
            },
            stats: {
                ...(state.stats || {}),
                lastRespawnAt: timestamp,
                ...(pvpRecovery ? { coldPvp: { ...state.stats.coldPvp, recoverUntil: 0, flagUntil: 0 } } : {}),
                restUntil: timestamp + respawnDelayMs,
                coldCombat: {
                    ...(state.stats?.coldCombat || {}),
                    ...(pvpRecovery ? { cp: combat.maxCp, cpAt: timestamp, effects: [] } : {}),
                    charges: 0,
                    chargeExpiresAt: null,
                    summon: null
                }
            }
        },
        events: [{
            type: 'respawn',
            summary: `${state.name || 'Bot'} recovered after dying near ${state.currentRegion || 'the hunting area'}`,
            weight: 2,
            meta: { spotId: state.spotId || null }
        }],
        materialize: { exp: 0, sp: 0, adena: 0, items: [] },
        nextResolveAt: timestamp + respawnDelayMs,
        debug: { activity: 'respawning', respawnDelayMs }
    };
}

function hitSucceeds(accuracy, evasion, rng) {
    const chance = clamp((80 + (2 * (Number(accuracy) - Number(evasion)))) / 100, 0.2, 0.98);
    return rng() < chance;
}

function actionDelayMs(profile, skill = null) {
    if (skill?.spell) {
        return Math.max(250, Formulas.calcRemoteAtkTime(Math.max(1, Number(skill.hitTime) || 1000), profile.castSpd));
    }
    if (skill) {
        return Math.max(250, Formulas.calcRemoteAtkTime(Math.max(1, Number(skill.hitTime) || 600), profile.atkSpd));
    }
    if (profile.equipment?.weaponKind === 'Weapon.Bow') {
        return Math.max(250,Formulas.calcBowAttackTimes(profile.atkSpd,profile.equipment.attackReuseDelay ?? 1500,ColdCombatProfile.statMultiplier(profile,'atkReuseMul',Date.now())).cycleMs);
    }
    return Math.max(250, Formulas.calcMeleeAtkTime(profile.atkSpd));
}

function effectiveSkillPower(profile, skill, hp) {
    const basePower = Number(skill?.power) || 0;
    return C4SkillRules.resolve(skill || {}).skillType === C4SkillRules.FATAL
        ? Formulas.calcFatalPower(basePower, hp, profile.maxHp)
        : basePower;
}

function chooseSkill(profile, hp, mp, cooldowns, time, charges = 0, rng, context = {}) {
    const selected=ColdClassPolicy.select(profile,{hp,mp,cooldowns,time,charges,...context});
    return selected?{...selected,power:effectiveSkillPower(profile,selected.skill,hp)}:null;
}

function chooseChargeSkill(profile, mp, cooldowns, time, charges = 0, context = {}) {
    return ColdClassPolicy.select(profile,{hp:profile.maxHp,mp,cooldowns,time,charges,...context,prepare:true});
}

function coldRaidControlCapacity(fighters = [], mob = {}) {
    const minionCount = Math.max(0, Number(mob.raidMinionCount || 0));
    if (!minionCount) return 0;
    const controllers = fighters.filter((fighter) => (fighter.profile?.skills || []).some((skill) => {
        if (skill.passive || Number(skill.mp || 0) > Number(fighter.vitals?.mp || 0)) return false;
        const semantic = C4SkillRules.resolve(skill);
        const effect = String(semantic.effect || '').toLowerCase();
        return semantic.effectType === 'debuff' && /sleep|root|stun/.test(effect);
    })).length;
    return Math.min(minionCount, controllers);
}

function coldRaidMinionPressure(mob = {}, mobHp = 0, controlCapacity = 0) {
    const count = Math.max(0, Number(mob.raidMinionCount || 0));
    const minionHp = Math.max(0, Number(mob.raidMinionHp || 0));
    if (!count || !minionHp) return { activeMinions: 0, uncontrolledMinions: 0, pAtk: 0 };
    const bossHp = Math.max(0, Number(mob.raidBossMaxHp || (Number(mob.maxHp || 0) - minionHp)));
    const remainingMinionHp = Math.max(0, Math.min(minionHp, Number(mobHp || 0) - bossHp));
    const activeMinions = remainingMinionHp > 0
        ? Math.max(1, Math.ceil(count * remainingMinionHp / minionHp))
        : 0;
    const uncontrolledMinions = Math.max(0, activeMinions - Math.max(0, Number(controlCapacity || 0)));
    return {
        activeMinions,
        uncontrolledMinions,
        pAtk: Math.round(Math.max(0, Number(mob.raidMinionPAtk || 0)) * uncontrolledMinions / Math.max(1, count))
    };
}

function coldRaidEncounterProfile(pending, spot = {}, targetNpcId = 0) {
    const storedMob = pending?.mob;
    const storedHp = Number(pending?.hp);
    if (!storedMob || storedMob.raidBossMaxHp != null) {
        return { mob: storedMob || null, hp: Number.isFinite(storedHp) ? storedHp : null, upgraded: false };
    }
    const bossId = Number(storedMob.selfId || targetNpcId || 0);
    const current = ColdCombatProfile.npcForSpot(spot, () => 1, {
        preferredNpcId: bossId,
        allowRaid: true,
        aggressiveInterruptionChance: 0
    });
    if (!current || current.avoided || Number(current.selfId || 0) !== bossId
        || current.raidBossMaxHp == null) {
        return { mob: storedMob, hp: Number.isFinite(storedHp) ? storedHp : null, upgraded: false };
    }
    const oldMaxHp = Math.max(1, Number(storedMob.maxHp || 1));
    const hpRatio = Number.isFinite(storedHp) ? clamp(storedHp / oldMaxHp, 0, 1) : 1;
    return {
        mob: { ...storedMob, ...current },
        hp: Number(current.maxHp || oldMaxHp) * hpRatio,
        upgraded: true
    };
}

function activeMusicEffectForSkill(profile, skill, timestamp) {
    const skillId = Number(skill.selfId) || 0;
    const semantic = C4SkillRules.resolve(skill);
    return (profile.effects || []).some((effect) => (
        effect
        && effect.type !== 'debuff'
        && effect.toggle !== true
        && (!effect.expiresAt || Number(effect.expiresAt) > timestamp)
        && (Number(effect.id) === skillId || effect.key === semantic.effect)
    ));
}

function actorLocation(state = {}) {
    return state.loc || state.location || state;
}

function withinSkillRadius(source, target, semantic) {
    const radius = Math.max(0, Number(semantic.radius) || 0);
    if (!radius) return true;
    const sourceLoc = actorLocation(source.state);
    const targetLoc = actorLocation(target.state);
    const coordinates = ['locX', 'locY'].map((key) => [Number(sourceLoc?.[key]), Number(targetLoc?.[key])]);
    if (coordinates.some(([from, to]) => !Number.isFinite(from) || !Number.isFinite(to))) return true;
    const dx = coordinates[0][0] - coordinates[0][1];
    const dy = coordinates[1][0] - coordinates[1][1];
    return (dx * dx) + (dy * dy) <= radius * radius;
}

function chooseMusicAction(provider, targets, timestamp) {
    const skill = ColdCombatProfile.partyMusicSkills(provider.profile)
        .map((candidate) => {
            const semantic = C4SkillRules.resolve(candidate);
            const affected = targets.filter((target) => target.vitals.hp > 0
                && withinSkillRadius(provider, target, semantic)
                && !activeMusicEffectForSkill(target.profile, candidate, timestamp));
            return {
                skill: candidate,
                affected,
                cost: ColdCombatProfile.partyMusicMpCost(provider.profile, candidate, timestamp)
            };
        })
        .filter((candidate) => candidate.cost <= provider.vitals.mp && candidate.affected.length > 0)
        .sort((a, b) => Number(a.skill.selfId) - Number(b.skill.selfId))[0];
    return skill || null;
}

function replaceMusicEffect(effects, nextEffect) {
    return [
        ...(effects || []).filter((effect) => Number(effect.id) !== Number(nextEffect.id) && effect.key !== nextEffect.key),
        nextEffect
    ];
}

function refreshFighterProfile(fighter, effects, timestamp) {
    const coldCombat = {
        ...(fighter.state.stats?.coldCombat || {}),
        classId: fighter.profile.classId,
        skills: fighter.profile.skills,
        effects
    };
    fighter.state = {
        ...fighter.state,
        stats: { ...(fighter.state.stats || {}), coldCombat }
    };
    const hp = fighter.vitals.hp;
    const mp = fighter.vitals.mp;
    fighter.profile = botCombatStats(fighter.state, timestamp);
    fighter.vitals.maxHp = fighter.profile.maxHp;
    fighter.vitals.maxMp = fighter.profile.maxMp;
    fighter.vitals.hp = Math.min(hp, fighter.vitals.maxHp);
    fighter.vitals.mp = Math.min(mp, fighter.vitals.maxMp);
}

function applyMusicAction(provider, action, timestamp) {
    if (!action?.affected?.length) return 0;
    const effect = ColdCombatProfile.partyMusicEffect(action.skill, timestamp);
    const semantic = C4SkillRules.resolve(action.skill);
    const targets = action.affected.length === 1 && action.affected[0] === provider
        ? action.affected
        : [provider, ...action.affected.filter((target) => target !== provider)];
    targets.filter((target) => target.vitals.hp > 0 && withinSkillRadius(provider, target, semantic))
        .forEach((target) => refreshFighterProfile(target, replaceMusicEffect(target.profile.effects, effect), timestamp));
    return action.cost;
}

function coldBuffSkill(skill) {
    const semantic = C4SkillRules.resolve(skill || {});
    const skillType = String(semantic.skillType || '');
    const durationMs = Math.max(0, Number(semantic.durationMs ?? skill?.buffTime) || 0);
    return skill && skill.passive !== true
        && semantic.effectType === 'buff'
        && ['friendly', 'ally', 'party'].includes(semantic.target)
        && semantic.isDance !== true
        && !['hot', 'healHot', 'manaHot'].includes(skillType)
        && !['kiss_of_eva'].includes(String(semantic.effect || '').toLowerCase())
        && durationMs >= 60000;
}

function coldSkillAdapter(record) {
    const semantic = C4SkillRules.resolve(record || {});
    return {
        coldRecord: record,
        fetchSelfId: () => Number(record?.selfId || 0),
        fetchLevel: () => Number(record?.level || 1),
        fetchPassive: () => record?.passive === true,
        fetchConsumedMp: () => Math.max(0, Number(record?.mp || 0)),
        fetchBuffTime: () => Math.max(0, Number(semantic.durationMs ?? record?.buffTime) || 0),
        fetchSemantic: () => semantic,
        fetchSkillType: () => semantic.skillType,
        fetchTargetKind: () => semantic.target
    };
}

function coldBuffActor(fighter) {
    const weaponKind = String(fighter.profile?.equipment?.weaponKind || '');
    const weapon = weaponKind ? {
        fetchKind: () => weaponKind,
        fetchName: () => '',
        fetchPAtk: () => Number(fighter.profile?.equipment?.pAtk || 0),
        fetchMAtk: () => Number(fighter.profile?.equipment?.mAtk || 0)
    } : null;
    return {
        fighter,
        classId: fighter.profile.classId,
        level: fighter.profile.level,
        fetchId: () => Number(fighter.state.characterId || 0),
        fetchClassId: () => Number(fighter.profile.classId || 0),
        fetchLevel: () => Number(fighter.profile.level || 1),
        fetchHp: () => Number(fighter.vitals.hp || 0),
        fetchMaxHp: () => Number(fighter.vitals.maxHp || 1),
        isDead: () => Number(fighter.vitals.hp || 0) <= 0,
        backpack: {
            fetchItems: () => [],
            fetchEquippedWeapon: () => weapon,
            fetchTotalWeaponKind: () => weaponKind
        }
    };
}

function coldBuffEffect(skill, timestamp) {
    const record = skill.coldRecord || {};
    const semantic = skill.fetchSemantic();
    const skillId = Number(skill.fetchSelfId() || 0);
    const durationMs = Math.max(60000, Number(semantic.durationMs ?? record.buffTime) || 1200000);
    const key = PartyBuffLoadout.normalize(semantic.effect || `skill_${skillId}`);
    return {
        key,
        id: skillId,
        name: semantic.effect || `Skill ${skillId}`,
        level: Number(skill.fetchLevel() || 1),
        type: 'buff',
        durationMs,
        expiresAt: timestamp + durationMs,
        stackFamily: semantic.stackFamily || PartyBuffLoadout.family(key),
        stackOrder: semantic.stackOrder ?? null,
        stats: { ...(semantic.stats || {}) }
    };
}

function replaceColdBuff(effects, nextEffect) {
    const family = PartyBuffLoadout.family(nextEffect.key);
    return [
        ...(effects || []).filter((effect) => (
            PartyBuffLoadout.family(effect?.key) !== family
            && (!nextEffect.stackFamily || effect?.stackFamily !== nextEffect.stackFamily)
        )),
        nextEffect
    ];
}

function raidPreparationFighters(members, timestamp) {
    return members.map((state) => {
        const fighterState = mutableCombatState(state);
        const profile = botCombatStats(fighterState, timestamp);
        const active = (profile.effects || []).filter((effect) => !effect?.expiresAt || Number(effect.expiresAt) > timestamp);
        const chargeState = coldChargeState(fighterState, timestamp);
        const fighter = {
            state: fighterState,
            profile,
            role: combatRoleForState(fighterState),
            vitals: {
                hp: Math.min(profile.maxHp, Math.max(0, Number(state.vitals?.hp ?? profile.maxHp))),
                maxHp: profile.maxHp,
                mp: Math.min(profile.maxMp, Math.max(0, Number(state.vitals?.mp ?? profile.maxMp))),
                maxMp: profile.maxMp
            },
            cooldowns: { ...(state.stats?.coldCombat?.cooldowns || {}) },
            readyAt: 0,
            charges: chargeState.charges,
            chargeExpiresAt: chargeState.chargeExpiresAt,
            summonUses: 0,
            summonActions: 0,
            summonReadyAt: Number.POSITIVE_INFINITY,
            potionsUsed: 0,
            potionHot: null,
            now: timestamp
        };
        refreshFighterProfile(fighter, active, timestamp);
        return fighter;
    });
}

function coldBuffPlan(fighters, timestamp) {
    const actors = fighters.map(coldBuffActor);
    const skillCache = new Map();
    const skills = (actor) => {
        if (!skillCache.has(actor)) {
            skillCache.set(actor, (actor.fighter.profile.skills || [])
                .filter(coldBuffSkill)
                .map(coldSkillAdapter));
        }
        return skillCache.get(actor);
    };
    const chosen = PartyBuffLoadout.build(
        actors.map((actor) => ({ actor })),
        actors,
        {},
        {
            skills,
            recipients: (_members, _provider, skill) => (
                ['party', 'ally'].includes(skill.fetchSemantic().target) ? actors : []
            ),
            isAura: (skill) => ['party', 'ally'].includes(skill.fetchSemantic().target),
            effects: (actor) => (actor.fighter.profile.effects || [])
                .filter((effect) => !effect?.expiresAt || Number(effect.expiresAt) > timestamp),
            useful: (actor, skill, _provider, context) => PartyBuffLoadout.useful(actor, skill, context)
        }
    ).chosen;
    return chosen.filter((action) => {
        const semantic = action.skill.fetchSemantic();
        const key = PartyBuffLoadout.normalize(semantic.effect);
        const family = PartyBuffLoadout.family(key);
        const level = Number(action.skill.fetchLevel() || 1);
        const durationMs = Math.max(60000, Number(semantic.durationMs ?? action.skill.fetchBuffTime()) || 1200000);
        const threshold = Math.min(120000, Math.floor(durationMs * 0.25));
        return action.beneficiaries.some((actor) => !(actor.fighter.profile.effects || []).some((effect) => (
            (Number(effect?.id || 0) === Number(action.skill.fetchSelfId())
                || PartyBuffLoadout.family(effect?.key) === family)
            && Number(effect?.level || 0) >= level
            && (!effect?.expiresAt || Number(effect.expiresAt) - timestamp > threshold)
        )));
    });
}

function prepareRaidParty(members, timestamp = Date.now()) {
    const fighters = raidPreparationFighters(members, timestamp);
    let buffCasts = 0;
    let musicCasts = 0;
    let summonCasts = 0;
    let chargeCasts = 0;
    let durationMs = 0;

    for (const action of coldBuffPlan(fighters, timestamp)) {
        const provider = action.provider.fighter;
        const cost = Math.max(0, Number(action.skill.fetchConsumedMp() || 0));
        if (provider.vitals.mp < cost) continue;
        const effect = coldBuffEffect(action.skill, timestamp + durationMs);
        action.recipients.forEach((actor) => {
            const target = actor.fighter;
            refreshFighterProfile(target, replaceColdBuff(target.profile.effects, effect), timestamp + durationMs);
        });
        provider.vitals.mp = Math.max(0, provider.vitals.mp - cost);
        provider.cooldowns[action.skill.fetchSelfId()] = timestamp + durationMs
            + Math.max(0, Number(action.skill.coldRecord?.reuse || 0));
        durationMs += actionDelayMs(provider.profile, action.skill.coldRecord);
        buffCasts += 1;
    }

    for (const fighter of fighters) {
        let action = chooseMusicAction(fighter, fighters, timestamp + durationMs);
        while (action && fighter.vitals.mp >= action.cost && musicCasts < 32) {
            applyMusicAction(fighter, action, timestamp + durationMs);
            fighter.vitals.mp = Math.max(0, fighter.vitals.mp - action.cost);
            fighter.cooldowns[action.skill.selfId] = timestamp + durationMs + Math.max(0, Number(action.skill.reuse || 0));
            durationMs += actionDelayMs(fighter.profile, action.skill);
            musicCasts += 1;
            action = chooseMusicAction(fighter, fighters, timestamp + durationMs);
        }
        const beforeSummon = Number(fighter.summonUses || 0);
        ensureColdSummon(fighter, timestamp + durationMs, fighter.cooldowns);
        if (Number(fighter.summonUses || 0) > beforeSummon) {
            summonCasts += 1;
            durationMs = Math.max(durationMs, Number(fighter.readyAt || 0));
        }
        for (let attempts = 0; attempts < 8; attempts += 1) {
            const charge = chooseChargeSkill(fighter.profile, fighter.vitals.mp, fighter.cooldowns,
                timestamp + durationMs, fighter.charges, { party: true, summon: fighter.summon });
            if (!charge || Number(charge.mp || 0) > fighter.vitals.mp) break;
            const semantic = C4SkillRules.resolve(charge);
            addCharges(fighter, 1, semantic.maxCharges, timestamp + durationMs);
            fighter.vitals.mp = Math.max(0, fighter.vitals.mp - Number(charge.mp || 0));
            fighter.cooldowns[charge.selfId] = timestamp + durationMs + Math.max(0, Number(charge.reuse || 0));
            durationMs += actionDelayMs(fighter.profile, charge);
            chargeCasts += 1;
        }
    }

    const remainingBuffs = coldBuffPlan(fighters, timestamp + durationMs).length;
    const remainingMusic = fighters.reduce((count, fighter) => (
        count + (chooseMusicAction(fighter, fighters, timestamp + durationMs) ? 1 : 0)
    ), 0);
    const ready = remainingBuffs === 0 && remainingMusic === 0;
    const restUntil = ready ? null : timestamp + Math.max(...fighters.map((fighter) => (
        estimateRestMs(fighter.state, fighter.vitals, { party: true, requireMana: true })
    )));
    const casts = buffCasts + musicCasts + summonCasts + chargeCasts;
    const memberResults = fighters.map((fighter) => ({
        state: fighter.state,
        result: {
            patch: {
                activity: ready ? 'grouped' : 'resting',
                vitals: { ...fighter.vitals },
                stats: {
                    ...(fighter.state.stats || {}),
                    restUntil,
                    coldCombat: {
                        ...(fighter.state.stats?.coldCombat || {}),
                        classId: fighter.profile.classId,
                        skills: fighter.profile.skills,
                        effects: fighter.profile.effects || [],
                        cooldowns: fighter.cooldowns,
                        charges: fighter.charges || 0,
                        chargeExpiresAt: fighter.chargeExpiresAt || null,
                        summon: fighter.summon || null
                    }
                }
            },
            events: [],
            memoryEvents: [],
            materialize: { exp: 0, sp: 0, adena: 0, items: [] },
            nextResolveAt: restUntil || timestamp + Math.max(3000, durationMs),
            debug: { reason: ready ? 'raid_prepared' : 'raid_preparing', buffCasts, musicCasts, summonCasts, chargeCasts }
        }
    }));
    return {
        ready,
        needsRest: !ready,
        casts,
        buffCasts,
        musicCasts,
        summonCasts,
        chargeCasts,
        remainingBuffs,
        remainingMusic,
        durationMs,
        restUntil,
        memberResults,
        nextResolveAt: restUntil || timestamp + Math.max(3000, durationMs)
    };
}

function mutableCombatState(state = {}) {
    return {
        ...state,
        inventory: Object.fromEntries(Object.entries(state.inventory || {}).map(([key, item]) => [key, { ...item }])),
        stats: {
            ...(state.stats || {}),
            coldCombat: { ...(state.stats?.coldCombat || {}),
                effects: (state.stats?.coldCombat?.effects || []).map(effect => ({ ...effect,
                    ...(effect.hot ? { hot: { ...effect.hot } } : {}) })) }
        }
    };
}

function applyColdPotionTicks(fighter, time) {
    const hot = fighter?.potionHot;
    if (!hot) return 0;
    let healed = 0;
    while (hot.remaining > 0 && hot.nextAt <= time) {
        const before = fighter.vitals.hp;
        fighter.vitals.hp = Math.min(fighter.vitals.maxHp, fighter.vitals.hp + hot.heal);
        healed += fighter.vitals.hp - before;
        hot.remaining -= 1;
        hot.nextAt += hot.intervalMs;
    }
    if (hot.remaining <= 0) fighter.potionHot = null;
    return healed;
}

function startColdPotion(fighter, time) {
    if (!fighter.state.instaHunt?.potions) return false;
    if (!fighter || fighter.potionsUsed > 0 || fighter.potionHot) return null;
    const potion = HealingPotionStock.consumeColdPotion(
        fighter.state.inventory,
        fighter.vitals.hp,
        fighter.vitals.maxHp,
        fighter.state
    );
    if (!potion) return null;
    const effect = HealingPotionStock.coldEffectFor(potion, time);
    fighter.vitals.hp = Math.min(fighter.vitals.maxHp, fighter.vitals.hp + Number(effect.immediateHeal || 0));
    fighter.potionHot = effect.hot;
    fighter.potionsUsed = Number(fighter.potionsUsed || 0) + 1;
    return potion;
}

function summonNpcStats(fighter, details) {
    return invoke('GameServer/Bot/Population/ColdSummonProfile')(fighter.profile, details);
}

function persistedSummon(fighter, timestamp) {
    const saved = fighter.state.stats?.coldCombat?.summon;
    if (!saved?.active || Number(saved.expiresAt || 0) <= timestamp) return null;
    const skill = (fighter.profile.skills || []).find((candidate) => Number(candidate.selfId) === Number(saved.skillId));
    const details = ColdCombatProfile.summonDetails(skill || saved);
    const npcStats = summonNpcStats(fighter, details);
    const savedHp = Number(saved.hp || 0);
    return {
        ...saved,
        ...npcStats,
        skillId: Number(saved.skillId || skill?.selfId || 0),
        expiresAt: Number(saved.expiresAt),
        hp: Math.min(npcStats.maxHp, Math.max(1, savedHp || npcStats.maxHp)),
        maxHp: npcStats.maxHp
    };
}

function setPersistedSummon(fighter, summon) {
    fighter.state = {
        ...fighter.state,
        stats: {
            ...(fighter.state.stats || {}),
            coldCombat: {
                ...(fighter.state.stats?.coldCombat || {}),
                summon: summon || null
            }
        }
    };
}

function summonAttackDelay(summon) {
    return Math.max(250, Formulas.calcMeleeAtkTime(Number(summon?.atkSpd) || 253));
}

function startColdSummon(fighter, timestamp, cooldowns, skills = ColdCombatProfile.summonSkills(fighter.profile)) {
    const skill = skills.find((candidate) => (
        Number(cooldowns[candidate.selfId] || 0) <= timestamp
        && Number(candidate.mp || 0) <= fighter.vitals.mp
    ));
    if (!skill) return false;

    const details = ColdCombatProfile.summonDetails(skill);
    fighter.vitals.mp = Math.max(0, fighter.vitals.mp - Number(skill.mp || 0));
    const totalLifeTime = Math.max(30000, Number(details.totalLifeTime || 1200000));
    const summon = {
        ...summonNpcStats(fighter, details),
        active: true,
        skillId: Number(skill.selfId),
        expiresAt: timestamp + totalLifeTime
    };
    setPersistedSummon(fighter, summon);
    fighter.summon = summon;
    fighter.summonUses = Number(fighter.summonUses || 0) + 1;
    cooldowns[skill.selfId] = timestamp + Math.max(0, Number(skill.reuse || 0));
    fighter.readyAt = Number(fighter.readyAt || 0) + actionDelayMs(fighter.profile, skill);
    fighter.summonReadyAt = fighter.readyAt + summonAttackDelay(summon);
    return true;
}

function startColdCorpseSummon(fighter, timestamp, cooldowns) {
    if (!BotRoles.isNecromancer(fighter.profile?.classId) || fighter.summon) return false;
    const persisted = persistedSummon(fighter, timestamp);
    if (persisted) {
        const sameActiveSummon = fighter.summon?.active === true
            && Number(fighter.summon.skillId) === Number(persisted.skillId)
            && Number(fighter.summon.expiresAt) === Number(persisted.expiresAt);
        fighter.summon = persisted;
        if (!sameActiveSummon) {
            fighter.summonReadyAt = Number(fighter.readyAt || 0) + summonAttackDelay(persisted);
        }
        return false;
    }
    return startColdSummon(
        fighter,
        timestamp,
        cooldowns,
        ColdCombatProfile.corpseSummonSkills(fighter.profile)
    );
}

function ensureColdSummon(fighter, timestamp, cooldowns) {
    const existing = persistedSummon(fighter, timestamp);
    if (existing) {
        const sameActiveSummon = fighter.summon?.active === true
            && Number(fighter.summon.skillId) === Number(existing.skillId)
            && Number(fighter.summon.expiresAt) === Number(existing.expiresAt);
        fighter.summon = existing;
        if (!sameActiveSummon) {
            fighter.summonReadyAt = Number(fighter.readyAt || 0) + summonAttackDelay(existing);
        }
        return false;
    }
    if (fighter.state.stats?.coldCombat?.summon?.active) setPersistedSummon(fighter, null);
    fighter.summon = null;
    return startColdSummon(fighter, timestamp, cooldowns);
}

function summonDamage(fighter, mob, rng) {
    const summon = fighter.summon;
    if (!summon?.active || Number(summon.expiresAt || 0) <= Number(fighter.now || 0)) return 0;
    if (!hitSucceeds(summon.accur, mob.evasion, rng)) return 0;
    return Math.max(0, Formulas.calcPhysicalDamage(
        summon.pAtk,
        summon.pAtkRnd,
        mob.pDef,
        0,
        { critical: Formulas.rollCritical(summon.critical, rng) }
    ));
}

function resolveFight({ state, spot, pressure, targetNpcId = 0, rng, timestamp = Date.now(), fightLimitMs = 12000, maxActions = 48 }) {
    const fightState = mutableCombatState(state);
    let bot = botCombatStats(fightState, timestamp);
    const encounterKey = PveEncounter.key([state], spot, targetNpcId);
    const pending = PveEncounter.read(state.stats?.pveEncounter, encounterKey, timestamp);
    const template = DataCache.npcs.find(entry => Number(entry.selfId) === Number(targetNpcId));
    if (!template) throw new Error('Monster template is unavailable.');
    const mob = pending?.mob || { ...ColdCombatProfile.npcCombatStats(template), selfId: Number(template.selfId) };
    if (mob.avoided) return { avoided: true, reason: mob.reason };
    if (!pending && !mob.aggressiveInterruption) {
        const readiness = EncounterReadiness.evaluate({
            hp: state.vitals?.hp ?? bot.maxHp, maxHp: bot.maxHp,
            mp: state.vitals?.mp ?? bot.maxMp, maxMp: bot.maxMp, level: bot.level,
            manaDependent: BotRoles.shouldRestForMana(state)
        }, mob);
        if (!readiness.ready) {
            return { avoided: true, needsRest: true, reason: 'solo_recovery_needed' };
        }
    }
    const vitals = {
        hp: Number(state.vitals?.hp ?? bot.maxHp),
        mp: Number(state.vitals?.mp ?? bot.maxMp),
        maxHp: bot.maxHp,
        maxMp: bot.maxMp
    };
    const soloFighter = {
        state: fightState,
        profile: bot,
        role: BotRoles.combatRoleFor(fightState),
        vitals,
        readyAt: 0,
        summonReadyAt: Number.POSITIVE_INFINITY,
        summonUses: 0,
        summonActions: 0,
        now: timestamp,
        potionsUsed: 0,
        potionHot: null
    };
    let botReadyAt = Number(pending?.botReadyAt || 0);
    let mobReadyAt = Number(pending?.mobReadyAt || 0);
    let time = 0;
    let mobHp = pending?.hp ?? mob.maxHp;
    let actions = 0;
    let skillUses = 0;
    let shotActions = 0;
    let resourceReason = '';
    let heals = 0;
    let musicUses = 0;
    let summonUses = 0;
    let summonActions = 0;
    let overhitContext = null;
    const chargeState = coldChargeState(state, timestamp);
    let charges = chargeState.charges;
    let chargeExpiresAt = chargeState.chargeExpiresAt;
    const cooldowns = { ...(state.stats?.coldCombat?.cooldowns || {}) };

    while (vitals.hp > 0 && mobHp > 0 && time < fightLimitMs && actions < maxActions) {
        const summonReadyAt = soloFighter.summon?.active
            ? Number(soloFighter.summonReadyAt)
            : Number.POSITIVE_INFINITY;
        const summonActs = summonReadyAt <= botReadyAt && summonReadyAt <= mobReadyAt;
        const botActs = !summonActs && botReadyAt <= mobReadyAt;
        time = summonActs ? summonReadyAt : botActs ? botReadyAt : mobReadyAt;
        if (time >= fightLimitMs) {
            time = fightLimitMs;
            break;
        }
        applyColdPotionTicks(soloFighter, time);
        applyPartyHotTicks(soloFighter, timestamp + time);
        actions += 1;

        if (summonActs) {
            soloFighter.now = timestamp + time;
            if (Number(soloFighter.summon.expiresAt || 0) <= soloFighter.now) {
                setPersistedSummon(soloFighter, null);
                soloFighter.summon = null;
                soloFighter.summonReadyAt = Number.POSITIVE_INFINITY;
                continue;
            }
            mobHp -= summonDamage(soloFighter, mob, rng);
            summonActions += 1;
            soloFighter.summonActions += 1;
            soloFighter.summonReadyAt = time + summonAttackDelay(soloFighter.summon);
            if (mobHp <= 0) break;
        }
        else if (botActs) {
            soloFighter.now = timestamp + time;
            soloFighter.readyAt = botReadyAt;
            const summonedNow = false;
            summonUses = Number(soloFighter.summonUses || 0);
            if (summonedNow) {
                botReadyAt = soloFighter.readyAt;
                continue;
            }
            const heldCharges = { charges, chargeExpiresAt };
            expireCharges(heldCharges, timestamp + time);
            charges = heldCharges.charges;
            chargeExpiresAt = heldCharges.chargeExpiresAt;
            if (startColdPotion(soloFighter, time)) {
                botReadyAt += 250;
                continue;
            }
            const heal = chooseHeal(bot, [soloFighter], vitals.mp, cooldowns, timestamp + time, soloFighter);
            if (heal) {
                applyAllyHeal(soloFighter, [soloFighter], heal);
                vitals.mp = Math.max(0, vitals.mp - Number(heal.skill.mp || 0));
                cooldowns[heal.skill.selfId] = timestamp + time + Math.max(0, Number(heal.skill.reuse || 0));
                skillUses += 1;
                heals += 1;
                botReadyAt += actionDelayMs(bot, heal.skill);
                continue;
            }
            const music = chooseMusicAction(soloFighter, [soloFighter], timestamp + time);
            if (music) {
                applyMusicAction(soloFighter, music, timestamp + time);
                bot = soloFighter.profile;
                vitals.mp = Math.max(0, vitals.mp - music.cost);
                cooldowns[music.skill.selfId] = timestamp + time + Math.max(0, Number(music.skill.reuse || 0));
                skillUses += 1;
                musicUses += 1;
                botReadyAt += actionDelayMs(bot, music.skill);
                continue;
            }
            const chargeSkill = chooseChargeSkill(bot, vitals.mp, cooldowns, timestamp + time, charges, {hp:vitals.hp,mob,summon:soloFighter.summon});
            if (chargeSkill) {
                const semantic = C4SkillRules.resolve(chargeSkill);
                const nextCharges = { charges, chargeExpiresAt };
                addCharges(nextCharges, 1, semantic.maxCharges, timestamp + time);
                charges = nextCharges.charges;
                chargeExpiresAt = nextCharges.chargeExpiresAt;
                vitals.mp = Math.max(0, vitals.mp - Number(chargeSkill.mp || 0));
                cooldowns[chargeSkill.selfId] = timestamp + time + Math.max(0, Number(chargeSkill.reuse || 0));
                skillUses += 1;
                botReadyAt += actionDelayMs(bot, chargeSkill);
                continue;
            }
            const selected = chooseSkill(bot, vitals.hp, vitals.mp, cooldowns, timestamp + time, charges, rng, {mob,summon:soloFighter.summon});
            const skill = selected?.skill || null;
            const magic = selected?.magic === true;
            const settings = state.instaHunt || {};
            const isBow = bot.equipment.weaponKind === 'Weapon.Bow' && !magic;
            const consume = (selfId, amount) => {
                if (!selfId || !amount) return false;
                const rows = Object.values(fightState.inventory || {}).filter(row => Number(row.selfId) === Number(selfId) && !row.locked && !row.equipped);
                if (rows.reduce((sum, row) => sum + Number(row.amount || 0), 0) < amount) return false;
                let remaining = amount;
                for (const row of rows) {
                    const take = Math.min(remaining, row.amount);
                    row.amount -= take;
                    remaining -= take;
                }
                return true;
            };
            const count = selfId => Object.values(fightState.inventory || {}).filter(row => Number(row.selfId) === Number(selfId) && !row.locked).reduce((sum,row) => sum+Number(row.amount || 0),0);
            let shotId = magic ? settings.magicShotId : settings.physicalShotId;
            const shotCost = magic ? settings.magicShotCost : settings.physicalShotCost;
            if (magic && shotId && count(shotId)<shotCost && settings.magicShotFallbackId) shotId=settings.magicShotFallbackId;
            const actionSemantic = skill ? C4SkillRules.resolve(skill) : {};
            const materialId = Number(actionSemantic.itemConsumeId || 0);
            const materialCount = materialId ? Math.max(1,Number(actionSemantic.itemConsumeCount || 1)) : 0;
            if (materialId && count(materialId)<materialCount) { resourceReason='skill_items_exhausted'; break; }
            if (skill && Number(skill.hp || 0)>=vitals.hp) { resourceReason='skill_hp_too_low'; break; }
            if (shotId && shotCost > 0 && count(shotId) < shotCost && settings.stopShots) { resourceReason = 'shots_exhausted'; break; }
            if (isBow && count(settings.arrowId) < 1) { resourceReason = 'arrows_exhausted'; break; }
            if (isBow) {
                const mpCost = Number(settings.bowMp || 0);
                if (vitals.mp < mpCost) { resourceReason = 'bow_mana_exhausted'; break; }
                vitals.mp -= mpCost;
                consume(settings.arrowId,1);
            }
            const charged = shotId ? consume(shotId, shotCost) : false;
            if (materialId) consume(materialId,materialCount);
            if (skill) vitals.hp -= Math.max(0,Number(skill.hp || 0));
            shotActions += charged ? 1 : 0;

            let damage = 0;
            if (magic) {
                const magicCritical = rng() < clamp(bot.critical / 1000, 0, 0.25);
                const semantic = C4SkillRules.resolve(selected.skill);
                damage = Formulas.calcMagicDamage(bot.mAtk, Math.max(1, selected.power), mob.mDef, { magicCritical, spiritshot: charged, blessedSpiritshot: charged && shotId===settings.blessedMagicShotId })
                    * coldMagicTargetModifier(mob, semantic);
            } else if (hitSucceeds(bot.accur, mob.evasion, rng)) {
                const critical = Formulas.rollCritical(bot.critical, rng);
                const semantic = selected?.skill ? C4SkillRules.resolve(selected.skill) : {};
                damage = Formulas.calcPhysicalDamage(bot.pAtk, bot.equipment.pAtkRnd, mob.pDef, selected?.power || 0, { critical, soulshot: charged, rng })
                    * coldPhysicalTargetModifier(bot, mob, semantic, timestamp + time);
            }
            if (skill) {
                const semantic = C4SkillRules.resolve(skill);
                const requiredCharges = Math.max(0, Number(semantic.requires?.charges) || 0);
                if (requiredCharges > 0) damage *= 0.8 + (0.201 * charges);
                const nextCharges = { charges, chargeExpiresAt };
                consumeCharges(nextCharges, semantic.requires?.charges);
                if (Number(semantic.chargeOnUse) > 0) {
                    addCharges(nextCharges, semantic.chargeOnUse, semantic.maxCharges, timestamp + time);
                }
                charges = nextCharges.charges;
                chargeExpiresAt = nextCharges.chargeExpiresAt;
                vitals.mp = Math.max(0, vitals.mp - Number(skill.mp || 0));
                cooldowns[skill.selfId] = timestamp + time + Math.max(0, Number(skill.reuse || 0));
                skillUses += 1;
            }
            const targetHpBeforeHit = mobHp;
            mobHp -= Math.max(0, damage);
            if (mobHp <= 0) {
                overhitContext = invoke('GameServer/Progression/OverhitReward').contextForHit({
                    attacker: { characterId: state.characterId },
                    skill,
                    targetHpBeforeHit,
                    targetMaxHp: mob.maxHp,
                    finalDamage: damage,
                    encounterId: mob.selfId || targetNpcId,
                    timestamp: timestamp + time
                });
            }
            botReadyAt += actionDelayMs(bot, skill);
            if (mobHp <= 0) {
                soloFighter.readyAt = botReadyAt;
                void soloFighter;
                summonUses = Number(soloFighter.summonUses || 0);
                break;
            }
        } else if (hitSucceeds(mob.accur, bot.evasion, rng)) {
            const critical = Formulas.rollCritical(mob.critical, rng);
            const damage = Formulas.calcMeleeDamage(mob.pAtk, mob.pAtkRnd, bot.pDef, { critical, rng })
                * coldNpcWeaponModifier(mob, bot, timestamp + time);
            vitals.hp -= Math.max(0, damage);
            mobReadyAt += Math.max(250, Formulas.calcMeleeAtkTime(mob.atkSpd));
        } else {
            mobReadyAt += Math.max(250, Formulas.calcMeleeAtkTime(mob.atkSpd));
        }
    }

    if (vitals.hp > 0) applyColdPotionTicks(soloFighter, Number.MAX_SAFE_INTEGER);

    const died = vitals.hp <= 0;
    const won = mobHp <= 0;
    if (!won) {
        return {
            won: false,
            encounter: !died ? PveEncounter.save(pending, encounterKey, mob, mobHp, timestamp, {
                botReadyAt: Math.max(0, botReadyAt - time), mobReadyAt: Math.max(0, mobReadyAt - time)
            }) : null,
            died,
            resourceReason,
            hp: Math.max(0, Math.round(vitals.hp)),
            maxHp: Math.max(1, Math.round(vitals.maxHp)),
            mp: Math.max(0, Math.round(vitals.mp)),
            maxMp: Math.max(1, Math.round(vitals.maxMp)),
            exp: 0,
            sp: 0,
            adena: 0,
            loot: [],
            cooldowns,
            charges: died ? 0 : charges,
            chargeExpiresAt: died ? null : chargeExpiresAt,
            effects: soloFighter.profile.effects,
            inventory: fightState.inventory,
            summon: soloFighter.summon || null,
            debug: { actions, durationMs: Math.min(fightLimitMs, Math.max(1, time, won ? botReadyAt : time)), skillUses, shotActions, heals, musicUses, summonUses, summonActions, potionsUsed: soloFighter.potionsUsed, mobSelfId: mob.selfId || null, timedOut: !died }
        };
    }

    const rewards = BackgroundDropResolver.progressionForFight({ spot, npcSelfId: mob.selfId, rng });
    const overhit = invoke('GameServer/Progression/OverhitReward').resolveContext(overhitContext, rewards.exp);
    const expMultiplier = pressure?.expMultiplier || 1;
    const rates = ProgressionRates.profile();
    const rolledRewards = BackgroundDropResolver.rollRewardsForFight({
        spot,
        killerLevel: Number(state.level || bot.level),
        npcSelfId: mob.selfId,
        rng
    });
    const adena = rolledRewards === null
        ? Math.round(randInt(rng, spot.rewards.adenaMin, spot.rewards.adenaMax) * rates.adena)
        : rolledRewards.adena;
    const loot = rolledRewards?.items || [];
    if (state.instaHunt?.spoil === true) {
        loot.push(...BackgroundDropResolver.rollSpoilForFight({
            spot,
            killerLevel: Number(state.level || bot.level),
            npcSelfId: mob.selfId,
            rng
        }));
    }

    return {
        won: true,
        died: false,
        resourceReason,
        hp: Math.max(1, Math.round(vitals.hp)),
        maxHp: Math.max(1, Math.round(vitals.maxHp)),
        mp: Math.max(0, Math.round(vitals.mp)),
        maxMp: Math.max(1, Math.round(vitals.maxMp)),
        exp: Math.round(overhit.adjustedExp * expMultiplier * rates.exp
            * ColdCombatProfile.statMultiplier(bot, 'expMul', timestamp)),
        sp: Math.round(rewards.sp * expMultiplier * rates.sp),
        adena,
        loot,
        cooldowns,
        charges,
        chargeExpiresAt,
        effects: soloFighter.profile.effects,
        inventory: fightState.inventory,
        summon: soloFighter.summon || null,
        debug: { actions, durationMs: Math.min(fightLimitMs, Math.max(1, time, won ? botReadyAt : time)), skillUses, shotActions, heals, musicUses, summonUses, summonActions, potionsUsed: soloFighter.potionsUsed,
            mobSelfId: mob.selfId || null, timedOut: false, overhit }
    };
}

function chooseHeal(profile, allies, mp, cooldowns, time, caster) {
    const injured = allies.filter((ally) => ally.vitals.hp > 0 && ally.vitals.hp / Math.max(1, ally.vitals.maxHp) < 0.7)
        .sort((a, b) => (a.vitals.hp / a.vitals.maxHp) - (b.vitals.hp / b.vitals.maxHp))[0];
    if (!injured) return null;
    const skill = (profile.skills || []).filter((candidate) => {
        if (candidate.passive || Number(candidate.mp || 0) > mp || Number(cooldowns[candidate.selfId] || 0) > time) return false;
        const semantic = C4SkillRules.resolveCached(candidate);
        return [C4SkillRules.HEAL, C4SkillRules.HEAL_PERCENT, C4SkillRules.HEAL_HOT, C4SkillRules.HOT].includes(semantic.skillType)
            && ['self', 'party', 'ally', 'friendly'].includes(semantic.target)
            && (semantic.target !== 'ally' || caster === injured || Number(caster?.state.clanId) > 0
                && Number(caster.state.clanId) === Number(injured.state.clanId))
            && (!semantic.hot || !(injured.profile.effects || []).some(e => e.key === semantic.effect && Number(e.expiresAt) > time))
            && (semantic.target !== 'self' || caster?.vitals.hp > 0 && caster.vitals.hp < caster.vitals.maxHp * 0.7);
    }).sort((a, b) => {
        const score = skill => {
            const semantic = C4SkillRules.resolveCached(skill);
            return invoke('GameServer/Bot/AI/PartyHealPolicy').score({
                missingHp: injured.vitals.maxHp - injured.vitals.hp, maxHp: injured.vitals.maxHp,
                power: semantic.hot?.heal ?? (semantic.skillType === C4SkillRules.HEAL_PERCENT
                    ? injured.vitals.maxHp * Number(skill.power || 0) / 100 : Formulas.calcHealAmount(skill.power)),
                cost: Number(skill.mp || 0), castMs: Number(skill.hitTime || 0),
                periodic: !!semantic.hot, ticks: semantic.hot?.count,
                recipients: ['party', 'ally'].includes(semantic.target) ? allies.filter(f => f.vitals.hp > 0 && f.vitals.hp < f.vitals.maxHp * 0.7).length : 1
            });
        };
        return score(b) - score(a);
    })[0];
    return skill ? { skill, target: C4SkillRules.resolveCached(skill).target === 'self' ? caster : injured } : null;
}

function applyAllyHeal(caster, allies, heal) {
    const semantic = C4SkillRules.resolve(heal.skill);
    const targets = semantic.target === 'self' ? [caster] : semantic.target === 'party' ? allies
        : semantic.target === 'ally' ? allies.filter(f => f === caster || Number(caster.state.clanId) > 0
            && Number(caster.state.clanId) === Number(f.state.clanId)) : [heal.target];
    const helped = [];
    for (const ally of targets.filter(f => f.vitals.hp > 0)) {
        if (semantic.hot) {
            const at = Number(caster.now || Date.now());
            const effect = { id: heal.skill.selfId, level: heal.skill.level, key: semantic.effect,
                type: 'buff', casterId: caster.state.characterId, createdAt: at,
                expiresAt: at + semantic.hot.count * semantic.hot.intervalMs,
                hot: { ...semantic.hot, nextAt: at + semantic.hot.intervalMs } };
            ally.profile.effects = replaceMusicEffect(ally.profile.effects, effect);
            continue;
        }
        const before = ally.vitals.hp;
        const amount = semantic.skillType === C4SkillRules.HEAL_PERCENT
            ? ally.vitals.maxHp * Number(heal.skill.power || 0) / 100 : Formulas.calcHealAmount(heal.skill.power);
        ally.vitals.hp = Math.min(ally.vitals.maxHp, before + Math.max(0, amount));
        if (ally !== caster && invoke('GameServer/Social/CombatHelpPolicy').meaningfulHeal(before, ally.vitals.hp, ally.vitals.maxHp)) {
            helped.push({ sourceId: ally.state.characterId, targetId: caster.state.characterId, type: 'healed' });
        }
    }
    return helped;
}

function applyPartyHotTicks(fighter, at) {
    if (fighter.vitals.hp <= 0) return;
    for (const effect of fighter.profile.effects || []) {
        const hot = effect.hot;
        if (!hot || !Number.isFinite(hot.nextAt) || !(hot.intervalMs > 0)) continue;
        const ticks = Math.max(0, Math.min(hot.count, Math.floor((Math.min(at, effect.expiresAt) - hot.nextAt) / hot.intervalMs) + 1));
        fighter.vitals.hp = Math.min(fighter.vitals.maxHp, fighter.vitals.hp + ticks * Number(hot.heal || 0));
        hot.count -= ticks;
        hot.nextAt += ticks * hot.intervalMs;
    }
}

module.exports = { resolveFight, resolveRest, estimateRestMs, needsRest, applyStandingRegen };
