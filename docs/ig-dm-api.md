# Instagram DM routes (read only)

Gateway routes of the 모니터링 > 인스타그램 > DM tab (hub/ig-dm-web.ts). There is no route that sends. Source of the data: features/youtube-instagram/lib/ig-dm.ts
(Instagram API with Instagram Login, Conversations API; permission `instagram_business_manage_messages`; see features/youtube-instagram/DESIGN.md for the Meta docs).

With the feature row "DM 읽기" off, every route answers as if there were no DMs and nothing is requested from Instagram.

- `GET /api/ig-dm` -> `{ on, connected, perm: "ok"|"missing"|"unknown", line?, checkedAt, convs: [{ id, peer, lastAt, last }] }`, newest first. `line` is the Korean
  permission text when `perm` is `missing`. Reads only the stored copy.
- `GET /api/ig-dm/<conversation id>` -> `{ id, peer, messages: [{ id, text, mine, from, at, attach: ("image"|"video"|"audio"|"file")[] }] }`, oldest first. 409 when off, 404 when unknown.
- `POST /api/ig-dm/refresh` -> the `GET /api/ig-dm` body after one poll of the Instagram API (only the conversations that moved are read). 409 when off or not connected, 502 on an API failure.
