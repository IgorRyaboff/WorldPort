const { app, BrowserWindow } = require('electron');
const Electron = require('electron');
const path = require('path');
const net = require('net');
const WebSocket = require('websocket');
const API_VERSION = '1.0';

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
function log(...args) {
    console.log(`[${formatDate(new Date)}]`, ...args);
    if (win) win.webContents.executeJavaScript(`console.log('[MAIN ${formatDate(new Date)}] ' + decodeURI('${[...args].map(x => encodeURI(x)).join(' ')}'))`);
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
    closeWindow: false
};
function setData(key, value) {
    data[key] = value;
    data.changed = true;
    if (win) win.webContents.executeJavaScript(`setData('${key}', ${typeof value == 'string' ? `'${value}'` : value})`);
    if (key == 'status') updateTrayTitle();
}

let win;
let winShowing = true;
function createWindow() {
    const wind = new BrowserWindow({
        width: 700,
        height: 400,
        //minimizable: false,
        maximizable: false,
        resizable: false,
        icon: './logo.png'
    });
    wind.setMenu(null);
    win = wind;

    wind.webContents.on('console-message', (_, __, msg) => {
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
                    if (data.changed) for (let i in data) setData(i, data[i]);
                    else {
                        let keys = [
                            'status',
                            'sockets',
                            'sessionID',
                            'lastError',
                            'received',
                            'sent'
                        ];

                        keys.forEach(i => setData(i, data[i]));
                    }
                    break;
                }
                case 'about': {
                    let package = require('./package.json');
                    Electron.dialog.showMessageBox(wind, {
                        buttons: ['Close'],
                        title: 'About WorldPort',
                        message: `WorldPort v${package.version}`,
                        detail: `API v${API_VERSION}\n\n© 2021-${package.version.substr(0, 4)} Igor Ryabov (https://github.com/IgorRyaboff)`,
                    });
                    break;
                }
                case 'devtools': {
                    wind.webContents.openDevTools();
                    break;
                }
            }
        }
    });

    wind.on('close', e => {
        e.preventDefault();
        hideWindow();
    });

    wind.on('minimize', () => {
        console.log('MINIMIZING');
    });

    wind.on('hide', () => {
        trayMenu.items[0].enabled = true;
        winShowing = false;
    });

    wind.on('show', () => {
        trayMenu.items[0].enabled = false;
        winShowing = true;
    });

    wind.loadFile('index.html');
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
app.whenReady().then(() => {
    createWindow();
    tray = new Electron.Tray(path.join(__dirname, 'logo.png'));
    trayMenu = Electron.Menu.buildFromTemplate([
        { label: 'Open window', enabled: false, click() { showWindow() } },
        { label: 'Quit', click() { process.exit() } }
    ]);
    tray.setContextMenu(trayMenu);
    updateTrayTitle();
    tray.on('double-click', () => winShowing || rdpRunning ? hideWindow() : showWindow());
});

function updateTrayTitle() {
    let txt;
    if (data.status == 0) txt = 'Not connected';
    else if (data.status == 1) txt = 'Connecting...';
    else if (data.status == 2) txt = 'Connecting...';
    else if (data.status == 3) txt = `Exposing ${data.localIP}:${data.localPort} via ${data.server}:${data.assignedExternalPort}`;
    else txt = 'Reconnecting...';
    tray.setToolTip(`WorldPort v${require('./package.json').version}\n${txt}`);
}

app.on('window-all-closed', e => {
    return e.preventDefault();
    if (process.platform !== 'darwin') {
        app.quit();
    }
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
    ws = new WebSocket.client();
    global.ws = ws;
    ws.on('connect', con => {
        setData('lastError', null);
        setData('status', 2);
        log('WS connected');
        let lastAliveCheck = new Date;
        let aliveCheckInterval = setInterval(() => {
            let time = new Date - lastAliveCheck;
            if (time >= 20000) {
                log(`Server did not aliveCheck last 20 seconds (${(time / 1000).toFixed(1)} s). Reconnecting...`);
                wsCon.close(4500);
            }
            else wsSend('aliveCheck');
        }, 10000);

        con.on('close', (code, desc) => {
            ws = false;
            wsCon = false;
            clearInterval(aliveCheckInterval);
            console.warn('WebSocket closed: ' + code, desc && desc.startsWith('!') ? desc : '');
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
                    log('Resurrect: wrong token. Connection will not be resurrected.');
                    break;
                }
                case 4008: { // Auth failed
                    dropSession();
                    log('Auth failed. Connection will not be resurrected.');
                    setData('status', 0);
                    setData('lastError', 'Auth failed: wrong login or password');
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
            log(`${msg.sessionID}: ${msg._e}`);
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
                    break;
                }
                case 'rps.create':
                case 's2.create': {
                    let s2 = new net.Socket();
                    s2.connect(data.assignedExternalPort + 10000, data.server, () => {
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
                            //log('S2 >> S3', [...chunk.slice(0, 10)].join(' '));
                            if (s3Alive) s3.write(chunk);
                            else buffer.push(chunk);
                            s2count += chunk.length;
                            if (s2count - s2lastcount > 1024 * 512) {
                                setData('received', s2count);
                                s2lastcount = s2count;
                            }
                        });
                        s2.on('close', () => s3.end() && log('S2 closed ' + msg.id));
                        s2.on('error', e => log(`Error in S3 #${msg.id}: ${e}`));

                        let s3lastcount = 0;
                        let s3count = 0;
                        s3.on('data', chunk => {
                            if (!rdpRunning && chunk.slice(0, 4).compare(Buffer.from([3, 0, 0, 19])) == 0) {
                                rdpRunning = true;
                                if (winShowing) hideWindow();
                                log('RDP detected, window locked');
                            }
                            //log('S2 << S3', [...chunk.slice(0, 10)].join(' '));
                            s2.write(chunk);
                            s3count += chunk.length;
                            if (s3count - s3lastcount > 1024 * 512) {
                                setData('sent', s3count);
                                s3lastcount = s3count;
                            }
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
        console.error('WebSocket failed: ' + e + '. Retrying in 3 seconds...', data.status);
        setData('lastError', String(e).split('\n')[0]);
        if (data.status != 0) reconTO = setTimeout(() => {
            wsConnect();
        }, 3000);
    });

    ws.connect(`ws://${data.server}${data.server.indexOf(':') == -1 ? ':100' : ''}`);
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