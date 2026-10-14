const crypto = require('crypto');
const Html = invoke('GameServer/World/Generics/HtmlKit');
const Response = invoke('GameServer/Network/Response');
const Database = invoke('Database');
const Queue = invoke('GameServer/Persistence/CharacterWriteQueue');
const Targets = require('./Targets');
const Simulator = require('./Simulator');
const config = require('./config.json');
const { version } = require('./version.json');
const Cache = invoke('GameServer/DataCache');
const ItemIndex = invoke('GameServer/Item/ItemTemplateIndex');

function minutes(value) {
    const text=String(value ?? '').trim();
    const amount=Number(text);
    if (!/^\d+$/.test(text) || !Number.isSafeInteger(amount) || amount<1 || !Number.isSafeInteger(amount*60000+Date.now())) throw new Error('Enter a positive whole number of minutes.');
    return amount;
}

function permitted(session) {
    const actor = session?.actor;
    if (!config.enabled) throw new Error('Insta Hunt is disabled.');
    if (!actor || session.botSession || String(session.accountId || '').startsWith('bot_')) throw new Error('Insta Hunt is available to players only.');
    if (actor.isDead()) throw new Error('You cannot use Insta Hunt while dead.');
    if (actor.state?.fetchCombats?.() || actor.state?.fetchHits?.() || actor.state?.fetchCasts?.()) throw new Error('Leave combat and finish your attack or cast before using Insta Hunt.');
    if (session.moveTimer || actor.state?.inMotion?.() || actor.state?.fetchTowards?.()) throw new Error('Stop moving before using Insta Hunt.');
    if (actor.fetchPrivateStoreType?.() || session.trade || session.tradeSession || session.activeTrade) throw new Error('Close your shop or trade first.');
    if (actor.pet || actor.summon) throw new Error('Dismiss your pet or summon before using Insta Hunt.');
    if (actor.party || session.party || invoke('GameServer/Bot/AI/PartyCompanionService').membersForLeader(session).length) throw new Error('Leave your party before using solo Insta Hunt.');
    return actor;
}

function send(session,body) {
    session.dataSendToMe(Response.npcHtml(0,`<html><body><center>${Html.font(`Insta Hunt v${version}`,'LEVEL')}</center><br>${body}</body></html>`));
    session.dataSendToMe(Response.actionFailed());
}

