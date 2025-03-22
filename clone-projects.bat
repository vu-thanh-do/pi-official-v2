@echo off
setlocal enabledelayedexpansion

rem Tìm số thứ tự cao nhất hiện có
set max_num=0
for /d %%f in (pi-automate-official-*) do (
    set folder=%%f
    set num=!folder:pi-automate-official-=!
    if !num! gtr !max_num! set max_num=!num!
)

echo STT cao nhat hien tai: %max_num%
set /p count="Nhap so luong du an can tao them: "

rem Bắt đầu nhân bản từ số tiếp theo
set /a start=%max_num%+1
set /a end=%start%+%count%-1

echo Bat dau tao du an tu STT %start% den %end%

rem Copy với tùy chọn /Y để tự động overwrite
for /l %%i in (%start%,1,%end%) do (
    xcopy /E /I /Y "pi-automate-official-1" "pi-automate-official-%%i"
    echo Da tao du an pi-automate-official-%%i
)

echo Da hoan thanh nhan ban them %count% du an, tu so %start% den %end%!