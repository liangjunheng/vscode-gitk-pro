// Monaco Diff 共享配置：MultiDiffPanel 为每个文件创建的 DiffEditor 与此保持一致。
export const MONACO_DIFF_OPTIONS = {
    automaticLayout: true,
    readOnly: true,
    originalEditable: false,
    renderSideBySide: true,
    ignoreTrimWhitespace: true,
    renderIndicators: true,
    renderOverviewRuler: false,
    // renderOverviewRuler 只关掉 diff 彩色标记, 概览标尺那条分隔边框由 overviewRulerBorder 控制(默认 true),
    // 滚动条已隐藏时它看起来像残留竖线; lanes 归零一并回收该区域宽度。
    overviewRulerBorder: false,
    overviewRulerLanes: 0,
    diffAlgorithm: 'advanced',
    diffWordWrap: 'off',
    wordWrap: 'off',
    renderWhitespace: 'selection',
    renderLineHighlight: 'line',
    // 不使用编辑器内部滚动条；MultiDiffPanel 按内容尺寸扩展卡片并由页面统一滚动。
    scrollBeyondLastLine: false,
    scrollbar: { vertical: 'hidden', horizontal: 'hidden', handleMouseWheel: false },
    minimap: { enabled: false },
    folding: true,
    hideUnchangedRegions: { enabled: true, contextLineCount: 3, minimumLineCount: 3, revealContextCount: 20 },
};

export const MONACO_DIFF_LANGUAGES: Record<string, string> = {
    js: 'javascript', mjs: 'javascript', cjs: 'javascript', ts: 'typescript', tsx: 'typescript',
    json: 'json', jsonc: 'json', html: 'html', htm: 'html', css: 'css', scss: 'scss', less: 'less',
    md: 'markdown', py: 'python', java: 'java', c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cc: 'cpp',
    cs: 'csharp', go: 'go', rs: 'rust', rb: 'ruby', php: 'php', sh: 'shell', bat: 'bat',
    ps1: 'powershell', yml: 'yaml', yaml: 'yaml', xml: 'xml', sql: 'sql', kt: 'kotlin', swift: 'swift',
};
