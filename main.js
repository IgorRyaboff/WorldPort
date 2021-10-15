const { app, BrowserWindow } = require('electron');
const Electron = require('electron');
const path = require('path');
const net = require('net');
const tls = require('tls');
const WebSocket = require('websocket');
const fs = require('fs');
const API_VERSION = '1.0';

const dataDir = path.join(require('os').homedir(), '.worldport');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);
let config = {
    lastData: {
        server: null,
        externalPort: null,
        localIP: 'localhost',
        localPort: null,
        forceExternalPort: false,
        login: null
    },
    ignoreSSL: {},
    lockWindowOnRDP: true
};

function getVersion() {
    const package = require('./package.json');
    return app.isPackaged ? package.version : 'UNPACKAGED';
}

function formatDate(date) {
    const adjustZeros = (x, required = 2) => {
        x = String(x);
        while (x.length < required) x = '0' + x;
        return x;
    }
    if (!(date instanceof Date)) date = new Date(+date);

    let Y = date.getFullYear();
    let M = adjustZeros(date.getMonth() + 1);
    let D = adjustZeros(date.getDate());

    let h = adjustZeros(date.getHours());
    let m = adjustZeros(date.getMinutes());
    let s = adjustZeros(date.getUTCSeconds());
    let ms = adjustZeros(date.getMilliseconds(), 3);

    return `${D}.${M}.${Y} ${h}:${m}:${s}.${ms}`;
}
function unicodeEscape(str) {
    for (var result = '', index = 0, charCode; !isNaN(charCode = str.charCodeAt(index++));) {
        result += '\\u' + ('0000' + charCode.toString(16)).slice(-4);
    }
    return result;
}
function log(...args) {
    console.log(`[${formatDate(new Date)}]`, ...args);
    if (typeof win == 'object') win.webContents.executeJavaScript(`console.log('[MAIN ${formatDate(new Date)}] ' + decodeURI('${[...args].map(x => unicodeEscape(String(x))).join(' ')}'))`);
}

let data = {
    status: 0,
    localIP: '127.0.0.1',
    localPort: null,
    externalPort: null,
    assignedExternalPort: null,
    force: false,
    server: '',
    sockets: 0,
    sessionID: null,
    lastError: null,
    received: 0,
    sent: 0,
    authMethod: 'credentials',
    credsLogin: '',
    credsPassword: '',
    changed: false,
    closeWindow: false,
    receiving: false,
    sending: false,
    lastReceive: 0,
    lastSend: 0,
    aliveCheckInterval: 0,
    aliveCheckTimeout: Infinity,
    bandwidthLimit: 0,
    allowDevTools: false
};
function setData(key, value) {
    data[key] = value;
    data.changed = true;
    if (win) win.webContents.executeJavaScript(`setData('${key}', ${typeof value == 'string' ? `'${value}'` : value})`);

    updateTray();
    trayMenuTpl[1].enabled = data.status == 3;
    trayMenuTpl[1].label = data.status == 3 ? `Copy "${data.server.split(':')[0]}:${data.assignedExternalPort}"` : 'No external address';
    updateTray();
}

let win;
let winShowing = true;
function createWindow() {
    win = new BrowserWindow({
        width: 800,
        height: 600,
        maximizable: false,
        resizable: false,
        icon: './logo.ico',
        show: !process.argv.some(x => x.toLowerCase() == '-minimized')
    });
    win.setMenu(null);

    win.webContents.on('console-message', (_, __, msg) => {
        if (msg.startsWith('!')) {
            let key = msg.replace('!', '').split(' ')[0];
            let type = msg.split(' ')[1];
            let value = msg.split(' ').slice(2).join(' ');
            data[key] = type == 'number' ? +value : value;
            log(`setData ${key} ${type} ${value}`);
        }

        else if (msg.startsWith('>')) {
            switch (msg.replace('>', '')) {
                case 'connect': {
                    log('Manual connect');
                    if (ws) {
                        setData('status', 0);
                        if (wsCon) wsCon.close(1000);
                        else ws.abort();
                        ws = null;
                    }
                    else wsConnect();
                    break;
                }
                case 'disconnect': {
                    log('Manual disconnect');
                    setData('status', 0);
                    if (wsCon) {
                        wsCon.close(1000);
                    }
                    if (ws) {
                        ws.removeAllListeners();
                        ws.abort();
                    }
                    clearTimeout(reconTO);
                    break;
                }
                case 'init': {
                    for (let i in data) setData(i, data[i]);
                    break;
                }
                case 'about': {
                    Electron.dialog.showMessageBox(win, {
                        buttons: ['Close'],
                        title: 'About WorldPort',
                        message: `WorldPort v${getVersion()}`,
                        detail: `API v${API_VERSION}\n\n© 2021-${getVersion().substr(0, 4)} Igor Ryabov (https://github.com/IgorRyaboff)`,
                    });
                    break;
                }
                case 'devtools': {
                    win.webContents.openDevTools();
                    break;
                }
            }
        }
    });

    win.on('close', e => {
        e.preventDefault();
        hideWindow();
    });

    win.on('minimize', () => {
        console.log('MINIMIZING');
    });

    win.on('hide', () => {
        trayMenuTpl[0].enabled = true;
        updateTray();
        winShowing = false;
    });

    win.on('show', () => {
        trayMenuTpl[0].enabled = false;
        updateTray();
        winShowing = true;
    });

    win.loadFile('index.html');
}

