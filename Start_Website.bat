@echo off
title Sangathan Search Website Launcher
echo ========================================================
echo         Starting Sangathan Search Website...
echo ========================================================
echo.

:: Check if Python is installed
python --version >nul 2>&1
if %errorlevel% == 0 (
    echo Python detected. Starting local web server on port 8080...
    start http://localhost:8080/index.html
    python -m http.server 8080
    goto end
)

:: Check if Node is installed
npx --version >nul 2>&1
if %errorlevel% == 0 (
    echo NPX detected. Starting local web server on port 8080...
    start http://localhost:8080/index.html
    npx -y serve -p 8080 .
    goto end
)

:: Fallback if neither is installed: open directly in browser
echo Starting in browser...
start index.html

:end
