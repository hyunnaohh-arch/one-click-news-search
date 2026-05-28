@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo 正在启动一键全站搜索...
one-click-news-search.exe

echo.
echo 程序已退出。
if exist one-click-news-search.log (
  echo 日志文件：one-click-news-search.log
)
pause