let hideNotification = false;
function showWindow() {
    if (rdpRunning) Electron.dialog.showMessageBox(null, {
        buttons: ['OK'],
        title: 'WorldPort',
        message: `RDP detected`,
        type: 'warning',
        detail: `WorldPort detected RDP connection that go through it. Using GUI right now can cause WorldPort to hang up\nEnd the session to open window`,
    });
    else win.show();
}
function hideWindow() {
    win.hide();
    if (!hideNotification) {
        new Electron.Notification({ title: 'WorldPort is still running', body: 'Use tray to exit or reopen the window' }).show();
        hideNotification = true;
    }
}

/**
 * @type {Electron.Tray}
 */
let tray;

/**
 * @type {Electron.Menu}
 */
let trayMenu;
let trayMenuTpl = [
    { label: 'Open window', enabled: false, click() { showWindow() } },
    { label: 'No external address', enabled: false, click() { Electron.clipboard.writeText(`${data.server.split(':')[0]}:${data.assignedExternalPort}`, 'clipboard') } },
    { label: 'Quit', click() { process.exit() } }
];
app.whenReady().then(() => {
    createWindow();
    tray = new Electron.Tray(path.join(__dirname, 'logo.ico'));
    global.t = tray;
    updateTray();
    tray.on('double-click', () => winShowing || rdpRunning ? hideWindow() : showWindow());
});

function updateTray() {
    if (!tray) return;
    let txt;
    let icon;
    if (data.status == 0) {
        txt = 'Not connected';
        icon = 'logo';
    }
    else if (data.status == 1) {
        txt = 'Connecting...';
        icon = 'logo';
    }
    else if (data.status == 2) {
        txt = 'Connecting...';
        icon = 'logo';
    }
    else if (data.status == 3) {
        txt = `Exposing ${data.localIP}:${data.localPort} via ${data.server.split(':')[0]}:${data.assignedExternalPort}`;
        icon = 'logoActive'
    }
    else {
        txt = 'Reconnecting...';
        icon = 'logoErrored';
    }
    tray.setToolTip(`WorldPort v${getVersion()}\n${txt}`);
    
    trayMenu = Electron.Menu.buildFromTemplate(trayMenuTpl);
    tray.setContextMenu(trayMenu);
    tray.setImage(path.join(__dirname, icon + '.ico'));
}

app.on('window-all-closed', e => {
    e.preventDefault();
});

process.on("uncaughtException", function (e) {
    log(e);
});

let wsBuffer = [];
let wsCon;
function wsSend(e, data = {}) {
    data._e = e;
    if (wsCon) wsCon.sendUTF(JSON.stringify(data));
    else wsBuffer.push(data);

}

let sockets = {};

function dropSession() {
    log('Dropped session');
    setData('sessionID', null);
    Object.values(sockets).forEach(pair => pair[0].end());
    setData('sockets', 0);
    setData('received', 0);
    setData('sent', 0);
}

