@echo off
REM 一键启动 vscode-gitk 扩展 (Extension Development Host)
REM 用法: 在项目根目录双击运行
REM 效果: 启动新 VS Code 窗口加载本插件, 不依赖 launch.json

setlocal
set PROJECT_DIR=%~dp0
set PROJECT_DIR=%PROJECT_DIR:~0,-1%
set CODE_EXE=C:\Users\JUNHENG.LIANG\AppData\Local\Programs\Microsoft VS Code\Code.exe

REM 先编译
cd /d "%PROJECT_DIR%"
echo [1/2] 编译 TypeScript...
call npx tsc -p tsconfig.json
if errorlevel 1 (
    echo 编译失败
    pause
    exit /b 1
)

REM 启动 Extension Development Host
echo [2/2] 启动 Extension Development Host...
start "" "%CODE_EXE%" --extensionDevelopmentPath="%PROJECT_DIR%" --new-window "%PROJECT_DIR%"

REM 等待 3 秒让窗口启动
timeout /t 3 /nobreak >nul
endlocal
