<p align="center">
  <a href="https://ddotz.dev"><img src="docs/assets/logo.svg" width="72" alt="dotz 로고"></a>
</p>

<h1 align="center">dotz</h1>

<h3 align="center">맨날 미루던 잡일, dotz가 먼저 해 놓고 폰으로 알려 줘요.</h3>

<p align="center">
  내 컴퓨터에서 항상 켜져 있는 개인 비서.<br>
  <a href="https://ddotz.dev">웹사이트</a> · <a href="https://ddotz.dev/demo/">데모</a> · <a href="docs/reference.md">문서</a>
</p>

<p align="center">
  <img alt="최신 버전" src="https://img.shields.io/github/v/tag/ddotz/dotz?label=version&color=3182f6">
  <img alt="macOS, Linux, Windows(WSL) 지원" src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows%20(WSL)-191f28">
</p>

<p align="center">
  <a href="https://ddotz.dev/demo/">
    <img src="docs/assets/hero.webp" width="1200" alt="dotz 채팅 화면. 새 메일이 오자 dotz가 요약과 답장 초안을 올리고, 입력창 위 확인 카드에서 보내기를 누르면 보냈어요로 바뀌는 장면.">
  </a>
</p>

## 하는 일

- **메일과 일정, 댓글을 챙겨요.** 새 소식을 확인해 알려 주고, 내 말투로 답장 초안까지 써 둬요.
- **폰에서 한마디면 돼요.** 웹 앱이나 Discord, Telegram, JANDI로 말을 걸면 돼요. Slack으로는 알림과 답을 받아 볼 수 있어요. 연달아 보낸 메시지는 묶어서 한 번에 답해요.
- **프로젝트마다 세션이 따로예요.** 폴더마다 세션과 채널이 하나씩 생겨요.
- **끊긴 일은 알아서 이어가요.** 재시작이나 네트워크 끊김으로 멈춘 일을 다시 띄워 마저 해요.
- **지난 대화를 찾아 줘요.** "그때 그거"처럼 막연하게 물어도 돼요. 색인과 검색은 이 컴퓨터 안에서만 돌아요.
- **컴퓨터 여러 대를 한곳에서 봐요.** 같은 Tailscale 계정의 컴퓨터가 목록에 뜨고, 앱에서 골라 옮겨 다녀요. 꺼진 컴퓨터는 목록에서 지울 수 있어요.
- **보내기 전에 꼭 물어봐요.** 밖으로 나가는 일은 모두 내 승인을 기다려요.
- **내 컴퓨터에 남아요.** 로그인과 파일은 그대로 두고, 비밀값은 `~/.dotz/secrets`에 보관해요.

## 설치

```sh
curl -fsSL https://raw.githubusercontent.com/ddotz/dotz/main/install.sh | sh
```

맥과 리눅스는 터미널에서 바로, 윈도우는 WSL 안에서 실행해요. WSL에 깔린 dotz가 윈도우를 다뤄요: [윈도우 설치 가이드](docs/windows.md)

새로 설치하면 브라우저가 열리고, 거기서 이름과 말투, 연결할 것을 차례로 정해요. 한 번 쓰는 주소는 이 컴퓨터에서만 열려요. 끝나면 게이트웨이가 켜지고 화면 안내가 한 번 떠요. 업데이트는 이 레포에서 알아서 받아요.

게이트웨이가 도는 컴퓨터에서는 터미널에 `dotz`만 치면 웹 앱이 로그인된 채로 열려요. 다른 기기에서 열려면 Tailscale이나 Cloudflare를 고르세요.

- `--no-open`을 주거나 SSH, 화면 없는 컴퓨터에서는 브라우저를 열지 않고 주소를 터미널에 찍어요. SSH면 내 컴퓨터에서 쓸 `ssh -L` 한 줄도 같이 나와요.
- 터미널에서 묻는 쪽이 좋으면 `--setup`을 주거나 나중에 `bun setup.ts`를 실행하세요. 이미 설치한 컴퓨터에서 다시 실행해도 온보딩은 뜨지 않아요.

## 문서

- [전체 레퍼런스](docs/reference.md): 설치 옵션, 명령어, 화면, 연동, API
- [구조](docs/ARCHITECTURE.md)
- [내 설정으로 바꾸기](docs/customization.md)
- [밖에서 웹 앱 열기](docs/web-access.ko.md)
- [메신저 연결](docs/messengers/README.ko.md)
- [맥락 검색](docs/context-search.md)
- [윈도우(WSL) 설치](docs/windows.md)
- [개발 가이드](docs/development.md)
- [서드파티 고지](THIRD_PARTY_NOTICES.md)
