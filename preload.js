const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('exposed', {
    Socket: require('net').Socket,
    bridge: global.bridge
});