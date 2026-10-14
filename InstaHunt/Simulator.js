const crypto = require('crypto');
const Combat = require('./Combat');
const Profile = invoke('GameServer/Bot/Population/ColdCombatProfile');
const Cap = invoke('GameServer/Progression/ProgressionCap');
const Cache = invoke('GameServer/DataCache');
const ShotStock = invoke('GameServer/Inventory/ShotStock');
const SA = invoke('GameServer/Items/C4WeaponSA');
const Clock = invoke('GameServer/World/GameTime');
const ItemIndex = invoke('GameServer/Item/ItemTemplateIndex');
const Limits = invoke('GameServer/PrivateStoreLimits');
const EffectStore = invoke('GameServer/Effects/EffectStore');

function snapshot(actor, settings) {
    const items = actor.backpack.fetchItems().slice().sort((a,b) => a.fetchId()-b.fetchId());
    const capture = Profile.capture(actor);
    capture.effects = EffectStore.list(actor).filter(effect => effect.type !== 'debuff').map(effect => ({
        id:effect.id,key:effect.key,level:effect.level,name:effect.name,type:effect.type,
        stats:{...(effect.stats || {})},toggle:false,expiresAt:Number.MAX_SAFE_INTEGER
    }));
    if (!capture.skills.length) capture.skills = [{ selfId: 0, level: 1, passive: true }];
    const weapon = actor.backpack.fetchEquippedWeapon();
    const physical = ShotStock.planForActorKind('soulshot', actor);
    const regularMagic = ShotStock.planForActorKind('spiritshot', actor);
    const blessedMagic = ShotStock.planForActorKind('blessedSpiritshot', actor);
    const stocked = selfId => items.some(item => item.fetchSelfId()===selfId && item.fetchAmount()>0 && !item.fetchPetLocked?.());
    const magic = stocked(blessedMagic.selfId)?blessedMagic:regularMagic;
    const arrows = { none:17, d:1341, c:1342, b:1343, a:1344, s:1345 };
    return {
        characterId: actor.fetchId(), name: actor.fetchName(), level: actor.fetchLevel(), exp: actor.fetchExp(), sp: actor.fetchSp(),
        loc: { locX: actor.fetchLocX(), locY: actor.fetchLocY(), locZ: actor.fetchLocZ() },
        classId: actor.fetchClassId(), stats: { classId: actor.fetchClassId(), coldCombat: capture },
        vitals: { hp: actor.fetchHp(), mp: actor.fetchMp(), maxHp: actor.fetchMaxHp(), maxMp: actor.fetchMaxMp() },
        inventory: Object.fromEntries(items.map(item => [item.fetchId(), { id:item.fetchId(), selfId:item.fetchSelfId(), amount:item.fetchAmount(), equipped:false, locked:item.fetchPetLocked?.() === true, mass:item.fetchMass(), stackable:item.fetchStackable(), actualEquipped:Number(item.fetchEquipped()), enchant:item.fetchEnchantLevel?.() || 0 }])),
        maxLoad: actor.fetchMaxLoad(), maxSlots: (actor.fetchRace() === 4 ? 100 : 80) + Math.max(0,Math.min(8,Limits.skillLevel(actor,1372)))*6,
        speed: Math.max(1,actor.fetchCollectiveRunSpd?.() || actor.fetchRunSpd() || 120),
        instaHunt: { physicalShotId:settings.shots ? physical.selfId : 0, physicalShotCost:SA.soulshotCost(weapon,()=>0.5), magicShotId:settings.shots ? magic.selfId : 0, magicShotFallbackId:settings.shots ? regularMagic.selfId : 0, blessedMagicShotId:blessedMagic.selfId, magicShotCost:actor.backpack.fetchTotalWeaponSpiritshot(), stopShots:settings.stopShots, arrowId:arrows[String(weapon?.fetchRank?.() || 'none').toLowerCase()], bowMp:SA.bowMpCost(weapon, () => 0.5), potions:settings.potions,spoil:settings.spoil===true }
    };
}

