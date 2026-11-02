// web.access = "cloudflare": the gateway answers an unpaired browser with 403 and X-Dotz-Pair (hub/devices.ts); the app then goes to the pairing page.
{
  const realFetch = window.fetch.bind(window);
  window.fetch = async (...args) => {
    const res = await realFetch(...args);
    if (res.status === 403 && res.headers.get("x-dotz-pair") && location.pathname !== "/pair") location.replace("/pair");
    return res;
  };
}
