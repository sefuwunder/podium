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
  tasks: [], tasksErr: "", inbox: null, inboxLoading: false,
  talent: [], talentFilter: "", talentSort: "load", builder: null, conflictsPanel: null,
  objectives: [], alerts: [], alertCount: 0, signing: null, showSigningForm: false,
  valueLog: false, stopTimerFor: null,
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
  refreshAlertCount();
  if (v === "home") return loadHome();
  if (v === "pods") return loadPods();
  if (v === "pod" && parts[1]) return loadPod(parts[1], parts[2] || "channels");
  if (v === "people") return loadPeople();
  if (v === "talent") return parts[1] === "builder" ? loadBuilder() : loadTalent();
  if (v === "payroll") return loadPayroll(parts[1] || null);
  if (v === "pipeline") return parts[1] === "top20" ? loadTop20() : loadPipeline();
  if (v === "lead" && parts[1]) return loadLead(parts[1]);
  if (v === "schedule") return loadSchedule();
  if (v === "invoices") return loadInvoices(parts[1] || null);
  if (v === "settings") return loadSettings();
  if (v === "alerts") return loadAlerts();
  return loadHome();
}

/* ---------- data loaders ---------- */
function refreshAlertCount() {
  api("GET", "/api/alerts?unseen=1").then(function (r) {
    if (r.unseen !== state.alertCount) { state.alertCount = r.unseen; render(); }
  }).catch(function () { /* badge is best-effort */ });
}
function loadAlerts() {
  api("GET", "/api/alerts").then(function (r) {
    state.alerts = r.alerts; state.alertCount = r.unseen; render();
  }).catch(function (e) { setErr(e.message); });
}
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
    } else if (tab === "tasks") {
      api("GET", "/api/pods/" + id + "/tasks").then(function (r) {
        state.tasks = r.tasks; state.tasksErr = ""; render();
      }).catch(function (e) { state.tasks = []; state.tasksErr = e.message; render(); });
    } else if (tab === "inbox") {
      state.inboxLoading = true; render();
      api("GET", "/api/pods/" + id + "/inbox").then(function (r) {
        state.inbox = r; state.inboxLoading = false; render();
      }).catch(function (e) { state.inbox = { items: [], error: e.message }; state.inboxLoading = false; render(); });
    } else if (tab === "objectives") {
      api("GET", "/api/pods/" + id + "/objectives").then(function (r) {
        state.objectives = r.objectives; render();
      }).catch(function (e) { setErr(e.message); });
    }
    render();
  }).catch(function (e) { setErr(e.message); });
}
function loadTimeTab() {
  var pid = state.timePerson || (state.members[0] && state.members[0].person_id);
  state.timePerson = pid;
  if (!pid) { state.entries = []; render(); return; }
  var weeksBack = state.valueLog ? 3 : 0;
  var from = addDays(state.timeWeek, -7 * weeksBack), to = addDays(state.timeWeek, 6);
  api("GET", "/api/time?person_id=" + pid + "&from=" + from + "&to=" + to)
    .then(function (r) { state.entries = r.entries; render(); })
    .catch(function (e) { setErr(e.message); });
}
function loadPeople() {
  var week = mondayOf();
  Promise.all([api("GET", "/api/people"), api("GET", "/api/dashboard"), api("GET", "/api/time?week=" + week), api("GET", "/api/capacity")])
    .then(function (r) {
      state.people = r[0].people; state.dash = r[1];
      var wh = {};
      r[2].entries.forEach(function (e) { wh[e.person_id] = (wh[e.person_id] || 0) + Number(e.hours); });
      state.weekHours = wh;
      var cc = {};
      (r[3].capacity || []).forEach(function (c) { cc[c.person_id] = c.conflict_count; });
      state.conflictCounts = cc;
      render();
    })
    .catch(function (e) { setErr(e.message); });
}
/* ---------- talent & pod builder ---------- */
function loadTalent() {
  api("GET", "/api/capacity").then(function (r) {
    state.talent = r.capacity; render();
  }).catch(function (e) { setErr(e.message); });
}
function freshBuilder() {
  return { company: "", skills: "", hours: 20, budget: "", suggestions: null, picked: {}, hoursEach: "", allSkills: [] };
}
function loadBuilder() {
  if (!state.builder) state.builder = freshBuilder();
  api("GET", "/api/capacity").then(function (r) {
    var seen = {}, skills = [];
    r.capacity.forEach(function (c) {
      (c.skills || []).forEach(function (s) { if (!seen[s.toLowerCase()]) { seen[s.toLowerCase()] = 1; skills.push(s); } });
    });
    state.builder.allSkills = skills.sort();
    render();
  }).catch(function (e) { setErr(e.message); });
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
function alertBellInner() {
  var n = state.alertCount || 0;
  var badge = n ? '<span class="bell-badge">' + (n > 99 ? "99+" : n) + '</span>' : '';
  return '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>' + badge;
}
function alertBellHtml() {
  var n = state.alertCount || 0;
  return '<a href="#/alerts" class="alert-bell" title="Alerts" aria-label="Alerts' + (n ? ", " + n + " unread" : "") + '">' + alertBellInner() + '</a>';
}
function renderSidebar() {
  var pods = state.pods.map(function (p) {
    return '<a class="nav-item' + (state.pod && state.pod.id === p.id ? " active" : "") + '" href="#/pod/' + p.id + '/channels">' +
      '<span class="dot" style="background:' + esc(p.color) + '"></span>' + esc(p.name) +
      '<span class="nav-count">' + p.members + '</span></a>';
  }).join("");
  return '<div class="brand">Podium<span>.</span>' + alertBellHtml() + '</div>' +
    '<div class="nav-sec">Firm</div>' +
    '<a class="nav-item" href="#/home">Dashboard</a>' +
    '<a class="nav-item" href="#/pipeline">Pipeline</a>' +
    '<a class="nav-item" href="#/talent">Talent</a>' +
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
  var tabs = [["channels", "Channels"], ["pages", "Pages"], ["time", "Time"], ["tasks", "Tasks"], ["inbox", "Inbox"], ["objectives", "Objectives"]].map(function (t) {
    return '<div class="tab' + (tab === t[0] ? " active" : "") + '" onclick="location.hash=\'#/pod/' + pod.id + '/' + t[0] + '\'">' + t[1] + "</div>";
  }).join("");
  var mem = members.map(function (m) {
    return '<span class="pill" style="background:var(--sand);margin:2px 4px 2px 0" title="' + esc(m.role || "member") + '">' +
      esc(m.person_name) + ' <a href="#" onclick="return Podium.removeMember(\'' + pod.id + "','" + m.person_id + '\')" style="color:var(--muted);text-decoration:none" title="Remove">×</a></span>';
  }).join("");
  var allocRows = members.map(function (m) {
    return '<tr><td>' + esc(m.person_name) + '</td>' +
      '<td class="num"><input type="number" min="0" step="0.5" class="hours-input" style="max-width:90px" placeholder="auto" ' +
      'value="' + (m.allocated_hours == null ? "" : m.allocated_hours) + '" ' +
      'onchange="Podium.setAllocation(\'' + pod.id + "','" + m.person_id + '\', this.value)" title="Monthly hours — blank splits the retainer evenly"></td></tr>';
  }).join("");
  var allocTable = members.length
    ? '<table class="alloc-table" style="margin-top:10px"><tr><th>Exec</th><th class="num">Hours / month</th></tr>' + allocRows + '</table>' +
      '<div class="muted small">Blank = even split of the retainer cap. Hourly pods count 0 unless set.</div>'
    : "";
  var billing = (pod.billing_type === "retainer")
    ? '<span class="pill billable">retainer' + (pod.retainer_hours ? ' · ' + fmtHours(pod.retainer_hours) + '/mo' : '') + '</span>'
    : '<span class="pill nonbill">hourly</span>';
  return '<div class="view-head"><span class="dot" style="background:' + esc(pod.color) + ';width:16px;height:16px"></span>' +
    '<h1>' + esc(pod.name) + '</h1><span class="sub">' + esc(pod.client_name || "") + ' · ' + members.length + '/9 members</span> ' + billing +
    '<span style="flex:1"></span><button class="link-btn" onclick="Podium.editBilling(\'' + pod.id + '\')">Billing</button></div>' + flash() +
    viewRetainerBar(retainer) + viewTimerWidget(pod, members, timers) +
    '<div class="card"><h3>Members</h3><div>' + (mem || '<span class="muted">No members yet — add the pod\'s execs below.</span>') + '</div>' + allocTable +
    '<form onsubmit="return Podium.addMember(event,\'' + pod.id + '\')" style="margin-top:10px"><div class="form-row">' +
    '<select name="person_id" id="member-picker" required></select>' +
    '<input name="role" placeholder="Role in pod (e.g. Lead)" maxlength="40">' +
    '</div><div style="margin-top:10px"><button class="btn small" type="submit">Add member</button></div></form></div>' +
    viewMatchPortal(pod) +
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
      '<div class="msg-body">' + md(page.body_md) + '</div>' + viewSigningBanner(page, state.signing) + '</div>';
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
      '<td>' + blockPill(e.block_type) + '</td>' +
      '<td>' + esc(e.note || "") + '</td>' +
      '<td><button class="link-btn" onclick="Podium.editEntry(\'' + e.id + '\')">Edit</button> ' +
      '<button class="link-btn" onclick="Podium.deleteEntry(\'' + e.id + '\')">Delete</button></td></tr>';
  }).join("");
  return '<div class="card"><div class="row between"><h3 style="margin:0">Time — week of ' + esc(week) + '</h3>' +
    '<div class="seg-toggle"><button class="' + (state.valueLog ? "" : "active") + '" onclick="Podium.toggleValueLog(false)">Timesheet</button>' +
    '<button class="' + (state.valueLog ? "active" : "") + '" onclick="Podium.toggleValueLog(true)">Value log</button></div></div>' +
    (state.valueLog ? viewValueLog(entries) :
    '<div class="form-row" style="margin-bottom:10px;max-width:420px;margin-top:12px"><div><label>Person</label>' +
    '<select id="time-person" onchange="Podium.switchTimePerson(this.value)">' + opts + '</select></div>' +
    '<div><label>Week</label><input type="date" id="time-week" value="' + esc(week) + '" onchange="Podium.switchTimeWeek(this.value)"></div></div>' +
    '<div class="time-grid"><table class="tg-table"><tr><th>Pod</th>' + head + '</tr>' + (rows || '<tr><td colspan="8" class="muted">No pods</td></tr>') + '</table></div>' +
    '<div class="muted" style="margin-top:6px">Tap a day to log time.</div></div>' +
    '<div class="card"><h3>Log time</h3><form onsubmit="return Podium.saveEntry(event)">' +
    '<input type="hidden" name="id" id="entry-id"><div class="form-row">' +
    '<div><label>Day</label><input type="date" name="day" id="entry-day" value="' + esc(todayIso()) + '" required></div>' +
    '<div><label>Hours</label><input type="number" name="hours" id="entry-hours" step="0.25" min="0.25" max="24" required placeholder="4"></div>' +
    '<div><label>Billable</label><select name="billable" id="entry-billable"><option value="1">Billable</option><option value="0">Non-billable</option></select></div>' +
    '<div><label>Block type</label><select name="block_type" id="entry-block">' +
    '<option value="hours">Hours</option><option value="advisory">Advisory block</option>' +
    '<option value="sprint">Sprint (0.5-day)</option><option value="milestone">Milestone</option></select></div>' +
    '</div><label>Note</label><input name="note" id="entry-note" placeholder="What was this for?" maxlength="200">' +
    '<label>Key decisions / assets <span class="muted">— one per line</span></label>' +
    '<textarea name="decisions" id="entry-decisions" rows="2" maxlength="2000" placeholder="Approved the pricing change&#10;Shipped the onboarding flow"></textarea>' +
    '<div style="margin-top:10px"><button class="btn" type="submit">Save entry</button> <button class="btn ghost" type="button" onclick="Podium.resetEntryForm()">Clear</button></div></form></div>' +
    '<div class="card"><h3>Entries</h3><table><tr><th>Day</th><th>Pod</th><th class="num">Hours</th><th>Type</th><th>Block</th><th>Note</th><th></th></tr>' +
    (list || '<tr><td colspan="7" class="muted">No entries this week.</td></tr>') + '</table></div>');
}

