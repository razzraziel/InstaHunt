const Cache = invoke('GameServer/DataCache');
const Geo = invoke('GameServer/Geodata/GeodataEngine');
const Clock = invoke('GameServer/World/GameTime');
const minions = require('../data/Npcs/Minions/c4_raid_bosses.json');
const forbidden = new Set(minions.flatMap(row => [Number(row.bossId), Number(row.minionId)]));
const Spawns = invoke('GameServer/World/Generics/SpawnNpcs');

function inside(x, y, points) {
    let result = false;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
        const a = points[i], b = points[j];
        if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) result = !result;
    }
    return result;
}

function list(actor, config) {
    const x = actor.fetchLocX(), y = actor.fetchLocY(), z = actor.fetchLocZ();
    const templates = new Map(Cache.npcs.map(npc => [Number(npc.selfId), npc]));
    const groups = new Map();
    const mode = Clock.mode();
    for (const area of Cache.npcSpawns || []) {
        for (const spawn of area.spawns || []) {
            const npc = templates.get(Number(spawn.selfId));
            if (!npc || npc.template?.kind !== 'Monster' || npc.template?.raidBoss || forbidden.has(Number(npc.selfId)) || Number(spawn.respawn) <= 0) continue;
            if (spawn.period && spawn.period !== 'always' && spawn.period !== mode) continue;
            let points = (spawn.coords || []).map(p => ({ x: Number(p.locX), y: Number(p.locY), z: Number(p.locZ) }));
            if (!points.length && area.bounds?.length >= 3) {
                const polygon = area.bounds.map(p => ({ x: Number(p.locX ?? p.x), y: Number(p.locY ?? p.y), z: Number(p.maxZ ?? p.locZ ?? z) }));
                if (polygon.every(p => Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z))) {
                    const center = { x: polygon.reduce((s,p) => s+p.x,0)/polygon.length, y: polygon.reduce((s,p) => s+p.y,0)/polygon.length, z: polygon[0].z };
                    points = [inside(x,y,polygon) ? { x, y, z: center.z } : center];
                }
            }
            const candidates = points.filter(p => Math.hypot(p.x-x,p.y-y) <= config.radius && Math.abs(p.z-z) <= config.maxHeightDifference)
                .sort((a,b) => Math.hypot(a.x-x,a.y-y)-Math.hypot(b.x-x,b.y-y));
            const reachable = candidates.filter(p => Geo.hasLineOfSight(x,y,z,p.x,p.y,p.z) && (!Geo.hasGeo(x,y) || !Geo.hasGeo(p.x,p.y) || Geo.findPath(x,y,z,p.x,p.y,p.z,2000)?.length));
            if (!reachable.length) continue;
            const count = (spawn.coords || []).length ? reachable.length * Math.max(1,Number(spawn.total || 1)) : Math.max(1, Number(spawn.total || 1));
            const id = Number(npc.selfId);
            const entry = groups.get(id) || { id, name: npc.template.name, level: Number(npc.template.level), points: [], respawnMs: 30000, period: spawn.period || 'always' };
            entry.respawnMs = Math.max(1000,Spawns.respawnDelayMs(spawn,() => 0.5));
            for (let index = 0; index < Math.min(count, 200); index++) entry.points.push(reachable[index % reachable.length]);
            groups.set(id, entry);
        }
    }
    return [...groups.values()].sort((a,b) => a.level-b.level || a.name.localeCompare(b.name));
}

module.exports = { list, inside };
