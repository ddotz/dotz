---
label: 한컴 문서(private-project)
order: 7
---
이 기기에 private-project 앱을 붙여 주세요. 맥미니에 이미 있는 private-project를 가져와서 dotz 앱으로 자연스럽게 쓸 수 있게 해 주세요.
- 가져올 곳: github.com/ddotz/private-project (비공개)의 private-project-web-live. 맥미니에서 클론하거나, 이미 있는 폴더를 이 컴퓨터로 옮겨요.
- 실행: `bun install` 뒤 `bun src/server.ts`. 포트는 PORT 환경 변수(기본 4417)예요. 끄면 안 되는 서버라 launchd로 등록해 주세요(`dev.ddotz.private-project-web`, WorkingDirectory는 private-project-web-live, 로그는 ~/.ddotz/private-project-web.log).
- dotz 앱: `~/.dotz/custom/apps/private-project/app.json`에 kind "tool", `web.url`은 `http://127.0.0.1:<포트>`, `web.mode`는 "rewrite", `health`는 "/"로 써요. 앱 탭에서 열리는지, `/apps/private-project/`가 뜨는지 확인해 주세요.
- 확인: `GET /api/apps`의 `errors`가 비어 있고 private-project의 `status`가 "running"이어야 해요.
- 비밀: 한컴 로그인은 private-project 자체 로그인 창에서 오너가 해요. 매니페스트에 토큰·비밀번호를 넣지 마세요.