/* Value log: the "value delivered" narrative — entries grouped by week with
   block-type pills and decision bullets. This is what the client sees. */
function blockPill(b) {
  var labels = { hours: "Hours", advisory: "Advisory", sprint: "Sprint", milestone: "Milestone" };
  return '<span class="pill block-' + esc(b || "hours") + '">' + esc(labels[b] || "Hours") + '</span>';
}
function viewValueLog(entries) {
  entries = entries || [];
  var weeks = {};
  entries.forEach(function (e) {
    var d = new Date(e.day + "T12:00:00");
    var monday = addDays(e.day, -((d.getDay() + 6) % 7));
    (weeks[monday] = weeks[monday] || []).push(e);
  });
  var keys = Object.keys(weeks).sort().reverse();
  var html = keys.map(function (w) {
    var items = weeks[w].map(function (e) {
      var bullets = String(e.decisions || "").split("\n").map(function (s) { return s.trim(); }).filter(Boolean);
      var dec = bullets.length ? '<ul class="dec-list">' + bullets.map(function (b) { return "<li>" + esc(b) + "</li>"; }).join("") + "</ul>" : "";
      return '<div class="vl-item"><div class="row between"><div>' + blockPill(e.block_type) +
        ' <b>' + fmtHours(e.hours) + '</b> <span class="muted">' + esc(e.day) + ' · ' + esc(e.pod_name || "") + '</span></div>' +
        '<button class="link-btn" onclick="Podium.editEntry(\'' + e.id + '\')">Edit</button></div>' +
        (e.note ? '<div>' + esc(e.note) + '</div>' : "") + dec + '</div>';
    }).join("");
    var tot = weeks[w].reduce(function (s, e) { return s + Number(e.hours); }, 0);
    return '<div class="card"><div class="row between"><h3 style="margin:0">Week of ' + esc(w) + '</h3>' +
      '<span class="muted">' + fmtHours(tot) + ' total</span></div>' + items + '</div>';
  }).join("");
  return '<div style="margin-top:12px">' + (html || '<div class="card"><div class="empty">No logged value in this range yet.</div></div>') + '</div>';
}

