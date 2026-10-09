/* Podium frontend — zero deps, hash-routed single page. */
(function () {
"use strict";

var reducedMotion = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/* ---------- utils ---------- */
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}
function money(cents) {
  var n = Number(cents) || 0;
  return "$" + (n / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
function fmtHours(h) { return (Math.round(Number(h) * 100) / 100) + "h"; }
function dayLabel(iso) {
  var d = new Date(iso + "T12:00:00");
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()] + " " + d.getDate();
}
function todayIso() {
  var d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
function mondayOf(iso) {
  var d = iso ? new Date(iso + "T12:00:00") : new Date();
  var dow = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - dow);
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
function addDays(iso, n) {
  var d = new Date(iso + "T12:00:00");
  d.setDate(d.getDate() + n);
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
function timeAgo(iso) {
  var s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  return Math.floor(s / 86400) + "d ago";
}

/* ---------- tiny markdown ---------- */
function md(src) {
  var lines = esc(src).split("\n");
  var html = "", inList = false, inCode = false, para = [];
  function inline(t) {
    return t
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\*([^*]+)\*/g, "<em>$1</em>")
      .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  }
  function flushPara() {
    if (para.length) { html += "<p>" + para.map(inline).join("<br>") + "</p>"; para = []; }
  }
  lines.forEach(function (ln) {
    if (/^```/.test(ln)) { flushPara(); if (inList) { html += "</ul>"; inList = false; } html += inCode ? "</pre>" : "<pre>"; inCode = !inCode; return; }
    if (inCode) { html += ln + "\n"; return; }
    var h = ln.match(/^(#{1,3})\s+(.*)/);
    if (h) { flushPara(); if (inList) { html += "</ul>"; inList = false; } html += "<h3>" + inline(h[2]) + "</h3>"; return; }
    if (/^\s*>\s?/.test(ln)) { flushPara(); if (inList) { html += "</ul>"; inList = false; } html += "<blockquote>" + inline(ln.replace(/^\s*>\s?/, "")) + "</blockquote>"; return; }
    if (/^\s*[-*]\s+/.test(ln)) { flushPara(); if (!inList) { html += "<ul>"; inList = true; } html += "<li>" + inline(ln.replace(/^\s*[-*]\s+/, "")) + "</li>"; return; }
    if (/^\s*$/.test(ln)) { flushPara(); if (inList) { html += "</ul>"; inList = false; } return; }
    para.push(ln);
  });
  flushPara();
  if (inList) html += "</ul>";
  if (inCode) html += "</pre>";
  return html;
}

/* ---------- api ---------- */
function api(method, path, body) {
  return fetch(path, {
    method: method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(function (r) {
    if (!r.ok) return r.json().catch(function () { return { error: "request failed" }; }).then(function (j) {
      throw new Error(j.error || ("HTTP " + r.status));
    });
    var ct = r.headers.get("content-type") || "";
    return ct.indexOf("application/json") >= 0 ? r.json() : r.text();
  });
}

/* ---------- state ---------- */
var state = {
  people: [], pods: [],
  pod: null, members: [], channels: [], channel: null, messages: [], pages: [], page: null,
  replyTo: null, editingPage: false,
  timePerson: null, timeWeek: mondayOf(), entries: [],
  periods: [], period: null,
  err: "", okMsg: "",
};
function setErr(m) { state.err = m; state.okMsg = ""; render(); if (!reducedMotion && typeof document !== "undefined") window.scrollTo(0, 0); }
function setOk(m) { state.okMsg = m; state.err = ""; render(); }

/* ---------- router ---------- */
function route() {
  var h = (location.hash || "#/home").replace(/^#/, "");
  var parts = h.split("/").filter(Boolean);
  state.err = ""; state.okMsg = "";
  state.replyTo = null; state.editingPage = false; state.page = null;
  var v = parts[0] || "home";
  if (v === "home") return loadHome();
  if (v === "pods") return loadPods();
  if (v === "pod" && parts[1]) return loadPod(parts[1], parts[2] || "channels");
  if (v === "people") return loadPeople();
  if (v === "payroll") return loadPayroll(parts[1] || null);
  if (v === "pipeline") return parts[1] === "top20" ? loadTop20() : loadPipeline();
  if (v === "lead" && parts[1]) return loadLead(parts[1]);
  if (v === "schedule") return loadSchedule();
  if (v === "invoices") return loadInvoices(parts[1] || null);
  if (v === "settings") return loadSettings();
  return loadHome();
}

/* ---------- data loaders ---------- */
function loadHome() {
  Promise.all([api("GET", "/api/dashboard"), api("GET", "/api/pods"), api("GET", "/api/people")])
    .then(function (r) { state.dash = r[0]; state.pods = r[1].pods; state.people = r[2].people; render(); })
    .catch(function (e) { setErr(e.message); });
}
function loadPods() {
  api("GET", "/api/pods").then(function (r) { state.pods = r.pods; render(); }).catch(function (e) { setErr(e.message); });
}
function loadPod(id, tab) {
  state.podTab = tab;
  api("GET", "/api/pods/" + id).then(function (r) {
    state.pod = r.pod; state.members = r.members; state.channels = r.channels;
    state.retainer = r.retainer; state.podTimers = r.timers;
    if (tab === "channels") {
      var cid = state.channel && r.channels.some(function (c) { return c.id === state.channel.id; })
        ? state.channel.id : (r.channels[0] && r.channels[0].id);
      if (!cid) { state.messages = []; render(); return; }
      state.channel = r.channels.find(function (c) { return c.id === cid; });
      api("GET", "/api/channels/" + cid + "/messages").then(function (m) { state.messages = m.messages; render(); });
    } else if (tab === "pages") {
      Promise.all([
        api("GET", "/api/pods/" + id + "/pages"),
        api("GET", "/api/templates"),
      ]).then(function (x) { state.pages = x[0].pages; state.templates = x[1].templates; render(); });
    } else if (tab === "time") {
      loadTimeTab();
      return;
    }
    render();
  }).catch(function (e) { setErr(e.message); });
}
function loadTimeTab() {
  var pid = state.timePerson || (state.members[0] && state.members[0].person_id);
  state.timePerson = pid;
  if (!pid) { state.entries = []; render(); return; }
  var from = state.timeWeek, to = addDays(state.timeWeek, 6);
  api("GET", "/api/time?person_id=" + pid + "&from=" + from + "&to=" + to)
    .then(function (r) { state.entries = r.entries; render(); })
    .catch(function (e) { setErr(e.message); });
}
function loadPeople() {
  var week = mondayOf();
  Promise.all([api("GET", "/api/people"), api("GET", "/api/dashboard"), api("GET", "/api/time?week=" + week)])
    .then(function (r) {
      state.people = r[0].people; state.dash = r[1];
      var wh = {};
      r[2].entries.forEach(function (e) { wh[e.person_id] = (wh[e.person_id] || 0) + Number(e.hours); });
      state.weekHours = wh;
      render();
    })
    .catch(function (e) { setErr(e.message); });
}
function loadPayroll(periodId) {
  api("GET", "/api/periods").then(function (r) {
    state.periods = r.periods;
    if (periodId) {
      return api("GET", "/api/periods/" + periodId).then(function (p) { state.period = p; render(); });
    }
    state.period = null; render();
  }).catch(function (e) { setErr(e.message); });
}
function loadPipeline() {
  api("GET", "/api/pipeline").then(function (r) { state.pipeline = r; render(); }).catch(function (e) { setErr(e.message); });
}
function loadTop20() {
  api("GET", "/api/leads/top20").then(function (r) { state.top20 = r.leads; render(); }).catch(function (e) { setErr(e.message); });
}
function loadLead(id) {
  Promise.all([
    api("GET", "/api/leads/" + id),
    api("GET", "/api/partners"),
    api("GET", "/api/bookings"),
  ]).then(function (r) {
    state.lead = r[0].lead; state.partners = r[1].partners; state.leadBookings = r[2].bookings;
    render();
  }).catch(function (e) { setErr(e.message); });
}
function loadSchedule() {
  var from = todayIso();
  Promise.all([
    api("GET", "/api/bookings?from=" + from),
    api("GET", "/api/people"),
  ]).then(function (r) {
    state.bookings = r[0].bookings; state.people = r[1].people;
    var avail = {};
    var ps = r[1].people.map(function (p) {
      return api("GET", "/api/availability?person_id=" + p.id).then(function (a) { avail[p.id] = a.availability; });
    });
    return Promise.all(ps).then(function () { state.availability = avail; render(); });
  }).catch(function (e) { setErr(e.message); });
}
function loadInvoices(invoiceId) {
  Promise.all([api("GET", "/api/invoices"), api("GET", "/api/pods")]).then(function (r) {
    state.invoices = r[0].invoices; state.pods = r[1].pods;
    if (invoiceId) {
      return Promise.all([
        api("GET", "/api/invoices/" + invoiceId),
        api("GET", "/api/integrations/qbo/status"),
      ]).then(function (x) { state.invoice = { invoice: x[0].invoice, qboConnected: x[1].connected }; render(); });
    }
    state.invoice = null; render();
  }).catch(function (e) { setErr(e.message); });
}
function loadSettings() {
  Promise.all([
    api("GET", "/api/settings"),
    api("GET", "/api/templates"),
    api("GET", "/api/pods"),
    api("GET", "/api/integrations/qbo/status"),
  ]).then(function (r) {
    state.settings = { settings: r[0].settings, stripeMode: r[0].stripeMode, qboConnected: r[3].connected, qboRealm: r[3].realm, pods: r[2].pods };
    state.templates = r[1].templates;
    render();
  }).catch(function (e) { setErr(e.message); });
}

/* ---------- chrome ---------- */
function renderSidebar() {
  var pods = state.pods.map(function (p) {
    return '<a class="nav-item' + (state.pod && state.pod.id === p.id ? " active" : "") + '" href="#/pod/' + p.id + '/channels">' +
      '<span class="dot" style="background:' + esc(p.color) + '"></span>' + esc(p.name) +
      '<span class="nav-count">' + p.members + '</span></a>';
  }).join("");
  return '<div class="brand">Podium<span>.</span></div>' +
    '<div class="nav-sec">Firm</div>' +
    '<a class="nav-item" href="#/home">Dashboard</a>' +
    '<a class="nav-item" href="#/pipeline">Pipeline</a>' +
    '<a class="nav-item" href="#/schedule">Schedule</a>' +
    '<a class="nav-item" href="#/invoices">Invoices</a>' +
    '<a class="nav-item" href="#/people">People</a>' +
    '<a class="nav-item" href="#/payroll">Payroll</a>' +
    '<a class="nav-item" href="#/settings">Settings</a>' +
    '<div class="nav-sec">Pods</div>' + (pods || '<div class="muted" style="padding:0 10px">No pods yet</div>') +
    '<div style="padding:12px 10px"><a class="link-btn" href="#/pods">Manage pods</a></div>';
}
function flash() {
  var h = "";
  if (state.err) h += '<div class="err">' + esc(state.err) + '</div>';
  if (state.okMsg) h += '<div class="ok-msg">' + esc(state.okMsg) + '</div>';
  return h;
}

/* ---------- views (pure: data in, html out) ---------- */
function viewHome(d) {
  d = d || { hoursPerPod: [], openPeriod: null, openPeriodPerPerson: [], week: {}, retainers: [], timers: [] };
  var max = Math.max.apply(null, [0].concat(d.hoursPerPod.map(function (r) { return Number(r.hours); })));
  var bars = d.hoursPerPod.map(function (r) {
    var w = max ? Math.round(Number(r.hours) / max * 100) : 0;
    return '<div class="bar-row"><div class="bar-label">' + esc(r.pod_name) + '</div>' +
      '<div class="bar-track"><div class="bar-fill" style="width:' + w + '%;background:' + esc(r.color || "#c96f4a") + '"></div></div>' +
      '<div class="bar-val">' + fmtHours(r.hours) + '</div></div>';
  }).join("") || '<div class="empty">No hours logged this week yet.</div>';
  var per = d.openPeriodPerPerson.map(function (r) {
    return '<div class="bar-row"><div class="bar-label">' + esc(r.person_name) + '</div>' +
      '<div class="bar-track"><div class="bar-fill" style="width:100%;background:#8a8175"></div></div>' +
      '<div class="bar-val">' + fmtHours(r.hours) + '</div></div>';
  }).join("");
  var ret = (d.retainers || []).map(function (r) {
    var pct = Math.min(100, Math.round(r.pct * 100));
    var color = r.pct >= 1 ? "var(--red)" : r.pct >= 0.8 ? "var(--amber)" : "var(--sage)";
    return '<div class="bar-row"><div class="bar-label">' + esc(r.pod_name) + '</div>' +
      '<div class="bar-track"><div class="bar-fill" style="width:' + pct + '%;background:' + color + '"></div></div>' +
      '<div class="bar-val">' + fmtHours(r.hours) + ' / ' + fmtHours(r.cap) + '</div></div>';
  }).join("");
  var timers = (d.timers || []).map(function (t) {
    var el = Math.max(0, Math.round((Date.now() - new Date(t.started_at).getTime()) / 1000));
    return '<div class="bar-row"><div class="bar-label">' + esc(t.person_name || "") + '</div>' +
      '<div class="muted">' + esc(t.pod_name || "") + (t.note ? " — " + esc(t.note) : "") + '</div>' +
      '<div class="bar-val"><span class="pulse"></span> ' + Math.floor(el / 60) + ':' + String(el % 60).padStart(2, "0") + '</div></div>';
  }).join("");
  return '<div class="view-head"><h1>Dashboard</h1><span class="sub">Week of ' + esc(d.week.from || "") + '</span></div>' + flash() +
    (timers ? '<div class="card"><h3>Timers running</h3>' + timers + '</div>' : '') +
    '<div class="card"><h3>Hours this week, by pod</h3>' + bars + '</div>' +
    (ret ? '<div class="card"><h3>Retainer usage — this month</h3>' + ret + '</div>' : '') +
    '<div class="card"><h3>Open pay period' + (d.openPeriod ? ' — ' + esc(d.openPeriod.label) : '') + '</h3>' +
    (d.openPeriod ? (per || '<div class="empty">No entries in this period yet.</div>') : '<div class="empty">No open period. Create one under Payroll.</div>') + '</div>';
}

function viewPods(pods) {
  var cards = pods.map(function (p) {
    return '<div class="card pod-card" onclick="location.hash=\'#/pod/' + p.id + '/channels\'">' +
      '<div class="row"><span class="dot" style="background:' + esc(p.color) + ';width:14px;height:14px"></span>' +
      '<span class="name">' + esc(p.name) + '</span></div>' +
      '<div class="client">' + esc(p.client_name || "No client set") + '</div>' +
      '<div class="stat"><b>' + p.members + '</b> members · <b>' + (p.channels || 0) + '</b> channels</div></div>';
  }).join("");
  return '<div class="view-head"><h1>Pods</h1><span class="sub">Intimate teams, under ten</span></div>' + flash() +
    '<div class="grid two">' + cards + '</div>' +
    '<div class="card"><h3>New pod</h3>' +
    '<form onsubmit="return Podium.createPod(event)"><div class="form-row">' +
    '<input name="name" placeholder="Pod name" required maxlength="60">' +
    '<input name="client_name" placeholder="Client company" maxlength="80">' +
    '<input name="color" type="color" value="#c96f4a" style="max-width:70px" title="Pod color">' +
    '</div><div style="margin-top:10px"><button class="btn" type="submit">Create pod</button></div></form></div>';
}

function viewPodHead(pod, tab, members, retainer, timers) {
  var tabs = [["channels", "Channels"], ["pages", "Pages"], ["time", "Time"]].map(function (t) {
    return '<div class="tab' + (tab === t[0] ? " active" : "") + '" onclick="location.hash=\'#/pod/' + pod.id + '/' + t[0] + '\'">' + t[1] + "</div>";
  }).join("");
  var mem = members.map(function (m) {
    return '<span class="pill" style="background:var(--sand);margin:2px 4px 2px 0" title="' + esc(m.role || "member") + '">' +
      esc(m.person_name) + ' <a href="#" onclick="return Podium.removeMember(\'' + pod.id + "','" + m.person_id + '\')" style="color:var(--muted);text-decoration:none" title="Remove">×</a></span>';
  }).join("");
  var billing = (pod.billing_type === "retainer")
    ? '<span class="pill billable">retainer' + (pod.retainer_hours ? ' · ' + fmtHours(pod.retainer_hours) + '/mo' : '') + '</span>'
    : '<span class="pill nonbill">hourly</span>';
  return '<div class="view-head"><span class="dot" style="background:' + esc(pod.color) + ';width:16px;height:16px"></span>' +
    '<h1>' + esc(pod.name) + '</h1><span class="sub">' + esc(pod.client_name || "") + ' · ' + members.length + '/9 members</span> ' + billing +
    '<span style="flex:1"></span><button class="link-btn" onclick="Podium.editBilling(\'' + pod.id + '\')">Billing</button></div>' + flash() +
    viewRetainerBar(retainer) + viewTimerWidget(pod, members, timers) +
    '<div class="card"><h3>Members</h3><div>' + (mem || '<span class="muted">No members yet — add the pod\'s execs below.</span>') + '</div>' +
    '<form onsubmit="return Podium.addMember(event,\'' + pod.id + '\')" style="margin-top:10px"><div class="form-row">' +
    '<select name="person_id" id="member-picker" required></select>' +
    '<input name="role" placeholder="Role in pod (e.g. Lead)" maxlength="40">' +
    '</div><div style="margin-top:10px"><button class="btn small" type="submit">Add member</button></div></form></div>' +
    '<div class="tabs">' + tabs + '</div>';
}

function viewChannels(channels, activeId, messages, replyTo, members, podId) {
  var list = channels.map(function (c) {
    return '<div class="chan-item' + (c.id === activeId ? " active" : "") + '" onclick="Podium.switchChannel(\'' + c.id + '\')"># ' + esc(c.name) + '</div>';
  }).join("");
  var msgs = messages.map(function (m) { return renderMessage(m); }).join("") ||
    '<div class="empty">Quiet in here. Say hello.</div>';
  var banner = replyTo
    ? '<div class="thread-banner">Replying in thread <button class="link-btn" onclick="Podium.cancelReply()">cancel</button></div>' : "";
  var lastAuthor = "";
  try { lastAuthor = localStorage.getItem("podium_author_" + podId) || ""; } catch (e) {}
  var authors = (members || []).map(function (m) {
    var sel = (m.person_id === lastAuthor || (!lastAuthor && m === members[0])) ? " selected" : "";
    return '<option value="' + m.person_id + '"' + sel + '>' + esc(m.person_name) + '</option>';
  }).join("");
  return '<div class="chat-wrap"><div class="chan-list">' + list +
    '<div style="padding:8px 4px"><button class="link-btn" onclick="Podium.newChannel()">+ New channel</button></div></div>' +
    '<div class="msg-pane card">' + msgs +
    '<form class="compose" onsubmit="return Podium.sendMessage(event)">' + banner +
    '<select name="author_id" id="compose-author" style="max-width:130px;flex-shrink:0">' + authors + '</select>' +
    '<input name="body" id="compose-box" placeholder="Message #' + esc((channels.find(function (c) { return c.id === activeId; }) || { name: "" }).name) + '" autocomplete="off">' +
    '<button class="btn" type="submit">Send</button></form></div></div>';
}
function renderMessage(m) {
  var replies = (m.replies || []).map(function (r) {
    return '<div class="msg"><div class="msg-head"><span class="msg-author">' + esc(r.author_name || "Unknown") +
      '</span><span class="msg-time">' + timeAgo(r.created_at) + '</span></div><div class="msg-body">' + md(r.body_md) + '</div></div>';
  }).join("");
  return '<div class="msg" id="msg-' + m.id + '"><div class="msg-head"><span class="msg-author">' +
    esc(m.author_name || "Unknown") + '</span><span class="msg-time">' + timeAgo(m.created_at) + '</span></div>' +
    '<div class="msg-body">' + md(m.body_md) + '</div>' +
    (replies ? '<div class="thread">' + replies + '</div>' : "") +
    '<div><span class="reply-link" onclick="Podium.startReply(\'' + m.id + '\')">Reply in thread</span></div></div>';
}

function viewPages(pages, editing, page, templates, showTemplateForm) {
  templates = templates || [];
  var list = pages.map(function (p) {
    return '<div class="page-item" onclick="Podium.openPage(\'' + p.id + '\')"><div class="t">' + esc(p.title) +
      '</div><div class="m">Updated ' + timeAgo(p.updated_at) + (p.updated_by ? ' by ' + esc(p.updated_by) : '') + '</div></div>';
  }).join("") || '<div class="empty">No pages yet — start the pod wiki.</div>';
  var main;
  if (editing) {
    main = '<div class="card"><h3>' + (page ? "Edit page" : "New page") + '</h3>' +
      '<form onsubmit="return Podium.savePage(event)">' +
      '<label>Title</label><input name="title" value="' + esc(page ? page.title : "") + '" required maxlength="120">' +
      '<label>Body (markdown)</label><div class="editor-split"><textarea name="body_md" id="page-src" oninput="Podium.previewPage()">' +
      esc(page ? page.body_md : "") + '</textarea><div class="preview" id="page-preview"></div></div>' +
      '<div style="margin-top:10px;display:flex;gap:8px"><button class="btn" type="submit">Save</button>' +
      '<button class="btn ghost" type="button" onclick="Podium.cancelPageEdit()">Cancel</button>' +
      (page ? '<button class="btn danger" type="button" onclick="Podium.deletePage(\'' + page.id + '\')">Delete</button>' : '') + '</div></form></div>';
  } else if (page) {
    main = '<div class="card"><div class="view-head"><h1 style="font-size:20px">' + esc(page.title) + '</h1>' +
      '<span class="sub">' + timeAgo(page.updated_at) + (page.updated_by ? ' · ' + esc(page.updated_by) : '') + '</span>' +
      '<span style="flex:1"></span><button class="btn small ghost" onclick="Podium.editPage()">Edit</button> ' +
      '<button class="btn small ghost" onclick="Podium.closePage()">All pages</button></div>' +
      '<div class="msg-body">' + md(page.body_md) + '</div></div>';
  } else {
    var tform = "";
    if (showTemplateForm && templates.length) {
      var topts = templates.map(function (t) { return '<option value="' + t.id + '">' + esc(t.name) + '</option>'; }).join("");
      tform = '<div class="card" style="background:var(--paper)"><h3>New page from template</h3>' +
        '<form onsubmit="return Podium.createFromTemplate(event)">' +
        '<div class="form-row"><div><label>Template</label><select name="template_id">' + topts + '</select></div>' +
        '<div><label>Title</label><input name="title" placeholder="Defaults to template name" maxlength="120"></div></div>' +
        '<div class="form-row"><div><label>Owner name</label><input name="owner_name" placeholder="Your name"></div>' +
        '<div><label>Date</label><input name="date" value="' + esc(todayIso()) + '"></div></div>' +
        '<div style="margin-top:10px;display:flex;gap:8px"><button class="btn small" type="submit">Create page</button>' +
        '<button class="btn small ghost" type="button" onclick="Podium.toggleTemplateForm(false)">Cancel</button></div></form></div>';
    }
    main = '<div class="card"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;flex-wrap:wrap;gap:8px">' +
      '<h3 style="margin:0">Wiki</h3><div><button class="btn small ghost" onclick="Podium.toggleTemplateForm(true)">From template</button> ' +
      '<button class="btn small" onclick="Podium.newPage()">+ New page</button></div></div>' + tform + list + '</div>';
  }
  return main;
}

function viewTimeTab(pod, members, people, personId, week, entries) {
  var opts = members.map(function (m) {
    var p = people.find(function (x) { return x.id === m.person_id; });
    return '<option value="' + m.person_id + '"' + (m.person_id === personId ? " selected" : "") + '>' + esc(p ? p.name : m.person_name) + '</option>';
  }).join("");
  var days = [0, 1, 2, 3, 4, 5, 6].map(function (i) { return addDays(week, i); });
  var byDayPod = {};
  entries.forEach(function (e) {
    var k = e.day + "|" + e.pod_id;
    byDayPod[k] = (byDayPod[k] || 0) + Number(e.hours);
  });
  // rows: this pod only in pod context
  var rows = "";
  if (state.pod) {
    var cells = days.map(function (d) {
      var h = byDayPod[d + "|" + state.pod.id] || 0;
      return '<td class="tg-cell" onclick="Podium.quickEntry(\'' + d + '\')">' + (h ? fmtHours(h) : '<span class="muted">–</span>') + '</td>';
    }).join("");
    rows = '<tr><td><span class="dot" style="background:' + esc(state.pod.color) + ';display:inline-block;margin-right:6px"></span>' + esc(state.pod.name) + '</td>' + cells + '</tr>';
  }
  var head = days.map(function (d) { return "<th>" + dayLabel(d) + "</th>"; }).join("");
  var list = entries.map(function (e) {
    return '<tr><td>' + esc(e.day) + '</td><td>' + esc(e.pod_name || "") + '</td><td class="num">' + fmtHours(e.hours) + '</td>' +
      '<td>' + (e.billable ? '<span class="pill billable">billable</span>' : '<span class="pill nonbill">non-billable</span>') + '</td>' +
      '<td>' + esc(e.note || "") + '</td>' +
      '<td><button class="link-btn" onclick="Podium.editEntry(\'' + e.id + '\')">Edit</button> ' +
      '<button class="link-btn" onclick="Podium.deleteEntry(\'' + e.id + '\')">Delete</button></td></tr>';
  }).join("");
  return '<div class="card"><h3>Time — week of ' + esc(week) + '</h3>' +
    '<div class="form-row" style="margin-bottom:10px;max-width:420px"><div><label>Person</label>' +
    '<select id="time-person" onchange="Podium.switchTimePerson(this.value)">' + opts + '</select></div>' +
    '<div><label>Week</label><input type="date" id="time-week" value="' + esc(week) + '" onchange="Podium.switchTimeWeek(this.value)"></div></div>' +
    '<div class="time-grid"><table class="tg-table"><tr><th>Pod</th>' + head + '</tr>' + (rows || '<tr><td colspan="8" class="muted">No pods</td></tr>') + '</table></div>' +
    '<div class="muted" style="margin-top:6px">Tap a day to log time.</div></div>' +
    '<div class="card"><h3>Log time</h3><form onsubmit="return Podium.saveEntry(event)">' +
    '<input type="hidden" name="id" id="entry-id"><div class="form-row">' +
    '<div><label>Day</label><input type="date" name="day" id="entry-day" value="' + esc(todayIso()) + '" required></div>' +
    '<div><label>Hours</label><input type="number" name="hours" id="entry-hours" step="0.25" min="0.25" max="24" required placeholder="4"></div>' +
    '<div><label>Billable</label><select name="billable" id="entry-billable"><option value="1">Billable</option><option value="0">Non-billable</option></select></div>' +
    '</div><label>Note</label><input name="note" id="entry-note" placeholder="What was this for?" maxlength="200">' +
    '<div style="margin-top:10px"><button class="btn" type="submit">Save entry</button> <button class="btn ghost" type="button" onclick="Podium.resetEntryForm()">Clear</button></div></form></div>' +
    '<div class="card"><h3>Entries</h3><table><tr><th>Day</th><th>Pod</th><th class="num">Hours</th><th>Type</th><th>Note</th><th></th></tr>' +
    (list || '<tr><td colspan="6" class="muted">No entries this week.</td></tr>') + '</table></div>';
}

function viewPeople(people, weekHours) {
  weekHours = weekHours || {};
  var rows = people.map(function (p) {
    var initials = p.name.split(/\s+/).map(function (w) { return w[0]; }).join("").slice(0, 2).toUpperCase();
    return '<div class="person-row"><div class="avatar">' + esc(initials) + '</div>' +
      '<div class="who"><div class="nm">' + esc(p.name) + '</div><div class="ti">' + esc(p.title || "—") + (p.email ? " · " + esc(p.email) : "") + '</div></div>' +
      '<div style="text-align:right"><div class="rate">' + money(p.hourly_rate_cents) + '/hr</div>' +
      '<div class="muted">' + fmtHours(weekHours[p.id] || 0) + ' this week</div></div>' +
      '<button class="link-btn" onclick="Podium.editPerson(\'' + p.id + '\')">Edit</button></div>';
  }).join("");
  return '<div class="view-head"><h1>People</h1><span class="sub">' + people.length + ' execs</span></div>' + flash() +
    '<div class="card">' + (rows || '<div class="empty">No people yet.</div>') + '</div>' +
    '<div class="card"><h3>Add person</h3><form onsubmit="return Podium.savePerson(event)">' +
    '<input type="hidden" name="id" id="person-id"><div class="form-row">' +
    '<div><label>Name</label><input name="name" id="person-name" required maxlength="60"></div>' +
    '<div><label>Title</label><input name="title" id="person-title" placeholder="Fractional CFO" maxlength="60"></div></div>' +
    '<div class="form-row"><div><label>Email</label><input name="email" id="person-email" type="email" maxlength="120"></div>' +
    '<div><label>Hourly rate (USD)</label><input name="rate" id="person-rate" type="number" min="0" step="1" placeholder="250"></div></div>' +
    '<div style="margin-top:10px"><button class="btn" type="submit">Save person</button> <button class="btn ghost" type="button" onclick="Podium.resetPersonForm()">Clear</button></div></form></div>';
}

function viewPayroll(periods, detail) {
  var open = periods.find(function (p) { return p.status === "open"; });
  var h = '<div class="view-head"><h1>Payroll</h1><span class="sub">Statements, not disbursement</span></div>' + flash();
  if (detail) {
    var p = detail.period;
    var live = p.status === "open" && (!detail.statements || !detail.statements.length) && detail.live;
    var rows = (live || detail.statements).map(function (s) {
      return '<tr><td>' + esc(s.person_name || s.person_id) + '</td><td>' + esc(s.pod_name || s.pod_id) + '</td>' +
        '<td class="num">' + fmtHours(s.hours) + '</td><td class="num">' + money(s.rate_cents) + '</td>' +
        '<td class="num"><b>' + money(s.amount_cents) + '</b></td></tr>';
    }).join("");
    var total = (live || detail.statements).reduce(function (a, s) { return a + s.amount_cents; }, 0);
    h += '<div class="card"><div class="view-head"><h1 style="font-size:20px">' + esc(p.label) + '</h1>' +
      '<span class="pill ' + p.status + '">' + p.status + '</span><span style="flex:1"></span>' +
      '<button class="btn small ghost" onclick="location.hash=\'#/payroll\'">All periods</button> ' +
      '<a class="btn small" href="/api/periods/' + p.id + '/export.csv">Download CSV</a></div>' +
      '<div class="muted">' + esc(p.start_day) + ' → ' + esc(p.end_day) + (p.closed_at ? ' · closed ' + timeAgo(p.closed_at) : '') +
      (live ? ' · <b>live preview</b> — what closing would snapshot' : '') + '</div>' +
      '<table style="margin-top:10px"><tr><th>Person</th><th>Pod</th><th class="num">Hours</th><th class="num">Rate</th><th class="num">Amount</th></tr>' +
      (rows || '<tr><td colspan="5" class="muted">No statements.</td></tr>') + '</table>' +
      '<div style="text-align:right;margin-top:10px;font-size:18px">Total <b>' + money(total) + '</b></div></div>';
    if (p.status === "open") {
      h += '<div class="card"><h3>Close this period</h3><p class="muted">Closing stamps every open entry in range and snapshots hours × each person\'s current rate. Entries become read-only.</p>' +
        '<button class="btn" onclick="Podium.closePeriod(\'' + p.id + '\')">Close period</button></div>';
    }
    return h;
  }
  var cards = periods.map(function (p) {
    return '<div class="page-item" onclick="location.hash=\'#/payroll/' + p.id + '\'"><div class="t">' + esc(p.label) +
      ' <span class="pill ' + p.status + '">' + p.status + '</span></div>' +
      '<div class="m">' + esc(p.start_day) + ' → ' + esc(p.end_day) + '</div></div>';
  }).join("") || '<div class="empty">No pay periods yet.</div>';
  h += '<div class="card"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px"><h3 style="margin:0">Pay periods</h3></div>' + cards + '</div>';
  if (!open) {
    h += '<div class="card"><h3>Open a period</h3><form onsubmit="return Podium.createPeriod(event)"><div class="form-row">' +
      '<div><label>Label</label><input name="label" required placeholder="October 2026" maxlength="60"></div>' +
      '<div><label>Start</label><input name="start_day" type="date" required></div>' +
      '<div><label>End</label><input name="end_day" type="date" required></div></div>' +
      '<div style="margin-top:10px"><button class="btn" type="submit">Open period</button></div></form></div>';
  } else {
    h += '<div class="card"><h3>Current open period</h3><div class="page-item" onclick="location.hash=\'#/payroll/' + open.id + '\'">' +
      '<div class="t">' + esc(open.label) + ' <span class="pill open">open</span></div>' +
      '<div class="m">' + esc(open.start_day) + ' → ' + esc(open.end_day) + ' — tap to review and close</div></div></div>';
  }
  h += '<div class="card"><h3>How payroll works here</h3><p class="muted">Podium calculates what each exec earned — hours × their rate at close — and exports a CSV for your payroll provider. <b>No money moves through Podium.</b> Self-hosted disbursement would be irresponsible to fake.</p></div>';
  return h;
}

/* ---------- v1 integrations: CRM, scheduling, invoices, settings ---------- */
var STAGE_LABEL = { intro: "Intro Call", diagnostic: "Diagnostic Pitch", sow: "SOW Sent", won: "Closed Won", lost: "Lost" };
var STAGE_ORDER = ["intro", "diagnostic", "sow", "won", "lost"];
function tempDot(t) {
  var c = t === "hot" ? "var(--red)" : t === "warm" ? "var(--amber)" : "var(--muted)";
  return '<span class="dot" style="background:' + c + ';display:inline-block;margin-right:6px" title="' + esc(t || "") + '"></span>';
}
function stagePill(s) {
  var cls = s === "won" ? "open" : s === "lost" ? "closed" : s === "sow" ? "billable" : "nonbill";
  return '<span class="pill ' + cls + '">' + esc(STAGE_LABEL[s] || s) + '</span>';
}
function leadCard(l) {
  var i = STAGE_ORDER.indexOf(l.stage);
  var next = i >= 0 && i < 3 ? STAGE_ORDER[i + 1] : null;
  var btns = "";
  if (l.stage !== "won" && l.stage !== "lost") {
    if (next) btns += '<button class="link-btn" onclick="event.stopPropagation();Podium.moveLead(\'' + l.id + "','" + next + '\')" title="Move to ' + esc(STAGE_LABEL[next]) + '">→</button> ';
    btns += '<button class="link-btn" onclick="event.stopPropagation();Podium.moveLead(\'' + l.id + "','lost')\" title=\"Mark lost\">✕</button>";
  }
  if (l.stage === "won" && !l.pod_id)
    btns += ' <button class="btn small" onclick="event.stopPropagation();Podium.spinUpPod(\'' + l.id + '\')">Spin up pod</button>';
  if (l.pod_id)
    btns += ' <a class="link-btn" href="#/pod/' + l.pod_id + '/channels" onclick="event.stopPropagation()">Open pod →</a>';
  return '<div class="lead-card" onclick="location.hash=\'#/lead/' + l.id + '\'">' +
    '<div class="lead-top">' + tempDot(l.temperature) + '<b>' + esc(l.name) + '</b></div>' +
    (l.company ? '<div class="lead-co">' + esc(l.company) + '</div>' : '') +
    '<div class="lead-meta"><span>P' + l.priority + '</span> · <span>' + money(l.value_cents) + '</span>' +
    (l.partner_name ? ' · <span class="muted">' + esc(l.partner_name) + '</span>' : '') + '</div>' +
    '<div class="lead-actions">' + btns + '</div></div>';
}
function viewPipeline(data) {
  data = data || { stages: [] };
  var total = data.stages.reduce(function (a, s) { return a + s.total_cents; }, 0);
  var weighted = data.stages.reduce(function (a, s) { return a + s.weighted_cents; }, 0);
  var cols = data.stages.map(function (s) {
    var cards = s.leads.map(leadCard).join("") || '<div class="empty" style="padding:14px">—</div>';
    return '<div class="kan-col"><div class="kan-head"><b>' + esc(s.label) + '</b>' +
      '<span class="kan-count">' + s.count + '</span></div>' +
      '<div class="kan-meta">' + money(s.total_cents) + ' <span class="muted">· wtd ' + money(s.weighted_cents) + '</span></div>' +
      '<div class="kan-cards">' + cards + '</div></div>';
  }).join("");
  return '<div class="view-head"><h1>Pipeline</h1><span class="sub">' + money(total) + ' total · ' + money(weighted) + ' weighted</span>' +
    '<span style="flex:1"></span><a class="btn small" href="#/pipeline/top20">Top 20</a></div>' + flash() +
    '<div class="kanban">' + cols + '</div>' +
    '<div class="card"><h3>New lead</h3><form onsubmit="return Podium.saveLead(event)">' +
    '<div class="form-row"><div><label>Name</label><input name="name" required maxlength="80"></div>' +
    '<div><label>Company</label><input name="company" maxlength="80"></div></div>' +
    '<div class="form-row"><div><label>Email</label><input name="email" type="email" maxlength="120"></div>' +
    '<div><label>Phone</label><input name="phone" maxlength="40"></div></div>' +
    '<div class="form-row"><div><label>Temperature</label><select name="temperature"><option value="hot">Hot</option><option value="warm" selected>Warm</option><option value="cold">Cold</option></select></div>' +
    '<div><label>Priority (1–5)</label><input name="priority" type="number" min="1" max="5" value="3"></div>' +
    '<div><label>Value (USD)</label><input name="value" type="number" min="0" step="1" placeholder="50000"></div></div>' +
    '<label>Source</label><input name="source" placeholder="Intro, referral, VC partner…" maxlength="120">' +
    '<div style="margin-top:10px"><button class="btn" type="submit">Add lead</button></div></form></div>';
}
function viewTop20(leads) {
  var rows = (leads || []).map(function (l, i) {
    return '<tr><td class="num">' + (i + 1) + '</td><td>' + tempDot(l.temperature) + '<a href="#/lead/' + l.id + '">' + esc(l.name) + '</a>' +
      (l.company ? '<div class="muted">' + esc(l.company) + '</div>' : '') + '</td>' +
      '<td class="num">P' + l.priority + '</td><td class="num">' + money(l.value_cents) + '</td>' +
      '<td>' + stagePill(l.stage) + '</td></tr>';
  }).join("");
  return '<div class="view-head"><h1>Top 20</h1><span class="sub">Warm + hot, priority then value</span>' +
    '<span style="flex:1"></span><a class="link-btn" href="#/pipeline">← Pipeline</a></div>' + flash() +
    '<div class="card"><table><tr><th class="num">#</th><th>Lead</th><th class="num">Pri</th><th class="num">Value</th><th>Stage</th></tr>' +
    (rows || '<tr><td colspan="5" class="muted">No warm or hot leads yet.</td></tr>') + '</table></div>';
}
function viewLead(lead, partners, bookings) {
  partners = partners || []; bookings = bookings || [];
  var i = STAGE_ORDER.indexOf(lead.stage);
  var next = i >= 0 && i < 3 ? STAGE_ORDER[i + 1] : null;
  var popts = '<option value="">No partner</option>' + partners.map(function (p) {
    return '<option value="' + p.id + '"' + (p.id === lead.partner_id ? " selected" : "") + '>' + esc(p.name) + ' (' + esc(p.kind) + ')</option>';
  }).join("");
  var bks = bookings.filter(function (b) { return b.lead_id === lead.id; });
  var bkRows = bks.map(function (b) {
    return '<tr><td>' + esc(b.start_at.replace("T", " ").slice(0, 16)) + '</td><td>' + esc(b.person_name || "") + '</td><td>' + esc(b.booker_name) + '</td></tr>';
  }).join("");
  return '<div class="view-head"><h1>' + esc(lead.name) + '</h1>' + stagePill(lead.stage) +
    '<span style="flex:1"></span><a class="link-btn" href="#/pipeline">← Pipeline</a></div>' + flash() +
    '<div class="card"><div class="form-row"><div><label>Company</label><div><b>' + esc(lead.company || "—") + '</b></div></div>' +
    '<div><label>Value</label><div><b>' + money(lead.value_cents) + '</b></div></div>' +
    '<div><label>Temperature / Priority</label><div>' + tempDot(lead.temperature) + esc(lead.temperature) + ' · P' + lead.priority + '</div></div></div>' +
    '<div class="form-row"><div><label>Contact</label><div>' + esc(lead.email || "—") + (lead.phone ? ' · ' + esc(lead.phone) : '') + '</div></div>' +
    '<div><label>Source</label><div>' + esc(lead.source || "—") + '</div></div>' +
    (lead.pod_id ? '<div><label>Pod</label><div><a href="#/pod/' + lead.pod_id + '/channels">Open pod →</a></div></div>' : '') + '</div>' +
    '<div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">' +
    (next ? '<button class="btn small" onclick="Podium.moveLead(\'' + lead.id + "','" + next + '\')">Move to ' + esc(STAGE_LABEL[next]) + '</button>' : '') +
    (lead.stage !== "won" && lead.stage !== "lost" ? '<button class="btn small ghost" onclick="Podium.moveLead(\'' + lead.id + "','lost')\">Mark lost</button>" : "") +
    (lead.stage === "won" && !lead.pod_id ? '<button class="btn small" onclick="Podium.spinUpPod(\'' + lead.id + '\')">Spin up pod</button>' : '') +
    '</div></div>' +
    '<div class="card"><h3>Notes</h3><form onsubmit="return Podium.saveLeadNotes(event,\'' + lead.id + '\')">' +
    '<textarea name="notes" rows="4">' + esc(lead.notes || "") + '</textarea>' +
    '<div class="form-row"><div><label>Partner</label><select name="partner_id" onchange="Podium.linkPartner(\'' + lead.id + '\',this.value)">' + popts + '</select></div>' +
    '<div><label>Temperature</label><select name="temperature" onchange="Podium.setLeadTemp(\'' + lead.id + '\',this.value)">' +
    ["hot", "warm", "cold"].map(function (t) { return '<option value="' + t + '"' + (t === lead.temperature ? " selected" : "") + '>' + t + '</option>'; }).join("") + '</select></div>' +
    '<div><label>Priority</label><select name="priority" onchange="Podium.setLeadPriority(\'' + lead.id + '\',this.value)">' +
    [1, 2, 3, 4, 5].map(function (n) { return '<option value="' + n + '"' + (n === lead.priority ? " selected" : "") + '>P' + n + '</option>'; }).join("") + '</select></div></div>' +
    '<div style="margin-top:10px"><button class="btn small" type="submit">Save notes</button> ' +
    '<button class="btn small danger" type="button" onclick="Podium.deleteLead(\'' + lead.id + '\')">Delete lead</button></div></form></div>' +
    '<div class="card"><h3>Bookings</h3>' +
    (bkRows ? '<table><tr><th>When</th><th>With</th><th>Booker</th></tr>' + bkRows + '</table>' : '<div class="muted">No bookings linked. Share a booking page — new bookings can attach to this lead.</div>') + '</div>';
}

function viewSchedule(data) {
  data = data || { bookings: [], people: [] };
  var rows = data.bookings.map(function (b) {
    return '<tr><td>' + esc(String(b.start_at).replace("T", " ").slice(0, 16)) + '</td>' +
      '<td>' + esc(b.person_name || "") + '</td><td>' + esc(b.booker_name) +
      (b.booker_email ? '<div class="muted">' + esc(b.booker_email) + '</div>' : '') + '</td>' +
      '<td>' + (b.lead_id ? '<a href="#/lead/' + b.lead_id + '">' + esc(b.lead_company || "lead") + '</a>' :
        '<button class="link-btn" onclick="Podium.linkBookingLeadPrompt(\'' + b.id + '\')">Link lead</button>') + '</td>' +
      '<td><button class="link-btn" onclick="Podium.cancelBooking(\'' + b.id + '\')">Cancel</button></td></tr>';
  }).join("");
  var ppl = data.people.map(function (p) {
    var av = (data.availability || {})[p.id] || [];
    var avRows = av.map(function (a) {
      return '<span class="pill" style="background:var(--sand);margin:2px 4px 2px 0">' +
        ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][a.weekday] + " " +
        fmtMin(a.start_min) + "–" + fmtMin(a.end_min) +
        ' <a href="#" onclick="return Podium.deleteAvailability(\'' + a.id + '\')" style="color:var(--muted);text-decoration:none">×</a></span>';
    }).join("") || '<span class="muted">No availability set</span>';
    var bookUrl = p.booking_slug ? location.origin + "/book/" + p.booking_slug : "";
    return '<div class="card"><div class="row between"><div><b>' + esc(p.name) + '</b> <span class="muted">' + esc(p.title || "") + '</span></div>' +
      (p.booking_slug
        ? '<span><a class="link-btn" href="/book/' + p.booking_slug + '" target="_blank">/book/' + esc(p.booking_slug) + ' ↗</a></span>'
        : '<button class="btn small" onclick="Podium.enableBooking(\'' + p.id + '\')">Enable booking page</button>') + '</div>' +
      '<div style="margin:8px 0">' + avRows + '</div>' +
      '<form onsubmit="return Podium.saveAvailability(event,\'' + p.id + '\')" class="form-row" style="align-items:end">' +
      '<div><label>Day</label><select name="weekday">' + ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map(function (d, i) { return '<option value="' + i + '">' + d + '</option>'; }).join("") + '</select></div>' +
      '<div><label>From</label><input type="time" name="start" value="09:00" required></div>' +
      '<div><label>To</label><input type="time" name="end" value="17:00" required></div>' +
      '<div><button class="btn small" type="submit">Add</button></div></form>' +
      (bookUrl ? '<div class="muted" style="margin-top:6px">Public link: <a href="' + bookUrl + '" target="_blank">' + esc(bookUrl) + '</a></div>' : '') + '</div>';
  }).join("");
  return '<div class="view-head"><h1>Schedule</h1><span class="sub">Frictionless booking, 30-min slots</span></div>' + flash() +
    '<div class="card"><h3>Upcoming bookings</h3><table><tr><th>When</th><th>With</th><th>Booker</th><th>Lead</th><th></th></tr>' +
    (rows || '<tr><td colspan="5" class="muted">Nothing booked yet.</td></tr>') + '</table></div>' + ppl;
}
function fmtMin(m) {
  var h = Math.floor(m / 60), mm = m % 60;
  return String(h).padStart(2, "0") + ":" + String(mm).padStart(2, "0");
}

function viewInvoices(invoices, detail, pods) {
  invoices = invoices || [];
  var h = '<div class="view-head"><h1>Invoices</h1><span class="sub">Client-facing billing</span>' +
    '<span style="flex:1"></span><a class="btn small ghost" href="/api/invoices/export.csv">QBO/Xero CSV</a></div>' + flash();
  if (detail) {
    var inv = detail.invoice;
    var rows = inv.line_items.map(function (l) {
      return '<tr><td>' + esc(l.description || ((l.person_name || "") + " — " + (l.hours || 0) + "h")) + '</td>' +
        '<td class="num">' + (l.hours != null ? fmtHours(l.hours) : "—") + '</td>' +
        '<td class="num">' + (l.rate_cents != null ? money(l.rate_cents) : "—") + '</td>' +
        '<td class="num"><b>' + money(l.amount_cents) + '</b></td></tr>';
    }).join("");
    h += '<div class="card"><div class="view-head"><h1 style="font-size:20px">' + esc(inv.number) + '</h1>' +
      '<span class="pill ' + inv.status + '">' + inv.status + '</span><span style="flex:1"></span>' +
      '<a class="btn small ghost" href="#/invoices">All invoices</a></div>' +
      '<div class="muted">' + esc(inv.client_name || inv.pod_name || "") + ' · ' + esc(inv.period_start) + ' → ' + esc(inv.period_end) +
      (inv.due_at ? ' · due ' + esc(inv.due_at) : '') +
      (inv.stripe_invoice_id ? ' · <span class="muted">Stripe ' + esc(inv.stripe_invoice_id) + '</span>' : '') +
      (inv.qbo_id ? ' · <span class="muted">QBO ' + esc(inv.qbo_id) + '</span>' : '') + '</div>' +
      '<table style="margin-top:10px"><tr><th>Line</th><th class="num">Hours</th><th class="num">Rate</th><th class="num">Amount</th></tr>' +
      (rows || '<tr><td colspan="4" class="muted">No line items.</td></tr>') + '</table>' +
      '<div style="text-align:right;margin-top:10px;font-size:18px">Total <b>' + money(inv.amount_cents) + '</b></div>' +
      '<div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">' +
      (inv.status === "draft" ? '<button class="btn small" onclick="Podium.sendInvoice(\'' + inv.id + '\')">Send invoice</button>' : '') +
      ((inv.status === "draft" || inv.status === "sent") ? '<button class="btn small ghost" onclick="Podium.voidInvoice(\'' + inv.id + '\')">Void</button>' : '') +
      (detail.qboConnected && inv.status !== "void" ? '<button class="btn small ghost" onclick="Podium.pushQbo(\'' + inv.id + '\')">Push to QuickBooks</button>' : '') +
      '</div>' +
      (detail.hosted_url ? '<div style="margin-top:10px"><a class="link-btn" href="' + esc(detail.hosted_url) + '" target="_blank">Stripe hosted payment page ↗</a></div>' : '') +
      '</div>';
    return h;
  }
  var cards = invoices.map(function (v) {
    return '<tr style="cursor:pointer" onclick="location.hash=\'#/invoices/' + v.id + '\'"><td><b>' + esc(v.number) + '</b></td>' +
      '<td>' + esc(v.client_name || v.pod_name || "") + '</td><td class="muted">' + esc(v.period_start) + ' → ' + esc(v.period_end) + '</td>' +
      '<td class="num">' + money(v.amount_cents) + '</td><td><span class="pill ' + v.status + '">' + v.status + '</span></td></tr>';
  }).join("");
  var popts = (pods || []).map(function (p) { return '<option value="' + p.id + '">' + esc(p.name) + '</option>'; }).join("");
  h += '<div class="card"><table><tr><th>Number</th><th>Client</th><th>Period</th><th class="num">Amount</th><th>Status</th></tr>' +
    (cards || '<tr><td colspan="5" class="muted">No invoices yet.</td></tr>') + '</table></div>';
  h += '<div class="card"><h3>Generate invoice</h3><form onsubmit="return Podium.generateInvoice(event)"><div class="form-row">' +
    '<div><label>Pod</label><select name="pod_id">' + popts + '</select></div>' +
    '<div><label>From</label><input type="date" name="period_start" required></div>' +
    '<div><label>To</label><input type="date" name="period_end" required></div></div>' +
    '<div style="margin-top:10px"><button class="btn" type="submit">Generate draft</button></div>' +
    '<p class="muted">Hourly pods bill hours × each person\'s rate. Retainer pods bill the flat retainer rate.</p></form></div>';
  return h;
}

function viewSettings(s, templates) {
  s = s || { settings: {}, stripeMode: "test" };
  var st = s.settings;
  function secretRow(key, label) {
    var v = st[key] || { set: false, preview: "" };
    return '<div><label>' + label + (v.set ? ' <span class="muted">(set · ' + esc(v.preview) + ')</span>' : '') + '</label>' +
      '<input name="' + key + '" type="password" placeholder="' + (v.set ? "•••• (leave blank to keep)" : "paste here") + '" autocomplete="off"></div>';
  }
  function textRow(key, label, ph) {
    var v = st[key] || { set: false, preview: "" };
    return '<div><label>' + label + '</label><input name="' + key + '" value="' + esc(v.preview) + '" placeholder="' + esc(ph || "") + '" autocomplete="off"></div>';
  }
  var trows = (templates || []).map(function (t) {
    return '<div class="page-item"><div class="t">' + esc(t.name) + ' <span class="muted">' + esc(t.kind) + '</span></div>' +
      '<div><button class="link-btn" onclick="Podium.editTemplate(\'' + t.id + '\')">Edit</button> ' +
      '<button class="link-btn" onclick="Podium.deleteTemplate(\'' + t.id + '\')">Delete</button></div></div>';
  }).join("");
  var et = s.editingTemplate;
  return '<div class="view-head"><h1>Settings</h1><span class="sub">Integrations & templates</span></div>' + flash() +
    '<div class="card"><h3>Stripe</h3><form onsubmit="return Podium.saveSettings(event,\'stripe\')">' +
    '<div class="form-row"><div><label>Mode</label><select name="stripe_mode">' +
    '<option value="test"' + (s.stripeMode === "test" ? " selected" : "") + '>Test — no real money</option>' +
    '<option value="live"' + (s.stripeMode === "live" ? " selected" : "") + '>Live — real money moves</option></select></div></div>' +
    '<div class="form-row">' + textRow("stripe_test_publishable", "Test publishable key", "pk_test_…") + secretRow("stripe_test_secret", "Test secret key") + '</div>' +
    '<div class="form-row">' + textRow("stripe_live_publishable", "Live publishable key", "pk_live_…") + secretRow("stripe_live_secret", "Live secret key") + '</div>' +
    '<div class="form-row">' + secretRow("stripe_webhook_secret", "Webhook endpoint secret") + '</div>' +
    '<div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap"><button class="btn small" type="submit">Save Stripe settings</button>' +
    '<button class="btn small ghost" type="button" onclick="Podium.syncRetainers()">Sync retainer subscriptions</button></div>' +
    '<p class="muted">Test mode by default — nothing real moves until you flip to Live with a live key. Webhook: point Stripe at <code>/api/integrations/stripe/webhook</code>.</p></form></div>' +
    '<div class="card"><h3>Slack</h3><form onsubmit="return Podium.saveSettings(event,\'slack\')">' +
    '<div class="form-row">' + secretRow("slack_bot_token", "Bot token (xoxb-…)") + '</div>' +
    '<div style="margin-top:10px;display:flex;gap:8px"><button class="btn small" type="submit">Save</button>' +
    '<button class="btn small ghost" type="button" onclick="Podium.testSlack()">Send test message</button></div></form>' +
    '<div style="margin-top:10px"><label>Provision a private channel for a pod</label><div class="form-row"><div><select id="slack-pod">' +
    (s.pods || []).map(function (p) { return '<option value="' + p.id + '">' + esc(p.name) + (p.slack_channel_id ? " ✓" : "") + '</option>'; }).join("") +
    '</select></div><div><button class="btn small" type="button" onclick="Podium.provisionSlack()">Provision channel</button></div></div></div></div>' +
    '<div class="card"><h3>QuickBooks Online</h3><form onsubmit="return Podium.saveSettings(event,\'qbo\')">' +
    '<div class="form-row">' + textRow("qbo_client_id", "Client ID") + secretRow("qbo_client_secret", "Client secret") + '</div>' +
    '<div class="form-row">' + textRow("qbo_redirect_uri", "Redirect URI", "http://127.0.0.1:3025/api/integrations/qbo/callback") +
    '<div><label>Sandbox</label><select name="qbo_sandbox"><option value="1"' + ((st.qbo_sandbox || {}).preview !== "0" ? " selected" : "") + '>Sandbox</option><option value="0"' + ((st.qbo_sandbox || {}).preview === "0" ? " selected" : "") + '>Production</option></select></div></div>' +
    '<div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap"><button class="btn small" type="submit">Save</button>' +
    '<button class="btn small ghost" type="button" onclick="Podium.qboConnect()">Connect QuickBooks</button></div>' +
    '<p class="muted">Status: ' + (s.qboConnected ? "connected" + (s.qboRealm ? " · realm " + esc(s.qboRealm) : "") : "not connected") +
    '. Until connected, the QBO/Xero CSV export is the bridge.</p></form></div>' +
    '<div class="card"><h3>Page templates</h3><div class="muted" style="margin-bottom:8px">Use {{pod_name}}, {{client_name}}, {{date}}, {{owner_name}} placeholders.</div>' +
    trows +
    (et
      ? '<form onsubmit="return Podium.saveTemplate(event)" style="margin-top:12px"><input type="hidden" name="id" value="' + esc(et.id || "") + '">' +
        '<div class="form-row"><div><label>Name</label><input name="name" value="' + esc(et.name || "") + '" required maxlength="80"></div>' +
        '<div><label>Kind</label><input name="kind" value="' + esc(et.kind || "doc") + '" maxlength="40"></div></div>' +
        '<label>Body (markdown)</label><textarea name="body_md" rows="10">' + esc(et.body_md || "") + '</textarea>' +
        '<div style="margin-top:10px;display:flex;gap:8px"><button class="btn small" type="submit">Save template</button>' +
        '<button class="btn small ghost" type="button" onclick="Podium.cancelTemplateEdit()">Cancel</button></div></form>'
      : '<div style="margin-top:10px"><button class="btn small" onclick="Podium.newTemplate()">+ New template</button></div>') + '</div>';
}

/* Retainer usage bar + big green timer button, for the pod header. */
function viewRetainerBar(retainer) {
  if (!retainer) return "";
  var pct = Math.min(100, Math.round(retainer.pct * 100));
  var color = retainer.pct >= 1 ? "var(--red)" : retainer.pct >= 0.8 ? "var(--amber)" : "var(--sage)";
  return '<div class="retainer"><div class="row between"><b>Retainer</b><span>' + fmtHours(retainer.hours) + ' / ' + fmtHours(retainer.cap) +
    (retainer.pct >= 1 ? ' <span class="pill closed">over cap</span>' : '') + '</span></div>' +
    '<div class="bar-track"><div class="bar-fill" style="width:' + pct + '%;background:' + color + '"></div></div></div>';
}
function viewTimerWidget(pod, members, timers) {
  timers = timers || [];
  var opts = members.map(function (m) {
    return '<option value="' + m.person_id + '">' + esc(m.person_name) + '</option>';
  }).join("");
  var running = timers.length ? timers[0] : null;
  var inner;
  if (running) {
    var el = running.elapsed_sec || 0;
    var mm = Math.floor(el / 60), ss = el % 60;
    inner = '<div class="timer-running"><span class="pulse"></span><b>' + esc(running.person_name || "Timer") + '</b>' +
      '<span class="timer-el">' + mm + ':' + String(ss).padStart(2, "0") + '</span>' +
      '<button class="btn small danger" onclick="Podium.stopTimer(\'' + running.person_id + '\')">Stop</button></div>';
  } else {
    inner = '<div class="timer-idle"><select id="timer-person">' + opts + '</select>' +
      '<input id="timer-note" placeholder="What are you working on?" maxlength="200">' +
      '<button class="timer-btn" onclick="Podium.startTimer(\'' + pod.id + '\')">▶ Start</button></div>';
  }
  return '<div class="timer-widget">' + inner + '</div>';
}

/* ---------- render orchestration ---------- */
function currentView() {  var h = (location.hash || "#/home").replace(/^#/, "");
  return (h.split("/").filter(Boolean)[0] || "home");
}
function render() {
  var v = currentView();
  var parts = currentViewParts();
  document.getElementById("sidebar").innerHTML = renderSidebar();
  document.querySelectorAll("#bottomnav a").forEach(function (a) {
    a.classList.toggle("active", a.getAttribute("data-v") === v || (v === "pod" && a.getAttribute("data-v") === "pods"));
  });
  var el = document.getElementById("view");
  if (v === "home") el.innerHTML = viewHome(state.dash);
  else if (v === "pods") el.innerHTML = viewPods(state.pods);
  else if (v === "pod" && state.pod) {
    var tab = state.podTab || "channels";
    var head = viewPodHead(state.pod, tab, state.members, state.retainer, state.podTimers);
    if (tab === "channels") el.innerHTML = head + viewChannels(state.channels, state.channel && state.channel.id, state.messages, state.replyTo, state.members, state.pod.id);
    else if (tab === "pages") el.innerHTML = head + viewPages(state.pages, state.editingPage, state.page, state.templates, state.showTemplateForm);
    else if (tab === "time") el.innerHTML = head + viewTimeTab(state.pod, state.members, state.people, state.timePerson, state.timeWeek, state.entries);
    fillMemberPicker();
  }
  else if (v === "people") el.innerHTML = viewPeople(state.people, state.weekHours || {});
  else if (v === "payroll") el.innerHTML = viewPayroll(state.periods, state.period);
  else if (v === "pipeline") el.innerHTML = parts[1] === "top20" ? viewTop20(state.top20) : viewPipeline(state.pipeline);
  else if (v === "lead" && state.lead) el.innerHTML = viewLead(state.lead, state.partners, state.leadBookings);
  else if (v === "schedule") el.innerHTML = viewSchedule({ bookings: state.bookings, people: state.people, availability: state.availability });
  else if (v === "invoices") el.innerHTML = viewInvoices(state.invoices, state.invoice, state.pods);
  else if (v === "settings") el.innerHTML = viewSettings(state.settings, state.templates);
  else el.innerHTML = viewHome(state.dash);
  if (state.editingPage) Podium.previewPage();
  updateTimerPill();
}

function currentViewParts() {
  return ((location.hash || "#/home").replace(/^#/, "").split("/").filter(Boolean));
}
function fillMemberPicker() {
  var sel = document.getElementById("member-picker");
  if (!sel || !state.people) return;
  var inPod = {};
  state.members.forEach(function (m) { inPod[m.person_id] = 1; });
  sel.innerHTML = state.people.filter(function (p) { return !inPod[p.id]; })
    .map(function (p) { return '<option value="' + p.id + '">' + esc(p.name) + '</option>'; }).join("") ||
    '<option value="">Everyone is already in this pod</option>';
}

/* ---------- actions ---------- */
var Podium = {
  md: md, esc: esc, money: money, fmtHours: fmtHours,
  viewHome: viewHome, viewPods: viewPods, viewPodHead: viewPodHead, viewChannels: viewChannels,
  renderMessage: renderMessage, viewPages: viewPages, viewTimeTab: viewTimeTab, viewPeople: viewPeople,
  viewPayroll: viewPayroll, renderSidebar: renderSidebar, mondayOf: mondayOf, addDays: addDays,
  viewPipeline: viewPipeline, viewTop20: viewTop20, viewLead: viewLead, leadCard: leadCard,
  viewSchedule: viewSchedule, viewInvoices: viewInvoices, viewSettings: viewSettings,
  viewRetainerBar: viewRetainerBar, viewTimerWidget: viewTimerWidget, fmtMin: fmtMin, tempDot: tempDot,

  createPod: function (e) {
    e.preventDefault();
    var f = e.target;
    api("POST", "/api/pods", { name: f.name.value, client_name: f.client_name.value, color: f.color.value })
      .then(function (r) { location.hash = "#/pod/" + r.pod.id + "/channels"; })
      .catch(function (er) { setErr(er.message); });
    return false;
  },
  addMember: function (e, podId) {
    e.preventDefault();
    var f = e.target;
    if (!f.person_id.value) { setErr("Everyone is already in this pod."); return false; }
    api("POST", "/api/pods/" + podId + "/members", { person_id: f.person_id.value, role: f.role.value })
      .then(function () { loadPod(podId, state.podTab || "channels"); })
      .catch(function (er) { setErr(er.message); });
    return false;
  },
  removeMember: function (podId, personId) {
    if (!confirm("Remove this member from the pod?")) return false;
    api("DELETE", "/api/pods/" + podId + "/members/" + personId)
      .then(function () { loadPod(podId, state.podTab || "channels"); })
      .catch(function (er) { setErr(er.message); });
    return false;
  },
  switchChannel: function (cid) {
    state.channel = state.channels.find(function (c) { return c.id === cid; });
    state.replyTo = null;
    api("GET", "/api/channels/" + cid + "/messages").then(function (m) { state.messages = m.messages; render(); });
  },
  newChannel: function () {
    var name = prompt("Channel name:");
    if (!name) return;
    api("POST", "/api/pods/" + state.pod.id + "/channels", { name: name })
      .then(function (r) { state.channels.push(r.channel); state.channel = r.channel; state.messages = []; render(); })
      .catch(function (e) { setErr(e.message); });
  },
  startReply: function (mid) {
    state.replyTo = mid;
    render();
    var box = document.getElementById("compose-box");
    if (box) box.focus();
  },
  cancelReply: function () { state.replyTo = null; render(); },
  sendMessage: function (e) {
    e.preventDefault();
    var body = e.target.body.value;
    if (!body.trim()) return false;
    var authorId = e.target.author_id.value;
    if (!authorId) { setErr("Add a member to the pod before chatting."); return false; }
    try { localStorage.setItem("podium_author_" + state.pod.id, authorId); } catch (err) {}
    api("POST", "/api/channels/" + state.channel.id + "/messages",
      { author_id: authorId, body_md: body, thread_parent_id: state.replyTo })
      .then(function () { state.replyTo = null; Podium.switchChannel(state.channel.id); })
      .catch(function (er) { setErr(er.message); });
    return false;
  },
  openPage: function (id) {
    api("GET", "/api/pages/" + id).then(function (r) { state.page = r.page; state.editingPage = false; render(); });
  },
  closePage: function () { state.page = null; state.editingPage = false; render(); },
  newPage: function () { state.page = null; state.editingPage = true; render(); },
  editPage: function () { state.editingPage = true; render(); },
  cancelPageEdit: function () { state.editingPage = false; render(); },
  previewPage: function () {
    var src = document.getElementById("page-src"), pv = document.getElementById("page-preview");
    if (src && pv) pv.innerHTML = md(src.value);
  },
  savePage: function (e) {
    e.preventDefault();
    var f = e.target;
    var author = (state.members[0] && state.members[0].person_name) || "";
    var p = state.page
      ? api("PUT", "/api/pages/" + state.page.id, { title: f.title.value, body_md: f.body_md.value, updated_by: author })
      : api("POST", "/api/pods/" + state.pod.id + "/pages", { title: f.title.value, body_md: f.body_md.value, updated_by: author });
    p.then(function (r) { state.page = r.page; state.editingPage = false; loadPod(state.pod.id, "pages"); })
      .catch(function (er) { setErr(er.message); });
    return false;
  },
  deletePage: function (id) {
    if (!confirm("Delete this page?")) return;
    api("DELETE", "/api/pages/" + id).then(function () { state.page = null; state.editingPage = false; loadPod(state.pod.id, "pages"); });
  },
  switchTimePerson: function (pid) { state.timePerson = pid; loadTimeTab(); },
  switchTimeWeek: function (w) { if (w) { state.timeWeek = mondayOf(w); loadTimeTab(); } },
  quickEntry: function (day) {
    document.getElementById("entry-day").value = day;
    document.getElementById("entry-hours").focus();
    if (!reducedMotion) document.getElementById("entry-day").scrollIntoView({ block: "center", behavior: "smooth" });
    else document.getElementById("entry-day").scrollIntoView({ block: "center" });
  },
  resetEntryForm: function () {
    document.getElementById("entry-id").value = "";
    document.getElementById("entry-day").value = todayIso();
    document.getElementById("entry-hours").value = "";
    document.getElementById("entry-note").value = "";
  },
  saveEntry: function (e) {
    e.preventDefault();
    var f = e.target, id = f.id.value;
    var body = { pod_id: state.pod.id, person_id: state.timePerson, day: f.day.value, hours: Number(f.hours.value), note: f.note.value, billable: Number(f.billable.value) };
    var p = id ? api("PUT", "/api/time/" + id, body) : api("POST", "/api/time", body);
    p.then(function () { Podium.resetEntryForm(); loadTimeTab(); setOk("Time saved."); })
      .catch(function (er) { setErr(er.message); });
    return false;
  },
  editEntry: function (id) {
    var e = state.entries.find(function (x) { return x.id === id; });
    if (!e) return;
    document.getElementById("entry-id").value = e.id;
    document.getElementById("entry-day").value = e.day;
    document.getElementById("entry-hours").value = e.hours;
    document.getElementById("entry-note").value = e.note || "";
    document.getElementById("entry-billable").value = String(e.billable);
    document.getElementById("entry-day").scrollIntoView({ block: "center" });
  },
  deleteEntry: function (id) {
    if (!confirm("Delete this entry?")) return;
    api("DELETE", "/api/time/" + id).then(function () { loadTimeTab(); }).catch(function (er) { setErr(er.message); });
  },
  savePerson: function (e) {
    e.preventDefault();
    var f = e.target, id = f.id.value;
    var body = { name: f.name.value, title: f.title.value, email: f.email.value, hourly_rate_cents: Math.round(Number(f.rate.value || 0) * 100) };
    var p = id ? api("PUT", "/api/people/" + id, body) : api("POST", "/api/people", body);
    p.then(function () { Podium.resetPersonForm(); loadPeople(); setOk("Saved."); }).catch(function (er) { setErr(er.message); });
    return false;
  },
  editPerson: function (id) {
    var pe = state.people.find(function (x) { return x.id === id; });
    if (!pe) return;
    document.getElementById("person-id").value = pe.id;
    document.getElementById("person-name").value = pe.name;
    document.getElementById("person-title").value = pe.title || "";
    document.getElementById("person-email").value = pe.email || "";
    document.getElementById("person-rate").value = (pe.hourly_rate_cents / 100).toString();
    document.getElementById("person-name").scrollIntoView({ block: "center" });
  },
  resetPersonForm: function () {
    ["person-id", "person-name", "person-title", "person-email", "person-rate"].forEach(function (i) { document.getElementById(i).value = ""; });
  },
  createPeriod: function (e) {
    e.preventDefault();
    var f = e.target;
    api("POST", "/api/periods", { label: f.label.value, start_day: f.start_day.value, end_day: f.end_day.value })
      .then(function () { loadPayroll(null); setOk("Period opened."); })
      .catch(function (er) { setErr(er.message); });
    return false;
  },
  closePeriod: function (id) {
    if (!confirm("Close this period? Entries become read-only and statements are snapshotted.")) return;
    api("POST", "/api/periods/" + id + "/close")
      .then(function () { loadPayroll(id); setOk("Period closed. Statements written."); })
      .catch(function (er) { setErr(er.message); });
  },

  /* ----- CRM ----- */
  saveLead: function (e) {
    e.preventDefault();
    var f = e.target;
    api("POST", "/api/leads", {
      name: f.name.value, company: f.company.value, email: f.email.value, phone: f.phone.value,
      temperature: f.temperature.value, priority: Number(f.priority.value),
      value_cents: Math.round(Number(f.value.value || 0) * 100), source: f.source.value,
    }).then(function () { loadPipeline(); setOk("Lead added."); }).catch(function (er) { setErr(er.message); });
    return false;
  },
  moveLead: function (id, stage) {
    api("POST", "/api/leads/" + id + "/move", { stage: stage })
      .then(function () {
        var v = currentView();
        if (v === "lead") loadLead(id); else loadPipeline();
        setOk("Moved to " + (STAGE_LABEL[stage] || stage) + ".");
      })
      .catch(function (er) { setErr(er.message); });
  },
  spinUpPod: function (id) {
    if (!confirm("Spin up a pod from this won deal?")) return;
    api("POST", "/api/leads/" + id + "/spin-up-pod")
      .then(function (r) { location.hash = "#/pod/" + r.pod.id + "/channels"; setOk("Pod created from the deal."); })
      .catch(function (er) { setErr(er.message); });
  },
  saveLeadNotes: function (e, id) {
    e.preventDefault();
    api("PUT", "/api/leads/" + id, { notes: e.target.notes.value })
      .then(function () { setOk("Notes saved."); }).catch(function (er) { setErr(er.message); });
    return false;
  },
  linkPartner: function (id, partnerId) {
    api("PUT", "/api/leads/" + id, { partner_id: partnerId || null })
      .then(function () { setOk("Partner linked."); }).catch(function (er) { setErr(er.message); });
  },
  setLeadTemp: function (id, t) {
    api("PUT", "/api/leads/" + id, { temperature: t }).then(function () { loadLead(id); }).catch(function (er) { setErr(er.message); });
  },
  setLeadPriority: function (id, p) {
    api("PUT", "/api/leads/" + id, { priority: Number(p) }).then(function () { loadLead(id); }).catch(function (er) { setErr(er.message); });
  },
  deleteLead: function (id) {
    if (!confirm("Delete this lead?")) return;
    api("DELETE", "/api/leads/" + id).then(function () { location.hash = "#/pipeline"; }).catch(function (er) { setErr(er.message); });
  },

  /* ----- templates ----- */
  toggleTemplateForm: function (show) { state.showTemplateForm = show; render(); },
  createFromTemplate: function (e) {
    e.preventDefault();
    var f = e.target;
    var vars = {
      pod_name: state.pod.name, client_name: state.pod.client_name || state.pod.name,
      date: f.date.value, owner_name: f.owner_name.value,
    };
    api("POST", "/api/pods/" + state.pod.id + "/pages/from-template", { template_id: f.template_id.value, variables: vars, title: f.title.value || undefined })
      .then(function (r) { state.showTemplateForm = false; state.page = r.page; state.editingPage = false; loadPod(state.pod.id, "pages"); setOk("Page created from template."); })
      .catch(function (er) { setErr(er.message); });
    return false;
  },
  newTemplate: function () { state.editingTemplate = { id: "", name: "", kind: "doc", body_md: "" }; render(); },
  editTemplate: function (id) {
    api("GET", "/api/templates/" + id).then(function (r) { state.editingTemplate = r.template; render(); });
  },
  cancelTemplateEdit: function () { state.editingTemplate = null; render(); },
  saveTemplate: function (e) {
    e.preventDefault();
    var f = e.target, id = f.id.value;
    var body = { name: f.name.value, kind: f.kind.value, body_md: f.body_md.value };
    var p = id ? api("PUT", "/api/templates/" + id, body) : api("POST", "/api/templates", body);
    p.then(function () { state.editingTemplate = null; loadSettings(); setOk("Template saved."); }).catch(function (er) { setErr(er.message); });
    return false;
  },
  deleteTemplate: function (id) {
    if (!confirm("Delete this template?")) return;
    api("DELETE", "/api/templates/" + id).then(function () { loadSettings(); }).catch(function (er) { setErr(er.message); });
  },

  /* ----- timer ----- */
  startTimer: function (podId) {
    var personId = document.getElementById("timer-person").value;
    var note = document.getElementById("timer-note").value;
    api("POST", "/api/timer/start", { person_id: personId, pod_id: podId, note: note })
      .then(function () { loadPod(podId, state.podTab || "channels"); setOk("Timer started."); })
      .catch(function (er) { setErr(er.message); });
  },
  stopTimer: function (personId) {
    api("POST", "/api/timer/stop", { person_id: personId })
      .then(function (r) { loadPod(state.pod.id, state.podTab || "channels"); setOk("Logged " + r.hours + "h."); })
      .catch(function (er) { setErr(er.message); });
  },
  editBilling: function (podId) {
    var type = prompt("Billing type: retainer or hourly?", state.pod.billing_type || "hourly");
    if (!type || (type !== "retainer" && type !== "hourly")) return;
    var body = { billing_type: type };
    if (type === "retainer") {
      var hrs = prompt("Monthly retainer cap (hours)?", state.pod.retainer_hours || "40");
      var rate = prompt("Monthly retainer fee (USD)?", state.pod.retainer_rate_cents ? (state.pod.retainer_rate_cents / 100) : "5000");
      body.retainer_hours = Number(hrs) || null;
      body.retainer_rate_cents = Math.round(Number(rate || 0) * 100);
    }
    api("PUT", "/api/pods/" + podId + "/retainer", body)
      .then(function () { loadPod(podId, state.podTab || "channels"); setOk("Billing updated."); })
      .catch(function (er) { setErr(er.message); });
  },

  /* ----- scheduling ----- */
  saveAvailability: function (e, personId) {
    e.preventDefault();
    var f = e.target;
    function toMin(t) { var p = t.split(":"); return Number(p[0]) * 60 + Number(p[1]); }
    api("POST", "/api/availability", { person_id: personId, weekday: Number(f.weekday.value), start_min: toMin(f.start.value), end_min: toMin(f.end.value) })
      .then(function () { loadSchedule(); setOk("Availability added."); })
      .catch(function (er) { setErr(er.message); });
    return false;
  },
  deleteAvailability: function (id) {
    api("DELETE", "/api/availability/" + id).then(function () { loadSchedule(); });
    return false;
  },
  enableBooking: function (personId) {
    api("POST", "/api/people/" + personId + "/enable-booking")
      .then(function (r) { loadSchedule(); setOk("Booking page live: /book/" + r.slug); })
      .catch(function (er) { setErr(er.message); });
  },
  cancelBooking: function (id) {
    if (!confirm("Cancel this booking?")) return;
    api("DELETE", "/api/bookings/" + id).then(function () { loadSchedule(); }).catch(function (er) { setErr(er.message); });
  },
  linkBookingLeadPrompt: function (bookingId) {
    api("GET", "/api/leads").then(function (r) {
      var opts = r.leads.map(function (l, i) { return (i + 1) + ". " + l.name + (l.company ? " (" + l.company + ")" : ""); }).join("\n");
      var pick = prompt("Link to which lead? Enter the number:\n" + opts);
      var idx = Number(pick) - 1;
      if (!pick || !r.leads[idx]) return;
      api("POST", "/api/bookings/" + bookingId + "/link-lead", { lead_id: r.leads[idx].id })
        .then(function () { loadSchedule(); setOk("Booking linked to lead."); })
        .catch(function (er) { setErr(er.message); });
    });
  },

  /* ----- invoices ----- */
  generateInvoice: function (e) {
    e.preventDefault();
    var f = e.target;
    api("POST", "/api/invoices/generate", { pod_id: f.pod_id.value, period_start: f.period_start.value, period_end: f.period_end.value })
      .then(function (r) { location.hash = "#/invoices/" + r.invoice.id; setOk("Draft " + r.invoice.number + " generated."); })
      .catch(function (er) { setErr(er.message); });
    return false;
  },
  sendInvoice: function (id) {
    if (!confirm("Send this invoice? (Uses Stripe if connected, otherwise marks sent.)")) return;
    api("POST", "/api/invoices/" + id + "/send")
      .then(function (r) { state.invoice = { invoice: r.invoice, hosted_url: r.hosted_url, qboConnected: state.invoice.qboConnected }; render(); setOk("Invoice sent."); })
      .catch(function (er) { setErr(er.message); });
  },
  voidInvoice: function (id) {
    if (!confirm("Void this invoice?")) return;
    api("POST", "/api/invoices/" + id + "/void")
      .then(function () { loadInvoices(id); setOk("Invoice voided."); })
      .catch(function (er) { setErr(er.message); });
  },
  pushQbo: function (id) {
    api("POST", "/api/integrations/qbo/push-invoice/" + id)
      .then(function () { loadInvoices(id); setOk("Pushed to QuickBooks."); })
      .catch(function (er) { setErr(er.message); });
  },

  /* ----- settings & integrations ----- */
  saveSettings: function (e) {
    e.preventDefault();
    var f = e.target, body = {};
    Array.prototype.forEach.call(f.elements, function (el) {
      if (el.name && el.value !== "") body[el.name] = el.value;
    });
    api("POST", "/api/settings", body)
      .then(function () { loadSettings(); setOk("Settings saved."); })
      .catch(function (er) { setErr(er.message); });
    return false;
  },
  syncRetainers: function () {
    api("POST", "/api/integrations/stripe/sync-retainers")
      .then(function (r) { setOk("Synced " + r.synced.length + " retainer subscription(s)."); loadSettings(); })
      .catch(function (er) { setErr(er.message); });
  },
  testSlack: function () {
    api("POST", "/api/integrations/slack/test", {})
      .then(function () { setOk("Test message sent to Slack."); })
      .catch(function (er) { setErr(er.message); });
  },
  provisionSlack: function () {
    var podId = document.getElementById("slack-pod").value;
    api("POST", "/api/integrations/slack/provision-channel", { pod_id: podId })
      .then(function (r) {
        setOk("Channel provisioned — invited " + r.invited + (r.missing.length ? ", " + r.missing.length + " without Slack email" : "") + ".");
        loadSettings();
      })
      .catch(function (er) { setErr(er.message); });
  },
  qboConnect: function () {
    api("GET", "/api/integrations/qbo/auth-url")
      .then(function (r) { window.open(r.url, "_blank"); })
      .catch(function (er) { setErr(er.message); });
  },
};

/* ---------- timer pill (persistent, polled) ---------- */
function updateTimerPill() {
  if (typeof document === "undefined") return;
  var el = document.getElementById("timer-pill");
  if (!el || !el.style) return; // stubbed DOM in tests
  var timers = state.timers || [];
  if (!timers.length) { el.innerHTML = ""; el.style.display = "none"; return; }
  el.style.display = "block";
  el.innerHTML = timers.map(function (t) {
    var s = t.elapsed_sec != null ? t.elapsed_sec
      : Math.max(0, Math.round((Date.now() - new Date(t.started_at).getTime()) / 1000));
    var label = Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
    return '<a href="#/pod/' + t.pod_id + '/time"><span class="pulse"></span> ' + label +
      ' · ' + esc(t.person_name || "") + '</a>';
  }).join("");
}
function pollTimers() {
  api("GET", "/api/timer/status").then(function (r) {
    state.timers = r.timers;
    updateTimerPill();
  }).catch(function () {});
}

/* ---------- boot ---------- */
if (typeof window !== "undefined") {
  window.Podium = Podium;
  window.addEventListener("hashchange", route);
  // preload for sidebar + member picker
  Promise.all([api("GET", "/api/pods"), api("GET", "/api/people")]).then(function (r) {
    state.pods = r[0].pods; state.people = r[1].people;
    route();
  }).catch(function () { route(); });
  setInterval(pollTimers, 30000);
  pollTimers();
}
if (typeof module !== "undefined" && module.exports) module.exports = Podium;

})();
