# 폰 웹앱 기준 (mobile)

폰에서 쓰는 웹앱을 만들 때 `SKILL.md`와 함께 봐요. 데스크톱 브라우저의 기기 흉내 모드로는 아래 문제 대부분이 안 보이니, 되도록 실제 폰으로 개발 서버 주소를 열어 확인해요. 못 열면 어느 항목을 코드로만 확인했는지 적어요.

## 점검 명령이 재는 것 `[측정]`

1. **확대를 막지 않아요**: viewport에 `user-scalable=no`나 `maximum-scale=1`을 넣지 않아요. 입력칸이 확대를 일으키면 글자를 16px 이상으로 키워요.
2. **입력칸 글자는 16px 이상**: `input`, `textarea`, `select`. 그보다 작으면 iOS가 화면을 확대해요.
3. **안전 영역**: `env(safe-area-inset-*)`를 쓰면 viewport에 `viewport-fit=cover`도 있어야 해요. 없으면 값이 0이에요.
4. **상태 막대 색**: 다크가 있으면 `theme-color`를 `media="(prefers-color-scheme: light)"`와 `dark` 둘로 나눠 적어요.
5. **높이는 `100dvh`(앱 틀) 또는 `100svh`(첫 화면)**: `100vh`는 주소창이 접히고 펴질 때 맞지 않아요. 아래에 붙는 고정·스티키 막대도 같아요.
6. **hover는 `@media (hover: hover) and (pointer: fine)` 안에서만**: 터치에서는 처음 누른 곳에 hover가 남아요. 누르는 느낌은 `:active`로 줘요.

## 눈으로 보는 것

- 탭할 때 번쩍이는 회색은 `-webkit-tap-highlight-color: transparent`로 꺼요.
- 눌렀을 때 바로 반응하게 `touch-action: manipulation`을 단추와 링크에 줘요.
- 당겨서 새로고침이 스크롤을 가로채면 `html, body`에 `overscroll-behavior: none`.
- 단추 글자는 길게 눌러도 선택되지 않게 `user-select: none`. 본문에는 쓰지 않아요.
- 가로로 미는 목록은 세로 스크롤을 막지 않게 `touch-action: pan-y`.
- 누르는 곳 44px 이상, 키보드가 올라와도 입력칸이 가려지지 않는지 봐요.
