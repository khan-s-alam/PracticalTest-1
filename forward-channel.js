const {
    makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    proto,
    getBinaryNodeChild,
    getBinaryNodeChildren,
    S_WHATSAPP_NET
} = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const fs = require('fs/promises');
const path = require('path');

const APP_CONFIG_FILE = path.join(__dirname, 'config.json');
const FORWARD_CONFIG_FILE = path.join(__dirname, 'forward-config.json');
const GROUP_JID_MAP_FILE = path.join(__dirname, 'group-jid-map.json');
const AUTH_DIRECTORY = path.join(__dirname, 'auth_info');
const BATCH_SIZE = 5;

async function readJsonFile(filePath) {
    try {
        return JSON.parse(await fs.readFile(filePath, 'utf8'));
    } catch (err) {
        if (err.code === 'ENOENT') {
            throw new Error(`Required configuration file not found: ${filePath}`);
        }
        throw err;
    }
}

async function loadConfig() {
    const appConfig = await readJsonFile(APP_CONFIG_FILE);
    const forwardConfig = await readJsonFile(FORWARD_CONFIG_FILE);

    if (!Array.isArray(appConfig.groups) || appConfig.groups.length === 0) {
        throw new Error(`${APP_CONFIG_FILE} must contain a non-empty "groups" array`);
    }
    if (typeof forwardConfig.channelInviteLink !== 'string' ||
        !URL.canParse(forwardConfig.channelInviteLink) ||
        !new URL(forwardConfig.channelInviteLink).pathname.includes('/channel/')) {
        throw new Error(`${FORWARD_CONFIG_FILE} must contain a valid WhatsApp channelInviteLink`);
    }
    const batchDelayMs = forwardConfig.batchDelayMs ?? 5000;
    if (!Number.isInteger(batchDelayMs) || batchDelayMs < 0) {
        throw new Error(`${FORWARD_CONFIG_FILE} batchDelayMs must be a non-negative integer`);
    }

    const inviteCodes = new Set();
    const groups = appConfig.groups.flatMap((group, index) => {
        if (!group || typeof group !== 'object' || Array.isArray(group)) {
            throw new Error(`Group #${index + 1} in ${APP_CONFIG_FILE} must be an object`);
        }
        const codes = Array.isArray(group.inviteCodes)
            ? group.inviteCodes
            : [group.inviteCode];
        if (codes.length === 0 || codes.some(code => typeof code !== 'string' || !code.trim())) {
            throw new Error(`Group #${index + 1} in ${APP_CONFIG_FILE} must have a non-empty "inviteCodes" array or an "inviteCode"`);
        }
        return codes.map(code => {
            const inviteCode = code.trim();
            if (inviteCodes.has(inviteCode)) {
                throw new Error(`Duplicate invite code in ${APP_CONFIG_FILE}: ${inviteCode}`);
            }
            inviteCodes.add(inviteCode);
            return { inviteCode };
        });
    });

    return {
        groups,
        channelInviteLink: forwardConfig.channelInviteLink,
        batchDelayMs
    };
}

async function loadGroupJidMap() {
    let contents;
    try {
        contents = await fs.readFile(GROUP_JID_MAP_FILE, 'utf8');
    } catch (err) {
        if (err.code === 'ENOENT') {
            return {};
        }
        throw err;
    }
    const map = JSON.parse(contents);
    if (!map || typeof map !== 'object' || Array.isArray(map)) {
        throw new Error(`${GROUP_JID_MAP_FILE} must contain an object`);
    }
    for (const [code, jid] of Object.entries(map)) {
        if (typeof jid !== 'string' || !jid.endsWith('@g.us')) {
            throw new Error(`Invalid group JID for invite code "${code}" in ${GROUP_JID_MAP_FILE}`);
        }
    }
    return map;
}

async function saveGroupJidMap(groupJidMap) {
    await fs.writeFile(GROUP_JID_MAP_FILE, `${JSON.stringify(groupJidMap, null, 2)}\n`, 'utf8');
}