function fail(session,error) {
    const code=`IH_${String(session.instaHuntStage || 'OPEN').toUpperCase().replace(/[^A-Z0-9]/g,'_')}_${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    const message=String(error.message || error).replace(/[\r\n]+/g,' ').slice(0,350);
    const detail=session.instaHuntCommitted?'Rewards were already saved. Reconnect if the character display did not update.':message;
    session.dataSendToMe(Response.speak({fetchId:()=>0,fetchName:()=> 'Insta Hunt'},{kind:0,text:`[${code}] ${detail}`}));
    if (typeof utils !== 'undefined' && utils.infoWarn) utils.infoWarn('InstaHunt','%s character=%s: %s',code,session.actor?.fetchId?.() || 0,error.stack || message);
    send(session,`${Html.font(code,'FF5555')}<br>${Html.font(detail,'FF5555')}<br>${Html.link('Back','insta-hunt reopen')}`);
}

function button(label,command) {
    return `<center>${Html.table([Html.row([Html.cell(Html.button(label,`insta-hunt ${command}`,{width:75}),{width:75,align:'center'})])],{width:75})}</center>`;
}

function calculationPage(session) {
    const quote=session.instaHunt?.quote;
    if (!quote?.summary) throw new Error('Roll and calculate first.');
    const selected=quote.summary.loot.filter(row => !session.instaHunt.excludedDrops.has(row.selfId)).length;
    send(session,summaryHtml(quote.summary,true,false)+Html.spacer(8)+linksRow([
        Html.link(`Choose drops (${selected}/${quote.summary.loot.length})`,'insta-hunt drops-page 0'),
        Html.link('Change hunt',`insta-hunt page ${session.instaHunt.page || 0}`)
    ])+Html.spacer(8)+button('Apply',`start ${quote.token}`));
}

function linksRow(items,width=270) {
    const cellWidth=Math.floor(width/items.length);
    return Html.table([Html.row(items.map(item => Html.cell(item,{width:cellWidth,align:'center'})))],{width});
}

function section(title,body) {
    return `<br>${Html.font(title,'LEVEL')}<br1>${Html.line('L2UI.SquareWhite',270,1)}${body}`;
}

function values(rows) {
    return Html.table(rows.map(([label,value]) => Html.row([
        Html.cell(Html.esc(label),{width:145}),
        Html.cell(Html.esc(value),{width:125,align:'right'})
    ])),{width:270});
}

function itemName(id) {
    return ItemIndex.find(Cache.items,id)?.template?.name || `Item ${id}`;
}

function summaryHtml(summary,preview=false,includeDrops=true) {
    const reason = {duration_completed:'Selected duration completed',shots_exhausted:'Shots ran out',arrows_exhausted:'Arrows ran out',skill_items_exhausted:'Skill materials ran out',skill_hp_too_low:'Not enough HP for the skill',monster_too_strong:'Cannot safely defeat this monster',inventory_capacity:'Inventory capacity reached',fight_timeout:'Fight could not finish',spawn_period_ended:'Selected monsters are no longer spawning'}[summary.reason] || summary.reason;
    return `${Html.font(preview ? 'Calculated result' : 'Hunt result','LEVEL')}<br>` +
        values([['Time',`${Math.floor(summary.elapsedMs/60000)}m ${Math.floor(summary.elapsedMs/1000)%60}s`],['Kills',summary.kills],['Level',summary.level],['XP',Math.floor(summary.exp).toLocaleString('en-US')],['SP',Math.floor(summary.sp).toLocaleString('en-US')],['Adena',Math.floor(summary.adena).toLocaleString('en-US')]]) +
        `${Html.font(reason,'FFCC00')}<br>` +
        section('Consumed',summary.consumed.length ? summary.consumed.map(row => `${Html.esc(itemName(row.selfId))}: ${row.amount}<br1>`).join('') : 'None') +
        (includeDrops?section('Drops',summary.loot.length ? summary.loot.slice(0,12).map(row => `${Html.esc(row.name)}: ${row.amount}<br1>`).join('') + (summary.loot.length>12 ? `${summary.loot.length-12} more item types in inventory<br1>` : '') : 'None') : '');
}

function preview(session,page=0) {
    const ui=session.instaHunt;
    const quote=ui.quote;
    if (!quote?.summary) throw new Error('Roll and calculate first.');
    const drops=quote.summary.loot;
    const pages=Math.max(1,Math.ceil(drops.length/6));
    page=Math.max(0,Math.min(pages-1,Number(page)||0));
    ui.dropPage=page;
    let rows=linksRow([Html.link('Select all','insta-hunt drop-all on'),Html.link('Clear all','insta-hunt drop-all off')])+Html.spacer(5);
    for (const row of drops.slice(page*6,page*6+6)) {
        const selected=!ui.excludedDrops.has(row.selfId);
        rows+=Html.table([Html.row([
            Html.cell(Html.link(selected?'[x]':'[ ]',`insta-hunt drop ${row.selfId}`),{width:25}),
            Html.cell(Html.link(row.name,`insta-hunt drop ${row.selfId}`,{color:selected?'99CCFF':'777777'}),{width:175}),
            Html.cell(Html.font(row.amount.toLocaleString('en-US'),'777777'),{width:70,align:'right'})
        ])],{width:270});
    }
    if (!drops.length) rows+='None<br1>';
    if (pages>1) rows+=Html.spacer(5)+linksRow([Html.link('Previous',`insta-hunt drops-page ${page-1}`),Html.font(`${page+1} / ${pages}`,'777777'),Html.link('Next',`insta-hunt drops-page ${page+1}`)]);
    send(session,Html.font('Collect drops','LEVEL')+'<br1>'+rows+Html.spacer(8)+button('Apply',`start ${quote.token}`)+'<br><center>'+Html.link('Back to result','insta-hunt result')+'</center>');
}

function render(session,page=0) {
    const ui = session.instaHunt;
    ui.quote = null;
    const pages = Math.max(1,Math.ceil(ui.targets.length/8));
    page = Math.max(0,Math.min(pages-1,Number(page)||0));
    ui.page = page;
    let body = values([['Selected duration',`${ui.minutes} min`]]);
    body += Html.table([Html.row([
        Html.cell('Minutes',{width:80}),
        Html.cell('<edit var="hunt_minutes" width=90 height=15 length=12>',{width:110}),
        Html.cell(Html.link('Set','insta-hunt duration $hunt_minutes'),{width:80,align:'right'})
    ])],{width:270})+'<br1>';
    body += linksRow((config.durationPresetsMinutes || [60,120,240,480,720]).map(value => Html.link(`${value/60}h`,`insta-hunt duration ${value}`)))+Html.spacer(8);
    body += '<center>'+Html.link('Refresh nearby spawns','insta-hunt reopen')+'</center><br1>';
    body += linksRow([Html.link('Select all','insta-hunt select all'),Html.link('Clear','insta-hunt select none')])+'<br1>';
    for (const target of ui.targets.slice(page*8,page*8+8)) body += Html.table([Html.row([
        Html.cell(Html.link(ui.selected.has(target.id)?'[x]':'[ ]',`insta-hunt toggle ${target.id}`),{width:30}),
        Html.cell(Html.link(target.name,`insta-hunt toggle ${target.id}`),{width:205}),
        Html.cell(Html.font(target.level,'777777'),{width:35,align:'right'})
    ])],{width:270});
    if (!ui.targets.length) body += 'No reachable normal monster spawns here.<br>';
    if (pages>1) body += linksRow([Html.link('Previous',`insta-hunt page ${page-1}`),Html.font(`${page+1} / ${pages}`,'777777'),Html.link('Next',`insta-hunt page ${page+1}`)])+'<br1>';
    body += Html.spacer(8);
    body += Html.link(`Shots: ${ui.settings.shots?'ON':'OFF'}`,'insta-hunt setting shots')+'<br1>';
    body += Html.link(`Spoil: ${ui.settings.spoil?'ON':'OFF'}`,'insta-hunt setting spoil')+'<br1>';
    body += Html.link(`Healing potions: ${ui.settings.potions?'ON':'OFF'}`,'insta-hunt setting potions')+'<br1>';
    body += Html.link(`Shot exhaustion: ${ui.settings.stopShots?'STOP':'CONTINUE WITHOUT'}`,'insta-hunt setting stopShots')+'<br><br1>';
    body += '<center>'+Html.font('Roll and Calculate','LEVEL')+'</center><br1>'+button('Hunt','estimate $hunt_minutes');
    send(session,body);
}

async function open(session) {
    if (session.instaHuntBusy) return;
    session.instaHuntBusy = true;
    session.instaHuntStage='OPEN';
    session.instaHuntCommitted=false;
    try {
        const actor = permitted(session);
        const id = actor.fetchId();
        const targets = Targets.list(actor,config);
        session.instaHunt = { characterId:id,targets,selected:new Set(targets.map(target => target.id)),excludedDrops:new Set(),minutes:minutes(config.defaultMinutes || 60),settings:{shots:true,spoil:false,potions:config.usePotionsByDefault,stopShots:false} };
        render(session);
    } catch(error) { fail(session,error); }
    finally { session.instaHuntBusy=false; }
}

function fingerprint(actor,settings) {
    const state = Simulator.snapshot(actor,settings);
    return JSON.stringify([state.characterId,state.level,state.exp,state.sp,state.loc,Simulator.inventoryStamp(state),state.stats.coldCombat.skills,state.stats.coldCombat.equipment]);
}

async function calculate(session,start,token) {
    const actor = permitted(session);
    const ui = session.instaHunt;
    if (!ui || ui.characterId !== actor.fetchId()) throw new Error('Reopen Insta Hunt.');
    const stamp = fingerprint(actor,ui.settings);
    const beforeHp = actor.fetchHp(), beforeMp = actor.fetchMp();
    let quote = ui.quote;
    if (start && (!quote || quote.token !== token)) throw new Error('Roll and calculate before applying the hunt.');
    let initial;
    let result;
    let durationMs;
    if (!start) {
        ui.quote=null;
        durationMs=minutes(ui.minutes)*60000;
        const reachable=new Set(Targets.list(actor,config).map(target => target.id));
        const targets=ui.targets.filter(target => ui.selected.has(target.id) && reachable.has(target.id));
        if (!targets.length) throw new Error('Select at least one nearby monster.');
        initial=Simulator.snapshot(actor,ui.settings);
        initial.instaHunt.excludedDrops=[];
        const seed=crypto.createHash('sha256').update(JSON.stringify([stamp,initial.vitals,initial.stats.coldCombat.effects,durationMs,targets.map(target => target.id),ui.settings])).digest('hex');
        quote={token:crypto.randomBytes(24).toString('hex'),fingerprint:stamp,seed,simulatedAt:Math.floor(Date.now()/60000)*60000};
        result=await Simulator.simulate(initial,targets,durationMs,config,quote.seed,quote.simulatedAt);
        if (session.actor !== actor || fingerprint(actor,ui.settings) !== stamp || actor.fetchHp()<beforeHp || actor.fetchMp()<beforeMp) throw new Error('Character changed during calculation. No rewards were applied. Roll and calculate again.');
        quote.initial=initial;
        quote.result=result;
        quote.durationMs=durationMs;
        quote.summary=result.summary;
        ui.excludedDrops=new Set();
        ui.dropPage=0;
        ui.quote=quote;
        calculationPage(session);
        return;
    }
    if (!quote.result || !quote.initial) throw new Error('The calculated result is missing. Roll and calculate again.');
    if (quote.fingerprint !== stamp) throw new Error('Equipment, inventory, level, skills or location changed after calculation. The stored roll was not applied. Roll and calculate again.');
    initial=quote.initial;
    durationMs=quote.durationMs;
    result=structuredClone(quote.result);
    result.loot=result.loot.filter(row => row.selfId===57 || !ui.excludedDrops.has(row.selfId));
    result.summary.loot=result.summary.loot.filter(row => !ui.excludedDrops.has(row.selfId));
    await Queue.flushCharacter(actor.fetchId());
    permitted(session);
    if (fingerprint(actor,ui.settings)!==quote.fingerprint) throw new Error('Character changed before applying. No rewards were applied. Roll and calculate again.');
    const committed = await Database.instaHuntCommit({characterId:actor.fetchId(),token:quote.token,durationMs,before:{level:initial.level,exp:initial.exp,sp:initial.sp,inventoryStamp:Simulator.inventoryStamp(initial)},result});
    ui.quote=null;
    session.instaHuntCommitted=true;
    if (committed.duplicate) { send(session,summaryHtml(committed.summary)); return; }
    const summary=committed.summary;
    session.dataSendToMe(Response.speak({fetchId:()=>0,fetchName:()=> 'Insta Hunt'},{kind:0,text:`Completed: ${Math.floor(summary.elapsedMs/60000)}m ${Math.floor(summary.elapsedMs/1000)%60}s | ${summary.kills} kills | XP ${Math.floor(summary.exp).toLocaleString('en-US')} | Adena ${Math.floor(summary.adena).toLocaleString('en-US')}`}));
    actor.backpack.items=[];
    for (const row of committed.rows) actor.backpack.insertItem(row.id,row.selfId,{...row});
    const oldLevel=actor.fetchLevel();
    actor.setExpSp(result.exp,result.sp);
    actor.setLevel(result.level);
    invoke('GameServer/Actor/Generics/CalculateStats')(session,actor);
    actor.setHp(Math.min(actor.fetchMaxHp(),Math.max(1,result.hp)));
    actor.setMp(Math.min(actor.fetchMaxMp(),Math.max(0,result.mp)));
    actor.refreshVitalsRegeneration?.();
    Queue.vitals(actor.fetchId(),actor.fetchHp(),actor.fetchMaxHp(),actor.fetchMp(),actor.fetchMaxMp());
    if (result.level>oldLevel) {
        await actor.skillset.awardSkills(actor.fetchId(),actor.fetchClassId(),result.level);
        invoke('GameServer/Actor/Generics/CalculateStats')(session,actor);
        session.dataSendToMe(Response.skillsList(actor.skillset.fetchSkills()));
        session.dataSendToMeAndOthers?.(Response.socialAction(actor.fetchId(),15),actor);
    }
    session.dataSendToMe(Response.itemsList(actor.backpack.fetchItems()));
    session.dataSendToMe(Response.userInfo(actor));
    actor.statusUpdateVitals?.(actor);
    session.dataSendToOthers?.(Response.charInfo(actor),actor);
    send(session,summaryHtml(committed.summary)+'<br>'+Html.link('Back','insta-hunt reopen'));
    const victory=Response.socialAction(actor.fetchId(),3);
    if (session.dataSendToMeAndOthers) session.dataSendToMeAndOthers(victory,actor);
    else { session.dataSendToMe(victory); session.dataSendToOthers?.(victory,actor); }
    session.dataSendToMe(Response.playSound('ItemSound.quest_finish'));
}

async function handle(session,parts) {
    if (session.instaHuntBusy) return;
    if (parts[1]==='reopen') return open(session);
    session.instaHuntBusy=true;
    session.instaHuntStage=parts[1]==='start'?'APPLY':parts[1]==='estimate'?'CALCULATE':parts[1];
    session.instaHuntCommitted=false;
    try {
        permitted(session);
        const ui=session.instaHunt;
        if (!ui) throw new Error('Open Insta Hunt first.');
        const action=parts[1];
        if (action==='result') { calculationPage(session); return; }
        if (['drop','drop-all','drops-page'].includes(action)) {
            if (!ui.quote?.summary) throw new Error('Roll and calculate first.');
            if (action==='drop') {
                const id=Number(parts[2]);
                if (!ui.quote.summary.loot.some(row => row.selfId===id)) throw new Error('Invalid drop.');
                if (ui.excludedDrops.has(id)) ui.excludedDrops.delete(id); else ui.excludedDrops.add(id);
            } else if (action==='drop-all') {
                for (const row of ui.quote.summary.loot) {
                    if (parts[2]==='on') ui.excludedDrops.delete(row.selfId); else ui.excludedDrops.add(row.selfId);
                }
            }
            preview(session,action==='drops-page'?parts[2]:ui.dropPage);
            return;
        }
        if (action==='estimate' || action==='start') {
            if (action==='estimate' && parts[2] && parts[2] !== '$hunt_minutes') ui.minutes=minutes(parts[2]);
            return await calculate(session,action==='start',parts[2]);
        }
        if (action==='duration') {
            ui.minutes=minutes(parts[2]);
        } else if (action==='toggle') {
            const id=Number(parts[2]);
            if (!ui.targets.some(target => target.id===id)) throw new Error('Invalid monster.');
            if (ui.selected.has(id)) ui.selected.delete(id); else ui.selected.add(id);
        } else if (action==='select') ui.selected=parts[2]==='all'?new Set(ui.targets.map(target => target.id)):new Set();
        else if (action==='setting') {
            const key=parts[2];
            if (['shots','spoil','potions','stopShots'].includes(key)) ui.settings[key]=!ui.settings[key];
            else throw new Error('Invalid setting.');
        }
        render(session,action==='page'?parts[2]:ui.page);
    } catch(error) { fail(session,error); }
    finally { session.instaHuntBusy=false; }
}

module.exports = { open,handle,permitted,minutes,summaryHtml };
