<p align="center">
  <a href="https://ddotz.dev"><img src="docs/assets/logo.svg" width="72" alt="dotz 로고"></a>
</p>

<h1 align="center">dotz</h1>

<h3 align="center">메일 정리부터 답장 초안까지, 내가 없어도 끝내 둬요.</h3>

<p align="center">
  내 컴퓨터에서 항상 켜져 있는 개인 비서.<br>
  <a href="https://ddotz.dev">웹사이트</a> · <a href="https://ddotz.dev/demo/">데모</a> · <a href="docs/reference.md">문서</a>
</p>

<p align="center">
  <img alt="최신 버전" src="https://img.shields.io/github/v/tag/ddotz/dotz?label=version&color=3182f6">
  <img alt="macOS와 Linux 지원" src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux-191f28">
</p>

<p align="center">
  <a href="https://ddotz.dev/demo/">
    <img src="docs/assets/hero.webp" width="1200" alt="dotz 채팅 화면. 새 메일이 오자 dotz가 요약과 답장 초안을 올리고, 입력창 위 확인 카드에서 보내기를 누르면 보냈어요로 바뀌는 장면.">
  </a>
</p>

## 하는 일

- **메일과 일정, 댓글을 챙겨요.** 새 소식을 확인해 알려 주고, 답장 초안까지 써 둬요.
- **폰에서 한마디면 돼요.** Discord나 테일넷 전용 웹 앱으로 말을 걸면 돼요.
- **프로젝트마다 세션이 따로예요.** 폴더마다 세션과 채널이 하나씩 생겨요.
- **보내기 전에 꼭 물어봐요.** 밖으로 나가는 일은 모두 내 승인을 기다려요.
- **내 컴퓨터에 남아요.** 로그인과 파일은 그대로 두고, 비밀값은 `~/.dotz/secrets`에 보관해요.

## 설치

```sh
curl -fsSL https://raw.githubusercontent.com/ddotz/dotz/main/install.sh | sh
```

설치 마법사가 이름과 말투, Discord 봇 토큰을 묻고 게이트웨이를 켜요. 업데이트는 이 레포에서 알아서 받아요.

## 문서

- [전체 레퍼런스](docs/reference.md): 설치 옵션, 명령어, 화면, 연동, API
- [구조](docs/ARCHITECTURE.md)
- [내 설정으로 바꾸기](docs/customization.md)
- [밖에서 웹 앱 열기](docs/web-access.ko.md)
- [개발 가이드](docs/development.md)
- [서드파티 고지](THIRD_PARTY_NOTICES.md)
