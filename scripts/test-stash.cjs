const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { renderGitkWebviewHtml } = require('../out/webview/gitkWebviewDocument');

// Stash UI: 列表开关、穿插的 stash 行、空心菱形、自适应连线和右键菜单。
async function main() {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 520, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('https://gitk.test/codicon.ttf*', route => route.fulfill({
      body: fs.readFileSync(path.resolve(__dirname, '../media/codicons/codicon.ttf')),
      contentType: 'font/ttf', headers: { 'Access-Control-Allow-Origin': '*' },
    }));
    const css = fs.readFileSync(path.resolve(__dirname, '../media/codicons/codicon.css'), 'utf8')
      .replaceAll('./codicon.ttf', 'https://gitk.test/codicon.ttf');
    const theme = ':root{--vscode-editor-background:#181818;--vscode-editor-foreground:#cccccc;--vscode-foreground:#cccccc;--vscode-icon-foreground:#aeb4bc;--vscode-descriptionForeground:#929292;--vscode-editorGroup-border:#343434;--vscode-widget-border:#343434;--vscode-panel-border:#303030;--vscode-input-background:#1f1f1f;--vscode-input-foreground:#cccccc;--vscode-font-family:"Segoe UI";--vscode-font-size:13px;--vscode-editor-font-family:Arial;--vscode-editor-font-size:13px}';
    const html = renderGitkWebviewHtml('codicon.css').replace('<link rel="stylesheet" href="codicon.css">', () => '<style>' + theme + css + '</style>');
    const measureStart = html.indexOf('function measureExpandedCommitRows()');
    const measureEnd = html.indexOf('function renderCommitVirtualWindow', measureStart);
    const measureSource = html.slice(measureStart, measureEnd);
    assert.ok(measureStart >= 0 && measureSource.includes('expandedCommitRowHeights.set(key, height);'),
      'measurement still updates the virtual-list height cache');
    assert.ok(measureSource.includes('!commits[index].isStash'), 'stash lanes never re-enter measured-height SVG redraw');
    assert.equal(measureSource.includes('new ResizeObserver'), false, 'expanded stash correction does not reintroduce the rejected persistent observer solution');
    for (const match of html.matchAll(/<script(?![^>]*type="application\/json")[^>]*>([\s\S]*?)<\/script>/g)) new Function(match[1]);
    await page.evaluate(() => {
      window.messages = [];
      window.acquireVsCodeApi = () => ({ postMessage: message => window.messages.push(message), getState: () => ({}), setState() {} });
    });
    await page.setContent(html);

    const repoA = { path: 'file:///stash/a', label: 'repo-a' };
    const h = ch => ch.repeat(40);
    const branchOption = (repo, hash) => ({ repoOption: repo, name: 'refs/heads/main', label: 'main', kind: 'current', hash });
    // 一条线性历史 c3 -> c2 -> c1 -> c0; stash 挂在 c2 上 (宿主已把它穿插成 c2 之上的一行, 单一父提交 = 基线)。
    // stash 不是侧枝: 不开泳道、不占颜色, 落在基线所在列 (lane 0), 输入/输出泳道原样穿过。
    const lane = (hash, color) => ({ hash, color });
    const base = (hash, parent, message, extra) => ({ hash, shortHash: hash.slice(0, 8), key: repoA.path + ':' + hash, parents: parent ? [parent] : [], refs: [], message, rawMessage: message, body: '', author: 'me', authorEmail: 'me@example.com', authorDateLabel: 'today', authorDate: '2026-10-21T10:00:00+08:00', gitBranchOption: branchOption(repoA, hash), ...extra });
    const red = '#e06c75', blue = '#61afef';
    const commits = [
      base(h('3'), h('2'), 'c3 newest', { lane: 0, laneColor: red, inputSwimlanes: [], outputSwimlanes: [lane(h('2'), red)] }),
      // stash 行: 在 c2 之上, 落在 c2 所在列; 泳道状态原样穿过
      base(h('5'), h('2'), 'WIP on main: stash tip', { isStash: true, stashRef: 'stash@{0}', stashIndex: 0, lane: 0, indentDepth: 0,
        inputSwimlanes: [lane(h('2'), red)], outputSwimlanes: [lane(h('2'), red)] }),
      base(h('2'), h('1'), 'c2 base of stash', { lane: 0, laneColor: red,
        inputSwimlanes: [lane(h('2'), red)], outputSwimlanes: [lane(h('1'), red)] }),
      base(h('1'), h('0'), 'c1', { lane: 0, laneColor: red, inputSwimlanes: [lane(h('1'), red)], outputSwimlanes: [lane(h('0'), red)] }),
    ];
    const state = {
      repositoryChanges: [], branches: [branchOption(repoA, h('3'))], selectedBranches: ['refs/heads/main'], selectedRepositoryPaths: [repoA.path],
      commits: commits.filter(c => !c.isStash),
      workingTreeRows: [{ hash: 'uncommitted', label: 'Uncommitted Changes', repositoryPath: repoA.path, headHash: h('3'), enabled: true, stagedCount: 1, changesCount: 1 }],
      cloudGroups: [], showStashes: false, hiddenStashCount: 0, files: [], stagedFiles: [], unstagedFiles: [], filesLoading: false, filesMode: 'flat',
      selectedCommit: null, isLoading: false, hasMoreCommits: false,
    };
    const publish = () => page.evaluate(next => window.dispatchEvent(new MessageEvent('message', { data: { type: 'stateUpdate', state: next } })), JSON.parse(JSON.stringify(state)));
    const lastMessages = type => page.evaluate(wanted => window.messages.filter(m => m.type === wanted), type);
    await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'selectedRepoDisplayChanged', repository: { path: 'file:///stash/a', label: 'repo-a' } } })));
    await publish();

    // 1) 开关: 在 @仓库名 这一行的最右侧, 默认不选中, 使用 inbox 图标
    const toggle = page.locator('#stashListToggle');
    assert.equal(await toggle.count(), 1);
    assert.equal(await toggle.getAttribute('aria-pressed'), 'false', 'not selected by default');
    assert.equal(await toggle.locator('.codicon-inbox').count(), 1, 'the toggle uses the inbox codicon');
    assert.equal(await page.locator('#commitVirtualRows .commit-row.stash').count(), 0, 'no stash row while the toggle is off');
    assert.equal(await page.locator('#commitVirtualRows .commit-row:not(.stash)').count(), 3, 'ordinary commits are shown as usual');
    assert.match(await toggle.getAttribute('title'), /^显示 Stash/, 'the tooltip offers to show them');
    // 缺字段时同样视为未选中(旧版宿主不带 showStashes)
    delete state.showStashes; await publish();
    assert.equal(await toggle.getAttribute('aria-pressed'), 'false', 'a missing showStashes field is treated as off');
    state.showStashes = false;
    // 点击开关: 发 toggleStashes(true); 宿主随后下发含 stash 行的提交图
    await page.evaluate(() => { window.messages.length = 0; });
    await toggle.click();
    assert.deepEqual(await lastMessages('toggleStashes'), [{ type: 'toggleStashes', visible: true }]);
    assert.equal(await toggle.getAttribute('aria-pressed'), 'true', 'the click selects the toggle right away');
    assert.match(await toggle.getAttribute('title'), /^隐藏 Stash/, 'and the tooltip now offers to hide them');
    state.commits = commits; state.showStashes = true; await publish();
    assert.equal(await toggle.getAttribute('aria-pressed'), 'true', 'host state keeps the toggle on');
    assert.equal(await page.locator('#commitVirtualRows .commit-row.stash').count(), 1, 'the stash row appears once the host publishes it');
    const geometry = await page.evaluate(() => {
      const row = document.querySelector('.selector-row').getBoundingClientRect();
      const btn = document.getElementById('stashListToggle').getBoundingClientRect();
      const repo = document.getElementById('repositoryDisplay').getBoundingClientRect();
      return { rowRight: row.right, btnRight: btn.right, btnLeft: btn.left, repoRight: repo.right, rowPaddingRight: parseFloat(getComputedStyle(document.querySelector('.selector-row')).paddingRight) };
    });
    assert.ok(Math.abs(geometry.rowRight - geometry.rowPaddingRight - geometry.btnRight) < 1.5, 'the toggle sits at the far right of the repository row: ' + JSON.stringify(geometry));
    assert.ok(geometry.btnLeft >= geometry.repoRight - 0.5, 'and does not overlap the repository name: ' + JSON.stringify(geometry));

    // 2) stash 行穿插在提交之间: c3, stash, c2, c1; 没有独立的 stash 分组容器和标题
    assert.equal(await page.locator('#commitStashRows').count(), 0, 'no separate stash container any more');
    assert.equal(await page.locator('.stash-group-title').count(), 0, 'no stash group title');
    const order = await page.evaluate(() => [...document.querySelectorAll('#commitVirtualRows .commit-row')].map(row => (row.classList.contains('stash') ? 'stash:' : 'commit:') + row.querySelector('.commit-message-text').textContent));
    assert.deepEqual(order, ['commit:c3 newest', 'stash:WIP on main: stash tip', 'commit:c2 base of stash', 'commit:c1'], 'the stash row sits between its neighbours, right above its base commit');
    const stashRow = page.locator('#commitVirtualRows .commit-row.stash');
    assert.equal(await stashRow.count(), 1);
    // 标题前的 stash@{n} 徽章 (截图风格): 左侧洋红图标块里放 inbox 图标, 右侧深灰底放引用名, 整体灰色 1px 描边的圆角矩形
    {
      const badge = stashRow.locator('.stash-badge');
      assert.equal(await badge.count(), 1, 'one badge in front of the title');
      assert.equal(await stashRow.locator('.stash-ref').count(), 0, 'the old plain-text prefix is gone');
      assert.equal(await badge.locator('.stash-badge-text').textContent(), 'stash@{0}', 'the badge text is the stash reference');
      assert.equal(await badge.locator('.stash-badge-icon .codicon-inbox').count(), 1, 'the icon block holds the inbox codicon');
      // 徽章在标题前面: 同一个摘要容器里, 徽章是标题的前一个兄弟节点, 且徽章右边缘 <= 标题左边缘
      const order = await stashRow.locator('.col-main-summary').evaluate(summary => {
        const kids = [...summary.children].map(el => el.className.split(' ')[0]);
        const badge = summary.querySelector('.stash-badge').getBoundingClientRect(); const title = summary.querySelector('.commit-message-text').getBoundingClientRect();
        return { kids, gap: Math.round((title.left - badge.right) * 10) / 10 };
      });
      assert.deepEqual(order.kids, ['stash-badge', 'commit-message-text'], 'the badge comes first, then the title');
      assert.ok(order.gap >= 4 && order.gap <= 8, 'a small gap separates the badge from the title: ' + order.gap);
      // 样式逐项对照截图量到的值
      const look = await badge.evaluate(el => {
        const css = node => getComputedStyle(node);
        const box = el.getBoundingClientRect(); const icon = el.querySelector('.stash-badge-icon'); const text = el.querySelector('.stash-badge-text');
        return { border: css(el).borderTopColor + ' ' + css(el).borderTopWidth + ' ' + css(el).borderTopStyle, radius: css(el).borderTopLeftRadius, height: box.height,
          iconBg: css(icon).backgroundColor, iconColor: css(icon.querySelector('.codicon')).color, textBg: css(text).backgroundColor, textColor: css(text).color,
          iconRight: icon.getBoundingClientRect().right, textLeft: text.getBoundingClientRect().left };
      });
      assert.equal(look.border, 'rgb(105, 105, 105) 1px solid', 'grey 1px outline');
      assert.equal(look.radius, '4px', 'rounded rectangle');
      assert.equal(look.height, 20, 'same height as the other chips in the list');
      assert.equal(look.iconBg, 'rgb(217, 0, 143)', 'magenta icon block');
      assert.equal(look.iconColor, 'rgb(24, 24, 24)', 'dark inbox glyph, matching the editor background in the screenshot theme');
      assert.equal(look.textBg, 'rgb(34, 35, 36)', 'dark grey text area');
      assert.equal(look.textColor, 'rgb(187, 190, 191)', 'light grey text');
      assert.ok(Math.abs(look.iconRight - look.textLeft) < 0.6, 'the icon block and the text area touch, no gap between them');
      // 渲染后的像素: 图标块的底色真的是洋红, 且里面有深色的 inbox 字形 (不是白色图标)
      const iconBox = await badge.locator('.stash-badge-icon').boundingBox();
      const png = (await page.screenshot({ clip: { x: Math.floor(iconBox.x), y: Math.floor(iconBox.y), width: Math.ceil(iconBox.width), height: Math.ceil(iconBox.height) } })).toString('base64');
      const pixels = await page.evaluate(async b64 => {
        const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
        const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0);
        const px = ctx.getImageData(0, 0, c.width, c.height).data; let magenta = 0, dark = 0, white = 0;
        for (let i = 0; i < px.length; i += 4) { const [r, g, b] = [px[i], px[i + 1], px[i + 2]]; if (r > 190 && g < 40 && b > 110 && b < 170) magenta++; if (r < 70 && g < 70 && b < 70) dark++; if (r > 200 && g > 200 && b > 200) white++; }
        return { magenta, dark, white, w: c.width, h: c.height };
      }, png);
      assert.ok(pixels.magenta > 150, 'the icon block is really painted magenta: ' + JSON.stringify(pixels));
      assert.ok(pixels.dark >= 5, 'and carries a dark inbox glyph on it: ' + JSON.stringify(pixels));
      assert.ok(pixels.white < 5, 'the glyph is not white: ' + JSON.stringify(pixels));
    }

    // 3) 空心菱形节点 + 泳道线: 与圆点区分, 并且真的画进了图里
    assert.equal(await stashRow.locator('svg path.stash-node').count(), 1, 'the stash node is a diamond path');
    assert.equal(await stashRow.locator('svg circle').count(), 0, 'and not a circle');
    const ordinary = page.locator('#commitVirtualRows .commit-row:not(.stash)').first();
    assert.ok(await ordinary.locator('svg circle').count() >= 1, 'ordinary commits keep their circle nodes');
    const diamond = await stashRow.locator('svg path.stash-node').getAttribute('d');
    assert.match(diamond, /^M [\d.]+ [\d.]+ L [\d.]+ [\d.]+ L [\d.]+ [\d.]+ L [\d.]+ [\d.]+ Z$/, 'diamond outline: ' + diamond);
    const box = await stashRow.locator('svg path.stash-node').boundingBox();
    assert.ok(Math.abs(box.width - box.height) < 0.6, 'a diamond is as wide as it is tall: ' + JSON.stringify(box));
    // 灰色空心菱形 + 上下虚线: 上虚线 = 行顶 → 菱形上顶点, 下虚线 = 菱形下顶点 → 行底, 都是灰色虚线
    assert.equal(await stashRow.locator('svg path.stash-link-up').count(), 1, 'a dashed link above the diamond');
    assert.equal(await stashRow.locator('svg .stash-link-down').count(), 1, 'a dashed link below the diamond');
    for (const name of ['up', 'down']) {
      const link = await stashRow.locator('svg .stash-link-' + name).evaluate(node => ({ dash: node.getAttribute('stroke-dasharray'), stroke: node.getAttribute('stroke') }));
      const dashPair = link.dash.split(' ').map(Number);
      assert.ok(dashPair.length === 2 && dashPair.every(v => v >= 2) && dashPair[0] === dashPair[1],
        name + ' link is dashed with an equal on/off step of at least 2px (the exact step is aligned to the row boundary): ' + link.dash);
      assert.equal(link.stroke, 'var(--vscode-descriptionForeground, #999)', name + ' link is grey, not a lane colour');
    }
    const linkGeometry = await stashRow.locator('svg').evaluate(svg => {
      const num = s => Number(s);
      const d = el => el instanceof SVGLineElement
        ? [el.x1.baseVal.value, el.y1.baseVal.value, el.y2.baseVal.value]
        : el.getAttribute('d').match(/-?[\d.]+/g).map(num);
      const up = d(svg.querySelector('.stash-link-up')), down = d(svg.querySelector('.stash-link-down')), node = d(svg.querySelector('.stash-node'));
      return { upFrom: up[1], upTo: up[2], downFrom: down[1], nodeTop: node[1], nodeBottom: node[5], x: [up[0], down[0], node[0]] };
    });
    assert.equal(linkGeometry.upFrom, 0, 'the upper link starts at the top of the row');
    assert.equal(linkGeometry.upTo, linkGeometry.nodeTop, 'and ends at the top vertex of the diamond');
    assert.equal(linkGeometry.downFrom, linkGeometry.nodeBottom, 'the lower link starts at the bottom vertex of the diamond');
    assert.equal(new Set(linkGeometry.x).size, 1, 'both links and the diamond share one x (the base commit column)');
    // 空心: 描边是灰色, 内部是编辑器背景色(盖住穿过它的泳道线), 而不是实心
    const paint = await stashRow.locator('svg path.stash-node').evaluate(node => ({
      fill: node.getAttribute('fill'), stroke: node.getAttribute('stroke'), width: node.getAttribute('stroke-width'),
      computedFill: getComputedStyle(node).fill, computedStroke: getComputedStyle(node).stroke,
    }));
    assert.equal(paint.fill, 'var(--vscode-editor-background)', 'the inside is the editor background, so the diamond reads as hollow');
    assert.equal(paint.stroke, 'var(--vscode-descriptionForeground, #999)', 'the outline is grey');
    assert.equal(paint.width, '1.5', 'outline thick enough to read at this size, same as the lane lines');
    assert.notEqual(paint.computedFill, paint.computedStroke, 'fill and outline resolve to different colours');
    assert.equal(paint.computedFill, 'rgb(24, 24, 24)', 'and the resolved fill is the theme editor background (#181818)');
    // 菱形内部不能露出泳道线: 节点在泳道线之后绘制, 所以 stash-node 必须排在该行所有 path 的最后
    const nodeIsLast = await stashRow.locator('svg').evaluate(svg => {
      const paths = [...svg.querySelectorAll('path')];
      return paths[paths.length - 1].classList.contains('stash-node');
    });
    assert.equal(nodeIsLast, true, 'the diamond is painted after the lane lines, so its background fill covers the line under it');
    // 渲染后的像素: 中心是背景色(从节点向下的泳道线被盖住), 左顶点附近是泳道色(轮廓真的画出来了)。
    // 属性断言只能证明写了 fill/stroke; 空心要看实际绘制结果。
    {
      const nodeBox = await stashRow.locator('svg path.stash-node').boundingBox();
      const clip = { x: Math.floor(nodeBox.x) - 3, y: Math.floor(nodeBox.y) - 3, width: Math.ceil(nodeBox.width) + 8, height: Math.ceil(nodeBox.height) + 8 };
      const png = (await page.screenshot({ clip })).toString('base64');
      const cx = nodeBox.x + nodeBox.width / 2 - clip.x, cy = nodeBox.y + nodeBox.height / 2 - clip.y;
      const sample = (points) => page.evaluate(async ({ b64, points }) => {
        const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
        const canvas = document.createElement('canvas'); canvas.width = img.width; canvas.height = img.height;
        const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0);
        return points.map(([x, y]) => Array.from(ctx.getImageData(x, y, 1, 1).data));
      }, { b64: png, points });
      // 中心正下方 2~3px: 泳道线在这里穿过节点, 空心菱形的背景填充必须把它盖住
      const inside = await sample([[Math.floor(cx) - 1, Math.round(cy) + 2], [Math.floor(cx), Math.round(cy) + 2], [Math.floor(cx) - 1, Math.round(cy) + 3], [Math.floor(cx), Math.round(cy) + 3], [Math.floor(cx), Math.round(cy)]]);
      for (const [r, g, b] of inside) assert.ok(b < 70 && g < 70, 'inside the hollow diamond the lane line is covered by the background: ' + JSON.stringify(inside));
      // 左顶点附近 3x3: 至少有一个像素是灰色描边(#929292 与背景的混合, 红蓝绿接近且明显亮于背景), 不是泳道色
      const vx = Math.floor(nodeBox.x - clip.x), vy = Math.round(cy);
      const edge = await sample([-1, 0, 1].flatMap(dx => [-1, 0, 1].map(dy => [vx + 1 + dx, vy + dy])));
      assert.ok(edge.some(([r, g, b]) => r > 70 && Math.abs(r - g) < 14 && Math.abs(g - b) < 14), 'the outline near the left vertex is drawn in grey: ' + JSON.stringify(edge));
      assert.ok(!edge.some(([r, g, b]) => b > r + 60), 'and no pixel there is the blue lane colour: ' + JSON.stringify(edge));
    }
    // 普通提交仍是实心圆点, 没有被空心样式影响
    assert.equal(await ordinary.locator('svg circle').first().getAttribute('fill'), '#e06c75', 'ordinary/current commits keep a solid lane-coloured circle');

    // 3a) 必须和上下连在一起: 折叠、展开、再折叠三种状态下, 灰色虚线都从行顶画到菱形上顶点、从菱形下顶点画到行底,
    //     行边界处与相邻行的线首尾相接 (相邻行的线端点也在行边界上), 展开时下虚线一直延伸到被撑高的整行底部。
    {
      const readLinks = () => page.evaluate(() => [...document.querySelectorAll('#commitVirtualRows .commit-row')].map(row => {
        const svg = row.querySelector('svg.graph-svg');
        const parse = el => !el ? null : el instanceof SVGLineElement
          ? [el.x1.baseVal.value, el.y1.baseVal.value, el.y2.baseVal.value]
          : el.getAttribute('d').match(/-?[\d.]+/g).map(Number);
        return { stash: row.classList.contains('stash'), height: row.getBoundingClientRect().height, svgHeight: svg.getBoundingClientRect().height,
          up: parse(svg.querySelector('.stash-link-up')), down: parse(svg.querySelector('.stash-link-down')), node: parse(svg.querySelector('.stash-node')) };
      }));
      const assertJoined = (rows, label) => {
        const stashes = rows.filter(r => r.stash);
        assert.ok(stashes.length >= 1, label + ': there is a stash row');
        for (const r of stashes) {
          assert.equal(r.up[1], 0, label + ': upper dash starts at the very top of the row');
          assert.equal(r.up[2], r.node[1], label + ': upper dash ends at the diamond top vertex');
          assert.equal(r.down[1], r.node[5], label + ': lower dash starts at the diamond bottom vertex');
          assert.equal(r.down[2], r.svgHeight, label + ': lower dash reaches the very bottom of the row (' + r.svgHeight + ')');
          assert.ok(Math.abs(r.svgHeight - r.height) < 1, label + ': the svg is as tall as the row, so the bottom of the dash is the bottom of the row');
        }
      };
      assertJoined(await readLinks(), 'collapsed');
      // 展开第一条 stash: 先选中, 再点一次展开
      state.selectedCommit = { key: repoA.path + ':' + h('5'), hash: h('5'), repositoryPath: repoA.path, message: 'WIP on main: stash tip', body: '', kind: 'commit' };
      await publish();
      await stashRow.click();
      await page.waitForTimeout(150);
      const expandedRows = await readLinks();
      assert.ok(expandedRows.find(r => r.stash).height > 40, 'the stash row really grew when expanded');
      assertJoined(expandedRows, 'expanded');
      await stashRow.click();
      await page.waitForTimeout(150);
      assertJoined(await readLinks(), 'collapsed again');
      state.selectedCommit = null; await publish();

      // 3a.1) 坐标对齐还不够: dasharray 固定写 '2 2' 时, 线段长度往往让收尾正好落在空档里,
      //       于是行边界处有一截完全没画出来 (26px 行实测尾部空 1.5px), 视觉上就是"没有完全连接到下方 commit"。
      //       这里直接按渲染后的像素验证: stash 行上下边界、以及与相邻行交界处都必须有可见的笔迹。
      const dashPixels = await page.evaluate(() => {
        const row = document.querySelector('#commitVirtualRows .commit-row.stash');
        const svg = row.querySelector('svg.graph-svg');
        const box = svg.getBoundingClientRect();
        const read = el => {
          const dash = el.getAttribute('stroke-dasharray').split(' ').map(Number);
          const nums = el instanceof SVGLineElement
            ? [el.x1.baseVal.value, el.y1.baseVal.value, el.y2.baseVal.value]
            : el.getAttribute('d').match(/-?[\d.]+/g).map(Number);
          return { dash, from: nums[1], to: nums[2], cap: el.getAttribute('stroke-linecap'),
            offset: Number(el.getAttribute('stroke-dashoffset')) };
        };
        return { up: read(svg.querySelector('.stash-link-up')), down: read(svg.querySelector('.stash-link-down')), height: box.height };
      });
      // 统一样式契约: 每段都用固定的 2/2 + butt, 由 stroke-dashoffset 把相位锁到该段在行内的起点,
      // 因此所有段落(折叠/展开、stash/云端/未提交)共享同一条无限虚线的相位, 行边界处既不错位也不断口。
      const PERIOD = 4, ON = 2;
      for (const [name, link] of Object.entries({ up: dashPixels.up, down: dashPixels.down })) {
        assert.deepEqual(link.dash, [ON, PERIOD - ON], name + ': uses the single shared 2/2 lane dash: ' + JSON.stringify(link));
        assert.equal(link.cap, 'butt', name + ': butt caps keep the painted ends exactly on the row boundary');
        // 相位必须由该段起点的绝对位置决定(读渲染出来的 stroke-dashoffset, 不是重新算一遍),
        // 这样同一条泳道上下相邻的段落看起来才是连续的一条虚线。offset 写死成 0 必须失败。
        const expectedOffset = ((link.from % PERIOD) + PERIOD) % PERIOD;
        assert.ok(Math.abs(link.offset - expectedOffset) < 0.01,
          name + ': stroke-dashoffset locks the pattern to the absolute lane position (expected ' + expectedOffset.toFixed(3) + '): ' + JSON.stringify(link));
      }
    }

    // 3a.3) 夹在两个 commit 之间的 stash: 上方 commit "节点 → 行底" 的下半段也必须是灰色虚线,
    //       整条链是 节点 → 虚线 → 空心菱形 → 虚线 → 节点, 中间不能出现一段实线泳道。
    {
      const chain = await page.evaluate(() => {
        const rows = [...document.querySelectorAll('#commitVirtualRows .commit-row')];
        const stashIndex = rows.findIndex(r => r.classList.contains('stash'));
        const read = row => [...row.querySelectorAll('svg path')].map(p => {
          const d = p.getAttribute('d');
          const nums = d.match(/-?[\d.]+/g).map(Number);
          return { cls: p.getAttribute('class') || '', d, dash: p.getAttribute('stroke-dasharray'), from: nums[1], to: nums[2] };
        });
        return { above: read(rows[stashIndex - 1]), below: read(rows[stashIndex + 1]), stashIndex };
      });
      assert.ok(chain.stashIndex > 0, 'the stash sits between two commits in this fixture');
      // 上方 commit 的下半段 (从节点中线 13 画到行底 26)
      const lowerHalf = chain.above.find(p => p.from === 13);
      assert.ok(lowerHalf, 'the commit above the stash draws a lane segment from its node down to the row bottom: ' + JSON.stringify(chain.above));
      assert.ok(/stash-link-continuation/.test(lowerHalf.cls), 'and that segment is a stash link, not a plain solid lane: ' + JSON.stringify(lowerHalf));
      assert.ok(lowerHalf.dash && Number(lowerHalf.dash.split(' ')[0]) >= 2, 'it is dashed with a boundary-aligned step: ' + JSON.stringify(lowerHalf));
      assert.equal(chain.above.filter(p => !p.dash).length, 0, 'no solid lane line remains on the row directly above the stash: ' + JSON.stringify(chain.above));
      // 下方基线提交: 上半段虚线接住 stash, 下半段恢复成实线 (它下面没有 stash)
      const belowUpper = chain.below.find(p => p.from === 0);
      const belowLower = chain.below.find(p => p.from === 13);
      assert.ok(belowUpper && belowUpper.dash, 'the base commit below still joins the stash with a dashed upper half');
      assert.ok(belowLower && !belowLower.dash, 'but its lower half stays solid because no stash hangs under it: ' + JSON.stringify(belowLower));
    }

    // 3a.2) stash 挂在“最新提交”上: 基线提交此时没有 inputSwimlanes, 也必须主动补灰色虚线接住 stash。
    //        展开 stash 后, 下虚线到被撑高的行底；下一行最新提交的 continuation 从行顶画到节点, 两行边界没有空档。
    {
      const latestRows = [
        base(h('8'), h('3'), 'WIP on main: stash above latest', { isStash: true, stashRef: 'stash@{0}', stashIndex: 0, lane: 0, indentDepth: 0, inputSwimlanes: [], outputSwimlanes: [] }),
        base(h('3'), h('2'), 'c3 newest', { lane: 0, laneColor: red, inputSwimlanes: [], outputSwimlanes: [lane(h('2'), red)] }),
        base(h('2'), h('1'), 'c2 base', { lane: 0, laneColor: red, inputSwimlanes: [lane(h('2'), red)], outputSwimlanes: [lane(h('1'), red)] }),
        base(h('1'), h('0'), 'c1', { lane: 0, laneColor: red, inputSwimlanes: [lane(h('1'), red)], outputSwimlanes: [lane(h('0'), red)] }),
      ];
      state.commits = latestRows; state.showStashes = true; state.selectedCommit = null; await publish();
      const latestStash = page.locator('#commitVirtualRows .commit-row.stash').first();
      const latestBase = page.locator('#commitVirtualRows .commit-row[data-hash="' + h('3') + '"]');
      const continuation = latestBase.locator('svg path.stash-link-continuation');
      assert.equal(await continuation.count(), 1, 'latest commit gets a continuation although it has no input lane');
      const continuationPaint = await continuation.evaluate(node => ({ d: node.getAttribute('d'), dash: node.getAttribute('stroke-dasharray'), stroke: node.getAttribute('stroke') }));
      const continuationDash = continuationPaint.dash.split(' ').map(Number);
      assert.ok(continuationDash.length === 2 && continuationDash.every(v => v >= 2) && continuationDash[0] === continuationDash[1],
        'the continuation is dashed with a boundary-aligned step: ' + continuationPaint.dash);
      assert.equal(continuationPaint.stroke, 'var(--vscode-descriptionForeground, #999)');
      assert.match(continuationPaint.d, /^M [0-9.]+ 0 V [0-9.]+$/, 'the continuation starts at the very top of the latest commit row');
      const assertBoundaryJoin = async label => {
        const joined = await page.evaluate(({ stashHash, baseHash }) => {
          const stash = document.querySelector('#commitVirtualRows .commit-row[data-hash="' + stashHash + '"]');
          const base = document.querySelector('#commitVirtualRows .commit-row[data-hash="' + baseHash + '"]');
          const stashSvg = stash.querySelector('svg.graph-svg'), baseSvg = base.querySelector('svg.graph-svg');
          const nums = el => el instanceof SVGLineElement
            ? [el.x1.baseVal.value, el.y1.baseVal.value, el.y2.baseVal.value]
            : el.getAttribute('d').match(/-?[0-9.]+/g).map(Number);
          const down = nums(stashSvg.querySelector('.stash-link-down'));
          const cont = nums(baseSvg.querySelector('.stash-link-continuation'));
          const stashViewportHeight = stashSvg.getBoundingClientRect().height;
          const stashBox = stash.getBoundingClientRect(), baseBox = base.getBoundingClientRect();
          return { stashBottomPath: down[2], stashViewportBottom: stashViewportHeight, continuationStarts: cont[1], sameX: Math.abs(down[0] - cont[0]) < .01,
            adjacentRows: Math.abs(stashBox.bottom - baseBox.top) < 1, stashHeight: stashBox.height, stashSvgHeight: stashSvg.getBoundingClientRect().height };
        }, { stashHash: h('8'), baseHash: h('3') });
        assert.equal(joined.stashBottomPath, joined.stashViewportBottom, label + ': stash lower dash reaches the row bottom');
        assert.equal(joined.continuationStarts, 0, label + ': latest commit continuation starts at its row top');
        assert.equal(joined.sameX, true, label + ': both segments share one x');
        assert.equal(joined.adjacentRows, true, label + ': row bottom and next row top are adjacent');
        assert.ok(Math.abs(joined.stashHeight - joined.stashSvgHeight) < 1, label + ': expanded SVG fills the whole stash row');
        return joined;
      };
      const collapsedJoin = await assertBoundaryJoin('collapsed, stash above latest');
      assert.equal(collapsedJoin.stashHeight, 26);
      state.selectedCommit = { key: repoA.path + ':' + h('8'), hash: h('8'), repositoryPath: repoA.path, message: 'WIP on main: stash above latest', body: '', kind: 'commit' };
      await publish(); await latestStash.click(); await page.waitForTimeout(150);
      const expandedJoin = await assertBoundaryJoin('expanded, stash above latest');
      assert.ok(expandedJoin.stashHeight > 40, 'the latest stash row really expanded');
      // 恢复主测试数据
      state.commits = commits; state.selectedCommit = null; await publish();
    }

    // 3b) 文字效果与云端行完全一致: 同一个云端行样式探针 (颜色、字体样式、字重、字号、行内前缀) 逐项比较
    {
      const probe = (selector) => page.evaluate(sel => {
        const text = document.querySelector(sel + ' .commit-message-text');
        const style = getComputedStyle(text);
        const summary = text.parentElement;
        // 徽章 (stash-badge) 是 stash 行独有的前缀, 不参与"标题样式一致"的比较; 它的外观在上面单独断言。
        const others = [...summary.children].filter(el => !el.classList.contains('stash-badge'));
        return { color: style.color, fontStyle: style.fontStyle, fontWeight: style.fontWeight, fontSize: style.fontSize, textDecoration: style.textDecorationLine,
          siblingsBeforeTitle: others.indexOf(text), otherChildren: others.length };
      }, selector);
      // 云端行: 先把折叠条展开, 让 #commitCloudRows 里出现一行
      const cloudCommit = { hash: h('c'), shortHash: 'cccccccc', parents: [h('3')], message: 'cloud commit', rawMessage: 'cloud commit', body: '', author: 'me', authorDate: '2026-10-21T10:00:00+08:00', refs: [] };
      state.cloudGroups = [{ repositoryPath: repoA.path, repositoryLabel: repoA.label, branchLabel: 'main', count: 1, commits: [cloudCommit] }];
      await publish();
      await page.locator('#cloudCommitBars .cloud-commit-bar').first().click();
      assert.equal(await page.locator('#commitCloudRows .commit-row.cloud').count(), 1, 'a cloud row to compare against');
      const cloudText = await probe('#commitCloudRows .commit-row.cloud');
      const stashText = await probe('#commitVirtualRows .commit-row.stash');
      const ordinaryText = await probe('#commitVirtualRows .commit-row:not(.stash)');
      assert.deepEqual(stashText, cloudText, 'a stash row\'s title looks exactly like a cloud row\'s title');
      assert.notEqual(stashText.color, ordinaryText.color, 'and both are greyed relative to an ordinary commit');
      assert.equal(stashText.fontStyle, 'normal', 'not italic');
      // 高亮后只加粗: stash / 云端行都保持原来的 descriptionForeground，不再切换为普通前景色。
      const selectedStyle = async selector => {
        await page.evaluate(sel => document.querySelector(sel).classList.add('selected'), selector);
        const style = await page.evaluate(sel => {
          const css = getComputedStyle(document.querySelector(sel + ' .commit-message-text'));
          return { color: css.color, fontWeight: css.fontWeight };
        }, selector);
        await page.evaluate(sel => document.querySelector(sel).classList.remove('selected'), selector);
        return style;
      };
      const selectedStash = await selectedStyle('#commitVirtualRows .commit-row.stash');
      const selectedCloud = await selectedStyle('#commitCloudRows .commit-row.cloud');
      assert.equal(selectedStash.color, stashText.color, 'selected stash keeps its original grey colour');
      assert.equal(selectedCloud.color, cloudText.color, 'selected cloud row keeps its original grey colour');
      assert.equal(selectedStash.fontWeight, '600', 'selected stash is bold');
      assert.equal(selectedCloud.fontWeight, '600', 'selected cloud row is bold');
      state.cloudGroups = []; await publish();
    }
    // 3c) 图形窄带: 所有提交行（含 stash）用同一个泳道窄带宽度, 摘要区(文字所在区域)起点一致, 不随经过该行的泳道数忽左忽右。
    //     量 .col-main-summary 的左边缘而不是文字节点: stash 行的文字前面还有 stash@{n} 引用前缀, 文字本身会更靠右。
    {
      const xs = await page.evaluate(() => {
        const list = document.getElementById('commitVirtualRows').getBoundingClientRect();
        return [...document.querySelectorAll('#commitVirtualRows .commit-row')].map(row => Math.round((row.querySelector('.col-main-summary').getBoundingClientRect().left - list.left) * 10) / 10);
      });
      assert.equal(new Set(xs).size, 1, 'every main-line row starts its summary at the same x: ' + JSON.stringify(xs));
    }

    // 4) 点击 stash 行: 像普通提交一样选中并发出 selectCommit
    await page.evaluate(() => { window.messages.length = 0; });
    await stashRow.click();
    assert.deepEqual(await lastMessages('selectCommit'), [{ type: 'selectCommit', hash: h('5'), repositoryPath: repoA.path }]);

    // 5) 右键 stash 行: 只出现 apply / pop / drop 以及展开描述、复制 hash; 普通提交的动作和分隔线全部隐藏
    const menuState = () => page.evaluate(() => {
      const menu = document.getElementById('commitContextMenu');
      const shown = [...menu.querySelectorAll('[data-commit-action]')].filter(item => item.getClientRects().length > 0).map(item => item.getAttribute('data-commit-action'));
      const separators = [...menu.querySelectorAll('.context-menu-separator')].filter(item => item.getClientRects().length > 0).length;
      return { open: menu.matches(':popover-open'), shown, separators };
    });
    await stashRow.click({ button: 'right' });
    let menu = await menuState();
    assert.equal(menu.open, true, 'the context menu opens on a stash row');
    assert.deepEqual(menu.shown, ['toggleDescription', 'copyHash', 'stashApply', 'stashPop', 'stashDrop'], 'a stash row offers stash actions only');
    assert.equal(menu.separators, 1, 'commit-only separators are hidden, so the stash actions follow copy hash after a single separator');
    assert.equal(await page.locator('#commitContextMenu [data-commit-action="stashApply"] span').textContent(), 'apply stash');
    await page.evaluate(() => { window.messages.length = 0; });
    for (const action of ['stashApply', 'stashPop', 'stashDrop']) {
      await stashRow.click({ button: 'right' });
      await page.locator('#commitContextMenu [data-commit-action="' + action + '"]').click();
      assert.equal((await menuState()).open, false, action + ' closes the menu');
    }
    assert.deepEqual(await lastMessages('commitAction'), [
      { type: 'commitAction', action: 'stashApply', hash: h('5'), repositoryPath: repoA.path },
      { type: 'commitAction', action: 'stashPop', hash: h('5'), repositoryPath: repoA.path },
      { type: 'commitAction', action: 'stashDrop', hash: h('5'), repositoryPath: repoA.path },
    ], 'each stash action targets the right-clicked stash by hash');
    // 同一个菜单再用在普通提交上: 提交动作回来, stash 动作消失
    await ordinary.click({ button: 'right' });
    menu = await menuState();
    assert.equal(menu.open, true);
    assert.ok(menu.shown.includes('checkout') && menu.shown.includes('cherryPick') && menu.shown.includes('addTag'), 'an ordinary commit keeps its commit actions: ' + menu.shown);
    assert.ok(!menu.shown.some(action => action.startsWith('stash')), 'and shows no stash action: ' + menu.shown);
    assert.equal(menu.separators, 3, 'ordinary commits keep all three separators');
    await page.keyboard.press('Escape');
    assert.equal((await menuState()).open, false);
    // 复制 hash 对 stash 行同样可用
    await stashRow.click({ button: 'right' });
    await page.evaluate(() => { window.messages.length = 0; });
    await page.locator('#commitContextMenu [data-commit-action="copyHash"]').click();
    assert.deepEqual(await lastMessages('commitAction'), [{ type: 'commitAction', action: 'copyHash', hash: h('5'), repositoryPath: repoA.path }]);

    // 6) 展开: 描述里有 stash 引用, 没有分支信息
    state.selectedCommit = { key: repoA.path + ':' + h('5'), hash: h('5'), repositoryPath: repoA.path, message: 'WIP on main: stash tip', body: '', kind: 'commit' };
    await publish();
    await stashRow.click();
    assert.equal(await page.locator('#commitVirtualRows .commit-row.stash.expanded').count(), 1, 'a selected stash row expands on click');
    assert.match(await page.locator('#commitVirtualRows .commit-row.stash.expanded .commit-description').textContent(), /stash@\{0\}/);
    assert.equal(await stashRow.locator('.commit-row-ref').count(), 0, 'stash rows show no branch or tag chips');
    state.selectedCommit = null; await publish();

    // 7) 再次点击关闭: 发 toggleStashes(false); 宿主重建的提交图不再含 stash 行; 再点一次又回来
    await page.evaluate(() => { window.messages.length = 0; });
    await toggle.click();
    assert.deepEqual(await lastMessages('toggleStashes'), [{ type: 'toggleStashes', visible: false }]);
    assert.equal(await toggle.getAttribute('aria-pressed'), 'false');
    state.commits = commits.filter(c => !c.isStash); state.showStashes = false; await publish();
    assert.equal(await page.locator('#commitVirtualRows .commit-row.stash').count(), 0, 'hidden when the toggle is off');
    assert.equal(await toggle.getAttribute('aria-pressed'), 'false', 'host state keeps the toggle off');
    state.commits = commits; state.showStashes = true; await toggle.click(); await publish();
    assert.equal(await toggle.getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('#commitVirtualRows .commit-row.stash').count(), 1, 'shown again when re-selected');

    // 8) 基线未加载的 stash: 开关上如实提示数量
    state.hiddenStashCount = 2; await publish();
    assert.match(await toggle.getAttribute('title'), /另有 2 个 Stash 的基线提交尚未加载/);
    state.hiddenStashCount = 0; await publish();
    assert.doesNotMatch(await toggle.getAttribute('title'), /尚未加载/);


    // 为下面的"样式统一"检查补一组云端提交: 云端行的泳道也是虚线, 必须和 stash/未提交行同款。

    // 10a) 样式统一的根源检查: 泳道虚线只能有一个样式来源 laneDashAttrs()。
    //      云端行的虚线由这个 harness 之外的 cloudGroupsState 驱动(见 test-cloud-commits.cjs),
    //      DOM 里看不到, 所以在源码层面断言: 不允许任何地方再手写 dasharray/round 端点。
    {
      const panelSource = fs.readFileSync(path.resolve(__dirname, '../out/webview/commitListSubPanel.js'), 'utf8');
      const handWritten = panelSource.match(/stroke-dasharray="(?!' \+ LANE_DASH_ON)/g) || [];
      assert.deepEqual(handWritten, [],
        'every dashed lane goes through laneDashAttrs(); no hand-written stroke-dasharray remains');
      // 只约束"虚线"的端点: laneDashAttrs() 自带 butt。实线泳道仍可以用 round, 那是另一回事,
      // 所以这里断言的是 dasharray 与 round 不再出现在同一条 path 上。
      const dashedWithRound = (panelSource.match(/stroke-dasharray=[^>]*stroke-linecap="round"/g) || [])
        .concat(panelSource.match(/stroke-linecap="round"[^>]*stroke-dasharray=/g) || []);
      assert.deepEqual(dashedWithRound, [],
        'no dashed lane uses round caps (round adds half a stroke width at each end): ' + JSON.stringify(dashedWithRound));
      assert.ok(/const laneDashAttrs = function\(startY\)/.test(panelSource),
        'the single shared dash helper exists');
      assert.ok(/stroke-dashoffset="' \+ phase/.test(panelSource),
        'and it phase-locks the pattern with stroke-dashoffset');
    }

    // 10) 整个泳道的虚线样式必须统一: 云端行、未提交行、stash 行, 折叠或展开, 全都是同一组参数。
    //     之前按线段长度各自凑步长, 实测出现 2.0 / 2.5 / 2.6 三种疏密, 肉眼就能看出"样式不一样"。
    {
      const styles = await page.evaluate(() => {
        const seen = [];
        document.querySelectorAll('.commit-row [stroke-dasharray]').forEach(p => {
          const row = p.closest('.commit-row');
          seen.push({
            kind: row.classList.contains('cloud') ? 'cloud'
              : row.classList.contains('stash') ? 'stash'
                : row.classList.contains('working-tree') ? 'worktree' : 'commit',
            expanded: row.classList.contains('expanded'),
            dash: p.getAttribute('stroke-dasharray'),
            cap: p.getAttribute('stroke-linecap'),
            width: p.getAttribute('stroke-width'),
          });
        });
        return seen;
      });
      assert.ok(styles.length >= 2, 'several dashed lane segments are on screen: ' + JSON.stringify(styles));
      const kinds = new Set(styles.map(s => s.kind));
      // 此处没有展开云端分组（由 test-cloud-commits.cjs / test-stash-lane-layout.cjs 覆盖），这里能看到的是
      // stash 行、未提交行和普通提交行的虚线; 至少要跨两种行类型, 否则"统一"没有意义。
      assert.ok(kinds.has('stash'), 'stash dashed lanes are included: ' + JSON.stringify([...kinds]));
      assert.ok(kinds.size >= 2, 'the check spans more than one row type: ' + JSON.stringify([...kinds]));
      const signatures = [...new Set(styles.map(s => s.dash + '|' + s.cap + '|' + s.width))];
      assert.deepEqual(signatures, ['2 2|butt|1.5'],
        'every dashed lane segment shares one style regardless of row type or expansion: ' + JSON.stringify(styles));
    }

    assert.deepEqual(errors, [], 'no page errors: ' + errors.join('; '));
    console.log('Stash UI passed: toggle at the far right of the repository row (off by default, shows the stash rows when selected), stash rows interleaved between commits with a diamond node and lane lines, no separate group, a stash-only context menu (apply / pop / drop), hidden-count hint.');
  } finally { await browser.close(); }
}

main().catch(error => { console.error(error); process.exit(1); });
