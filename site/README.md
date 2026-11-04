# dotz 사이트

정적 파일로 된 한 페이지와, 실제 웹 앱을 그대로 돌리는 데모입니다. 배포할 때 빌드 단계가 없습니다.

- `index.html` — 모든 문구와 인라인 SVG
- `style.css` — 색, 타이포그래피, 라이트·다크 테마
- `app.js` — 설치 명령 복사 버튼
- `favicon.svg`
- `demo/` — 실제 웹 앱(`web/`)을 만들어 낸 데이터로 띄우는 데모 (`/demo/`로 열립니다)

외부 요청은 없습니다. 폰트는 시스템 폰트 스택을 쓰고, 이미지나 스크립트를 네트워크에서 받지 않습니다.

## 데모 빌드

데모는 `web/`의 CSS·JS를 이어 붙여 만듭니다(게이트웨이가 `/app.css`, `/app.js`로 서빙하는 것과 같은 순서). 원본을 고치면 다시 돌리고 결과도 함께 커밋합니다.

```sh
bun site/build-demo.ts
```

`demo/fixtures.js`와 `demo/demo-api.js`는 손으로 쓴 파일이라 빌드가 건드리지 않습니다. 빌드는 `demo/index.html`의 자산 주소에 내용 해시(`?v=`)를 찍습니다. 자산은 브라우저에 몇 시간 캐시되므로, 이 버전이 없으면 다시 찾은 브라우저가 새 페이지에 옛 스크립트를 붙여 화면이 깨집니다. 페이지는 모든 `/api/*` 요청을 그 두 파일로 답하므로 실제 서버가 필요 없습니다.

## 로컬 확인

```sh
bunx serve site
```

히어로와 카드의 움직이는 장면(`js/stageshow.js`)은 `site/stageshow-src`를 고친 뒤 `bun site/stageshow-src/build.ts`로 다시 빌드합니다.

## 배포

Cloudflare Pages에 `site` 폴더를 그대로 올립니다(프로젝트 이름 `dotz`, 사용자 도메인 `ddotz.dev`).

```sh
bun site/stamp-landing.ts   # 자산 주소에 내용 해시를 찍어, 다시 찾은 브라우저가 옛 CSS와 섞이지 않게 합니다
rsync -a --delete --exclude AGENTS.md site/ /tmp/dotz-site/   # Pages는 .assetsignore를 안 읽어서, 작업 규칙 파일은 복사본에서 뺍니다
bunx wrangler pages deploy /tmp/dotz-site --project-name dotz --branch main
```

`ddotz.dev`는 Pages 프로젝트의 커스텀 도메인으로 붙어 있고, apex 레코드는 존 안의 프록시된 CNAME이다. 배포마다 `site` 폴더의 파일을 그대로 덮어쓰므로 빌드 설정은 필요 없습니다.