function viewPeople(people, weekHours) {
  weekHours = weekHours || {};
  var cc = state.conflictCounts || {};
  var rows = people.map(function (p) {
    var initials = p.name.split(/\s+/).map(function (w) { return w[0]; }).join("").slice(0, 2).toUpperCase();
    var cbadge = cc[p.id]
      ? '<button class="conflict-badge" onclick="Podium.showConflicts(\'' + p.id + '\')">⚠ ' + cc[p.id] + '</button> ' : "";
    var tags = (p.skills || []).slice(0, 4).map(function (s) { return '<span class="skill-tag">' + esc(s) + '</span>'; }).join("");
    return '<div class="person-row"><div class="avatar">' + esc(initials) + '</div>' +
      '<div class="who"><div class="nm">' + esc(p.name) + '</div><div class="ti">' + esc(p.title || "—") + (p.email ? " · " + esc(p.email) : "") + '</div>' +
      (tags ? '<div class="tags">' + tags + '</div>' : "") + '</div>' +
      '<div style="text-align:right"><div class="rate">' + money(p.hourly_rate_cents) + '/hr' +
      (p.rate_tier ? ' <span class="pill tier">' + esc(p.rate_tier) + '</span>' : "") + '</div>' +
      '<div class="muted">' + fmtHours(weekHours[p.id] || 0) + ' this week</div></div>' +
      '<div class="person-actions">' + cbadge +
      '<button class="link-btn" onclick="Podium.showConflicts(\'' + p.id + '\')">Conflicts</button>' +
      '<button class="link-btn" onclick="Podium.editPerson(\'' + p.id + '\')">Edit</button></div></div>';
  }).join("");
  return '<div class="view-head"><h1>People</h1><span class="sub">' + people.length + ' execs</span><span style="flex:1"></span>' +
    '<a class="link-btn" href="#/talent">Talent & capacity →</a></div>' + flash() +
    viewConflictsPanel(state.conflictsPanel) +
    '<div class="card">' + (rows || '<div class="empty">No people yet.</div>') + '</div>' +
    '<div class="card"><h3>Add person</h3><form onsubmit="return Podium.savePerson(event)">' +
    '<input type="hidden" name="id" id="person-id"><div class="form-row">' +
    '<div><label>Name</label><input name="name" id="person-name" required maxlength="60"></div>' +
    '<div><label>Title</label><input name="title" id="person-title" placeholder="Fractional CFO" maxlength="60"></div></div>' +
    '<div class="form-row"><div><label>Email</label><input name="email" id="person-email" type="email" maxlength="120"></div>' +
    '<div><label>Hourly rate (USD)</label><input name="rate" id="person-rate" type="number" min="0" step="1" placeholder="250"></div></div>' +
    '<div class="form-row"><div><label>Max hours / week (blank = unlimited)</label><input name="maxh" id="person-maxh" type="number" min="0" step="0.5" placeholder="20"></div>' +
    '<div><label>Rate tier</label><select name="tier" id="person-tier"><option value="">—</option>' +
    ["I", "II", "III", "$", "$$", "$$$"].map(function (t) { return '<option value="' + t + '">' + t + '</option>'; }).join("") +
    '</select></div></div>' +
    '<div style="margin-top:8px"><label>Skills (comma-separated)</label><input name="skills" id="person-skills" placeholder="fintech, turnaround, fundraising" maxlength="300"></div>' +
    '<div style="margin-top:8px"><label>Bio (shown on the client match page)</label><textarea name="bio" id="person-bio" rows="2" maxlength="600" placeholder="Two lines on background and edge."></textarea></div>' +
    '<div style="margin-top:10px"><button class="btn" type="submit">Save person</button> <button class="btn ghost" type="button" onclick="Podium.resetPersonForm()">Clear</button></div></form></div>';
}

