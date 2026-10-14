module.exports = table => {
    const load = () => require('./Runtime');
    table[0x7f] = session => load().open(session);
    const html = table[0x21];
    table[0x21] = (session, buffer) => {
        const Packet = invoke('Packet/Receive');
        const packet = new Packet(buffer);
        packet.readS();
        const link = String(packet.data[0] || '');
        if (link.startsWith('insta-hunt ')) return load().handle(session, link.split(' '));
        return html(session, buffer);
    };
    const speak = table[0x38];
    table[0x38] = (session, buffer) => {
        const Packet = invoke('Packet/Receive');
        const packet = new Packet(buffer);
        packet.readS();
        if (/^\.(?:instahunt|hunt|h)\s*$/i.test(String(packet.data[0] || ''))) return load().open(session);
        return speak(session, buffer);
    };
    for (let index = 0; index < table.length; index++) {
        const previous = table[index];
        table[index] = (session, ...args) => {
            if (session.instaHuntBusy) {
                session.dataSendToMe(invoke('GameServer/Network/Response').actionFailed());
                return;
            }
            return previous(session, ...args);
        };
    }
    return table;
};
