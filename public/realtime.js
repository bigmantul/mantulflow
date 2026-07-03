// ═══════════════════════════════════════════════════════
//  public/realtime.js
//
//  Thin shared wrapper around the Socket.IO client so every
//  dashboard page connects the same way: authenticate with
//  the JWT already in localStorage/sessionStorage, auto-
//  reconnect on drop, and expose a tiny on(event, cb) API
//  for pages to subscribe to specific data events.
//
//  Requires <script src="/socket.io/socket.io.js"></script>
//  to be included BEFORE this file.
// ═══════════════════════════════════════════════════════

const RT = (function () {
  let socket = null;
  const pending = []; // [event, cb] registered before connect()

  function connect(token) {
    if (socket) return socket;

    socket = io({
      auth: { token },
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
    });

    socket.on("connect",       () => setStatus(true));
    socket.on("disconnect",    () => setStatus(false));
    socket.on("connect_error", () => setStatus(false));
    socket.on("reconnect",     () => setStatus(true));

    // Attach anything registered before the socket existed
    for (const [event, cb] of pending) socket.on(event, cb);
    pending.length = 0;

    return socket;
  }

  function on(event, cb) {
    if (socket) socket.on(event, cb);
    else pending.push([event, cb]);
  }

  // Reflects connection state onto an optional status dot/label,
  // if the page has elements with these ids. Safe no-op otherwise.
  function setStatus(isUp) {
    const dot   = document.getElementById("rtDot");
    const label = document.getElementById("rtStatus");
    if (dot) {
      dot.style.background = isUp ? "var(--green)" : "var(--red)";
      dot.style.boxShadow  = isUp ? "0 0 8px var(--green)" : "none";
    }
    if (label) {
      label.textContent = isUp ? "Live" : "Reconnecting…";
      label.style.color = isUp ? "var(--green)" : "var(--muted)";
    }
  }

  return { connect, on };
})();
