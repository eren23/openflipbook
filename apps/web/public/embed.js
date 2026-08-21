// openflipbook embed wrapper — for pages whose platform doesn't speak oEmbed.
// Usage (one line each):
//   <div data-openflipbook="https://<host>/n/<nodeId>"></div>
//   <script async src="https://<host>/embed.js"></script>
// Each tagged div is swapped for the interactive world iframe, built with DOM
// methods only (no innerHTML — the attribute is page-author input). The world
// must be published (right-click → Publish) or the framed page 404s.
(function () {
  function targetSrc(raw) {
    var url;
    try {
      url = new URL(raw, window.location.href);
    } catch (e) {
      return null;
    }
    var parts = url.pathname.split("/").filter(Boolean);
    if (parts.length !== 2) return null;
    if (parts[0] === "embed") return url.origin + "/embed/" + parts[1] + url.search;
    if (parts[0] === "n") {
      // A /n/<nodeId> permalink: let the provider resolve node -> session.
      return (
        url.origin + "/embed/_from-node?node=" + encodeURIComponent(parts[1])
      );
    }
    return null;
  }
  function mount(el) {
    var raw = el.getAttribute("data-openflipbook");
    if (!raw || el.getAttribute("data-ofb-mounted")) return;
    var src = targetSrc(raw);
    if (!src) return;
    el.setAttribute("data-ofb-mounted", "1");
    var width = Math.max(320, Math.min(1280, Math.round(el.clientWidth || 720)));
    var frame = document.createElement("iframe");
    frame.src = src;
    frame.width = String(width);
    frame.height = String(Math.round(width * 0.625));
    frame.loading = "lazy";
    frame.title = "openflipbook world";
    frame.style.border = "0";
    frame.style.maxWidth = "100%";
    frame.style.borderRadius = "12px";
    el.appendChild(frame);
  }
  function scan() {
    var els = document.querySelectorAll("[data-openflipbook]");
    for (var i = 0; i < els.length; i++) mount(els[i]);
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", scan);
  } else {
    scan();
  }
})();
