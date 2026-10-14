const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const vm = require('vm');

const connections = [
    {
        name: 'src/GameServer/Network/Opcodes.js',
        exportName: 'Opcodes',
        marker: 'InstaHunt/Hooks',
        code: "if (require('fs').existsSync(require('path').resolve(__dirname, '../../../InstaHunt/Hooks.js'))) require('../../../InstaHunt/Hooks')(Opcodes.table);"
    },
    {
        name: 'src/Database.js',
        exportName: 'Database',
        marker: 'InstaHunt/Repository',
        dependencies: ['one', 'all', 'write', 'inTransaction', 'withCharacterFlush'],
        code: "if (require('fs').existsSync(require('path').resolve(__dirname, '../InstaHunt/Repository.js'))) Object.assign(Database, require('../InstaHunt/Repository')({ one, all, write, inTransaction, withCharacterFlush }));"
    }
];

function hash(text) {
    return crypto.createHash('sha256').update(text).digest('hex');
}

function strip(source, connection) {
    const newline = source.includes('\r\n') ? '\r\n' : '\n';
    let cleaned = source.split(connection.code + newline + newline).join('');
    cleaned = cleaned.split(connection.code + newline).join('');
    if (cleaned.includes(connection.marker)) throw new Error(`Unrecognized Insta Hunt connection: ${connection.name}. No files were changed.`);
    return cleaned;
}

function replacement(source, connection) {
    const anchor = new RegExp(`module\\.exports\\s*=\\s*${connection.exportName}\\s*;`, 'g');
    if ((source.match(anchor) || []).length !== 1) throw new Error(`The connection point in this server version is not supported: ${connection.name}. No files were changed.`);
    for (const name of connection.dependencies || []) {
        if (!new RegExp(`\\b(?:function\\s+${name}\\s*\\(|(?:const|let|var)\\s+${name}\\s*=)`).test(source)) throw new Error(`The server database interface has changed (${name}). A compatible Insta Hunt update is required. No files were changed.`);
    }
    const newline = source.includes('\r\n') ? '\r\n' : '\n';
    return source.replace(anchor, match => connection.code + newline + newline + match);
}

function atomicWrite(file, content) {
    const temporary = `${file}.instahunt-${crypto.randomBytes(6).toString('hex')}.tmp`;
    try {
        fs.writeFileSync(temporary, content);
        fs.renameSync(temporary, file);
    } finally {
        if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
}

function loadState(folder) {
    const file = path.join(folder, 'installation.json');
    if (!fs.existsSync(file)) return null;
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch { throw new Error('The installation record could not be read. No files were changed.'); }
}

function plan(root, folder, action) {
    const previous = loadState(folder);
    return connections.map(connection => {
        const file = path.join(root, connection.name);
        if (!fs.existsSync(file)) throw new Error(`Server file not found: ${connection.name}. Place the InstaHunt folder in the server main folder containing src and database.`);
        const source = fs.readFileSync(file, 'utf8');
        const clean = strip(source, connection);
        let updated = action === 'install' ? replacement(clean, connection) : clean;
        let restoredBackup = false;
        if (action === 'uninstall') {
            const record = previous?.action === 'install' && previous.files?.find(entry => entry.name === connection.name);
            if (record && hash(source) === record.installedHash) {
                const originalFile = path.resolve(folder, record.originalFile);
                if (!originalFile.startsWith(path.join(folder, 'backups') + path.sep)) throw new Error('Invalid backup path. No files were changed.');
                if (fs.existsSync(originalFile)) {
                    const original = fs.readFileSync(originalFile, 'utf8');
                    if (hash(original) === record.originalHash) {
                        updated = original;
                        restoredBackup = true;
                    }
                }
            }
        }
        new vm.Script(updated, { filename: connection.name });
        return { name: connection.name, file, source, clean, updated, restoredBackup };
    });
}

function apply(root, folder, action) {
    if (!['install', 'uninstall'].includes(action)) throw new Error('Invalid setup action.');
    const entries = plan(root, folder, action);
    const changed = entries.filter(entry => entry.source !== entry.updated);
    if (!changed.length) return { ok: true, action, changed: 0, message: action === 'install' ? 'Insta Hunt is already installed. The connections are up to date.' : 'The Insta Hunt connections are already removed.' };
    const session = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const backupFolder = path.join(folder, 'backups', session);
    fs.mkdirSync(backupFolder, { recursive: true });
    const manifest = { version: 2, action, createdAt: new Date().toISOString(), files: [] };
    for (const entry of entries) {
        const basename = entry.name.replace(/[\\/]/g, '_');
        fs.writeFileSync(path.join(backupFolder, `${basename}.before`), entry.source);
        fs.writeFileSync(path.join(backupFolder, `${basename}.original`), entry.clean);
        manifest.files.push({ name: entry.name, beforeHash: hash(entry.source), originalHash: hash(entry.clean), installedHash: hash(entry.updated), originalFile: path.relative(folder, path.join(backupFolder, `${basename}.original`)) });
    }
    fs.writeFileSync(path.join(backupFolder, 'manifest.json'), JSON.stringify(manifest, null, 2));
    const completed = [];
    try {
        for (const entry of changed) {
            if (fs.readFileSync(entry.file, 'utf8') !== entry.source) throw new Error('A server file changed during setup. Please try again.');
            atomicWrite(entry.file, entry.updated);
            completed.push(entry);
        }
        atomicWrite(path.join(folder, 'installation.json'), JSON.stringify(manifest, null, 2));
    } catch (error) {
        const failures = [];
        for (const entry of completed.reverse()) {
            try {
                if (fs.readFileSync(entry.file, 'utf8') !== entry.updated) throw new Error('The file was changed by another process');
                atomicWrite(entry.file, entry.source);
            } catch (restoreError) { failures.push(`${entry.name}: ${restoreError.message}`); }
        }
        if (failures.length) throw new Error(`${error.message}\nBackups: ${backupFolder}\nRollback could not be completed: ${failures.join('; ')}`);
        throw error;
    }
    const preservedUpdate = action === 'uninstall' && changed.some(entry => !entry.restoredBackup);
    return {
        ok: true, action, changed: changed.length, preservedUpdate,
        message: action === 'install'
            ? 'Insta Hunt has been installed. You can start your server normally.'
            : preservedUpdate
                ? 'Insta Hunt has been removed. Later server updates were preserved; only the Insta Hunt connections were removed.'
                : 'Insta Hunt has been removed. The original server files were restored from backup.'
    };
}

function ensureStopped(root) {
    const { DatabaseSync } = require('node:sqlite');
    const folder = path.join(root, 'tmp');
    if (!fs.existsSync(folder)) return () => {};
    const locks = [];
    try {
        for (const name of fs.readdirSync(folder).filter(name => name.endsWith('.access.sqlite'))) {
            const lock = new DatabaseSync(path.join(folder, name));
            locks.push(lock);
            lock.exec('PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE');
        }
    } catch {
        for (const lock of locks) { try { lock.close(); } catch {} }
        throw new Error('The server is running or the database is in use. Stop the server and try again.');
    }
    return () => { for (const lock of locks) lock.close(); };
}

function main() {
    const root = path.resolve(__dirname, '..');
    let release = () => {};
    try {
        release = ensureStopped(root);
        const result = apply(root, __dirname, process.argv[2] || 'install');
        console.log(JSON.stringify(result));
    } catch (error) {
        console.log(JSON.stringify({ ok: false, message: error.message }));
        process.exitCode = 1;
    } finally { release(); }
}

if (require.main === module) main();
module.exports = { apply, plan, strip, replacement, connections };
