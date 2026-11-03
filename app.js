(async function () {
  var $ = function (id) { return document.getElementById(id); };
  var state = { devs: [], apps: [], links: [], loaded: { d: false, a: false, l: false }, boot: false, view: "matrix", q: "", risk: false, armed: null, canWrite: true, edit: null, pendingRender: false };
  var db = null, downloads = null, armTimer = null, statusTimer = null;
  var collator = new Intl.Collator("fr", { sensitivity: "base", numeric: true });
  var CRIT = { 1: "Standard", 2: "Importante", 3: "Critique" };
  var PCS = [10, 20, 30, 50, 80, 100];

  function h(tag, attrs, kids) {
    var el = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === "class") el.className = attrs[k];
      else if (k === "text") el.textContent = attrs[k];
      else if (k.indexOf("on") === 0) el.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] === true) el.setAttribute(k, "");
      else if (attrs[k] !== false && attrs[k] != null) el.setAttribute(k, attrs[k]);
    });
    (kids || []).forEach(function (c) { if (c) el.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
    return el;
  }
  function say(msg, isErr) {
    var s = $("status"); s.textContent = msg; s.className = "status" + (isErr ? " err" : "");
    clearTimeout(statusTimer);
    if (msg) statusTimer = setTimeout(function () { s.textContent = ""; }, 6000);
  }
  function key(d, a) { return d + ":" + a; }
  function plural(n, one, many) { return n + " " + (n > 1 ? many : one); }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function norm(s) { return String(s == null ? "" : s).replace(/\s+/g, " ").trim(); }
  function fmt1(n) { return n.toLocaleString("fr-FR", { maximumFractionDigits: 1 }); }
  function parseNames(str) {
    var seen = {}, out = [];
    String(str).split(/[\n;,]+/).forEach(function (s) {
      var n = norm(s);
      if (n && !seen[n.toLowerCase()]) { seen[n.toLowerCase()] = 1; out.push(n); }
    });
    return out;
  }

  /* ---------- modèle ---------- */
  function appStatus(a, n, refs) {
    if (n === 0) return { key: "none", level: "crit", label: "Non couverte" };
    if (refs === 0) return { key: "noref", level: a.crit >= 2 ? "crit" : "warn", label: "Sans référent" };
    if (n === 1) return { key: "single", level: a.crit === 3 ? "crit" : "warn", label: "Point unique" };
    return { key: "ok", level: "ok", label: n + " DevOps" };
  }
  function model() {
    var devs = state.devs.slice().sort(function (x, y) { return collator.compare(x.name, y.name); });
    var apps = state.apps.slice().sort(function (x, y) { return (y.crit - x.crit) || collator.compare(x.name, y.name); });
    var devIds = {}, appIds = {};
    devs.forEach(function (d) { devIds[d.id] = d; });
    apps.forEach(function (a) { appIds[a.id] = a; });
    var link = {}, byDev = {}, byApp = {}, load = {}, tot = {}, refs = {};
    state.links.forEach(function (l) {
      if (!devIds[l.d] || !appIds[l.a] || l.pct <= 0) return;
      link[key(l.d, l.a)] = l;
      (byDev[l.d] = byDev[l.d] || []).push(l);
      (byApp[l.a] = byApp[l.a] || []).push(l);
      load[l.d] = (load[l.d] || 0) + l.pct;
      tot[l.a] = (tot[l.a] || 0) + l.pct;
      if (l.role === "ref") refs[l.a] = (refs[l.a] || 0) + 1;
    });
    var status = {}, devLevel = {};
    apps.forEach(function (a) { status[a.id] = appStatus(a, (byApp[a.id] || []).length, refs[a.id] || 0); });
    devs.forEach(function (d) {
      var s = load[d.id] || 0;
      devLevel[d.id] = s > d.cap ? "crit" : (s > 0 && s >= d.cap * 0.9 ? "warn" : "ok");
    });
    return { devs: devs, apps: apps, devIds: devIds, appIds: appIds, link: link, byDev: byDev, byApp: byApp, load: load, tot: tot, refs: refs, status: status, devLevel: devLevel };
  }
  function visible(m) {
    var q = state.q.trim().toLowerCase();
    var devs = m.devs, apps = m.apps;
    if (q) {
      var md = {}, ma = {}, rd = {}, ra = {};
      m.devs.forEach(function (d) { if (d.name.toLowerCase().indexOf(q) >= 0) md[d.id] = 1; });
      m.apps.forEach(function (a) { if (a.name.toLowerCase().indexOf(q) >= 0) ma[a.id] = 1; });
      Object.keys(md).forEach(function (d) { rd[d] = 1; (m.byDev[d] || []).forEach(function (l) { ra[l.a] = 1; }); });
      Object.keys(ma).forEach(function (a) { ra[a] = 1; (m.byApp[a] || []).forEach(function (l) { rd[l.d] = 1; }); });
      devs = devs.filter(function (d) { return rd[d.id]; });
      apps = apps.filter(function (a) { return ra[a.id]; });
    }
    if (state.risk) apps = apps.filter(function (a) { return m.status[a.id].level !== "ok"; });
    return { devs: devs, apps: apps };
  }

  /* ---------- écritures ---------- */
  async function guard(fn) {
    if (!db || !state.canWrite) return false;
    try { await fn(); return true; }
    catch (e) {
      var c = e && e.code;
      if (c === "invalid_argument") say("Modification refusée : données invalides.", true);
      else if (c === "storage") say("Le navigateur refuse d'enregistrer (navigation privée ou stockage plein). Exportez une sauvegarde JSON.", true);
      else if (c === "quota_exceeded") say("Limite de stockage atteinte, supprimez des entrées avant d'en ajouter.", true);
      else if (c === "resource_exhausted") say("Trop d'enregistrements d'un coup. Attendez un instant puis réessayez.", true);
      else say("L'enregistrement a échoué. Réessayez dans un instant.", true);
      return false;
    }
  }
  function setLink(d, a, pct, role) {
    return guard(function () { return db.doc("staffing/" + key(d, a)).set({ d: d, a: a, pct: clamp(Math.round(pct), 1, 100), role: role }); });
  }
  function dropLink(d, a) {
    return guard(function () { return db.doc("staffing/" + key(d, a)).delete(); });
  }
  function addMany(kind, raw) {
    return guard(async function () {
      var list = state[kind === "devops" ? "devs" : "apps"];
      var have = {}; list.forEach(function (x) { have[x.name.toLowerCase()] = 1; });
      var all = parseNames(raw);
      var fresh = all.filter(function (n) { return !have[n.toLowerCase()]; });
      var skipped = all.length - fresh.length;
      for (var i = 0; i < fresh.length; i++) await db.collection(kind).add(kind === "devops" ? { name: fresh[i], cap: 100 } : { name: fresh[i], crit: 1 });
      say(fresh.length ? plural(fresh.length, "ajout", "ajouts") + (skipped ? ", " + plural(skipped, "doublon ignoré", "doublons ignorés") : "") : (skipped ? "Déjà présent dans le plan." : ""));
    });
  }
  function removeEntity(kind, id) {
    return guard(async function () {
      var isDev = kind === "devops";
      var rel = state.links.filter(function (l) { return isDev ? l.d === id : l.a === id; });
      for (var i = 0; i < rel.length; i++) await db.doc("staffing/" + key(rel[i].d, rel[i].a)).delete();
      await db.doc(kind + "/" + id).delete();
      if (state.edit && (state.edit.d === id || state.edit.a === id)) state.edit = null;
      say(isDev ? "DevOps retiré du plan." : "Application retirée du plan.");
    });
  }
  function armOrRemove(kind, id) {
    var k = kind + ":" + id;
    if (state.armed === k) { clearTimeout(armTimer); state.armed = null; removeEntity(kind, id); render(); return; }
    state.armed = k; render();
    clearTimeout(armTimer);
    armTimer = setTimeout(function () { state.armed = null; render(); }, 4000);
  }
  function rmButton(kind, id, name) {
    var armed = state.armed === kind + ":" + id;
    return h("button", {
      class: "rm" + (armed ? " arm" : ""), type: "button", disabled: !state.canWrite,
      "aria-label": (armed ? "Confirmer la suppression de " : "Supprimer ") + name,
      title: armed ? "Cliquez encore pour confirmer" : "Retirer du plan",
      text: armed ? "Supprimer ?" : "×",
      onclick: function () { armOrRemove(kind, id); }
    });
  }

  /* ---------- rendu ---------- */
  function pill(st) { return h("span", { class: "pill " + st.level, text: st.key === "ok" ? st.label : st.label }); }
  function renderStats(m) {
    var risk = m.apps.filter(function (a) { return m.status[a.id].level !== "ok"; }).length;
    var critRisk = m.apps.filter(function (a) { return a.crit === 3 && m.status[a.id].level !== "ok"; }).length;
    var over = m.devs.filter(function (d) { return m.devLevel[d.id] === "crit"; }).length;
    var el = $("stats"); el.textContent = "";
    [["DevOps", m.devs.length, ""], ["Applications", m.apps.length, ""], ["Apps à risque", risk, risk ? "warn" : ""], ["Critiques à risque", critRisk, critRisk ? "crit" : ""], ["En surcharge", over, over ? "crit" : ""]].forEach(function (s) {
      el.appendChild(h("div", { class: "stat " + s[2] }, [h("b", { text: String(s[1]) }), h("span", { text: s[0] })]));
    });
  }
  function openCell(m, d, a) {
    if (state.edit && state.edit.d === d && state.edit.a === a) { state.edit = null; render(); return; }
    var cur = m.link[key(d, a)];
    state.edit = { d: d, a: a, role: cur ? cur.role : ((m.refs[a] || 0) > 0 ? "sup" : "ref") };
    render();
  }
  function renderEditor(m) {
    var box = $("editor"), e = state.edit;
    if (state.view !== "matrix" || !e || !m || !m.devIds[e.d] || !m.appIds[e.a]) { box.hidden = true; box.textContent = ""; box.dataset.sig = ""; return; }
    var cur = m.link[key(e.d, e.a)];
    var sig = [e.d, e.a, e.role, cur ? cur.pct + cur.role : "-", state.canWrite, m.load[e.d] || 0].join("|");
    if (box.dataset.sig === sig && !box.hidden) return;
    box.dataset.sig = sig; box.hidden = false; box.textContent = "";
    var dev = m.devIds[e.d], app = m.appIds[e.a];
    var rest = dev.cap - (m.load[e.d] || 0);
    function choose(v) { setLink(e.d, e.a, v, e.role); }
    var pcs = PCS.map(function (v) {
      return h("button", { class: "pc", type: "button", disabled: !state.canWrite, "aria-pressed": cur && cur.pct === v ? "true" : "false", text: v + " %", onclick: function () { choose(v); } });
    });
    var custom = h("input", { type: "number", id: "ed-pct", min: "1", max: "100", step: "5", placeholder: "autre %", "aria-label": "Autre pourcentage", disabled: !state.canWrite });
    var ok = h("button", { class: "btn small", type: "button", disabled: !state.canWrite, text: "OK", onclick: function () { var v = Number(custom.value); if (v >= 1 && v <= 100) choose(v); } });
    custom.addEventListener("keydown", function (ev) { if (ev.key === "Enter") { ev.preventDefault(); ok.click(); } });
    function roleBtn(r, label) {
      return h("button", { class: "pc role", type: "button", disabled: !state.canWrite, "aria-pressed": e.role === r ? "true" : "false", text: label, onclick: function () {
        e.role = r;
        if (cur) setLink(e.d, e.a, cur.pct, r); else render();
      } });
    }
    box.appendChild(h("div", { class: "ed-head" }, [h("h3", { text: dev.name + " sur " + app.name }), h("span", { text: "Charge " + (m.load[e.d] || 0) + " / " + dev.cap + " %" + (rest >= 0 ? " · reste " + rest + " %" : " · dépasse de " + (-rest) + " %") })]));
    box.appendChild(h("div", { class: "ed-row" }, [h("span", { class: "lbl", text: "Part du temps" })].concat(pcs, [custom, ok])));
    box.appendChild(h("div", { class: "ed-row" }, [h("span", { class: "lbl", text: "Rôle" }), roleBtn("ref", "Référent"), roleBtn("sup", "Renfort")]));
    box.appendChild(h("div", { class: "ed-foot" }, [
      h("span", { class: "hint", text: cur ? "Modifiez le pourcentage ou le rôle, c'est enregistré aussitôt." : "Choisissez un pourcentage pour affecter " + dev.name + "." }),
      h("div", { class: "ed-row" }, [
        cur ? h("button", { class: "btn danger small", type: "button", disabled: !state.canWrite, text: "Retirer de l'application", onclick: function () { state.edit = null; dropLink(e.d, e.a); render(); } }) : null,
        h("button", { class: "btn ghost small", type: "button", text: "Fermer", onclick: function () { state.edit = null; render(); } })
      ])
    ]));
  }
  function renderMatrix(m, v) {
    var hr = h("tr", null, [h("th", { class: "corner", scope: "col", text: "DevOps ↓  Application →" })]);
    v.apps.forEach(function (a) {
      var cb = h("button", { class: "critb c" + a.crit, type: "button", disabled: !state.canWrite, title: "Criticité : cliquez pour changer",
        text: CRIT[a.crit], onclick: function () { guard(function () { return db.doc("apps/" + a.id).update({ crit: a.crit % 3 + 1 }); }); } });
      hr.appendChild(h("th", { scope: "col" }, [h("div", { class: "hd" }, [h("span", { text: a.name }), rmButton("apps", a.id, a.name)]), cb]));
    });
    hr.appendChild(h("th", { scope: "col", text: "Charge" }));
    var body = h("tbody");
    v.devs.forEach(function (d) {
      var sum = m.load[d.id] || 0, lvl = m.devLevel[d.id];
      var cin = h("input", { type: "number", class: "capin", id: "cap-" + d.id, min: "0", max: "100", step: "5", value: String(d.cap), disabled: !state.canWrite, "aria-label": "Capacité de " + d.name + " en pourcentage" });
      cin.addEventListener("change", function () {
        if (cin.value === "") return;
        var val = clamp(Math.round(Number(cin.value)), 0, 100);
        guard(function () { return db.doc("devops/" + d.id).update({ cap: val }); });
      });
      var tr = h("tr", null, [h("th", { class: "rowh", scope: "row" }, [
        h("div", { class: "hd" }, [h("span", { text: d.name }), rmButton("devops", d.id, d.name)]),
        h("label", { class: "capl", for: "cap-" + d.id }, ["Capacité", cin, "%"])
      ])]);
      v.apps.forEach(function (a) {
        var cur = m.link[key(d.id, a.id)];
        var sel = state.edit && state.edit.d === d.id && state.edit.a === a.id;
        var b = h("button", { class: "cell" + (cur ? " " + cur.role : "") + (sel ? " sel" : ""), type: "button", disabled: !state.canWrite,
          "aria-expanded": sel ? "true" : "false",
          "aria-label": d.name + " sur " + a.name + (cur ? ", " + cur.pct + " %, " + (cur.role === "ref" ? "référent" : "renfort") : ", non affecté"),
          text: cur ? String(cur.pct) : "", onclick: function () { openCell(m, d.id, a.id); } });
        tr.appendChild(h("td", null, [b]));
      });
      var pct = d.cap > 0 ? Math.min(100, Math.round(sum / d.cap * 100)) : (sum > 0 ? 100 : 0);
      var lc = h("td", { class: "load" }, [
        h("div", { text: sum + " / " + d.cap + " %" }),
        h("div", { class: "bar " + lvl }, [h("i", { style: "width:" + pct + "%" })]),
        lvl === "ok" ? null : h("div", null, [h("span", { class: "pill " + lvl, text: lvl === "crit" ? "surcharge" : "presque plein" })])
      ]);
      tr.appendChild(lc);
      body.appendChild(tr);
    });
    var foot = h("tr", null, [h("th", { class: "rowh", scope: "row", text: "Couverture" })]);
    v.apps.forEach(function (a) { foot.appendChild(h("td", null, [pill(m.status[a.id])])); });
    foot.appendChild(h("td"));
    var foot2 = h("tr", null, [h("th", { class: "rowh", scope: "row", text: "Temps total" })]);
    v.apps.forEach(function (a) { foot2.appendChild(h("td", { text: fmt1((m.tot[a.id] || 0) / 100) + " ETP" })); });
    foot2.appendChild(h("td"));
    var table = h("table", null, [h("thead", null, [hr]), body, h("tfoot", null, [foot, foot2])]);
    return h("div", { class: "scroll" }, [table]);
  }
  function chipFor(name, l) {
    return h("span", { class: "chip" + (l.role === "ref" ? " ref" : "") }, [name + " ", h("small", { text: l.pct + " %" + (l.role === "ref" ? " · réf" : "") })]);
  }
  function renderLists(m, v) {
    var byDev = h("section", null, [h("h2", { text: "Par DevOps" })]);
    v.devs.forEach(function (d) {
      var ls = (m.byDev[d.id] || []).slice().sort(function (x, y) { return collator.compare(m.appIds[x.a].name, m.appIds[y.a].name); });
      var chips = ls.length ? h("div", { class: "chips" }, ls.map(function (l) { return chipFor(m.appIds[l.a].name, l); })) : h("span", { class: "none", text: "Aucune application" });
      var lvl = m.devLevel[d.id];
      byDev.appendChild(h("div", { class: "item" }, [h("header", null, [h("b", { text: d.name }), h("span", { class: "pill " + (lvl === "ok" ? "ok" : lvl), text: (m.load[d.id] || 0) + " / " + d.cap + " %" })]), chips]));
    });
    if (!v.devs.length) byDev.appendChild(h("span", { class: "none", text: "Aucun DevOps ne correspond." }));
    var byApp = h("section", null, [h("h2", { text: "Par application" })]);
    v.apps.forEach(function (a) {
      var ls = (m.byApp[a.id] || []).slice().sort(function (x, y) { return (y.role === "ref") - (x.role === "ref") || collator.compare(m.devIds[x.d].name, m.devIds[y.d].name); });
      var chips = ls.length ? h("div", { class: "chips" }, ls.map(function (l) { return chipFor(m.devIds[l.d].name, l); })) : h("span", { class: "none", text: "Aucun DevOps affecté" });
      byApp.appendChild(h("div", { class: "item" }, [h("header", null, [h("b", { text: a.name + " · " + CRIT[a.crit] }), pill(m.status[a.id])]), chips]));
    });
    if (!v.apps.length) byApp.appendChild(h("span", { class: "none", text: "Aucune application ne correspond." }));
    return h("div", { class: "lists" }, [byDev, byApp]);
  }
  function renderEmpty() {
    return h("div", { class: "empty" }, [
      h("h2", { text: "Le plan est vide" }),
      h("p", { text: "Ajoutez vos DevOps et vos applications, puis cliquez une case de la matrice pour affecter quelqu'un." }),
      h("ol", null, [
        h("li", { text: "Saisissez un ou plusieurs noms de DevOps, séparés par une virgule." }),
        h("li", { text: "Faites de même pour les applications, puis réglez leur criticité en cliquant sur leur badge." }),
        h("li", { text: "Cliquez une case pour choisir le pourcentage de temps et le rôle (référent ou renfort)." }),
        h("li", { text: "Vous avez déjà un plan de l'ancienne version ? Utilisez « Importer » avec son export JSON." })
      ])
    ]);
  }
  function setView() {
    var v = state.view;
    $("tab-matrix").setAttribute("aria-selected", String(v === "matrix"));
    $("tab-list").setAttribute("aria-selected", String(v === "list"));
    $("legend").hidden = v !== "matrix";
  }
  function render() {
    if (document.activeElement && document.activeElement.classList && document.activeElement.classList.contains("capin")) { state.pendingRender = true; return; }
    state.pendingRender = false;
    var board = $("board");
    var off = !state.canWrite || !db;
    ["in-dev", "in-app"].forEach(function (id) { $(id).disabled = off; });
    document.querySelectorAll(".tools .btn").forEach(function (b) { b.disabled = off; });
    $("btn-json-in").disabled = off;
    $("btn-csv").hidden = !downloads; $("btn-json-out").hidden = !downloads;
    setView();
    if (!state.boot) { board.textContent = ""; board.appendChild(h("p", { class: "none", text: "Chargement du plan…" })); renderEditor(null); return; }
    if (!db) {
      board.textContent = ""; renderEditor(null);
      board.appendChild(h("div", { class: "empty" }, [h("h2", { text: "Serveur injoignable" }), h("p", { text: "Le serveur est injoignable. Lancez « npm start » dans le dossier du projet, puis rechargez la page." })]));
      renderStats(model()); return;
    }
    if (!(state.loaded.d && state.loaded.a && state.loaded.l)) { board.textContent = ""; renderEditor(null); board.appendChild(h("p", { class: "none", text: "Chargement du plan…" })); return; }
    var m = model(); renderStats(m);
    $("btn-csv").disabled = !m.devs.length;
    renderEditor(m);
    board.textContent = "";
    if (!m.devs.length && !m.apps.length) { board.appendChild(renderEmpty()); return; }
    var v = visible(m);
    if (state.view === "matrix") {
      if (!m.devs.length || !m.apps.length) {
        board.appendChild(h("div", { class: "empty" }, [h("h2", { text: m.devs.length ? "Ajoutez une application" : "Ajoutez un DevOps" }), h("p", { text: "La matrice apparaît dès qu'il y a au moins un DevOps et une application." })]));
      } else if (!v.devs.length || !v.apps.length) {
        board.appendChild(h("p", { class: "none", text: "Rien ne correspond à ce filtre." }));
      } else board.appendChild(renderMatrix(m, v));
    } else if (state.view === "list") board.appendChild(renderLists(m, v));
  }

  /* ---------- export / import ---------- */
  function saveFile(filename, data) {
    return downloads.save({ filename: filename, data: data }).then(function () { say("Fichier enregistré."); })
      .catch(function (e) { if (!e || e.code !== "declined") say("Export impossible dans cette vue.", true); });
  }
  function exportCsv() {
    var m = model();
    function esc(s) { s = String(s); return /[";\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
    var lines = [["DevOps", "Capacité %"].concat(m.apps.map(function (a) { return a.name; })).concat(["Charge %"]).map(esc).join(";")];
    lines.push(["Criticité", ""].concat(m.apps.map(function (a) { return CRIT[a.crit]; })).concat([""]).map(esc).join(";"));
    m.devs.forEach(function (d) {
      var row = [d.name, d.cap].concat(m.apps.map(function (a) { var l = m.link[key(d.id, a.id)]; return l ? l.pct + (l.role === "ref" ? " (réf)" : "") : ""; })).concat([m.load[d.id] || 0]);
      lines.push(row.map(esc).join(";"));
    });
    lines.push(["Couverture", ""].concat(m.apps.map(function (a) { return m.status[a.id].label; })).concat([""]).map(esc).join(";"));
    lines.push(["Temps total (ETP)", ""].concat(m.apps.map(function (a) { return fmt1((m.tot[a.id] || 0) / 100); })).concat([""]).map(esc).join(";"));
    saveFile("staffing-plan.csv", "﻿" + lines.join("\r\n"));
  }
  function exportJson() {
    var o = { devops: {}, apps: {}, staffing: {} };
    state.devs.forEach(function (d) { o.devops[d.id] = { name: d.name, cap: d.cap }; });
    state.apps.forEach(function (a) { o.apps[a.id] = { name: a.name, crit: a.crit }; });
    state.links.forEach(function (l) { o.staffing[key(l.d, l.a)] = { d: l.d, a: l.a, pct: l.pct, role: l.role }; });
    saveFile("staffing-plan.json", JSON.stringify({ format: "staffing-plan", version: 2, data: o }, null, 2));
  }
  function importJson(text) {
    var j;
    try { j = JSON.parse(text); } catch (e) { say("Ce fichier n'est pas un export du staffing plan.", true); return; }
    var src = j && j.format === "staffing-plan" && j.data && typeof j.data === "object" ? j.data : null;
    if (!src) { say("Ce fichier n'est pas un export du staffing plan.", true); return; }
    var v1 = !(j.version >= 2);
    var okId = /^[A-Za-z0-9_.~+@-]{1,100}$/;
    var devs = [], apps = [], links = [];
    Object.keys(src.devops || {}).forEach(function (id) { var x = src.devops[id] || {}; if (okId.test(id) && norm(x.name)) devs.push({ id: id, name: norm(x.name), cap: x.cap == null ? 100 : clamp(Math.round(Number(x.cap) || 0), 0, 100) }); });
    Object.keys(src.apps || {}).forEach(function (id) { var x = src.apps[id] || {}; if (okId.test(id) && norm(x.name)) apps.push({ id: id, name: norm(x.name), crit: [1, 2, 3].indexOf(Number(x.crit)) >= 0 ? Number(x.crit) : 1 }); });
    var dIds = {}, aIds = {};
    devs.forEach(function (d) { dIds[d.id] = 1; }); apps.forEach(function (a) { aIds[a.id] = 1; });
    Object.keys(src.staffing || {}).forEach(function (k) {
      var x = src.staffing[k] || {};
      if (!dIds[x.d] || !aIds[x.a]) return;
      links.push({ d: x.d, a: x.a, pct: v1 ? 20 : clamp(Math.round(Number(x.pct) || 0), 1, 100), role: v1 ? "ref" : (x.role === "sup" ? "sup" : "ref") });
    });
    if (!devs.length && !apps.length) { say("Rien à importer dans ce fichier.", true); return; }
    guard(async function () {
      for (var i = 0; i < devs.length; i++) await db.doc("devops/" + devs[i].id).set({ name: devs[i].name, cap: devs[i].cap });
      for (var k = 0; k < apps.length; k++) await db.doc("apps/" + apps[k].id).set({ name: apps[k].name, crit: apps[k].crit });
      for (var n = 0; n < links.length; n++) await db.doc("staffing/" + key(links[n].d, links[n].a)).set(links[n]);
      say(plural(devs.length, "DevOps", "DevOps") + ", " + plural(apps.length, "application", "applications") + ", " + plural(links.length, "affectation", "affectations") + " importés." + (v1 ? " Ancien format : chaque affectation est à 20 % en référent, à ajuster." : ""));
    });
  }

  /* ---------- événements ---------- */
  $("f-dev").addEventListener("submit", function (e) { e.preventDefault(); var v = $("in-dev").value; if (v.trim()) { $("in-dev").value = ""; addMany("devops", v); } });
  $("f-app").addEventListener("submit", function (e) { e.preventDefault(); var v = $("in-app").value; if (v.trim()) { $("in-app").value = ""; addMany("apps", v); } });
  $("in-q").addEventListener("input", function (e) { state.q = e.target.value; render(); });
  $("in-risk").addEventListener("change", function (e) { state.risk = e.target.checked; render(); });
  $("tab-matrix").addEventListener("click", function () { state.view = "matrix"; render(); });
  $("tab-list").addEventListener("click", function () { state.view = "list"; render(); });
  $("btn-csv").addEventListener("click", function () { if (downloads) exportCsv(); });
  $("btn-json-out").addEventListener("click", function () { if (downloads) exportJson(); });
  $("btn-json-in").addEventListener("click", function () { $("in-file").click(); });
  $("in-file").addEventListener("change", function (e) {
    var f = e.target.files && e.target.files[0]; e.target.value = "";
    if (!f) return;
    var r = new FileReader();
    r.onload = function () { importJson(String(r.result)); };
    r.readAsText(f);
  });
  document.addEventListener("click", function (e) { if (state.armed && !e.target.closest(".rm")) { state.armed = null; render(); } });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && state.edit) { state.edit = null; render(); } });
  document.addEventListener("focusout", function (e) { if (state.pendingRender && e.target.classList && e.target.classList.contains("capin")) setTimeout(render, 0); });

  /* ---------- démarrage ---------- */
  render();
  /* ----- stockage dans le navigateur (localStorage) ----- */
  var COLS = ["devops", "apps", "staffing"];
  var STORE_KEY = "staffing-plan-v2";
  var listeners = { devops: [], apps: [], staffing: [] };
  function loadStore() {
    var o = { devops: {}, apps: {}, staffing: {} };
    try {
      var r = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
      if (r) COLS.forEach(function (c) { if (r[c] && typeof r[c] === "object") o[c] = r[c]; });
    } catch (e) {}
    return o;
  }
  var store = loadStore();
  function persist() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); }
    catch (e) { throw { code: "storage" }; }
  }
  function snapFor(col) {
    var data = store[col];
    return { docs: Object.keys(data).sort().map(function (id) { return { id: id, data: function () { return data[id]; } }; }) };
  }
  function notify() { COLS.forEach(function (c) { listeners[c].slice().forEach(function (fn) { fn(); }); }); }
  function newId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  function mutate(fn) {
    return new Promise(function (resolve, reject) {
      try { fn(); persist(); notify(); resolve(); }
      catch (e) { store = loadStore(); notify(); reject(e && e.code ? e : { code: "unavailable" }); }
    });
  }
  db = {
    doc: function (path) {
      var p = path.split("/"), col = p[0], id = p[1];
      return {
        set: function (d) { return mutate(function () { store[col][id] = d; }); },
        update: function (d) { return mutate(function () { if (!store[col][id]) throw { code: "invalid_argument" }; store[col][id] = Object.assign({}, store[col][id], d); }); },
        delete: function () { return mutate(function () { delete store[col][id]; }); }
      };
    },
    collection: function (col) {
      return {
        add: function (d) { var id = newId(); return mutate(function () { store[col][id] = d; }).then(function () { return { id: id }; }); },
        onSnapshot: function (next) {
          var fn = function () { next(snapFor(col)); };
          listeners[col].push(fn); fn();
          return function () { listeners[col].splice(listeners[col].indexOf(fn), 1); };
        }
      };
    }
  };
  /* une autre fenêtre du même navigateur modifie le plan : on se met à jour */
  window.addEventListener("storage", function (e) { if (e.key === STORE_KEY) { store = loadStore(); notify(); } });
  downloads = {
    save: function (o) {
      return new Promise(function (resolve, reject) {
        try {
          var blob = new Blob([o.data], { type: /\.json$/.test(o.filename) ? "application/json" : "text/csv;charset=utf-8" });
          var url = URL.createObjectURL(blob);
          var a = document.createElement("a"); a.href = url; a.download = o.filename;
          document.body.appendChild(a); a.click(); a.remove();
          setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
          resolve({ status: "saved" });
        } catch (e) { reject(e); }
      });
    }
  };
  state.boot = true;
  render();
  function fail() { say("Le plan n'est plus accessible. Rechargez la page.", true); }
  db.collection("devops").onSnapshot(function (s) {
    state.devs = s.docs.map(function (d) { var x = d.data() || {}; return { id: d.id, name: String(x.name || ""), cap: x.cap == null ? 100 : clamp(Math.round(Number(x.cap) || 0), 0, 100) }; });
    state.loaded.d = true; render();
  }, fail);
  db.collection("apps").onSnapshot(function (s) {
    state.apps = s.docs.map(function (d) { var x = d.data() || {}; var c = Number(x.crit); return { id: d.id, name: String(x.name || ""), crit: c === 2 || c === 3 ? c : 1 }; });
    state.loaded.a = true; render();
  }, fail);
  db.collection("staffing").onSnapshot(function (s) {
    state.links = s.docs.map(function (d) { var x = d.data() || {}; return { d: String(x.d || ""), a: String(x.a || ""), pct: clamp(Math.round(Number(x.pct == null ? 100 : x.pct) || 0), 0, 100), role: x.role === "sup" ? "sup" : "ref" }; });
    state.loaded.l = true; render();
  }, fail);
})();
