@echo off
setlocal enabledelayedexpansion

echo Bat dau cai dat packages cho tat ca du an...
echo.

rem Tìm tất cả các thư mục dự án
for /d %%f in (pi-automate-official-*) do (
    echo Dang cai dat packages cho %%f...
    cd %%f
    call npm install
    cd ..
    echo Da hoan thanh cai dat packages cho %%f
    echo.
)

echo Da hoan thanh cai dat packages cho tat ca cac du an!
pause