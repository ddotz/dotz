# dotz 사이트

정적 파일로 된 다섯 언어 랜딩 페이지와, 실제 웹 앱을 그대로 돌리는 데모입니다. 배포할 때 빌드 단계가 없습니다.

- `page.html` — 랜딩 템플릿 (`{{키}}`는 이스케이프, `{{{키}}}`는 그대로, `{{#키}}…{{/키}}`는 값이 있을 때만)
- `i18n/pages.json` — 페이지 문구 전부 (en, ko, ja, zh-cn, es)
- `build-pages.ts` — 템플릿과 문구로 `index.html`(en), `ko/`, `ja/`, `zh-cn/`, `es/`의 `index.html`을 만듭니다. 결과 파일을 커밋합니다
- `index.html`, `ko/index.html`, `ja/index.html`, `zh-cn/index.html`, `es/index.html` — 만들어진 랜딩 (직접 고치지 않습니다)
- `style.css` — 색, 타이포그래피, 라이트·다크 테마
- `app.js` — 설치 명령 복사 버튼, 언어 메뉴 (문구는 템플릿의 data 속성에서 읽습니다)
- `favicon.svg`
- `demo/` — 실제 웹 앱(`web/`)을 만들어 낸 데이터로 띄우는 데모 (`/demo/`로 열립니다)

외부 요청은 없습니다. 폰트는 시스템 폰트 스택을 쓰고, 이미지나 스크립트를 네트워크에서 받지 않습니다.

랜딩은 위에서 아래로 한 이야기입니다: 폰에서 확인하는 순간(히어로) → 메일만이 아님(장면 둘) → 실제 앱(`/demo/`를 페이지 안에 그대로 띄움) → 내 컴퓨터에서 돌고 먼저 물어봄 → 명령 한 줄. 누르라고 권하는 것은 설치 명령 하나이고, 구역을 더하거나 뺄 때는 앞뒤 구역과 이어지는지 먼저 봅니다. 페이지 안의 데모는 `site/demo`를 iframe으로 불러올 뿐이라 데모 쪽은 고칠 것이 없습니다.

## 데모 빌드

데모는 `web/`의 CSS·JS를 이어 붙여 만듭니다(게이트웨이가 `/app.css`, `/app.js`로 서빙하는 것과 같은 순서). 원본을 고치면 다시 돌리고 결과도 함께 커밋합니다.

```sh
bun site/build-demo.ts
```

`demo/fixtures.js`와 `demo/demo-api.js`는 손으로 쓴 파일이라 빌드가 건드리지 않습니다. 공개 사이트에 나오면 안 되는 말(`site/AGENTS.md`)은 빌드가 묶음에서 바꿔 쓰고(`web/`은 그대로), 배포되는 파일 어디든 남아 있으면 빌드가 실패합니다(`banned-words.ts`). 빌드는 `demo/index.html`의 자산 주소에 내용 해시(`?v=`)를 찍습니다. 자산은 브라우저에 몇 시간 캐시되므로, 이 버전이 없으면 다시 찾은 브라우저가 새 페이지에 옛 스크립트를 붙여 화면이 깨집니다. 페이지는 모든 `/api/*` 요청을 그 두 파일로 답하므로 실제 서버가 필요 없습니다.

## 로컬 확인

```sh
bunx serve site
```

문구나 `page.html`을 고친 뒤에는 다섯 페이지를 다시 만듭니다.

```sh
bun site/build-pages.ts
```

히어로와 카드의 움직이는 장면(`js/stageshow.js`)은 `site/stageshow-src`를 고친 뒤 `bun site/stageshow-src/build.ts`로 다시 빌드합니다. 장면 안의 문구는 `stageshow-src/strings.ts`에 언어별(`ko`, `en`, `ja`, `zh-CN`, `es`)로 모여 있고, `<html lang>`에 따라 골라 씁니다. 스크립트·CSS를 고친 뒤에는 `build-pages.ts`가 자산 해시를 새로 찍으므로 스테이지쇼 빌드 다음에 돌립니다.

README 맨 위의 소개 영상(`docs/assets/hero*.webp`, 다섯 언어)은 `site/stageshow-src/video.tsx`의 장면을 녹화기로 찍어 만듭니다. 장면이나 `strings.ts`의 `video` 문구를 고친 뒤 다시 만듭니다.

```sh
bun site/stageshow-src/record.ts
```

가상 시계(`kit/clock.ts`)를 한 프레임(40ms)씩 직접 넘기며 무대만 찍고, 같은 화면이 이어지면 한 프레임으로 합쳐 `img2webp`로 묶습니다. 약 1분 걸리고 `img2webp`가 있어야 합니다(`brew install webp`). `--lang ko,en`으로 일부 언어만, `--lossless`로 무손실로 만들 수 있습니다.

## 배포

Cloudflare Pages에 `site` 폴더를 그대로 올립니다(프로젝트 이름 `dotz`, 사용자 도메인 `ddotz.dev`).

```sh
bun site/stamp-landing.ts   # 다섯 랜딩과 시제품의 자산 주소에 내용 해시를 찍어, 다시 찾은 브라우저가 옛 CSS나 스크립트와 섞이지 않게 합니다
rsync -a --delete --exclude AGENTS.md site/ /tmp/dotz-site/   # Pages는 .assetsignore를 안 읽어서, 작업 규칙 파일은 복사본에서 뺍니다
bunx wrangler pages deploy /tmp/dotz-site --project-name dotz --branch main
```

시제품(`site/prototype`)의 CSS나 JS를 고쳤을 때도 이 찍기가 필요합니다. 이 단계는 `prototype/index.html`이 불러오는 파일마다 해시를 찍으므로, 파일을 새로 더해도 목록을 고칠 일은 없습니다.

`ddotz.dev`는 Pages 프로젝트의 커스텀 도메인으로 붙어 있고, apex 레코드는 존 안의 프록시된 CNAME이다. 배포마다 `site` 폴더의 파일을 그대로 덮어쓰므로 빌드 설정은 필요 없습니다.
