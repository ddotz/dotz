# 윈도우에서 쓰기 (WSL)

윈도우에서는 WSL 2 안의 리눅스에 Tailscale, OmO, dotz를 깔고, Aside는 윈도우 쪽에 깔아요. dotz는 WSL에서 돌면서 `powershell.exe`, `cmd.exe`, `/mnt/c`로 윈도우를 다뤄요. 윈도우용 dotz 설치 파일은 따로 없어요.

이 구성은 실제 윈도우 PC에서 돌아가는 걸 확인했어요. 명령은 dotz 코드와 아래 공식 문서를 보고 적었고, 하나하나 그대로 돌려 본 건 아니에요.

## 준비물

- 윈도우 10 2004(빌드 19041) 이상 또는 윈도우 11
- WSL 2와 리눅스 배포판 하나. 아래 명령은 기본값인 Ubuntu 기준이에요.

## 1. WSL 설치

PowerShell을 관리자 권한으로 열고 실행한 뒤 컴퓨터를 다시 시작해요.

```powershell
wsl --install
```

다시 시작한 뒤 Ubuntu를 처음 열면 리눅스 사용자 이름과 암호를 만들어요. 버전은 이렇게 확인해요. `VERSION` 칸이 `2`여야 해요.

```powershell
wsl -l -v
```

## 2. systemd 켜기

게이트웨이는 systemd 사용자 서비스로 돌아요. 지금 Ubuntu는 기본으로 켜져 있지만, 다른 배포판이나 오래된 설치는 꺼져 있을 수 있어요. Ubuntu 창에서 확인해요.

```sh
systemctl --user show-environment
```

오류가 나면 `/etc/wsl.conf`를 열어요.

```sh
sudo nano /etc/wsl.conf
```

아래 두 줄을 넣고 저장해요.

```ini
[boot]
systemd=true
```

PowerShell에서 WSL을 끈 뒤 Ubuntu를 다시 열어요.

```powershell
wsl --shutdown
```

systemd가 꺼져 있으면 설치 스크립트가 이 방법을 알려 주고 멈춰요.

## 3. Tailscale 설치

Ubuntu 창에서 필요한 도구부터 깔아요. `unzip`은 다음 단계의 bun 설치에 필요해요.

```sh
sudo apt update && sudo apt install -y curl unzip
```

Tailscale은 윈도우가 아니라 WSL 안에 깔아요. dotz가 WSL 안의 `tailscale` 명령으로 주소를 잡기 때문이에요.

