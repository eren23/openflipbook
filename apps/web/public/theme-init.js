(function () {
  try {
    var d = document.documentElement;
    var t = localStorage.getItem("openflipbook.theme");
    if (t === "sepia" || t === "dark" || t === "light") {
      d.setAttribute("data-theme", t);
    } else {
      d.setAttribute("data-theme", "light");
    }
    var raw = localStorage.getItem("openflipbook.outputLocale") || "auto";
    var head =
      raw === "auto"
        ? ((navigator.language || "en").split("-")[0] || "en").toLowerCase()
        : raw;
    d.setAttribute("lang", head);
    var rtl = head === "ar" || head === "he" || head === "fa" || head === "ur";
    d.setAttribute("dir", rtl ? "rtl" : "ltr");
  } catch (_) {}
})();
