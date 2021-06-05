const { app, BrowserWindow } = require('electron');
const path = require('path');
const net = require('net');
const WebSocket = require('websocket');

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
    recieved: 0,
    sent: 0,
    authMethod: 'anon',
    credsLogin: '',
    credsPassword: ''
};
function setData(key, value) {
    data[key] = value;
    win.webContents.executeJavaScript(`setData('${key}', ${typeof value == 'string' ? `'${value}'` : value})`);
}

let win;
function createWindow() {
    const wind = new BrowserWindow({
        width: 600,
        height: 350
    });
    win = wind;

    wind.webContents.on('console-message', (_, __, msg) => {
        if (msg.startsWith('!')) {
            let key = msg.replace('!', '').split(' ')[0];
            let type = msg.split(' ')[1];
            let value = msg.split(' ').slice(2).join(' ');
            data[key] = type == 'number' ? +value : value;
            console.log(`setData ${key} ${type} ${value}`);
        }

        else if (msg.startsWith('>')) {
            switch (msg.replace('>', '')) {
                case 'connect': {
                    console.log('Manual connect');
                    if (ws) {
                        setData('status', 0);
                        if (wsCon) wsCon.close(1000);
                        else ws.abort();
                    }
                    else wsConnect();
                    break;
                }
                case 'disconnect': {
                    console.log('Manual disconnect');
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
            }
        }
    });

    wind.loadFile('index.html');
}

app.whenReady().then(() => {
    createWindow()

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow()
        }
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit()
    }
});

process.on("uncaughtException", function (e) {
    console.log(e);
});

let wsBuffer = [];
/**
 * @type {WebSocket.connection}
 */
let wsCon;
function wsSend(e, data = {}) {
    if (e) data._e = e;
    if (wsCon) wsCon.sendUTF(JSON.stringify(data));
    else wsBuffer.push(data);

}
function wsSendBinary(tunnelID, data) {
    if (tunnelID) data = Buffer.from([...[...tunnelID].map(x => x.charCodeAt(0)), ...data]);
    if (wsCon) {
        wsCon.sendBytes(data);
        console.log(tunnelID || data.subarray(0, 2).toString(), 'sent binary');
    }
    else wsBuffer.push(data);
}

/**
 * @type {Object<string, [ net.Socket, Buffer[] ]>}
 */
let tunnels = {};

function dropSession() {
    console.log('Dropped session');
    setData('sessionID', null);
    Object.values(tunnels).forEach(pair => pair[0].end());
    setData('sockets', 0);
    setData('recieved', 0);
    setData('sent', 0);
}

