module.exports = ({ one, all, write, inTransaction, withCharacterFlush }) => {
    function tables() {
        write('CREATE TABLE IF NOT EXISTS insta_hunt_results (token TEXT PRIMARY KEY, characterId INTEGER NOT NULL, createdAt INTEGER NOT NULL, resultJson TEXT NOT NULL)');
    }
    return {
        instaHuntCommit(input) {
            return withCharacterFlush(input.characterId, () => inTransaction(() => {
                tables();
                const existing = one('SELECT resultJson FROM insta_hunt_results WHERE token = ? AND characterId = ?', [input.token, input.characterId]);
                if (existing) return { duplicate: true, summary: JSON.parse(existing.resultJson) };
                if (!Number.isSafeInteger(input.result.elapsedMs) || input.result.elapsedMs < 0 || input.result.elapsedMs > input.durationMs) throw new Error('Invalid simulation time.');
                if (![input.result.level,input.result.exp,input.result.sp,input.result.hp,input.result.mp].every(Number.isFinite)) throw new Error('Invalid character result.');
                const character = one('SELECT level, exp, sp FROM characters WHERE id = ?', [input.characterId]);
                if (!character || Number(character.exp) !== input.before.exp || Number(character.sp) !== input.before.sp || Number(character.level) !== input.before.level) throw new Error('Character changed; reopen Insta Hunt.');
                const rows = all('SELECT * FROM items WHERE characterId = ? ORDER BY id', [input.characterId]);
                const stamp = rows.map(row => [Number(row.id), Number(row.selfId), Number(row.amount), Number(row.equipped), Number(row.enchant || 0)]);
                if (JSON.stringify(stamp) !== JSON.stringify(input.before.inventoryStamp)) throw new Error('Inventory changed; reopen Insta Hunt.');
                for (const row of rows) {
                    const remaining = input.result.inventory[row.id]?.amount ?? Number(row.amount);
                    if (!Number.isSafeInteger(remaining) || remaining < 0 || remaining > Number(row.amount)) throw new Error('Invalid consumption.');
                    if (remaining === 0) write('DELETE FROM items WHERE id = ? AND characterId = ?', [row.id, input.characterId]);
                    else if (remaining !== Number(row.amount)) write('UPDATE items SET amount = ? WHERE id = ? AND characterId = ?', [remaining, row.id, input.characterId]);
                }
                for (const loot of input.result.loot) {
                    if (!Number.isSafeInteger(loot.amount) || loot.amount < 1) throw new Error('Invalid reward amount.');
                    const stack = loot.stackable ? one('SELECT id FROM items WHERE characterId = ? AND selfId = ? AND equipped = 0 ORDER BY id LIMIT 1', [input.characterId, loot.selfId]) : null;
                    if (stack) write('UPDATE items SET amount = amount + ? WHERE id = ?', [loot.amount, stack.id]);
                    else {
                        const count = loot.stackable ? 1 : loot.amount;
                        for (let index = 0; index < count; index++) write('INSERT INTO items (selfId, name, amount, enchant, equipped, slot, characterId) VALUES (?, ?, ?, 0, 0, 0, ?)', [loot.selfId, loot.name, loot.stackable ? loot.amount : 1, input.characterId]);
                    }
                }
                write('UPDATE characters SET level = ?, exp = ?, sp = ?, hp = ?, mp = ? WHERE id = ?', [input.result.level, input.result.exp, input.result.sp, input.result.hp, input.result.mp, input.characterId]);
                write('INSERT INTO insta_hunt_results (token, characterId, createdAt, resultJson) VALUES (?, ?, ?, ?)', [input.token, input.characterId, Date.now(), JSON.stringify(input.result.summary)]);
                return { rows: all('SELECT * FROM items WHERE characterId = ? ORDER BY id', [input.characterId]), summary: input.result.summary };
            }, 'insta-hunt:commit'));
        }
    };
};
