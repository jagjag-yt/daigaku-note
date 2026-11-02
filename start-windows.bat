@echo off
cd /d "%~dp0"
start "" http://localhost:8123/
node serve.mjs 8123
