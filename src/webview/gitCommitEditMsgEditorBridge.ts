import * as net from 'net';

const pipeName = process.env.VSCODE_GITK_EDITOR_PIPE;
const [, , commitMessagePath] = process.argv;
if (!pipeName || !commitMessagePath) {
    process.exit(1);
}

const socket = net.createConnection(pipeName, () => {
    socket.write(`${commitMessagePath}\n`);
});

let response = '';
socket.setEncoding('utf8');
socket.on('data', chunk => { response += chunk; });
socket.once('end', () => {
    process.exit(response.trim() === 'commit' ? 0 : 1);
});
socket.once('error', () => process.exit(1));
