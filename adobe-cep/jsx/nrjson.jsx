/*
 * NRJSON — sérialiseur JSON minimal pour ExtendScript (ES3, pas de JSON natif).
 * stringify uniquement (le parse se fait côté panneau, JSON natif de CEF).
 */
var NRJSON = (function () {
  var ESC = { "\b": "\\b", "\t": "\\t", "\n": "\\n", "\f": "\\f", "\r": "\\r", '"': '\\"', "\\": "\\\\" };

  function esc(s) {
    var out = "", i, c, code;
    for (i = 0; i < s.length; i++) {
      c = s.charAt(i);
      if (ESC[c]) { out += ESC[c]; continue; }
      code = s.charCodeAt(i);
      if (code < 32) {
        out += "\\u" + ("0000" + code.toString(16)).slice(-4);
      } else {
        out += c;
      }
    }
    return out;
  }

  function str(v) {
    var i, k, parts, t;
    if (v === null || v === undefined) return "null";
    t = typeof v;
    if (t === "number") return isFinite(v) ? String(v) : "null";
    if (t === "boolean") return String(v);
    if (t === "string") return '"' + esc(v) + '"';
    if (t === "object") {
      if (v instanceof Array) {
        parts = [];
        for (i = 0; i < v.length; i++) parts.push(str(v[i]));
        return "[" + parts.join(",") + "]";
      }
      parts = [];
      for (k in v) {
        if (v.hasOwnProperty(k) && typeof v[k] !== "function") {
          parts.push('"' + esc(k) + '":' + str(v[k]));
        }
      }
      return "{" + parts.join(",") + "}";
    }
    return "null";
  }

  return { stringify: str };
})();
