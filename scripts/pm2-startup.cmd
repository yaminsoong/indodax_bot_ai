@echo off
REM ============================================================================
REM  Nyalakan bot di bawah PM2 setelah Windows reboot.
REM
REM  Dijalankan oleh Task Scheduler (task "IndodaxBot") saat pengguna login.
REM  Lihat PANDUAN.md bagian "Bertahan setelah komputer reboot".
REM
REM  Mengapa berkas ini ada, bukan perintah panjang di dalam task:
REM  perintah di Task Scheduler sulit dibaca, sulit diuji, dan tidak bisa
REM  dijalankan manual untuk memeriksa apakah ia benar-benar bekerja. Skrip ini
REM  bisa dijalankan kapan saja dengan dobel-klik untuk membuktikan isinya.
REM ============================================================================

setlocal

set "PROYEK=%~dp0.."
cd /d "%PROYEK%"

REM Catat tiap percobaan. Tanpa log, auto-start yang gagal tidak meninggalkan
REM jejak apa pun — dan itulah cara sebulan berlalu tanpa data.
if not exist "logs" mkdir "logs"
set "LOG=%PROYEK%\logs\startup.log"

echo [%date% %time%] --- pm2-startup dijalankan --- >> "%LOG%"

REM PM2 dipanggil lewat jalur lengkap bila ada. nvm untuk Windows menaruh versi
REM Node yang aktif di C:\Program Files\nodejs lewat symlink, dan PATH pada
REM sesi Task Scheduler tidak selalu sama dengan PATH di terminal pengguna.
set "PM2=pm2"
if exist "%ProgramFiles%\nodejs\pm2.cmd" set "PM2=%ProgramFiles%\nodejs\pm2.cmd"

call "%PM2%" resurrect >> "%LOG%" 2>&1

REM resurrect gagal bila dump.pm2 belum ada atau sudah rusak. Dalam keadaan itu
REM bot tetap harus menyala, jadi dijalankan langsung dari ecosystem config.
call "%PM2%" describe indodax-bot >nul 2>&1
if errorlevel 1 (
  echo [%date% %time%] resurrect tidak memulihkan apa pun; memakai ecosystem.config.js >> "%LOG%"
  call "%PM2%" start ecosystem.config.js >> "%LOG%" 2>&1
  call "%PM2%" save >> "%LOG%" 2>&1
)

call "%PM2%" list >> "%LOG%" 2>&1
echo [%date% %time%] --- selesai --- >> "%LOG%"

endlocal