function parseNewsletterMessage(node, channelJid) {
    const plaintext = getBinaryNodeChild(node, 'plaintext');
    if (!plaintext?.content) {
        return null;
    }

    const content = typeof plaintext.content === 'string'
        ? Buffer.from(plaintext.content, 'binary')
        : Buffer.from(plaintext.content);
    const message = proto.Message.decode(content);
    const id = node.attrs?.server_id || node.attrs?.id;
    if (!id || !message) {
        return null;
    }

    return proto.WebMessageInfo.fromObject({
        key: { remoteJid: channelJid, id, fromMe: false },
        message: message.toJSON(),
        messageTimestamp: Number(node.attrs?.t || 0)
    }).toJSON();
}

async function fetchLatestNewsletterMessages(sock, channelJid) {
    const response = await sock.query({
        tag: 'iq',
        attrs: {
            id: sock.generateMessageTag(),
            type: 'get',
            to: S_WHATSAPP_NET,
            xmlns: 'newsletter'
        },
        content: [{
            tag: 'messages',
            attrs: {
                type: 'jid',
                jid: channelJid,
                count: '2'
            }
        }]
    });

    const messagesNode = getBinaryNodeChild(response, 'messages');
    const messages = getBinaryNodeChildren(messagesNode, 'message')
        .map(node => parseNewsletterMessage(node, channelJid))
        .filter(Boolean)
        .sort((a, b) => Number(a.messageTimestamp) - Number(b.messageTimestamp))
        .slice(-2);

    if (messages.length === 0) {
        throw new Error('The channel query returned no posts with readable message content.');
    }
    return messages;
}

function getChannelInviteCode(inviteLink) {
    const segments = new URL(inviteLink).pathname.split('/').filter(Boolean);
    return segments[segments.length - 1];
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function startForwarder() {
    const config = await loadConfig();
    const groupJidMap = await loadGroupJidMap();
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIRECTORY);
    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        generateHighQualityLinkPreview: true
    });
    let forwardingStarted = false;
    let stopping = false;

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', async update => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            qrcode.generate(qr, { small: true });
        }
        if (connection === 'close') {
            if (stopping) {
                return;
            }
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            if (statusCode !== DisconnectReason.loggedOut) {
                console.log('Connection closed; reconnecting in 3 seconds.');
                setTimeout(startForwarder, 3000);
            } else {
                console.error('WhatsApp logged out. Scan a new QR code to sign in.');
            }
            return;
        }
        if (connection !== 'open' || forwardingStarted) {
            return;
        }

        forwardingStarted = true;
        try {
            const inviteCode = getChannelInviteCode(config.channelInviteLink);
            const channel = await sock.newsletterMetadata('invite', inviteCode);
            if (!channel?.id) {
                throw new Error('Could not resolve the WhatsApp channel from the invite link');
            }
            console.log(`Fetching the latest two posts from channel ${channel.id}...`);
            const messages = await fetchLatestNewsletterMessages(sock, channel.id);
            console.log(`Fetched ${messages.length} channel post(s).`);

            for (let batchStart = 0; batchStart < config.groups.length; batchStart += BATCH_SIZE) {
                const batch = config.groups.slice(batchStart, batchStart + BATCH_SIZE);
                console.log(`Forwarding to group batch ${Math.floor(batchStart / BATCH_SIZE) + 1} (${batch.length} group(s))...`);

                for (const { inviteCode: code } of batch) {
                    let groupJid = groupJidMap[code];
                    if (!groupJid) {
                        const groupInfo = await sock.groupGetInviteInfo(code);
                        groupJid = groupInfo.id;
                        groupJidMap[code] = groupJid;
                        await saveGroupJidMap(groupJidMap);
                    }

                    for (const message of messages) {
                        await sock.sendMessage(groupJid, { forward: message, force: true });
                        console.log(`Forwarded channel post ${message.key.id} to ${groupJid}`);
                    }
                }

                if (batchStart + BATCH_SIZE < config.groups.length && config.batchDelayMs > 0) {
                    await delay(config.batchDelayMs);
                }
            }

            console.log('Channel forwarding completed.');
        } catch (err) {
            console.error('Channel forwarding failed:', err);
        } finally {
            stopping = true;
            await sock.end(undefined);
        }
    });
}

startForwarder().catch(err => {
    console.error('Unable to start channel forwarder:', err);
    process.exitCode = 1;
});
