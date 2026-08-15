// 零依赖 logo 光栅化: 与 media/gitk-logo.svg 使用同一套几何参数
// 用法: node scripts/gen-logo.cjs
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const BASE = 128;          // 设计坐标系
const SUPER = 1024;        // 超采样画布
const S = SUPER / BASE;
const OUT_SIZES = [256, 128];

// 透明底: 不再需要背景色, 节点抠边以 null 挖空
const RED = [224, 108, 117];
const BLUE = [97, 175, 239];
const GREY = [92, 99, 112];

// 三次贝塞尔折线化, 便于按距离做描边判定
function flattenCubic(p0, p1, p2, p3, steps) {
    const pts = [];
    for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const u = 1 - t;
        pts.push([
            u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
            u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
        ]);
    }
    return pts;
}

function distToSegment(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const lenSq = dx * dx + dy * dy;
    let t = lenSq === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / lenSq;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const cx = x1 + t * dx;
    const cy = y1 + t * dy;
    return Math.hypot(px - cx, py - cy);
}

function distToPolyline(px, py, pts) {
    let min = Infinity;
    for (let i = 0; i < pts.length - 1; i++) {
        const d = distToSegment(px, py, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]);
        if (d < min) { min = d; }
    }
    return min;
}

function roundRectHit(px, py, x, y, w, h, r) {
    if (px < x || py < y || px > x + w || py > y + h) { return false; }
    const ix = Math.min(Math.max(px, x + r), x + w - r);
    const iy = Math.min(Math.max(py, y + r), y + h - r);
    const dx = px - ix;
    const dy = py - iy;
    return dx * dx + dy * dy <= r * r;
}

const trunk = [[32, 32], [32, 108]];
const branchUp = flattenCubic([68, 64], [68, 48], [50, 32], [32, 32], 48);
const branchDown = flattenCubic([68, 64], [68, 80], [50, 96], [32, 96], 48);

// 顶层优先的命中列表 (绘制顺序的逆序)
const shapes = [
    { color: BLUE, hit: (x, y) => Math.hypot(x - 68, y - 64) <= 8 },
    { color: null, hit: (x, y) => Math.hypot(x - 68, y - 64) <= 9.25 },
    { color: RED, hit: (x, y) => Math.hypot(x - 32, y - 96) <= 8 },
    { color: null, hit: (x, y) => Math.hypot(x - 32, y - 96) <= 9.25 },
    { color: RED, hit: (x, y) => Math.hypot(x - 32, y - 32) <= 4.5 },
    { color: RED, hit: (x, y) => { const d = Math.hypot(x - 32, y - 32); return d >= 8.25 && d <= 11.75; } },
    { color: null, hit: (x, y) => Math.hypot(x - 32, y - 32) <= 11.75 },
    { color: BLUE, hit: (x, y) => distToPolyline(x, y, branchUp) <= 1.75 },
    { color: BLUE, hit: (x, y) => distToPolyline(x, y, branchDown) <= 1.75 },
    { color: RED, hit: (x, y) => distToPolyline(x, y, trunk) <= 1.75 },
    { color: GREY, hit: (x, y) => roundRectHit(x, y, 84, 29, 30, 6, 3) },
    { color: GREY, hit: (x, y) => roundRectHit(x, y, 84, 61, 24, 6, 3) },
    { color: GREY, hit: (x, y) => roundRectHit(x, y, 84, 93, 28, 6, 3) },
];

// 超采样缓冲, 预乘 alpha 便于降采样
const src = new Uint8Array(SUPER * SUPER * 4);
for (let py = 0; py < SUPER; py++) {
    const y = (py + 0.5) / S;
    for (let px = 0; px < SUPER; px++) {
        const x = (px + 0.5) / S;
        for (const shape of shapes) {
            if (!shape.hit(x, y)) { continue; }
            // color 为 null 表示抠空区, 命中即终止且保持透明
            if (shape.color === null) { break; }
            const o = (py * SUPER + px) * 4;
            src[o] = shape.color[0];
            src[o + 1] = shape.color[1];
            src[o + 2] = shape.color[2];
            src[o + 3] = 255;
            break;
        }
    }
}

function downsample(size) {
    const f = SUPER / size;
    const out = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            let r = 0, g = 0, b = 0, a = 0;
            for (let sy = 0; sy < f; sy++) {
                for (let sx = 0; sx < f; sx++) {
                    const o = (((y * f + sy) | 0) * SUPER + ((x * f + sx) | 0)) * 4;
                    const sa = src[o + 3] / 255;
                    r += src[o] * sa;
                    g += src[o + 1] * sa;
                    b += src[o + 2] * sa;
                    a += sa;
                }
            }
            const n = f * f;
            const alpha = a / n;
            const o = (y * size + x) * 4;
            out[o] = alpha > 0 ? Math.round(r / n / alpha) : 0;
            out[o + 1] = alpha > 0 ? Math.round(g / n / alpha) : 0;
            out[o + 2] = alpha > 0 ? Math.round(b / n / alpha) : 0;
            out[o + 3] = Math.round(alpha * 255);
        }
    }
    return out;
}

const crcTable = (() => {
    const table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) { c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; }
        table[n] = c;
    }
    return table;
})();

function crc32(buf) {
    let c = -1;
    for (let i = 0; i < buf.length; i++) { c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8); }
    return (c ^ -1) >>> 0;
}

function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([len, body, crc]);
}

function writePng(file, rgba, size) {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(size, 0);
    ihdr.writeUInt32BE(size, 4);
    ihdr[8] = 8;   // bit depth
    ihdr[9] = 6;   // RGBA
    const raw = Buffer.alloc((size * 4 + 1) * size);
    for (let y = 0; y < size; y++) {
        raw[y * (size * 4 + 1)] = 0; // filter none
        Buffer.from(rgba.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
    }
    const png = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
        chunk('IEND', Buffer.alloc(0)),
    ]);
    fs.writeFileSync(file, png);
    console.log('wrote', file, size + 'x' + size);
}

const mediaDir = path.join(__dirname, '..', 'media');
for (const size of OUT_SIZES) {
    const name = size === 256 ? 'gitk-logo.png' : `gitk-logo-${size}.png`;
    writePng(path.join(mediaDir, name), downsample(size), size);
}