let reconTO;
let ws;
function wsConnect() {
    if (ws) return;
    setData('status', 1);
    ws = new WebSocket.client();
    global.ws = ws;
    ws.on('connect', con => {
        setData('lastError', null);
        setData('status', 2);
        console.log('WS connected');
        let lastAliveCheck = new Date;
        let aliveCheckInterval = setInterval(() => {
            if (new Date - lastAliveCheck >= 20000) {
                console.log('Server did not aliveCheck last 20 seconds. Connection will be closed');
                wsCon.close(4500);
            }
            else wsSend('aliveCheck');
        }, 10000);

        con.on('close', code => {
            ws = false;
            wsCon = false;
            clearInterval(aliveCheckInterval);
            console.warn('WebSocket closed: ' + code);
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
                    console.log('Authentication timed out. Trying again in 3 seconds...')
                    break;
                }
                case 4003: { // Selected port in use
                    dropSession();
                    reconTO = setTimeout(() => {
                        wsConnect();
                    }, 3000);
                    console.log('Selected external port is in use. Trying again in 3 seconds...');
                    break;
                }
                case 4004: { // No ports available on this server
                    dropSession();
                    reconTO = setTimeout(() => {
                        wsConnect();
                    }, 3000);
                    console.log('This server has no available ports. Trying again in 3 seconds...');
                    break;
                }
                case 4005: { // Invalid session ID on ressurection
                    dropSession();
                    reconTO = setTimeout(() => {
                        wsConnect();
                    }, 3000);
                    console.log('This session is no longer alive. Trying again in 3 seconds...');
                    break;
                }
                case 4006: { // aliveCheck timed out
                    reconTO = setTimeout(() => {
                        wsConnect();
                    }, 3000);
                    console.log('Server did not send aliveCheck in 20 seconds. Trying again in 3 seconds...');
                    break;
                }
                case 4007: { // Resurrect: wrong token
                    dropSession();
                    console.log('Resurrect: wrong token. Connection will not be resurrected.');
                    break;
                }
                case 4008: { // Auth failed
                    dropSession();
                    console.log('Auth failed. Connection will not be resurrected.');
                    break;
                }
                default: {
                    reconTO = setTimeout(() => {
                        wsConnect();
                    }, 3000);
                    console.log('Something happened. Trying again in 3 seconds...');
                    break;
                }
            }
        });

        con.on('error', e => console.error(`Error in WebSocket: ${e}`));
    
        con.on('message', raw => {
            if (raw.type == 'binary') {
                let id = raw.binaryData.subarray(0, 2).toString();
                let data = raw.binaryData.slice(2);
                if (tunnels[id]) {
                    if (tunnels[id][0]) tunnels[id][0].write(data);
                    else tunnels[id][1].push(data);
                    console.log(id, 'received binary');
                }
                else console.log('unknown binary for ', id);
            }
            else {
                let msg;
                try {
                    msg = JSON.parse(raw.utf8Data);
                }
                catch (_e) { }
        
                if (!msg || !msg._e) return;
                console.log(`${msg.sessionID}: ${msg._e}`);
                switch (msg._e) {
                    case 'aliveCheck': {
                        lastAliveCheck = new Date;
                        console.log(data.sessionID + ': aliveCheck recieved');
                        break;
                    }
                    case 'session.created': {
                        setData('sessionID', msg.id);
                        console.log(`Session ${msg.id} on ext port ${msg.port} created`);
                        setData('status', 3);
                        setData('assignedExternalPort', msg.port);
                        break;
                    }
                    case 'tunnel.created': {
                        console.log('New tunnel ' + msg.id);
                        tunnels[msg.id] = [null, []];

                        let s2 = new net.Socket();
                        let s2lastcount = 0;
                        let s2count = 0;
                        s2.on('data', chunk => {
                            wsSendBinary(msg.id, chunk);
                            s2count += chunk.length;
                            if (s2count - s2lastcount > 1024 * 512) {
                                setData('sent', s2count);
                                s2lastcount = s2count;
                            }
                        });
                        s2.on('close', () => {
                            if (tunnels[msg.id]) {
                                delete tunnels[msg.id];
                                wsSend('tunnel.close', {
                                    id: msg.id
                                });
                                setData('sockets', Object.keys(tunnels).length);
                                console.log('S2 closed ' + msg.id);
                            }
                        });
                        s2.on('error', () => {});
                        
                        s2.connect(data.localPort, data.localIP, () => {
                            console.log('S2 opened ' + msg.id, tunnels[msg.id]);
                            if (!tunnels[msg.id]) {
                                s2.end();
                                return;
                            }
                            tunnels[msg.id][0] = s2;
                            tunnels[msg.id][1].forEach(chunk => s2.write(chunk));
                            tunnels[msg.id][1] = [];
                        });
                        break;
                    }
                    case 'tunnel.closed': {
                        if (tunnels[msg.id]) {
                            if (tunnels[msg.id][0]) tunnels[msg.id][0].end();
                            delete tunnels[msg.id];
                        }
                        console.log(`Tunnel #${msg.id} closed by server`);
                        break;
                    }
                }
            }
        });
        wsCon = con;
        wsBuffer.forEach(m => Buffer.isBuffer(m) ? wsSendBinary(null, m) : wsSend(null, m));
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
            id: data.sessionID
        });
        console.log('Resurrecting session', data.sessionID);
    }
    else {
        wsSend('session.create', {
            externalPort: data.externalPort && !isNaN(data.externalPort) ? parseInt(data.externalPort) : null,
            forceExternalPort: Boolean(data.force),
            authMethod: data.authMethod,
            login: data.authMethod == 'credentials' ? data.credsLogin : undefined,
            password: data.authMethod == 'credentials' ? data.credsPassword : undefined,
        });
        console.log(`Creating new session for ${data.credsLogin}:${data.credsPassword.substr(0, 4)}***@${data.server}`);
    }
}