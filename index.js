function setData(k, v) {
    vueApp[k] = v;
    console.log(`setData ${k} ${v}`);
}

let vueApp = new Vue({
    el: '#app',
    data: {
        status: 0,
        port: null,
        externalPort: null,
        assignedExternalPort: null,
        force: false,
        server: null,
        sockets: 0,
        sessionID: null,
        lastError: null
    },
    computed: {
        displayStatus() {
            switch (this.status) {
                case 4000: { // WS connection duplicated
                    return 'Server closed WS connection because it is duplicated';
                }
                case 4001: { // Session ended
                    return 'Session is ended by server';
                }
                case 4002: { // Auth timeout
                    return 'Authentication timed out. Wait for reconnect...';
                }
                case 4003: { // Selected port in use
                    return 'Selected external port is in use. Wait for reconnect...';
                }
                case 4004: { // No ports available on this server
                    return 'This server has no available ports. Wait for reconnect...';
                }
                case 4005: { // Invalid session ID on ressurection
                    return 'This session is no longer alive. Wait for reconnect...';
                }
                case 4006: { // aliveCheck timed out
                    return 'AliveCheck timed out. Wait for reconnect...';
                }
                case 0: return 'Not connected';
                case 1: return 'Connecting...';
                case 2: return 'Obtaining external port...';
                case 3: return 'Connected';
                default: {
                    return 'Something happened. Wait for reconnect...';
                }
            }
        }
    },
    methods: {
        connect() {
            if (this.status == 0) {
                /*
                status: 0,
                port: null,
                externalPort: null,
                force: false,
                server: ''
                */
               console.log('!port number ' + this.port);
               console.log('!externalPort number ' + this.externalPort);
               console.log('!force number ' + +this.force);
               console.log('!server string ' + this.server);
               console.log('>connect');
            }
            else console.log('>disconnect');
        }
    }
});