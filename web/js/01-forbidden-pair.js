// web.access = "cloudflare": the gateway answers an unpaired browser with 403 and X-Dotz-Pair (hub/devices.ts); the app then goes to the pairing page.
{
  const realFetch = window.fetch.bind(window);
  window.fetch = async (...args) => {
    const res = await realFetch(...args);
    if (res.status === 403 && res.headers.get("x-dotz-pair") && location.pathname !== "/pair") { snapForget(); location.replace((location.pathname === "/" ? "/pair" : `/pair?next=${encodeURIComponent(location.pathname + location.search)}`) + location.hash); }   // the stored conversations go with the access (13-snapshot.js)
    return res;
  };
}
