const { app, BrowserWindow } = require('electron');
const path = require('path');
const net = require('net');
const WebSocket = require('websocket');

let data = {
    status: 0,
    port: null,
    externalPort: null,
    assignedExternalPort: null,
    force: false,
    server: '',
    sockets: 0,
    sessionID: null,
    lastError: null
};
function setData(key, value) {
    data[key] = value;
    win.webContents.executeJavaScript(`setData('${key}', ${typeof value == 'string' ? `'${value}'` : value})`);
}

let win;
function createWindow() {
    const wind = new BrowserWindow({
        width: 800,
        height: 600,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js')
        }
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
let wsCon;
function wsSend(e, data = {}) {
    data._e = e;
    if (wsCon) wsCon.sendUTF(JSON.stringify(data));
    else wsBuffer.push(data);

}

let sockets = {};

function dropSession() {
    console.log('Dropped session');
    setData('sessionID', null);
    Object.values(sockets).forEach(pair => pair[0].end());
    setData('sockets', 0);
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
                console.log('Server did not aliveCheck last 20 seconds. Connection will beclosed');
                wsCon.close();
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
                case 'rps.create': {
                    let isocket = new net.Socket();
                    isocket.connect(data.externalPort + 10000, data.server, () => {
                        console.log('isocket opened ' + msg.id);
                        if (sockets[msg.id]) {
                            sockets[msg.id][0].end();
                            sockets[msg.id][0] = isocket;
                        }
                        else {
                            sockets[msg.id] = [ isocket, false, [] ];
                            setData('sockets', Object.keys(sockets).length);
                        }
                        isocket.write(msg.id);
    
                        let osocketAlive = false;
                        let buffer = [];
                        let osocket = new net.Socket();
    
                        isocket.on('data', chunk => {
                            if (osocketAlive) osocket.write(chunk);
                            else buffer.push(chunk);
                        });
                        isocket.on('close', () => osocket.end() && console.log('isocket closed ' + msg.id));
                        isocket.on('error', () => {});
    
                        osocket.on('data', chunk => {
                            isocket.write(chunk);
                        });
                        osocket.on('close', () => {
                            if (sockets[msg.id]) isocket.end();
                            delete sockets[msg.id];
                            setData('sockets', Object.keys(sockets).length);
                            console.log('osocket closed ' + msg.id);
                        });
                        osocket.on('error', () => {});
    
                        osocket.connect(data.port, '127.0.0.1', () => {
                            console.log('osocket opened ' + msg.id);
                            osocketAlive = true;
                            sockets[msg.id][1] = osocket;
                            buffer.forEach(chunk => osocket.write(chunk));
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
        setData('lastError', String(e));
        if (data.status != 0) reconTO = setTimeout(() => {
            wsConnect();
        }, 3000);
    });

    ws.connect(`ws://${data.server}:100`);
    if (data.sessionID) {
        wsSend('session.resurrect', {
            id: data.sessionID
        });
        console.log('Resurrecting session', data.sessionID);
    }
    else {
        wsSend('session.create', {
            externalPort: data.externalPort && !isNaN(data.externalPort) ? parseInt(data.externalPort) : null,
            forceExternalPort: Boolean(data.force)
        });
        console.log('Creating new session');
    }
}