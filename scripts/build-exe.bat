@echo off
chcp 65001 >nul
cd /d "%~dp0.."

echo [1/2] 安装依赖...
call npm install
if errorlevel 1 (
  echo 依赖安装失败
  pause
  exit /b 1
)

echo [2/2] 打包 Windows exe...
if not exist dist mkdir dist
call npm run build:exe
if errorlevel 1 (
  echo 打包失败
  pause
  exit /b 1
)

echo.
echo 打包完成: dist\one-click-news-search.exe
echo 双击 exe 即可在本地使用（会自动打开浏览器）
pause
