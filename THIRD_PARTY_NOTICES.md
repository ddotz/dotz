# Third-party notices

## kakaocli

- Source: https://github.com/silver-flight-group/kakaocli
- Commit: 8b6ffcfdaebc592a735dc1a8bd5e50037e626406
- Copyright (c) 2026 Silver Flight Group, LLC
- License: MIT
- Ported into `hub/kakao/db.ts`: the database name and SQLCipher key derivation (`KeyDerivation.swift`), the device UUID and
  KakaoTalk user id discovery from the preference plists, including the SHA-512 pre-image search, and the database file
  discovery (`DeviceInfo.swift`), and the room, message and context queries (`DatabaseReader.swift`, `Models/*.swift`).
- Ported (login side): the login-window identification, the field and button lookup and the error texts of `Sources/KakaoCore/Automation/LoginAutomator.swift` into `hub/kakao/login.jxa.js`.

```
MIT License

Copyright (c) 2026 Silver Flight Group, LLC

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## kmsg

- Source: https://github.com/channprj/kmsg (commit 54cbff790b409214735ef365a621d791034fe500)
- Copyright (c) 2026 Park Hee Chan, MIT License
- Ported: the login-window, lock-screen, post-login notice and login-button detection of `Sources/kmsg/Auth/KakaoTalkAuthenticator.swift` into `hub/kakao/login.jxa.js` and `hub/kakao/login.ts` (rewritten in JavaScript for Accessibility through System Events; no Swift code is copied), and the rejected-password guard idea of `Sources/kmsg/Auth/CredentialStore.swift` (a rejected password is never submitted again), in `hub/kakao/login.ts`.
- Used, not copied: sending a KakaoTalk message invokes the installed `kmsg` CLI (`kmsg send`, with `--dry-run` first) from `hub/kakao/send.ts`.

```
MIT License

Copyright (c) 2026 Park Hee Chan

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## xterm.js

- Source: https://github.com/xtermjs/xterm.js (npm `@xterm/xterm` 6.0.0, `@xterm/addon-fit` 0.11.0)
- Copyright (c) 2017-2019, The xterm.js authors; (c) 2014-2016, SourceLair Private Company; (c) 2012-2013, Christopher Jeffrey
- License: MIT (`web/vendor/xterm-LICENSE.txt`)
- Vendored unchanged as `web/vendor/xterm.js`, `xterm.css` and `addon-fit.js` (source maps dropped); the web terminal (`web/js/36-shell.js`) loads them on first open.
