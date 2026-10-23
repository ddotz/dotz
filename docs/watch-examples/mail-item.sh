#!/bin/sh
# A report about an app item shows that item the way the app shows it. Print one DOTZ_ITEM line and the feed draws the app's own card
# (for a mail: sender, time, subject, summary, attachment clip; tap opens the mail). Your other lines stay under "원문 보기".
#   DOTZ_ITEM mail:<source>/<id>     the source and id the mail was posted with (POST /api/mail), or the mail key: DOTZ_ITEM mail:<key>
#   subject: <text>  from: <text>    optional; shown when the hub has no such mail itself (it is on another gateway)
# Put the DOTZ_ITEM line in the first lines: the raw text kept with the report is cut after five lines.
# Add it with: dotz_watch add {name, label, script: "<abs path>", on: "match", pattern: "DOTZ_ITEM"}.
# This one reports the mail ids listed in the file $DOTZ_WATCH_STATE_DIR/new (one "<source>/<id> <subject>" per line), then empties it.
state="${DOTZ_WATCH_STATE_DIR:?run it as a dotz_watch script}"
[ -s "$state/new" ] || exit 0
head -n 1 "$state/new" | while read -r ref subject; do
  echo "DOTZ_ITEM mail:$ref"
  [ -n "$subject" ] && echo "subject: $subject"
done
: > "$state/new"
exit 0