```sh
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

윈도우에 Tailscale이 이미 있으면 꺼 두세요. 둘 다 켜 두면 WSL 트래픽이 막혀요. Tailscale 문서는 윈도우 쪽에만 두라고 권하지만, dotz는 위 이유로 WSL 쪽을 써요. 관리 화면에는 WSL이 기기 하나로 따로 보여요.

## 4. dotz와 OmO 설치

맥, 리눅스와 같은 한 줄이에요. OmO도 함께 깔려요. PowerShell이 아니라 Ubuntu 창에서 실행해요.

```sh
curl -fsSL https://raw.githubusercontent.com/ddotz/dotz/main/install.sh | sh
```

설치가 끝나면 윈도우 브라우저에 온보딩 화면이 열려요. 안 열리면 터미널에 찍힌 주소를 윈도우 브라우저에 붙여 넣으세요.

## 5. Aside 설치

브라우저 작업은 윈도우에 깐 Aside로 해요. [aside.com/download](https://aside.com/download)에서 받아 윈도우에 깔고 로그인해요. 온보딩은 WSL에서 Aside를 건너뛰니까 직접 깔아야 해요.

## 6. 계속 켜 두기

WSL, 게이트웨이, Tailscale이 늘 돌고 있어야 해요.

**게이트웨이와 Tailscale:** 게이트웨이는 systemd 사용자 서비스(`dotz-gateway.service`)로, `tailscaled`는 WSL의 시스템 서비스로 돌아요. 아래 명령으로 로그아웃해도 멈추지 않게 하고, WSL이 켜질 때마다 함께 뜨게 해요.

```sh
sudo loginctl enable-linger "$USER"
sudo systemctl enable --now tailscaled
```

**WSL:** 위 설정만으로는 부족해요. Microsoft 문서에 따르면 systemd 서비스는 WSL을 살려 두지 못해서, 열어 둔 창이 없으면 WSL이 꺼질 수 있어요. 윈도우에 로그온할 때 WSL 안에서 프로세스 하나가 계속 돌도록 작업 스케줄러에 등록해요. 관리자 PowerShell에서 실행해요. 배포판 이름이 다르면 `Ubuntu`를 바꿔요.

```powershell
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-WindowStyle Hidden -Command wsl.exe -d Ubuntu --exec sleep infinity"
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName "dotz WSL" -Action $action -Trigger $trigger -Settings $settings
```

지우려면 이렇게 해요.

```powershell
Unregister-ScheduledTask -TaskName "dotz WSL"
```

**절전과 잠금 끄기:** 윈도우에 로그온해 있고 컴퓨터가 깨어 있는 동안만 dotz가 돌아요. 전원에 연결했을 때 절전에 들어가지 않게 해요. 설정 앱의 Settings > System > Power & battery > Screen, sleep, & hibernate timeouts에서 Make my device sleep after를 Never로 하거나, PowerShell에서 실행해요. `0`이 '안 함'이고, 지금 쓰는 전원 관리 옵션에 적용돼요.

```powershell
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
```

화면 잠금은 설정 앱에서 꺼요.

- Settings > Accounts > Sign-in options > If you've been away, when should Windows require you to sign in again?: Never
- Settings > Personalization > Lock screen > Screen saver: 화면 보호기를 쓴다면 On resume, display logon screen 해제

메뉴 이름은 Microsoft 영어 문서 기준이고, 윈도우 언어와 버전에 따라 달라요. 잠금을 끄면 PC 앞에 앉은 사람은 누구나 쓸 수 있으니, 다른 사람이 만지지 않는 PC에서만 끄세요.

## 7. 웹 앱 열기

**이 컴퓨터에서:** WSL 안의 포트는 윈도우의 `localhost`로 넘어와요. 윈도우 브라우저에서 설치 때 나온 주소를 열어요. 기본 포트는 `7420`이에요.

```text
http://127.0.0.1:7420/
```

로그인 버튼을 눌렀는데 확인 창이 뜨지 않으면, Ubuntu 창에서 한 번 쓰는 로그인 링크를 만들어 열어요.

```sh
cd ~/.local/share/dotz && bun hub/web-login-cli.ts --open
```

**폰에서:** 3번에서 WSL에 깐 Tailscale로 접속해요. 폰도 같은 Tailscale 계정에 연결해 둬요.

## dotz가 윈도우를 다루는 방법

WSL에서는 윈도우 프로그램을 리눅스 명령처럼 실행할 수 있어요. 이름에 `.exe`까지 써야 하고, 로그인한 윈도우 사용자로 실행돼요.

```sh
powershell.exe -NoProfile -Command "Get-Process | Select-Object -First 5"   # PowerShell 명령
cmd.exe /c dir                                                              # cmd 내장 명령
notepad.exe                                                                 # 윈도우 앱 열기
explorer.exe .                                                              # 지금 폴더를 탐색기로 열기
ls /mnt/c/Users                                                             # C 드라이브 파일 보기
```

작업 폴더는 윈도우 쪽이 아니라 `/home/사용자이름` 아래에 두는 게 빨라요. `/mnt/c`는 리눅스 파일 시스템보다 느려요.

설치할 때 `powershell.exe`와 `cmd.exe`가 있는 폴더를 게이트웨이 서비스의 PATH 끝에 넣어요. 서비스 안에서도 윈도우 명령이 되는지는 이렇게 확인해요. 윈도우 버전이 나오면 돼요.

```sh
systemd-run --user --wait --pipe /mnt/c/Windows/System32/cmd.exe /c ver
```

## 되는 것과 안 되는 것

화면을 보거나 마우스로 누르는 조작은 없어요. 명령과 파일로 할 수 있는 일만 해요.

| 기능 | 윈도우(WSL) | 이유 |
| --- | --- | --- |
| 게이트웨이, 웹 앱 | 돼요 | 리눅스와 같은 경로예요 |
| Discord, Telegram, Slack, 잔디 | 돼요 | 맥 전용 코드가 없어요. Discord 봇 자동 만들기는 Aside가 있을 때만 돼요 |
| 메일, 캘린더(zele) | 돼요 | 리눅스와 같아요 |
| 윈도우 명령과 파일 | 돼요 | WSL 연동을 그대로 써요 |
| 웹 앱 로그인 확인 창 | 제한 있어요 | 리눅스 대화 상자(zenity, kdialog)와 화면이 있어야 떠요. 없으면 위의 로그인 링크를 써요 |
| 브라우저 작업 | 제한 있어요 | 로그인 유지, 웹메일 읽기, 유튜브·인스타그램은 Aside로 돌아가요. Aside는 윈도우에 직접 깔아요. 이 기능들은 WSL 안에서 `aside` 명령을 부르니, 그 명령이 없으면 안 돼요 |
| 항상 켜 두기 | 제한 있어요 | 윈도우에 로그온해 있고 PC가 절전에 들어가지 않은 동안만 돌아요. 6번 설정이 필요해요 |
| 비밀값 저장 | 달라요 | 맥 키체인 대신 `~/.config/dotz/secret.key`를 써요 |
| 화면 공유 | 맥만 돼요 | `features/remote-desktop`은 macOS에서만 켜져요 |
| 데스크톱 메신저 자동화 | 맥만 돼요 | 맥 앱과 키체인을 써요 |
| 시스템 권한 자동 설정 | 맥만 돼요 | 윈도우에는 이 단계가 없어요 |
| 문자 인증번호 읽기 | 맥만 돼요 | 맥의 메시지 앱을 읽어요 |
| iCloud 파일 내려받기 | 맥만 돼요 | `brctl`을 써요 |

## 참고한 문서

- [Install WSL](https://learn.microsoft.com/en-us/windows/wsl/install)
- [Use systemd to manage Linux services with WSL](https://learn.microsoft.com/en-us/windows/wsl/systemd)
- [Accessing network applications with WSL](https://learn.microsoft.com/en-us/windows/wsl/networking)
- [Working across file systems](https://learn.microsoft.com/en-us/windows/wsl/filesystems)
- [Register-ScheduledTask](https://learn.microsoft.com/en-us/powershell/module/scheduledtasks/register-scheduledtask)
- [New-ScheduledTaskTrigger](https://learn.microsoft.com/en-us/powershell/module/scheduledtasks/new-scheduledtasktrigger)
- [Install Tailscale on Windows with WSL 2](https://tailscale.com/kb/1295/install-windows-wsl2)
- [tailscaled daemon](https://tailscale.com/kb/1278/tailscaled)
- [Powercfg command-line options](https://learn.microsoft.com/en-us/windows-hardware/design/device-experiences/powercfg-command-line-options)
- [Power settings in Windows 11](https://support.microsoft.com/en-us/windows/experience/power-battery/power-settings-in-windows-11)
- [Sign in to and out of your Surface](https://support.microsoft.com/en-us/surface/setup/sign-in-to-and-out-of-your-surface) (Windows 로그인 옵션 경로)
- [Configure a Screen Saver in Windows](https://support.microsoft.com/en-au/windows/experience/configure-a-screen-saver-in-windows)