/* ---------- talent & pod builder ---------- */
function talentLoadClass(pct) {
  if (pct == null) return "load-none";
  if (pct < 0.7) return "load-ok";
  if (pct <= 0.95) return "load-warn";
  return "load-over";
}
function viewTalent(cap, filter, sort) {
  filter = (filter || "").toLowerCase();
  sort = sort || "load";
  var list = cap.filter(function (c) {
    if (!filter) return true;
    var hay = (c.person_name + " " + (c.title || "") + " " + (c.skills || []).join(" ")).toLowerCase();
    return hay.indexOf(filter) >= 0;
  }).slice();
  if (sort === "name") list.sort(function (a, b) { return a.person_name.localeCompare(b.person_name); });
  else if (sort === "free") list.sort(function (a, b) {
    var fa = a.max_monthly_hours == null ? 1e12 : a.max_monthly_hours - a.allocated;
    var fb = b.max_monthly_hours == null ? 1e12 : b.max_monthly_hours - b.allocated;
    return fb - fa;
  });
  else list.sort(function (a, b) { return (b.load_pct == null ? -1 : b.load_pct) - (a.load_pct == null ? -1 : a.load_pct); });
  var rows = list.map(function (c) {
    var initials = c.person_name.split(/\s+/).map(function (w) { return w[0]; }).join("").slice(0, 2).toUpperCase();
    var loadHtml;
    if (c.max_monthly_hours == null) {
      loadHtml = '<div class="bar-row"><div class="bar-track"><div class="bar-fill load-none" style="width:100%"></div></div></div>' +
        '<div class="muted small">' + fmtHours(c.allocated) + ' allocated · no cap set</div>';
    } else {
      var pct = Math.min(1, c.load_pct || 0);
      loadHtml = '<div class="bar-row"><div class="bar-track"><div class="bar-fill ' + talentLoadClass(c.load_pct) +
        '" style="width:' + Math.round(pct * 100) + '%"></div></div>' +
        '<div class="load-num ' + talentLoadClass(c.load_pct) + '">' + Math.round((c.load_pct || 0) * 100) + '%</div></div>' +
        '<div class="muted small">' + fmtHours(c.allocated) + ' / ' + fmtHours(c.max_monthly_hours) + ' per month · ' +
        c.pod_count + ' pod' + (c.pod_count === 1 ? "" : "s") + '</div>';
    }
    var tags = (c.skills || []).map(function (s) { return '<span class="skill-tag">' + esc(s) + '</span>'; }).join("");
    var tier = c.rate_tier ? '<span class="pill tier">' + esc(c.rate_tier) + '</span>' : "";
    var cbadge = c.conflict_count
      ? '<button class="conflict-badge" onclick="Podium.showConflicts(\'' + c.person_id + '\')" title="Manage conflicts">⚠ ' +
        c.conflict_count + ' conflict' + (c.conflict_count === 1 ? "" : "s") + '</button>' : "";
    return '<div class="card talent-card"><div class="talent-top"><div class="avatar">' + esc(initials) + '</div>' +
      '<div class="who"><div class="nm">' + esc(c.person_name) + '</div>' +
      '<div class="ti">' + esc(c.title || "—") + '</div></div>' +
      '<div class="talent-meta">' + tier + cbadge + '</div></div>' +
      '<div class="talent-bar">' + loadHtml + '</div>' +
      (tags ? '<div class="tags">' + tags + '</div>' : '<div class="muted small">No skills tagged yet</div>') + '</div>';
  }).join("");
  return '<div class="view-head"><h1>Talent</h1><span class="sub">' + cap.length + ' execs</span><span style="flex:1"></span>' +
    '<a class="btn small" href="#/talent/builder">Pod builder</a></div>' + flash() +
    '<div class="card"><div class="form-row"><div><label>Filter by skill, name, or title</label>' +
    '<input id="talent-filter" placeholder="e.g. fintech" value="' + esc(state.talentFilter || "") +
    '" oninput="Podium.setTalentFilter(this.value)"></div>' +
    '<div><label>Sort</label><select id="talent-sort" onchange="Podium.setTalentSort(this.value)">' +
    '<option value="load"' + (sort === "load" ? " selected" : "") + '>Busiest first</option>' +
    '<option value="free"' + (sort === "free" ? " selected" : "") + '>Most free capacity</option>' +
    '<option value="name"' + (sort === "name" ? " selected" : "") + '>Name A–Z</option>' +
    '</select></div></div></div>' +
    (rows || '<div class="card"><div class="empty">No execs match that filter.</div></div>');
}
function viewBuilder(b) {
  var chips = (b.allSkills || []).map(function (s) {
    var on = ("," + (b.skills || "") + ",").toLowerCase().indexOf("," + s.toLowerCase() + ",") >= 0;
    return '<button type="button" class="skill-chip' + (on ? " on" : "") + '" onclick="Podium.toggleBuilderSkill(this)" data-skill="' +
      esc(s) + '">' + esc(s) + '</button>';
  }).join("");
  var tiers = ["", "I", "II", "III", "$", "$$", "$$$"].map(function (t) {
    return '<option value="' + t + '"' + (b.budget === t ? " selected" : "") + '>' + (t || "No preference") + '</option>';
  }).join("");
  var results;
  if (!b.suggestions) {
    results = '<div class="card"><div class="empty">Run a search to rank the firm\'s execs against the client need.</div></div>';
  } else if (!b.suggestions.length) {
    results = '<div class="card"><div class="empty">No execs available — try fewer skills or a different company.</div></div>';
  } else {
    var picked = Object.keys(b.picked || {}).filter(function (k) { return b.picked[k]; });
    var each = b.hoursEach !== "" && b.hoursEach != null
      ? Number(b.hoursEach)
      : (picked.length ? Math.round(b.hours / picked.length * 10) / 10 : b.hours);
    results = b.suggestions.map(function (s) {
      var isOn = !!b.picked[s.person_id];
      var tags = (s.skills || []).map(function (t) { return '<span class="skill-tag">' + esc(t) + '</span>'; }).join("");
      var reasons = s.reasons.map(function (r) { return '<li>' + esc(r) + '</li>'; }).join("");
      return '<label class="card builder-pick' + (isOn ? " on" : "") + '">' +
        '<input type="checkbox"' + (isOn ? " checked" : "") + ' onchange="Podium.toggleBuilderPick(\'' + s.person_id + '\')">' +
        '<div class="builder-body"><div class="builder-top"><b>' + esc(s.person_name) + '</b> ' +
        '<span class="score-pill">' + s.score + ' pts</span>' +
        (s.rate_tier ? '<span class="pill tier">' + esc(s.rate_tier) + '</span>' : "") + '</div>' +
        '<div class="muted small">' + esc(s.title || "—") + (s.free_hours == null
          ? " · unlimited capacity" : " · " + fmtHours(s.free_hours) + " free") + '</div>' +
        '<div class="tags">' + tags + '</div>' +
        '<ul class="reasons">' + reasons + '</ul>' +
        '<div class="muted small">' + s.breakdown.map(esc).join(" · ") + '</div></div></label>';
    }).join("");
    results += '<div class="card builder-cta"><div class="form-row"><div><label>Hours each / month</label>' +
      '<input type="number" min="0" step="0.5" value="' + (b.hoursEach === "" ? each : esc(b.hoursEach)) +
      '" oninput="Podium.builderField(\'hoursEach\', this.value)"></div>' +
      '<div style="align-self:end"><button class="btn" ' + (picked.length ? "" : "disabled") +
      ' onclick="Podium.createBuiltPod()">Create pod' + (picked.length ? " (" + picked.length + ")" : "") + '</button></div></div>' +
      '<div class="muted small">Creates "' + esc(b.company || "…") + ' Pod" with ' + picked.length + ' exec' +
      (picked.length === 1 ? "" : "s") + ' at ' + fmtHours(each) + '/month each.</div></div>';
  }
  return '<div class="view-head"><h1>Pod builder</h1><span class="sub">Match execs to a client need</span>' +
    '<span style="flex:1"></span><a class="link-btn" href="#/talent">← Talent</a></div>' + flash() +
    '<div class="card"><h3>Client need</h3>' +
    '<div class="form-row"><div><label>Client company</label>' +
    '<input value="' + esc(b.company) + '" placeholder="Acme Foods" oninput="Podium.builderField(\'company\', this.value)"></div>' +
    '<div><label>Target hours / month</label>' +
    '<input type="number" min="0" step="1" value="' + esc(b.hours) + '" oninput="Podium.builderField(\'hours\', this.value)"></div></div>' +
    '<div class="form-row"><div><label>Required skills (comma-separated)</label>' +
    '<input value="' + esc(b.skills) + '" placeholder="fintech, turnaround" oninput="Podium.builderField(\'skills\', this.value)"></div>' +
    '<div><label>Budget tier (display only)</label><select onchange="Podium.builderField(\'budget\', this.value)">' + tiers + '</select></div></div>' +
    (chips ? '<div class="tags" style="margin-top:8px">' + chips + '</div>' : "") +
    '<div style="margin-top:12px"><button class="btn" onclick="Podium.runBuilderSuggest()">Find matches</button></div></div>' +
    results;
}
/* conflicts panel (lives on the People view) */
function viewConflictsPanel(panel) {
  if (!panel) return "";
  var rows = panel.list.map(function (c) {
    return '<div class="page-item"><div class="t">' + esc(c.company) + '</div>' +
      (c.reason ? '<div class="muted small">' + esc(c.reason) + '</div>' : "") +
      '<button class="link-btn" onclick="Podium.removeConflict(\'' + panel.person.id + "','" + c.id + '\')">Remove</button></div>';
  }).join("");
  return '<div class="card"><div class="view-head"><h3 style="margin:0">Conflicts — ' + esc(panel.person.name) +
    '</h3><span style="flex:1"></span><button class="link-btn" onclick="Podium.closeConflicts()">Close</button></div>' +
    (rows || '<div class="muted">None on file.</div>') +
    '<form onsubmit="return Podium.addConflict(event,\'' + panel.person.id + '\')" style="margin-top:10px"><div class="form-row">' +
    '<div><label>Company</label><input name="company" required maxlength="80" placeholder="Rival Inc"></div>' +
    '<div><label>Reason (optional)</label><input name="reason" maxlength="300" placeholder="Board seat"></div>' +
    '</div><div style="margin-top:10px"><button class="btn small" type="submit">Add conflict</button></div></form></div>';
}
/* client match portal card (lives on the pod view) */
function viewMatchPortal(pod) {
  var h = '<div class="card"><h3>Client match portal</h3>';
  if (pod.match_visible && pod.match_slug) {
    var url = (typeof location !== "undefined" ? location.origin : "") + "/match/" + pod.match_slug;
    h += '<div class="muted small">Live — clients see anonymized profiles (no full names, emails, or dollar rates).</div>' +
      '<div class="form-row" style="margin-top:8px"><input id="match-url" readonly value="' + esc(url) + '" onclick="this.select()"></div>' +
      '<div style="margin-top:8px"><button class="btn small" onclick="Podium.copyMatchLink()">Copy link</button> ' +
      '<button class="btn small ghost" onclick="Podium.revokeMatchLink(\'' + pod.id + '\')">Revoke</button></div>';
  } else {
    h += '<div class="muted small">Generate a public link so the client can meet this pod — anonymized profiles only.</div>';
  }
  h += '<div style="margin-top:10px"><label>Client-need summary (shown on the page)</label>' +
    '<textarea id="match-blurb" maxlength="500" rows="2" placeholder="e.g. Series A fintech — needs CFO + COO, ~30h/mo">' +
    esc(pod.match_blurb || "") + '</textarea></div>' +
    '<div style="margin-top:8px"><button class="btn small" onclick="Podium.enableMatchLink(\'' + pod.id + '\')">' +
    (pod.match_visible ? "Update summary" : "Enable match link") + '</button></div></div>';
  return h;
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
    '<div class="card"><h3>ClickUp</h3><form onsubmit="return Podium.saveSettings(event,\'clickup\')">' +
    '<div class="form-row">' + secretRow("clickup_token", "Personal token") + '</div>' +
    '<div style="margin-top:10px;display:flex;gap:8px"><button class="btn small" type="submit">Save</button>' +
    '<button class="btn small ghost" type="button" onclick="Podium.testClickup()">Verify token</button></div>' +
    '<p class="muted">Link a ClickUp list per pod under its Tasks tab. Create a personal token in ClickUp under Settings → Apps.</p></form></div>' +
    '<div class="card"><h3>Mailbox (IMAP)</h3><form onsubmit="return Podium.saveSettings(event,\'imap\')">' +
    '<div class="form-row">' + textRow("imap_host", "IMAP host", "mail.example.com") + textRow("imap_port", "Port", "993") + '</div>' +
    '<div class="form-row">' + textRow("imap_user", "Username") + secretRow("imap_pass", "Password") + '</div>' +
    '<div style="margin-top:10px;display:flex;gap:8px"><button class="btn small" type="submit">Save</button>' +
    '<button class="btn small ghost" type="button" onclick="Podium.testImap()">Test connection</button></div>' +
    '<p class="muted">Powers each pod\'s Inbox tab — the latest thread with every member. Read-only: never marks mail seen. Uses the same zero-dep IMAP client as Relay.</p></form></div>' +
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
    var stopRow;
    if (state.stopTimerFor === running.person_id) {
      stopRow = '<div class="stop-confirm"><div class="form-row"><div><label>Block type</label><select id="stop-block">' +
        '<option value="hours">Hours</option><option value="advisory">Advisory block</option>' +
        '<option value="sprint">Sprint (0.5-day)</option><option value="milestone">Milestone</option></select></div></div>' +
        '<label>Key decisions / assets <span class="muted">— one per line</span></label>' +
        '<textarea id="stop-decisions" rows="2" maxlength="2000" placeholder="What got decided or shipped?"></textarea>' +
        '<div style="margin-top:8px;display:flex;gap:8px"><button class="btn small" onclick="Podium.confirmStopTimer(\'' + running.person_id + '\')">Log time</button>' +
        '<button class="btn small ghost" onclick="Podium.cancelStopTimer()">Back</button></div></div>';
    } else {
      stopRow = '<button class="btn small danger" onclick="Podium.stopTimer(\'' + running.person_id + '\')">Stop</button>';
    }
    inner = '<div class="timer-running"><span class="pulse"></span><b>' + esc(running.person_name || "Timer") + '</b>' +
      '<span class="timer-el">' + mm + ':' + String(ss).padStart(2, "0") + '</span>' + stopRow + '</div>';
  } else {
    inner = '<div class="timer-idle"><select id="timer-person">' + opts + '</select>' +
      '<input id="timer-note" placeholder="What are you working on?" maxlength="200">' +
      '<button class="timer-btn" onclick="Podium.startTimer(\'' + pod.id + '\')">▶ Start</button></div>';
  }
  return '<div class="timer-widget">' + inner + '</div>';
}

