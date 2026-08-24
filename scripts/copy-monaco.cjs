const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

// Monaco 与 codicons 都从 node_modules 同步到 media, 使开发运行和 vsce 打包使用同一份资源路径。
const assets = [
    {
        name: 'Monaco Webview',
        source: path.join(root, 'node_modules', 'monaco-editor', 'min', 'vs'),
        target: path.join(root, 'media', 'monaco', 'vs'),
    },
    {
        name: 'Codicons',
        source: path.join(root, 'node_modules', '@vscode', 'codicons', 'dist'),
        target: path.join(root, 'media', 'codicons'),
        files: ['codicon.css', 'codicon.ttf'],
    },
];

for (const asset of assets) {
    if (!fs.existsSync(asset.source)) {
        throw new Error(`${asset.name} 资源不存在：${asset.source}`);
    }
    if (asset.files) {
        fs.mkdirSync(asset.target, { recursive: true });
        for (const file of asset.files) {
            const source = path.join(asset.source, file);
            if (!fs.existsSync(source)) {
                throw new Error(`${asset.name} 资源不存在：${source}`);
            }
            fs.copyFileSync(source, path.join(asset.target, file));
        }
    } else {
        fs.cpSync(asset.source, asset.target, { recursive: true, force: true });
    }
    console.log(`已同步 ${asset.name} 资源。`);
}
