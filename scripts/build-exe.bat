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

echo [2/3] 打包 Windows exe...
if not exist dist mkdir dist
if not exist dist\release mkdir dist\release
call npm run build:exe
if errorlevel 1 (
  echo 打包失败
  pause
  exit /b 1
)

echo [3/3] 组装发布目录...
copy /Y dist\one-click-news-search.exe dist\release\
xcopy /E /I /Y public dist\release\public
copy /Y scripts\start-windows.bat dist\release\启动.bat

echo.
echo 打包完成: dist\release\
echo 请双击 dist\release\启动.bat 运行（不要单独移动 exe）
pause
