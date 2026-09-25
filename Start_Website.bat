@echo off
title Sangathan Search Website Launcher
echo ========================================================
echo         Starting Sangathan Search Website...
echo ========================================================
echo.

:: Check if Node is installed (Recommended for full Serverless Search & Sync APIs)
node --version >nul 2>&1
if %errorlevel% == 0 (
    echo Node.js detected. Starting Sangathan Web Server on port 8081...
    start http://localhost:8081/index.html
    node server.js
    goto end
)

:: Check if Python is installed
python --version >nul 2>&1
if %errorlevel% == 0 (
    echo Python detected. Starting local web server on port 8080...
    start http://localhost:8080/index.html
    python -m http.server 8080
    goto end
)

:: Fallback if neither is installed: open directly in browser
echo Opening directly in default browser...
start index.html

:end