/* ---------- pod tasks (ClickUp) ---------- */
function viewTasks(pod, tasks, err) {
  var listId = pod.clickup_list_id || "";
  var head = '<div class="card"><h3>ClickUp list</h3>' +
    '<form onsubmit="return Podium.setClickupList(event,\'' + pod.id + '\')"><div class="form-row">' +
    '<input name="list_id" placeholder="ClickUp list ID" value="' + esc(listId) + '" maxlength="60">' +
    '</div><div style="margin-top:10px"><button class="btn small" type="submit">Link list</button> ' +
    '<span class="muted">Find it in the ClickUp URL when a list is open.</span></div></form></div>';
  if (err) {
    var hint = /not connected/i.test(err)
      ? ' <a href="#/settings">Add your ClickUp token in Settings</a>.'
      : /no clickup list/i.test(err) ? ' Link a list above.' : '';
    return head + '<div class="card"><div class="empty">' + esc(err) + '.' + hint + '</div></div>';
  }
  var rows = (tasks || []).map(function (t) {
    var done = t.status_type === "done" || t.status_type === "closed";
    var due = t.due_date ? new Date(t.due_date).toLocaleDateString() : "—";
    var who = (t.assignees || []).map(function (a) { return esc(a.username || a.email); }).join(", ");
    return '<div class="task-row' + (done ? " is-done" : "") + '">' +
      '<button class="task-check' + (done ? " on" : "") + '" onclick="Podium.toggleTask(\'' + pod.id + "','" + t.id + '\',' + (!done) + ')" title="' + (done ? "done" : "mark done") + '"></button>' +
      '<div class="task-main"><div class="task-name">' + esc(t.name) + '</div>' +
      '<div class="task-meta"><span class="pill" style="background:' + esc(t.status_color || "var(--sand)") + '22;color:var(--ink)">' + esc(t.status) + '</span>' +
      ' <span class="muted">due ' + esc(due) + (who ? ' · ' + who : '') + '</span>' +
      (t.url ? ' <a href="' + esc(t.url) + '" target="_blank" rel="noopener" class="link-btn">Open in ClickUp</a>' : '') + '</div></div></div>';
  }).join("");
  return head +
    '<div class="card"><div class="row between"><h3>Tasks</h3><span class="muted">' + (tasks || []).length + ' in list</span></div>' +
    (rows || '<div class="empty">No tasks yet — add the first one below.</div>') + '</div>' +
    '<div class="card"><h3>New task</h3>' +
    '<form onsubmit="return Podium.createTask(event,\'' + pod.id + '\')">' +
    '<label>Title</label><input name="name" required maxlength="120" placeholder="What needs doing?">' +
    '<div class="form-row"><div><label>Due date</label><input name="due_date" type="date"></div>' +
    '<div><label>Description</label><input name="description" maxlength="500" placeholder="Optional"></div></div>' +
    '<div style="margin-top:10px"><button class="btn" type="submit">Add task</button></div></form></div>';
}

/* ---------- pod inbox (IMAP) ---------- */
function viewInbox(pod, inbox, loading) {
  var head = '<div class="row between" style="margin-bottom:14px"><div><h3 style="margin:0">Recent email with members</h3>' +
    '<div class="muted">Latest thread with each pod member, via IMAP.</div></div>' +
    '<button class="btn small ghost" onclick="Podium.refreshInbox(\'' + pod.id + '\')">Refresh</button></div>';
  if (loading) return head + '<div class="card"><div class="empty">Checking the mailbox…</div></div>';
  inbox = inbox || { items: [] };
  if (inbox.error) {
    var isCfg = /not configured/i.test(inbox.error);
    return head + '<div class="card"><div class="empty">' + esc(inbox.error) + '.' +
      (isCfg ? ' <a href="#/settings">Add your mailbox in Settings</a>.' : '') + '</div></div>';
  }
  var items = inbox.items || [];
  var stamp = inbox.cached && inbox.cachedAt ? '<div class="muted" style="margin-bottom:10px">Cached ' + esc(timeAgo(inbox.cachedAt)) + ' — refresh for the latest.</div>' : '';
  var rows = items.map(function (m) {
    var dir = m.direction === "out" ? "you → " : "";
    return '<div class="card inbox-item" id="inbox-' + esc(m.uid) + '">' +
      '<div class="inbox-top"><b>' + esc(m.person_name) + '</b> <span class="muted">' + esc(m.email) + '</span></div>' +
      '<div class="inbox-subj">' + esc(dir) + esc(m.subject || "(no subject)") + '</div>' +
      '<div class="muted">' + esc(m.from) + ' · ' + esc(timeAgo(m.date)) + '</div>' +
      '<div class="inbox-snip">' + esc(m.snippet) + '</div>' +
      '<div class="inbox-body" style="display:none"></div>' +
      '<button class="link-btn" onclick="Podium.toggleInboxBody(\'' + pod.id + "','" + esc(m.uid) + '\')">Read full email</button></div>';
  }).join("");
  return head + stamp + (rows || '<div class="card"><div class="empty">No recent email with pod members.</div></div>');
}

