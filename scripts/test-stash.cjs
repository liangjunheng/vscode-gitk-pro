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
    assert.equal(measureSource.includes('drawSvg('), false, 'virtual-list height measurement never redraws either real or stash lanes');
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
    // 数据中的 lane 是基线锚点；展示侧枝只由 Webview 为 stash 行添加，真实泳道状态原样穿过。
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
      commits,
      workingTreeRows: [{ hash: 'uncommitted', label: 'Uncommitted Changes', repositoryPath: repoA.path, headHash: h('3'), enabled: true, stagedCount: 1, changesCount: 1 }],
      cloudGroups: [], showStashes: true, hiddenStashCount: 0, files: [], stagedFiles: [], unstagedFiles: [], filesLoading: false, filesMode: 'flat',
      selectedCommit: null, isLoading: false, hasMoreCommits: false,
    };
    const publish = () => page.evaluate(next => window.dispatchEvent(new MessageEvent('message', { data: { type: 'stateUpdate', state: next } })), JSON.parse(JSON.stringify(state)));
    const lastMessages = type => page.evaluate(wanted => window.messages.filter(m => m.type === wanted), type);
    await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'selectedRepoDisplayChanged', repository: { path: 'file:///stash/a', label: 'repo-a' } } })));
    await publish();

    // 回归: stash 位于最新提交与 Uncommitted Changes 之间时，基线泳道仍应保持虚线。
    {
      const topStash = base(h('6'), h('3'), 'WIP on main: stash at HEAD', { isStash: true, stashRef: 'stash@{1}', stashIndex: 1, lane: 0,
        inputSwimlanes: [], outputSwimlanes: [] });
      state.commits = [topStash, ...commits];
      await publish();
      const stashLane = page.locator('#commitVirtualRows .commit-row.stash[data-hash="' + h('6') + '"] .stash-base-lane');
      const commitLane = page.locator('#commitVirtualRows .commit-row[data-hash="' + h('3') + '"] .stash-prefix-lane');
      assert.equal(await stashLane.getAttribute('stroke-dasharray'), '2 2', 'the stash base lane stays dashed below Uncommitted Changes');
      assert.equal(await commitLane.count(), 1, 'the latest commit has a dedicated working-tree connector');
      assert.equal(await commitLane.getAttribute('stroke-dasharray'), '2 2', 'the connector into the latest commit stays dashed');
      state.commits = commits;
      await publish();
    }

    // 1) 开关: 位于提交搜索行中的分支选择器右侧, 默认选中, 使用 inbox 图标
    const toggle = page.locator('#stashListToggle');
    assert.equal(await toggle.count(), 1);
    assert.equal(await toggle.getAttribute('aria-pressed'), 'true', 'selected by default');
    assert.equal(await toggle.locator('.codicon-inbox').count(), 1, 'the toggle uses the inbox codicon');
    assert.equal(await page.locator('#commitVirtualRows .commit-row.stash').count(), 1, 'the stash row is shown while the default toggle is on');
    assert.equal(await page.locator('#commitVirtualRows .commit-row:not(.stash)').count(), 3, 'ordinary commits are shown as usual');
    assert.equal(await toggle.getAttribute('title'), '在commit列表中显示stash提交（当前状态： 开）');
    assert.equal(await toggle.getAttribute('aria-label'), '在commit列表中显示stash提交（当前状态： 开）');
    // 缺字段时沿用新默认值“开”(兼容尚未下发 showStashes 的宿主状态)。
    delete state.showStashes; await publish();
    assert.equal(await toggle.getAttribute('aria-pressed'), 'true', 'a missing showStashes field is treated as on');
    state.showStashes = true;
    // 点击关闭: 乐观更新描述, 宿主随后下发不含 stash 行的提交图。
    await page.evaluate(() => { window.messages.length = 0; });
    await toggle.click();
    assert.deepEqual(await lastMessages('toggleStashes'), [{ type: 'toggleStashes', visible: false }]);
    assert.equal(await toggle.getAttribute('aria-pressed'), 'false', 'the click clears the toggle right away');
    assert.equal(await toggle.getAttribute('title'), '在commit列表中显示stash提交（当前状态： 关）');
    assert.equal(await toggle.getAttribute('aria-label'), '在commit列表中显示stash提交（当前状态： 关）');
    state.commits = commits.filter(c => !c.isStash); state.showStashes = false; await publish();
    assert.equal(await page.locator('#commitVirtualRows .commit-row.stash').count(), 0, 'the stash row disappears once the host publishes the off state');
    // 再次点击打开: 发 toggleStashes(true), 宿主重建的提交图恢复 stash 行。
    await page.evaluate(() => { window.messages.length = 0; });
    await toggle.click();
    assert.deepEqual(await lastMessages('toggleStashes'), [{ type: 'toggleStashes', visible: true }]);
    assert.equal(await toggle.getAttribute('aria-pressed'), 'true', 'the second click selects the toggle right away');
    assert.equal(await toggle.getAttribute('title'), '在commit列表中显示stash提交（当前状态： 开）');
    state.commits = commits; state.showStashes = true; await publish();
    assert.equal(await toggle.getAttribute('aria-pressed'), 'true', 'host state keeps the toggle on');
    assert.equal(await page.locator('#commitVirtualRows .commit-row.stash').count(), 1, 'the stash row appears once the host publishes it');
    const geometry = await page.evaluate(() => {
      const row = document.getElementById('commitSearchRow').getBoundingClientRect();
      const branch = document.getElementById('branchSelector').getBoundingClientRect();
      const btn = document.getElementById('stashListToggle').getBoundingClientRect();
      return { rowRight: row.right, rowPaddingRight: parseFloat(getComputedStyle(document.getElementById('commitSearchRow')).paddingRight), branchRight: branch.right, btnLeft: btn.left, btnRight: btn.right, branchCenter: branch.top + branch.height / 2, btnCenter: btn.top + btn.height / 2 };
    });
    assert.equal(await page.locator('.selector-row #stashListToggle').count(), 0, 'the toggle leaves the repository row');
    assert.ok(Math.abs(geometry.btnLeft - geometry.branchRight - 8) < 1.5, 'the toggle sits 8px to the right of the branch selector: ' + JSON.stringify(geometry));
    assert.ok(Math.abs(geometry.branchCenter - geometry.btnCenter) < 1, 'the toggle aligns with the branch selector: ' + JSON.stringify(geometry));
    assert.ok(geometry.btnRight <= geometry.rowRight - geometry.rowPaddingRight + 0.5, 'the toggle stays within the search row: ' + JSON.stringify(geometry));

    // 2) stash 行穿插在提交之间: c3, stash, c2, c1; 没有独立的 stash 分组容器和标题
    assert.equal(await page.locator('#commitStashRows').count(), 0, 'no separate stash container any more');
    assert.equal(await page.locator('.stash-group-title').count(), 0, 'no stash group title');
    const order = await page.evaluate(() => [...document.querySelectorAll('#commitVirtualRows .commit-row')].map(row => (row.classList.contains('stash') ? 'stash:' : 'commit:') + row.querySelector('.commit-message-text').textContent));
    assert.deepEqual(order, ['commit:c3 newest', 'stash:WIP on main: stash tip', 'commit:c2 base of stash', 'commit:c1'], 'the stash row sits between its neighbours, right above its base commit');
    const stashRow = page.locator('#commitVirtualRows .commit-row.stash');
    assert.equal(await stashRow.count(), 1);
    // 标题前的 stash@{n} 徽章: 不再显示图标，只保留左右 4px 内边距的紧凑引用名标签。
    {
      const badge = stashRow.locator('.stash-badge');
      assert.equal(await badge.count(), 1, 'one badge in front of the title');
      assert.equal(await stashRow.locator('.stash-ref').count(), 0, 'the old plain-text prefix is gone');
      assert.equal(await badge.locator('.stash-badge-text').textContent(), 'stash@{0}', 'the badge text is the stash reference');
      assert.equal(await badge.locator('.stash-badge-icon').count(), 0, 'the prefix badge has no icon block');
      assert.equal(await badge.locator('.codicon').count(), 0, 'the prefix badge has no logo glyph');
      // 徽章在标题前面: 同一个摘要容器里, 徽章是标题的前一个兄弟节点, 且徽章右边缘 <= 标题左边缘。
      const order = await stashRow.locator('.col-main-summary').evaluate(summary => {
        const kids = [...summary.children].map(el => el.className.split(' ')[0]);
        const badge = summary.querySelector('.stash-badge').getBoundingClientRect(); const title = summary.querySelector('.commit-message-text').getBoundingClientRect();
        return { kids, gap: Math.round((title.left - badge.right) * 10) / 10 };
      });
      assert.deepEqual(order.kids, ['stash-badge', 'commit-message-text'], 'the badge comes first, then the title');
      assert.ok(order.gap >= 4 && order.gap <= 8, 'a small gap separates the badge from the title: ' + order.gap);
      const look = await badge.evaluate(el => {
        const badgeCss = getComputedStyle(el); const text = el.querySelector('.stash-badge-text'); const textCss = getComputedStyle(text);
        return { border: badgeCss.borderTopColor + ' ' + badgeCss.borderTopWidth + ' ' + badgeCss.borderTopStyle,
          radius: badgeCss.borderTopLeftRadius, height: el.getBoundingClientRect().height, textBg: textCss.backgroundColor, textColor: textCss.color,
          paddingLeft: textCss.paddingLeft, paddingRight: textCss.paddingRight };
      });
      assert.equal(look.border, 'rgb(105, 105, 105) 1px solid', 'grey 1px outline');
      assert.equal(look.radius, '4px', 'rounded rectangle');
      assert.equal(look.height, 20, 'same height as the other chips in the list');
      assert.equal(look.textBg, 'rgb(34, 35, 36)', 'dark grey text area');
      assert.equal(look.textColor, 'rgb(187, 190, 191)', 'light grey text');
      assert.equal(look.paddingLeft, '4px', 'left text padding is compact');
      assert.equal(look.paddingRight, '4px', 'right text padding is compact');
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
    // 主泳道保持原色实线；只有 stash 在右侧增加展示侧枝。
    const linkGeometry = await stashRow.locator('svg').evaluate(svg => {
      const branch = svg.querySelector('.stash-branch');
      const start = branch.getPointAtLength(0), end = branch.getPointAtLength(branch.getTotalLength());
      const trunk = svg.querySelector('.stash-base-lane');
      const node = svg.querySelector('.stash-node').getAttribute('d').match(/-?[\d.]+/g).map(Number);
      return { trunkX: trunk.x1.baseVal.value, trunkDash: trunk.getAttribute('stroke-dasharray'), trunkColor: trunk.getAttribute('stroke'),
        dash: branch.getAttribute('stroke-dasharray'), color: branch.getAttribute('stroke'), start: {x:start.x,y:start.y}, end: {x:end.x,y:end.y}, nodeX: node[0], nodeBottom: node[5] };
    });
    assert.equal(linkGeometry.trunkDash, null, 'main lane is solid through stash');
    assert.equal(linkGeometry.trunkColor, '#e06c75', 'main lane retains the real commit colour');
    assert.equal(linkGeometry.dash, '2 2', 'only the stash side branch is dashed');
    assert.equal(linkGeometry.color, 'var(--vscode-descriptionForeground, #999)', 'stash branch remains grey');
    assert.equal(linkGeometry.nodeX - linkGeometry.trunkX, 11, 'stash leaf moves one display lane right');
    assert.equal(linkGeometry.start.x, linkGeometry.nodeX, 'branch starts under its diamond');
    assert.equal(linkGeometry.start.y, 13, 'stem starts inside the diamond, whose background masks the hidden segment');
    assert.equal(linkGeometry.end.x, linkGeometry.nodeX, 'stem stays in the display column until the fork in the real base row');
    const baseFork = page.locator('#commitVirtualRows .commit-row[data-hash="' + h('2') + '"] .stash-fork');
    assert.equal(await baseFork.count(), 1, 'real base commit owns the fork rooted at its circle');
    // 空心: 描边是灰色, 内部是编辑器背景色(盖住穿过它的泳道线), 而不是实心
    const paint = await stashRow.locator('svg path.stash-node').evaluate(node => ({
      fill: node.getAttribute('fill'), stroke: node.getAttribute('stroke'), width: node.getAttribute('stroke-width'),
      computedFill: getComputedStyle(node).fill, computedStroke: getComputedStyle(node).stroke,
    }));
    assert.equal(paint.fill, 'var(--vscode-editor-background)', 'the inside is the editor background, so the diamond reads as hollow');
    assert.equal(paint.stroke, 'var(--vscode-descriptionForeground, #999)', 'the outline is grey');
    assert.equal(paint.width, '1', 'hollow diamond uses its own 1px outline without changing the 2px lanes');
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
      // 只采样菱形的真实空心区域，避开 1px 描边的抗锯齿边缘。
      const outline = diamond.match(/-?[\d.]+/g).map(Number);
      const innerRadius = (outline[5] - outline[1]) / 2 - Number(paint.width) / Math.SQRT2;
      const centerPixels = [];
      for (let y = Math.floor(cy) - 1; y <= Math.ceil(cy); y++) {
        for (let x = Math.floor(cx) - 1; x <= Math.ceil(cx); x++) {
          if (Math.abs(x + .5 - cx) + Math.abs(y + .5 - cy) < innerRadius - 1) centerPixels.push([x, y]);
        }
      }
      assert.ok(centerPixels.length > 0, 'the smaller diamond still has a visible hollow centre');
      const inside = await sample(centerPixels);
      for (const [r, g, b] of inside) assert.ok(b < 70 && g < 70, 'inside the hollow diamond the lane line is covered by the background: ' + JSON.stringify(inside));
      // 左顶点附近 3x3: 至少有一个像素是灰色描边(#929292 与背景的混合, 红蓝绿接近且明显亮于背景), 不是泳道色
      const vx = Math.floor(nodeBox.x - clip.x), vy = Math.round(cy);
      const edge = await sample([-1, 0, 1].flatMap(dx => [-1, 0, 1].map(dy => [vx + 1 + dx, vy + dy])));
      assert.ok(edge.some(([r, g, b]) => r > 70 && Math.abs(r - g) < 14 && Math.abs(g - b) < 14), 'the outline near the left vertex is drawn in grey: ' + JSON.stringify(edge));
      assert.ok(!edge.some(([r, g, b]) => b > r + 60), 'and no pixel there is the blue lane colour: ' + JSON.stringify(edge));
    }
    // 普通提交仍是实心圆点, 没有被空心样式影响
    assert.equal(await ordinary.locator('svg circle').first().getAttribute('fill'), '#e06c75', 'ordinary/current commits keep a solid lane-coloured circle');

    // 3a) 折叠/展开时，贯穿 stash 的真实泳道必须连到下一行；侧枝不参与其他行的宽度。
    {
      const assertBoundaryJoin = async (selector, label, expectedDash = null) => {
        const g = await page.locator(selector).evaluate(row => {
          const svg = row.querySelector('svg.graph-svg'), branch = svg.querySelector('.stash-branch');
          const trunk = svg.querySelector('.stash-base-lane');
          const end = trunk.getPointAtLength(trunk.getTotalLength()).matrixTransform(trunk.getScreenCTM());
          return { height: row.getBoundingClientRect().height, svgHeight: svg.getBoundingClientRect().height,
            endY: end.y, nextTop: row.nextElementSibling.getBoundingClientRect().top, dash: trunk.getAttribute('stroke-dasharray'),
            branchX: branch.x1.baseVal.value, width: svg.getBoundingClientRect().width };
        });
        assert.equal(g.dash, expectedDash, label + ': lane dash style');
        assert.ok(Math.abs(g.height - g.svgHeight) < .5, label + ': SVG fills actual row');
        assert.ok(Math.abs(g.endY - g.nextTop) < .5, label + ': trunk reaches next commit');
        return g;
      };
      const selector = '#commitVirtualRows .commit-row.stash';
      const collapsed = await assertBoundaryJoin(selector, 'collapsed');
      state.selectedCommit = { key: repoA.path + ':' + h('5'), hash: h('5'), repositoryPath: repoA.path, message: 'WIP on main: stash tip', body: '', kind: 'commit' };
      await publish(); await stashRow.locator('.stash-badge').click(); await page.waitForTimeout(150);
      const expanded = await assertBoundaryJoin(selector, 'expanded');
      assert.ok(expanded.height > 40);
      assert.equal(expanded.branchX, collapsed.branchX, 'expansion keeps the stash stem in its own display column');
      await stashRow.locator('.stash-badge').click(); await page.waitForTimeout(150);
      assert.equal((await assertBoundaryJoin(selector, 'collapsed again')).height, 26);
      const halves = await page.evaluate(() => {
        const rows = [...document.querySelectorAll('#commitVirtualRows .commit-row')];
        const i = rows.findIndex(row => row.classList.contains('stash'));
        return [rows[i - 1], rows[i + 1]].map(row => [...row.querySelectorAll('svg path')]
          .filter(p => /^M 11 (0|13) V (13|26)$/.test(p.getAttribute('d')))
          .map(p => ({ d:p.getAttribute('d'), dash:p.getAttribute('stroke-dasharray'), color:p.getAttribute('stroke') })));
      });
      assert.ok(halves[0].some(p => p.d === 'M 11 13 V 26' && !p.dash && p.color === '#e06c75'), 'commit above stash keeps a solid lower half');
      assert.ok(halves[1].some(p => p.d === 'M 11 0 V 13' && !p.dash && p.color === '#e06c75'), 'base commit keeps a solid upper half');
      state.selectedCommit = null; await publish();

      // 最新提交没有输入泳道；有 Uncommitted Changes 时，基线连接保持虚线但仍使用真实颜色。
      const latestRows = [
        base(h('8'), h('3'), 'WIP on main: stash above latest', { isStash:true, stashRef:'stash@{0}', stashIndex:0, lane:0, inputSwimlanes:[], outputSwimlanes:[] }),
        ...commits.filter(c => !c.isStash),
      ];
      state.commits = latestRows; await publish();
      const latest = page.locator(selector);
      assert.equal(await latest.locator('.stash-main-lane').getAttribute('stroke'), '#e06c75');
      await assertBoundaryJoin(selector, 'stash above latest', '2 2');
      state.selectedCommit = { key:repoA.path + ':' + h('8'), hash:h('8'), repositoryPath:repoA.path, kind:'commit', message:'WIP on main: stash above latest' };
      await publish(); await latest.locator('.stash-badge').click(); await page.waitForTimeout(150);
      await assertBoundaryJoin(selector, 'expanded above latest', '2 2');
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
    // 3c) 只有 stash 摘要向右增加一个泳道槽，普通提交仍保持原来的对齐位置。
    {
      const rows = await page.locator('#commitVirtualRows .commit-row').evaluateAll(rows => rows.map(row => ({
        stash:row.classList.contains('stash'), x:row.querySelector('.col-main-summary').getBoundingClientRect().left,
      })));
      const real = rows.filter(row => !row.stash);
      assert.equal(new Set(real.map(row => row.x)).size, 1, 'ordinary commit summaries stay aligned');
      assert.ok(rows.filter(row => row.stash).every(row => row.x === real[0].x + 11), 'only stash gets one display-lane indent');
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
    assert.ok(menu.shown.includes('checkout') && menu.shown.includes('cherryPick') && menu.shown.includes('createTag') && menu.shown.includes('deleteTag') && menu.shown.includes('deleteRemoteTag') && menu.shown.includes('pushTag'), 'an ordinary commit keeps its commit and grouped tag actions: ' + menu.shown);
    assert.ok(!menu.shown.some(action => action.startsWith('stash')), 'and shows no stash action: ' + menu.shown);
    assert.equal(menu.separators, 4, 'ordinary commits keep the Tag actions in their own fourth group');
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
      assert.ok(/const laneDashAttrs = function\(startY, strokeWidth = LANE_STROKE_W\)/.test(panelSource),
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
            stash: p.matches('.stash-branch, .stash-fork'),
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
      const signatures = [...new Set(styles.map(s => s.dash + '|' + s.cap))];
      for (const style of styles) assert.equal(style.width, '2', 'all dashed lane edges use the requested 2px stroke');
      assert.deepEqual(signatures, ['2 2|butt'],
        'every dashed lane segment shares one style regardless of row type or expansion: ' + JSON.stringify(styles));
    }

    assert.deepEqual(errors, [], 'no page errors: ' + errors.join('; '));
    console.log('Stash UI passed: toggle at the right of the branch selector in the commit search row (on by default, hides stash rows when cleared), stash rows interleaved with a hollow side-branch diamond and a solid real-commit trunk, no separate group, a stash-only context menu (apply / pop / drop), hidden-count hint.');
  } finally { await browser.close(); }
}

main().catch(error => { console.error(error); process.exit(1); });
