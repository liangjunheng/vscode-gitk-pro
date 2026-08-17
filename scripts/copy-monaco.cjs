const fs = require('fs');
const path = require('path');

const source = path.join(__dirname, '..', 'node_modules', 'monaco-editor', 'min', 'vs');
const target = path.join(__dirname, '..', 'media', 'monaco', 'vs');

if (!fs.existsSync(source)) {
    throw new Error(`Monaco 资源不存在：${source}`);
}

fs.cpSync(source, target, { recursive: true, force: true });
console.log('已同步 Monaco Webview 资源。');