/* ---------- objectives & key results ---------- */
function objStatusPill(s) {
  var cls = s === "done" ? "open" : s === "at_risk" ? "closed" : "billable";
  var label = s === "on_track" ? "On track" : s === "at_risk" ? "At risk" : "Done";
  return '<span class="pill ' + cls + '">' + label + '</span>';
}
function viewObjectives(pod, objectives) {
  objectives = objectives || [];
  var cards = objectives.map(function (o) {
    var krs = (o.key_results || []).map(function (k) {
      return '<div class="kr-row"><div class="kr-main"><b>' + esc(k.title) + '</b>' +
        '<div class="muted">' + esc(k.current || "—") + (k.target ? ' <span class="muted">/ target ' + esc(k.target) + '</span>' : '') + '</div></div>' +
        '<button class="link-btn" onclick="Podium.editKeyResult(\'' + k.id + '\',\'' + esc(k.title) + '\',\'' + esc(k.current) + '\',\'' + esc(k.target) + '\')">Edit</button> ' +
        '<button class="link-btn" onclick="Podium.deleteKeyResult(\'' + k.id + '\')">Delete</button></div>';
    }).join("");
    var bar = '<div class="bar-track"><div class="bar-fill obj-fill" style="width:' + o.progress_pct + '%"></div></div>';
    return '<div class="card obj-card"><div class="row between"><div><h3 style="margin:0">' + esc(o.title) + '</h3>' +
      '<div class="muted">' + esc(o.period || "no period") + '</div></div>' + objStatusPill(o.status) + '</div>' +
      '<div class="bar-row" style="margin:12px 0 4px">' + bar + '<div class="bar-val">' + o.progress_pct + '%</div></div>' +
      '<form class="obj-progress" onsubmit="return Podium.saveObjectiveProgress(event,\'' + o.id + '\')">' +
      '<input type="range" name="progress_pct" min="0" max="100" value="' + o.progress_pct + '" oninput="this.nextElementSibling.value=this.value+\'%\'">' +
      '<output>' + o.progress_pct + '%</output> ' +
      '<select name="status"><option value="on_track"' + (o.status === "on_track" ? " selected" : "") + '>On track</option>' +
      '<option value="at_risk"' + (o.status === "at_risk" ? " selected" : "") + '>At risk</option>' +
      '<option value="done"' + (o.status === "done" ? " selected" : "") + '>Done</option></select> ' +
      '<button class="btn small" type="submit">Update</button> ' +
      '<button class="link-btn" type="button" onclick="Podium.deleteObjective(\'' + o.id + '\')">Delete</button></form>' +
      '<div class="kr-list">' + (krs || '<div class="muted">No key results yet.</div>') + '</div>' +
      '<form class="kr-add" onsubmit="return Podium.saveKeyResult(event,\'' + o.id + '\')">' +
      '<input name="title" placeholder="Key result…" required maxlength="200"> ' +
      '<input name="current" placeholder="Current" maxlength="200" style="max-width:140px"> ' +
      '<input name="target" placeholder="Target" maxlength="200" style="max-width:140px"> ' +
      '<button class="btn small ghost" type="submit">+ KR</button></form></div>';
  }).join("");
  return '<div class="view-head"><h1>Objectives</h1><span class="sub">Value delivered, not hours worked</span></div>' + flash() +
    (cards || '<div class="card"><div class="empty">No objectives yet — set the pod\'s quarterly bets.</div></div>') +
    '<div class="card"><h3>New objective</h3><form onsubmit="return Podium.saveObjective(event,\'' + pod.id + '\')">' +
    '<div class="form-row"><div><label>Title</label><input name="title" required maxlength="200" placeholder="e.g. Cut monthly burn below $180k"></div>' +
    '<div style="max-width:140px"><label>Period</label><input name="period" placeholder="2026-Q4" maxlength="12"></div></div>' +
    '<div style="margin-top:10px"><button class="btn" type="submit">Add objective</button></div></form></div>';
}

/* ---------- scope-drift alerts ---------- */
function viewAlerts(alerts) {
  alerts = alerts || [];
  var rows = alerts.map(function (a) {
    return '<div class="card alert-card' + (a.seen ? "" : " alert-unseen") + '">' +
      '<div class="row between"><b>' + esc(a.pod_name || "Pod") + '</b>' +
      '<span class="muted">' + esc(timeAgo(a.created_at)) + '</span></div>' +
      '<div style="margin:8px 0">' + esc(a.message) + '</div>' +
      (a.seen ? '<span class="muted">Seen</span>'
        : '<button class="btn small ghost" onclick="Podium.markAlertSeen(\'' + a.id + '\')">Mark seen</button>') +
      '</div>';
  }).join("");
  return '<div class="view-head"><h1>Alerts</h1><span class="sub">Scope drift & retainer warnings</span></div>' + flash() +
    (rows || '<div class="card"><div class="empty">All quiet — no alerts.</div></div>');
}

/* ---------- page signing banner ---------- */
function viewSigningBanner(page, signing) {
  if (!signing) {
    return '<div style="margin-top:12px"><button class="btn small ghost" onclick="Podium.showSigningForm()">Send for signature</button></div>' +
      (state.showSigningForm ?
        '<form class="card" style="margin-top:10px;background:var(--paper)" onsubmit="return Podium.createSigning(event,\'' + page.id + '\')">' +
        '<h3 style="margin-top:0">Send for signature</h3>' +
        '<div class="form-row"><div><label>Signer name</label><input name="signer_name" required maxlength="120" placeholder="Client name"></div>' +
        '<div><label>Signer email</label><input name="signer_email" type="email" required maxlength="160" placeholder="client@company.com"></div></div>' +
        '<div style="margin-top:10px;display:flex;gap:8px"><button class="btn small" type="submit">Create signing link</button>' +
        '<button class="btn small ghost" type="button" onclick="Podium.showSigningForm(false)">Cancel</button></div></form>' : '');
  }
  if (signing.status === "signed") {
    return '<div class="sign-banner signed"><b>Signed</b> by ' + esc(signing.signer_name) + ' · ' + esc(timeAgo(signing.signed_at)) +
      '<div class="muted mono">hash ' + esc((signing.signature_hash || "").slice(0, 16)) + '…</div></div>';
  }
  return '<div class="sign-banner pending"><b>Awaiting signature</b> — ' + esc(signing.signer_name) + ' &lt;' + esc(signing.signer_email) + '&gt;' +
    '<div class="muted">Signing link: <a href="/sign/' + esc(signing.token) + '">/sign/' + esc(signing.token).slice(0, 12) + '…</a></div>' +
    '<div style="margin-top:8px"><button class="link-btn" onclick="Podium.revokeSigning(\'' + page.id + '\')">Revoke</button></div></div>';
}

/* ---------- render orchestration ---------- */
function currentView() {  var h = (location.hash || "#/home").replace(/^#/, "");
  return (h.split("/").filter(Boolean)[0] || "home");
}
function render() {
  var v = currentView();
  var parts = currentViewParts();
  document.getElementById("sidebar").innerHTML = renderSidebar();
  var abf = document.getElementById("alertbell-float");
  if (abf && abf.style) { abf.innerHTML = alertBellInner(); abf.style.display = ""; }
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
    else if (tab === "tasks") el.innerHTML = head + viewTasks(state.pod, state.tasks, state.tasksErr);
    else if (tab === "inbox") el.innerHTML = head + viewInbox(state.pod, state.inbox, state.inboxLoading);
    else if (tab === "objectives") el.innerHTML = head + viewObjectives(state.pod, state.objectives);
    fillMemberPicker();
  }
  else if (v === "people") el.innerHTML = viewPeople(state.people, state.weekHours || {});
  else if (v === "talent") el.innerHTML = parts[1] === "builder" ? viewBuilder(state.builder || freshBuilder()) : viewTalent(state.talent || [], state.talentFilter, state.talentSort);
  else if (v === "payroll") el.innerHTML = viewPayroll(state.periods, state.period);
  else if (v === "pipeline") el.innerHTML = parts[1] === "top20" ? viewTop20(state.top20) : viewPipeline(state.pipeline);
  else if (v === "lead" && state.lead) el.innerHTML = viewLead(state.lead, state.partners, state.leadBookings);
  else if (v === "schedule") el.innerHTML = viewSchedule({ bookings: state.bookings, people: state.people, availability: state.availability });
  else if (v === "invoices") el.innerHTML = viewInvoices(state.invoices, state.invoice, state.pods);
  else if (v === "settings") el.innerHTML = viewSettings(state.settings, state.templates);
  else if (v === "alerts") el.innerHTML = viewAlerts(state.alerts);
  else el.innerHTML = viewHome(state.dash);
  if (state.editingPage) Podium.previewPage();
  labelTables(document.getElementById("view"));
  updateTimerPill();
}