function rngFor(seed) {
    let state = crypto.createHash('sha256').update(String(seed)).digest().readUInt32LE(0);
    return () => { state += 0x6D2B79F5; let t = Math.imul(state ^ state >>> 15, state | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

function inventoryStamp(state) {
    return Object.values(state.inventory).sort((a,b) => a.id-b.id).map(row => [row.id,row.selfId,row.amount,row.actualEquipped,row.enchant]);
}

function capacity(state, loot) {
    const rows = Object.values(state.inventory).filter(row => row.amount > 0);
    const stackIds = new Set(rows.filter(row => row.stackable).map(row => row.selfId));
    let slots = rows.length;
    let mass = rows.reduce((sum,row) => sum+row.amount*Number(row.mass || 0),0);
    for (const row of loot) {
        const template = ItemIndex.find(Cache.items,row.selfId);
        if (!template) throw new Error(`Unknown loot template ${row.selfId}`);
        mass += Number(utils.crushOb(template).mass || 0)*row.amount;
        if (row.stackable) { if (!stackIds.has(row.selfId)) { slots++; stackIds.add(row.selfId); } }
        else slots += row.amount;
    }
    return slots <= state.maxSlots && mass <= state.maxLoad;
}

async function simulate(initial, targets, durationMs, config, seed, simulatedAt=Date.now()) {
    let state = structuredClone(initial);
    const rng = rngFor(seed);
    const pools = targets.flatMap(target => target.points.map(point => ({ target, point, available:0 })));
    const drops = new Map();
    let elapsedMs = 0, kills = 0, reason = 'duration_completed', attempts = 0;
    let location = { x:initial.loc.locX,y:initial.loc.locY,z:initial.loc.locZ };
    const timestamp = simulatedAt;
    while (elapsedMs < durationMs) {
        if (attempts % 16 === 0) await new Promise(resolve => setImmediate(resolve));
        if (Combat.needsRest(state,state.vitals,{requireMana:true})) {
            const rest = Math.min(durationMs-elapsedMs,Combat.estimateRestMs(state,state.vitals,{requireMana:true}));
            state.vitals = Combat.resolveRest(state,rest,timestamp+elapsedMs,{requireMana:true}).patch.vitals;
            elapsedMs += rest;
            if (elapsedMs >= durationMs) break;
        }
        const available = pools.filter(pool => pool.target.period === 'always' || pool.target.period === Clock.mode(timestamp+elapsedMs));
        if (!available.length) { reason='spawn_period_ended'; break; }
        const pool = available.slice().sort((a,b) => Math.max(a.available,elapsedMs)-Math.max(b.available,elapsedMs) || Math.hypot(a.point.x-location.x,a.point.y-location.y)-Math.hypot(b.point.x-location.x,b.point.y-location.y))[0];
        const travel = Math.ceil(Math.hypot(pool.point.x-location.x,pool.point.y-location.y)/state.speed*1000)+1000;
        const wait = Math.max(0,pool.available-elapsedMs);
        const quiet = Math.min(durationMs-elapsedMs,travel+wait);
        state.vitals = Combat.applyStandingRegen(state,state.vitals,quiet,timestamp+elapsedMs);
        elapsedMs += quiet;
        location = pool.point;
        if (state.instaHunt.spoil) elapsedMs += Math.min(durationMs-elapsedMs,1000);
        if (elapsedMs >= durationMs) break;
        const spot = { id:`insta:${pool.target.id}`,npcSelfIds:[pool.target.id],npcEntries:[{selfId:pool.target.id,count:1}],npcNames:[pool.target.name],avgLevel:pool.target.level,rewards:{adenaMin:0,adenaMax:0} };
        const limit = Math.min(durationMs-elapsedMs,config.fightTimeoutSeconds*1000);
        const result = Combat.resolveFight({state,spot,pressure:{},targetNpcId:pool.target.id,rng,timestamp:timestamp+elapsedMs,fightLimitMs:limit,maxActions:10000});
        attempts++;
        if (result.avoided) {
            if (result.needsRest) {
                const rest = Math.min(durationMs-elapsedMs,Math.max(3000,Combat.estimateRestMs(state,state.vitals,{requireMana:true})));
                state.vitals = Combat.resolveRest(state,rest,timestamp+elapsedMs,{requireMana:true}).patch.vitals;
                elapsedMs += rest;
                continue;
            }
            reason='monster_too_strong'; break;
        }
        const next = { ...state,inventory:result.inventory,vitals:{hp:Math.max(1,result.hp),mp:result.mp,maxHp:result.maxHp,maxMp:result.maxMp},stats:{...state.stats,coldCombat:{...state.stats.coldCombat,effects:result.effects,cooldowns:result.cooldowns,charges:result.charges,chargeExpiresAt:result.chargeExpiresAt}} };
        const excluded=new Set(initial.instaHunt.excludedDrops || []);
        const rewards = result.loot.filter(row => !excluded.has(row.selfId));
        if (result.adena > 0) rewards.push({selfId:57,name:'Adena',amount:result.adena,stackable:true});
        const allLoot = [...drops.values()].map(row => ({...row}));
        for (const reward of rewards) {
            const existing = allLoot.find(row => row.selfId === reward.selfId);
            if (existing) existing.amount += reward.amount;
            else allLoot.push({...reward});
        }
        if (config.enforceInventoryLimits === true && !capacity(next,allLoot)) { reason='inventory_capacity'; break; }
        state = next;
        elapsedMs += Math.max(1,Math.min(limit,result.debug?.durationMs || limit));
        if (result.resourceReason) {
            if (result.resourceReason === 'bow_mana_exhausted') {
                const rest = Math.min(durationMs-elapsedMs,Combat.estimateRestMs(state,state.vitals,{requireMana:true}));
                state.vitals = Combat.resolveRest(state,rest,timestamp+elapsedMs,{requireMana:true}).patch.vitals;
                elapsedMs += rest;
                continue;
            }
            reason=result.resourceReason; break;
        }
        if (!result.won) { reason=result.died ? 'monster_too_strong' : elapsedMs >= durationMs ? 'duration_completed' : 'fight_timeout'; break; }
        kills++;
        for (const reward of rewards) {
            const previous = drops.get(reward.selfId);
            if (previous) previous.amount += reward.amount;
            else drops.set(reward.selfId,{...reward});
        }
        const award = Cap.applyAward(state.exp,result.exp);
        state.exp = award.totalExp;
        state.sp += result.sp;
        const level = Cap.levelForExperience(state.exp,state.level);
        if (level > state.level) {
            state.level = level;
            const learned = Profile.treeSnapshot(state,timestamp+elapsedMs);
            state.stats.coldCombat.skills = learned.skills;
            const profile = Profile.profileFor(state,timestamp+elapsedMs);
            state.vitals = { hp:profile.maxHp,maxHp:profile.maxHp,mp:profile.maxMp,maxMp:profile.maxMp };
        }
        pool.available = elapsedMs+pool.target.respawnMs;
    }
    const consumed = Object.values(initial.inventory).map(row => ({selfId:row.selfId,amount:row.amount-(state.inventory[row.id]?.amount || 0)})).filter(row => row.amount > 0);
    const loot = [...drops.values()];
    const usedMs = Math.min(durationMs,Math.ceil(elapsedMs));
    return { inventory:state.inventory,elapsedMs:usedMs,level:state.level,exp:state.exp,sp:state.sp,hp:state.vitals.hp,mp:state.vitals.mp,loot,summary:{ elapsedMs:usedMs,kills,exp:state.exp-initial.exp,sp:state.sp-initial.sp,adena:drops.get(57)?.amount || 0,loot:loot.filter(row => row.selfId !== 57),consumed,reason,level:state.level } };
}

module.exports = { snapshot,simulate,rngFor,inventoryStamp,capacity };
