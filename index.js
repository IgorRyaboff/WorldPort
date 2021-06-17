function setData(k, v) {
    vueApp[k] = v;
    console.log(`setData ${k} ${v}`);
}

let vueApp = new Vue({
    el: '#app',
    data: {
        status: 0,
        localIP: '127.0.0.1',
        localPort: null,
        externalPort: null,
        assignedExternalPort: null,
        force: false,
        server: null,
        sockets: 0,
        sessionID: null,
        lastError: null,
        received: 0,
        sent: 0,
        authMethod: 'credentials',
        credsLogin: '',
        credsPassword: '',
        receiving: false,
        sending: false,
        aliveCheckInterval: 0,
        aliveCheckTimeout: Infinity
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
                case 4009: return 'Could not obtain port in time. Wait for reconnect...';
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
                console.log('!localIP string ' + this.localIP);
                console.log('!localPort number ' + this.localPort);
                console.log('!externalPort number ' + (this.externalPort || 0));
                console.log('!force number ' + +this.force);
                console.log('!server string ' + this.server);
                console.log('!credsLogin string ' + (this.authMethod == 'credentials' ? this.credsLogin : 'anon'));
                console.log('!credsPassword string ' + (this.authMethod == 'credentials' ? this.credsPassword : ''));
                console.log('!authMethod string ' + (this.authMethod == 'anon' ? 'credentials' : this.authMethod));
                console.log('>connect');

                localStorage.last = JSON.stringify({
                    localIP: this.localIP,
                    localPort: this.localPort,
                    externalPort: this.externalPort,
                    force: this.force,
                    server: this.server,
                    authMethod: this.authMethod,
                    credsLogin: this.credsLogin
                });
            }
            else console.log('>disconnect');
        },
        showAbout() {
            console.log('>about');
        }
    }
});
if (localStorage.last) {
    try {
        let data = JSON.parse(localStorage.last);
        for (let i in data) vueApp[i] = data[i];
    }
    catch (e) {
        if (!(e instanceof SyntaxError)) throw e;
        else delete localStorage.last;
    }
}

console.log('>init');