function currentViewParts() {
  return ((location.hash || "#/home").replace(/^#/, "").split("/").filter(Boolean));
}
/* Copy each table's header text into its cells' data-label, so the
   mobile-first stylesheet can restack tables as labeled cards. */
function labelTables(root) {
  if (!root || !root.querySelectorAll) return;
  root.querySelectorAll("table").forEach(function (t) {
    var heads = [];
    t.querySelectorAll("tr").forEach(function (tr) {
      var ths = tr.querySelectorAll("th");
      if (ths.length && !heads.length) {
        heads = Array.prototype.map.call(ths, function (th) { return (th.textContent || "").trim(); });
      } else {
        Array.prototype.forEach.call(tr.querySelectorAll("td"), function (td, ci) {
          if (heads[ci]) td.setAttribute("data-label", heads[ci]);
        });
      }
    });
  });
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
  viewTasks: viewTasks, viewInbox: viewInbox, labelTables: labelTables, timeAgo: timeAgo,
  viewTalent: viewTalent, viewBuilder: viewBuilder, viewMatchPortal: viewMatchPortal,
  freshBuilder: freshBuilder, talentLoadClass: talentLoadClass,
  viewObjectives: viewObjectives, viewAlerts: viewAlerts, viewValueLog: viewValueLog,
  viewSigningBanner: viewSigningBanner, blockPill: blockPill,

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
    Promise.all([
      api("GET", "/api/pages/" + id),
      api("GET", "/api/pages/" + id + "/signing"),
    ]).then(function (r) {
      state.page = r[0].page; state.signing = r[1].signing; state.showSigningForm = false; state.editingPage = false; render();
    }).catch(function (e) { setErr(e.message); });
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
    document.getElementById("entry-block").value = "hours";
    document.getElementById("entry-decisions").value = "";
  },
  saveEntry: function (e) {
    e.preventDefault();
    var f = e.target, id = f.id.value;
    var body = { pod_id: state.pod.id, person_id: state.timePerson, day: f.day.value, hours: Number(f.hours.value), note: f.note.value, billable: Number(f.billable.value), block_type: f.block_type.value, decisions: f.decisions.value };
    var p = id ? api("PUT", "/api/time/" + id, body) : api("POST", "/api/time", body);
    p.then(function (r) {
      Podium.resetEntryForm(); loadTimeTab();
      setOk("Time saved." + (r && r.alert ? " Scope alert: " + r.alert.kind + "." : ""));
    }).catch(function (er) { setErr(er.message); });
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
    document.getElementById("entry-block").value = e.block_type || "hours";
    document.getElementById("entry-decisions").value = e.decisions || "";
    document.getElementById("entry-day").scrollIntoView({ block: "center" });
  },
  toggleValueLog: function (on) {
    state.valueLog = on;
    loadTimeTab();
  },
  deleteEntry: function (id) {
    if (!confirm("Delete this entry?")) return;
    api("DELETE", "/api/time/" + id).then(function () { loadTimeTab(); }).catch(function (er) { setErr(er.message); });
  },
  savePerson: function (e) {
    e.preventDefault();
    var f = e.target, id = f.id.value;
    var body = {
      name: f.name.value, title: f.title.value, email: f.email.value,
      hourly_rate_cents: Math.round(Number(f.rate.value || 0) * 100),
      max_weekly_hours: f.maxh.value === "" ? null : Number(f.maxh.value),
      skills: f.skills.value, rate_tier: f.tier.value, bio: f.bio.value,
    };
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
    document.getElementById("person-maxh").value = pe.max_weekly_hours == null ? "" : pe.max_weekly_hours;
    document.getElementById("person-tier").value = pe.rate_tier || "";
    document.getElementById("person-skills").value = (pe.skills || []).join(", ");
    document.getElementById("person-bio").value = pe.bio || "";
    document.getElementById("person-name").scrollIntoView({ block: "center" });
  },
  resetPersonForm: function () {
    ["person-id", "person-name", "person-title", "person-email", "person-rate", "person-maxh", "person-tier", "person-skills", "person-bio"]
      .forEach(function (i) { var el = document.getElementById(i); if (el) el.value = ""; });
  },

  /* ----- talent ----- */
  setTalentFilter: function (v) { state.talentFilter = v; render(); var el = document.getElementById("talent-filter"); if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } },
  setTalentSort: function (v) { state.talentSort = v; render(); },
  builderField: function (k, v) { if (!state.builder) state.builder = freshBuilder(); state.builder[k] = v; },
  toggleBuilderSkill: function (btn) {
    var s = btn.getAttribute("data-skill") || "";
    if (!state.builder) state.builder = freshBuilder();
    var cur = ("," + (state.builder.skills || "") + ",").toLowerCase();
    var key = "," + s.toLowerCase() + ",";
    var parts = (state.builder.skills || "").split(",").map(function (x) { return x.trim(); }).filter(Boolean);
    if (cur.indexOf(key) >= 0) parts = parts.filter(function (x) { return x.toLowerCase() !== s.toLowerCase(); });
    else parts.push(s);
    state.builder.skills = parts.join(", ");
    render();
  },
  runBuilderSuggest: function () {
    if (!state.builder) state.builder = freshBuilder();
    var b = state.builder;
    if (!b.company.trim()) { setErr("Enter the client company first."); return; }
    api("POST", "/api/pod-builder/suggest", { skills: b.skills, hours: Number(b.hours) || 0, exclude_company: b.company })
      .then(function (r) { b.suggestions = r.suggestions; render(); setOk(b.suggestions.length + " execs ranked."); })
      .catch(function (er) { setErr(er.message); });
  },
  toggleBuilderPick: function (id) {
    if (!state.builder) return;
    state.builder.picked[id] = !state.builder.picked[id];
    render();
  },
  createBuiltPod: function () {
    var b = state.builder;
    if (!b || !b.company.trim()) { setErr("Enter the client company first."); return; }
    var picked = Object.keys(b.picked).filter(function (k) { return b.picked[k]; });
    if (!picked.length) { setErr("Pick at least one exec."); return; }
    var each = b.hoursEach !== "" && b.hoursEach != null
      ? Number(b.hoursEach)
      : Math.round((Number(b.hours) || 0) / picked.length * 10) / 10;
    api("POST", "/api/pod-builder/create", {
      company: b.company.trim(),
      allocations: picked.map(function (id) { return { person_id: id, allocated_hours: each }; }),
    }).then(function (r) {
      state.builder = freshBuilder();
      location.hash = "#/pod/" + r.pod.id + "/channels";
      setOk("Pod created.");
    }).catch(function (er) { setErr(er.message); });
  },

  /* ----- conflicts ----- */
  showConflicts: function (personId) {
    var pe = (state.people || []).find(function (x) { return x.id === personId; }) ||
      (state.talent || []).find(function (x) { return x.person_id === personId; });
    var person = pe ? { id: pe.id || pe.person_id, name: pe.name || pe.person_name } : { id: personId, name: "Exec" };
    api("GET", "/api/people/" + personId + "/conflicts").then(function (r) {
      state.conflictsPanel = { person: person, list: r.conflicts };
      if (currentView() !== "people") location.hash = "#/people";
      else render();
    }).catch(function (er) { setErr(er.message); });
  },
  closeConflicts: function () { state.conflictsPanel = null; render(); },
  addConflict: function (e, personId) {
    e.preventDefault();
    var f = e.target;
    api("POST", "/api/people/" + personId + "/conflicts", { company: f.company.value, reason: f.reason.value })
      .then(function () { f.reset(); Podium.showConflicts(personId); setOk("Conflict recorded."); })
      .catch(function (er) { setErr(er.message); });
    return false;
  },
  removeConflict: function (personId, cid) {
    if (!confirm("Remove this conflict?")) return;
    api("DELETE", "/api/people/" + personId + "/conflicts/" + cid)
      .then(function () { Podium.showConflicts(personId); })
      .catch(function (er) { setErr(er.message); });
  },

  /* ----- allocations ----- */
  setAllocation: function (podId, personId, v) {
    var hours = v === "" ? null : Number(v);
    api("PUT", "/api/pods/" + podId + "/members/" + personId, { allocated_hours: hours })
      .then(function () { loadPod(podId, state.podTab || "channels"); })
      .catch(function (er) { setErr(er.message); });
  },

  /* ----- match portal ----- */
  enableMatchLink: function (podId) {
    var blurb = document.getElementById("match-blurb");
    api("POST", "/api/pods/" + podId + "/match-link", { blurb: blurb ? blurb.value : "" })
      .then(function () { loadPod(podId, state.podTab || "channels"); setOk("Match link live."); })
      .catch(function (er) { setErr(er.message); });
  },
  revokeMatchLink: function (podId) {
    if (!confirm("Revoke the client match link? Clients will see a 404.")) return;
    api("DELETE", "/api/pods/" + podId + "/match-link")
      .then(function () { loadPod(podId, state.podTab || "channels"); setOk("Match link revoked."); })
      .catch(function (er) { setErr(er.message); });
  },
  copyMatchLink: function () {
    var el = document.getElementById("match-url");
    if (!el) return;
    el.select();
    try { document.execCommand("copy"); setOk("Link copied."); }
    catch (e) { setErr("Copy failed — select the link manually."); }
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
    state.stopTimerFor = personId;
    render();
    var d = document.getElementById("stop-decisions");
    if (d) d.focus();
  },
  cancelStopTimer: function () {
    state.stopTimerFor = null;
    render();
  },
  confirmStopTimer: function (personId) {
    var bt = document.getElementById("stop-block"), dc = document.getElementById("stop-decisions");
    var body = { person_id: personId };
    if (bt) body.block_type = bt.value;
    if (dc) body.decisions = dc.value;
    api("POST", "/api/timer/stop", body)
      .then(function (r) {
        state.stopTimerFor = null;
        loadPod(state.pod.id, state.podTab || "channels");
        setOk("Logged " + r.hours + "h." + (r.alert ? " Scope alert: " + r.alert.kind + "." : ""));
      })
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
  testClickup: function () {
    api("POST", "/api/integrations/clickup/test", {})
      .then(function (r) { setOk("ClickUp connected — hello, " + r.user.username + "."); })
      .catch(function (er) { setErr(er.message); });
  },
  testImap: function () {
    api("POST", "/api/integrations/imap/test", {})
      .then(function () { setOk("Mailbox connected — login succeeded."); })
      .catch(function (er) { setErr(er.message); });
  },
  setClickupList: function (e, podId) {
    e.preventDefault();
    var v = e.target.list_id.value.trim();
    api("PUT", "/api/pods/" + podId + "/clickup-list", { list_id: v })
      .then(function () { loadPod(podId, "tasks"); setOk(v ? "ClickUp list linked." : "ClickUp list unlinked."); })
      .catch(function (er) { setErr(er.message); });
    return false;
  },
  createTask: function (e, podId) {
    e.preventDefault();
    var f = e.target;
    api("POST", "/api/pods/" + podId + "/tasks", {
      name: f.name.value, description: f.description.value, due_date: f.due_date.value || null,
    }).then(function () { loadPod(podId, "tasks"); setOk("Task created in ClickUp."); })
      .catch(function (er) { setErr(er.message); });
    return false;
  },
  toggleTask: function (podId, taskId, close) {
    if (!close) { setErr("Reopening a task must be done in ClickUp for now."); return; }
    api("POST", "/api/pods/" + podId + "/tasks/" + taskId + "/close", {})
      .then(function () { loadPod(podId, "tasks"); })
      .catch(function (er) { setErr(er.message); });
  },
  refreshInbox: function (podId) {
    api("POST", "/api/pods/" + podId + "/inbox/refresh", {})
      .then(function (r) { state.inbox = r; state.inboxLoading = false; render(); setOk("Inbox refreshed."); })
      .catch(function (er) { setErr(er.message); });
  },
  toggleInboxBody: function (podId, uid) {
    var card = document.getElementById("inbox-" + uid);
    if (!card) return;
    var body = card.querySelector(".inbox-body");
    var btn = card.querySelector(".link-btn");
    if (body.style.display !== "none") { body.style.display = "none"; body.innerHTML = ""; if (btn) btn.textContent = "Read full email"; return; }
    body.innerHTML = '<div class="muted">Loading…</div>';
    api("GET", "/api/pods/" + podId + "/inbox/" + encodeURIComponent(uid) + "/body")
      .then(function (r) {
        body.innerHTML = '<div class="msg-body">' + Podium.md(r.body || "(no text body)") + '</div>';
        body.style.display = "block";
        if (btn) btn.textContent = "Hide email";
      })
      .catch(function (er) { body.innerHTML = '<div class="err">' + er.message + '</div>'; body.style.display = "block"; });
  },

  /* ----- objectives & key results ----- */
  saveObjective: function (e, podId) {
    e.preventDefault();
    var f = e.target;
    api("POST", "/api/pods/" + podId + "/objectives", { title: f.title.value, period: f.period.value })
      .then(function () { loadPod(podId, "objectives"); setOk("Objective added."); })
      .catch(function (er) { setErr(er.message); });
    return false;
  },
  saveObjectiveProgress: function (e, id) {
    e.preventDefault();
    var f = e.target;
    api("PUT", "/api/objectives/" + id, { progress_pct: Number(f.progress_pct.value), status: f.status.value })
      .then(function () { loadPod(state.pod.id, "objectives"); })
      .catch(function (er) { setErr(er.message); });
    return false;
  },
  deleteObjective: function (id) {
    if (!confirm("Delete this objective and its key results?")) return;
    api("DELETE", "/api/objectives/" + id)
      .then(function () { loadPod(state.pod.id, "objectives"); })
      .catch(function (er) { setErr(er.message); });
  },
  saveKeyResult: function (e, objectiveId) {
    e.preventDefault();
    var f = e.target;
    api("POST", "/api/objectives/" + objectiveId + "/key-results", { title: f.title.value, current: f.current.value, target: f.target.value })
      .then(function () { loadPod(state.pod.id, "objectives"); })
      .catch(function (er) { setErr(er.message); });
    return false;
  },
  editKeyResult: function (id, title, current, target) {
    var t = prompt("Key result", title);
    if (t === null) return;
    var c = prompt("Current value", current || "");
    if (c === null) return;
    var tg = prompt("Target value", target || "");
    if (tg === null) return;
    api("PUT", "/api/key-results/" + id, { title: t, current: c, target: tg })
      .then(function () { loadPod(state.pod.id, "objectives"); })
      .catch(function (er) { setErr(er.message); });
  },
  deleteKeyResult: function (id) {
    if (!confirm("Delete this key result?")) return;
    api("DELETE", "/api/key-results/" + id)
      .then(function () { loadPod(state.pod.id, "objectives"); })
      .catch(function (er) { setErr(er.message); });
  },

  /* ----- alerts ----- */
  markAlertSeen: function (id) {
    api("POST", "/api/alerts/" + id + "/seen", {})
      .then(function () { loadAlerts(); setOk("Marked seen."); })
      .catch(function (er) { setErr(er.message); });
  },

  /* ----- page signing ----- */
  showSigningForm: function (on) {
    state.showSigningForm = on === undefined ? true : on;
    render();
  },
  createSigning: function (e, pageId) {
    e.preventDefault();
    var f = e.target;
    api("POST", "/api/pages/" + pageId + "/signing", { signer_name: f.signer_name.value, signer_email: f.signer_email.value })
      .then(function (r) {
        state.signing = r.signing; state.showSigningForm = false; render();
        setOk("Signing link created — share it with the client.");
      })
      .catch(function (er) { setErr(er.message); });
    return false;
  },
  revokeSigning: function (pageId) {
    if (!confirm("Revoke this signing link?")) return;
    api("DELETE", "/api/pages/" + pageId + "/signing")
      .then(function () { state.signing = null; render(); setOk("Signing revoked."); })
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