let reconTO;
let ws;
let rdpRunning = false;
function wsConnect() {
    if (ws) return;
    setData('status', 1);
    let hostname = data.server.split(':')[0].toLowerCase();
    if (config.ignoreSSL && config.ignoreSSL[hostname]) process.env.NODE_TLS_REJECT_UNAUTHORIZED = 0;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = 1;
    ws = new WebSocket.client();
    global.ws = ws;
    ws.on('connect', con => {
        setData('lastError', null);
        setData('status', 2);
        config.lastData = {
            server: data.server || null,
            externalPort: data.externalPort || null,
            localIP: data.localIP || null,
            localPort: data.localPort || null,
            forceExternalPort: !!data.forceExternalPort,
            login: data.login || null
        };
        fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify(config, null, 4));
        log('WS connected');
        let lastAliveCheck = new Date;
        let aliveCheckInterval;
        let aliveCheckTimeoutChecker = setInterval(() => {
            let time = new Date - lastAliveCheck;
            if (time >= data.aliveCheckTimeout) {
                log(`Server did not aliveCheck last ${data.aliveCheckTimeout} ms (${(time / 1000).toFixed(1)} s). Reconnecting...`);
                wsCon.close(4500);
            }
        }, 1000);
        let portObtainTO = setTimeout(() => {
            wsCon.close(4009);
        }, 5000);

        con.on('close', (code, desc) => {
            ws = false;
            wsCon = false;
            clearInterval(aliveCheckInterval);
            clearInterval(aliveCheckTimeoutChecker);
            clearInterval(portObtainTO);
            setData('aliveCheckTimeout', Infinity);
            log('WebSocket closed: ' + code, desc && desc.startsWith('!') ? desc : '');
            setData('status', code == 1000 ? 0 : code);
            switch (code) {
                case 1000: {
                    dropSession();
                    break;
                }
                case 4002: { // Auth timeout
                    reconTO = setTimeout(() => {
                        wsConnect();
                    }, 3000);
                    log('Authentication timed out. Trying again in 3 seconds...')
                    break;
                }
                case 4003: { // Selected port in use
                    dropSession();
                    reconTO = setTimeout(() => {
                        wsConnect();
                    }, 3000);
                    log('Selected external port is in use. Trying again in 3 seconds...');
                    break;
                }
                case 4004: { // No ports available on this server
                    dropSession();
                    reconTO = setTimeout(() => {
                        wsConnect();
                    }, 3000);
                    log('This server has no available ports. Trying again in 3 seconds...');
                    break;
                }
                case 4005: { // Invalid session ID on ressurection
                    dropSession();
                    reconTO = setTimeout(() => {
                        wsConnect();
                    }, 3000);
                    log('This session is no longer alive. Trying again in 3 seconds...');
                    break;
                }
                case 4006: { // aliveCheck timed out
                    reconTO = setTimeout(() => {
                        wsConnect();
                    }, 3000);
                    log('Server did not send aliveCheck in 20 seconds. Trying again in 3 seconds...');
                    break;
                }
                case 4007: { // Resurrect: wrong token
                    dropSession();
                    reconTO = setTimeout(() => {
                        wsConnect();
                    }, 3000);
                    log('Resurrect: wrong token. Trying again in 3 seconds...');
                    break;
                }
                case 4008: { // Auth failed
                    dropSession();
                    log('Auth failed. Connection will not be resurrected.');
                    setData('status', 0);
                    setData('lastError', 'Auth failed: wrong login or password');
                    break;
                }
                case 4009: { // Port obtain timeout
                    reconTO = setTimeout(() => {
                        wsConnect();
                    }, 3000);
                    log('Port obtain timed out. Trying again in 3 seconds...');
                    break;
                }
                default: {
                    reconTO = setTimeout(() => {
                        wsConnect();
                    }, 3000);
                    log('Something happened. Trying again in 3 seconds...');
                    break;
                }
            }
        });

        con.on('error', e => console.error(`Error in WebSocket: ${e}`));

        con.on('message', raw => {
            let msg;
            try {
                msg = JSON.parse(raw.utf8Data);
            }
            catch (_e) { }

            if (!msg || !msg._e) return;
            log(`${data.sessionID}: ${msg._e}`);
            switch (msg._e) {
                case 'aliveCheck': {
                    lastAliveCheck = new Date;
                    break;
                }
                case 'session.created': {
                    setData('sessionID', msg.id);
                    log(`Session ${msg.id} on ext port ${msg.port} created`);
                    setData('status', 3);
                    setData('assignedExternalPort', msg.port);
                    setData('aliveCheckInterval', msg.aliveCheckInterval);
                    setData('aliveCheckTimeout', msg.aliveCheckTimeout);
                    setData('bandwidthLimit', msg.bandwidthLimit);
                    aliveCheckInterval = setInterval(() => {
                        wsSend('aliveCheck');
                    }, msg.aliveCheckInterval);
                    clearTimeout(portObtainTO);
                    break;
                }
                case 's2.create': {
                    let s2 = tls.connect(data.assignedExternalPort + 10000, data.server.split(':')[0], () => {
                        log('S2 opened ' + msg.id);
                        if (sockets[msg.id]) {
                            sockets[msg.id][0].end();
                            sockets[msg.id][0] = s2;
                        }
                        else {
                            sockets[msg.id] = [s2, false, []];
                            setData('sockets', Object.keys(sockets).length);
                        }
                        s2.write(msg.id);

                        let s3Alive = false;
                        let buffer = [];
                        let s3 = new net.Socket();

                        let s2lastcount = 0;
                        let s2count = 0;
                        s2.on('data', chunk => {
                            if (s3Alive) s3.write(chunk);
                            else buffer.push(chunk);
                            s2count += chunk.length;
                            if (s2count - s2lastcount > 1024 * 512) {
                                setData('received', s2count);
                                s2lastcount = s2count;
                            }
                            data.lastReceive = new Date;
                        });
                        s2.on('close', () => s3.end() && log('S2 closed ' + msg.id));
                        s2.on('error', e => log(`Error in S3 #${msg.id}: ${e}`));

                        let s3lastcount = 0;
                        let s3count = 0;
                        s3.on('data', chunk => {
                            if (!rdpRunning && config.lockWindowOnRDP && chunk.slice(0, 4).compare(Buffer.from([3, 0, 0, 19])) == 0) {
                                rdpRunning = true;
                                if (winShowing) hideWindow();
                                log('RDP detected, window locked');
                            }
                            s2.write(chunk);
                            s3count += chunk.length;
                            if (s3count - s3lastcount > 1024 * 512) {
                                setData('sent', s3count);
                                s3lastcount = s3count;
                            }
                            data.lastSend = new Date;
                        });
                        s3.on('close', () => {
                            if (sockets[msg.id]) s2.end();
                            delete sockets[msg.id];
                            setData('sockets', Object.keys(sockets).length);
                            log('S3 closed ' + msg.id);
                            if (Object.keys(sockets).length == 0) rdpRunning = false;
                        });
                        s3.on('error', () => { });

                        s3.connect(data.localPort, data.localIP, () => {
                            log('S3 opened ' + msg.id);
                            s3Alive = true;
                            sockets[msg.id][1] = s3;
                            buffer.forEach(chunk => s3.write(chunk));
                            buffer = [];
                        });
                    });
                    break;
                }
            }
        });
        wsCon = con;
        wsBuffer.forEach(m => wsSend(m._e, m));
        wsBuffer = [];
    });
    ws.on('connectFailed', e => {
        ws = false;
        console.error('WebSocket failed: ' + e + '. Retrying in 3 seconds...', data.status, e);
        setData('lastError', String(e).split('\n')[0]);
        if (data.status != 0) reconTO = setTimeout(() => {
            wsConnect();
        }, 3000);
    });

    ws.connect(`wss://${data.server}${data.server.indexOf(':') == -1 ? ':100' : ''}`);
    if (data.sessionID) {
        wsSend('session.resurrect', {
            v: API_VERSION,
            id: data.sessionID
        });
        log('Resurrecting session', data.sessionID);
    }
    else {
        wsSend('session.create', {
            v: API_VERSION,
            externalPort: data.externalPort && !isNaN(data.externalPort) ? parseInt(data.externalPort) : null,
            forceExternalPort: Boolean(data.force),
            authMethod: data.authMethod,
            login: data.authMethod == 'credentials' ? data.credsLogin : undefined,
            password: data.authMethod == 'credentials' ? data.credsPassword : undefined,
        });
        log(`Creating new session for ${data.credsLogin}:${data.credsPassword.substr(0, 4)}***@${data.server}`);
    }
}

setInterval(() => {
    let receiving = new Date - data.lastReceive < 500;
    let sending = new Date - data.lastSend < 500;

    if (receiving != data.receiving) setData('receiving', receiving);
    if (sending != data.sending) setData('sending', sending);
}, 200);


if (fs.existsSync(path.join(dataDir, 'config.json'))) config = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json')).toString());
for (let i in config.lastData) setData(i, config.lastData[i]);
setData('allowDevTools', config.allowDevTools || false);
if (config.ignoreSSL && Object.values(config.ignoreSSL).some(x => x === true)) {
    log('config.verifySSL: SSL cert verification disabled for some hosts. You should only disable it for testing on your own server with self-signed certificate');
}
if (config.allowDevTools) log('config.allowDevTools: Chrome devtools enabled');
if (!config.lockWindowOnRDP) log('config.lockWindowOnRDP: RDP hangup glitch prevention disabled');
if (process.argv.some(x => x.toLowerCase() == '-minimized')) log('CLI args: Starting minimized');